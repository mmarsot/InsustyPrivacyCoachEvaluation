/**
 * The extension's redaction module at a git ref, behind the redaction
 * contract (`contract/types.ts`). The harness scores the ref only through
 * `redact()`; everything below drives the ref's own code:
 *
 * - **rules**: `detectSensitiveData` with the ref's `DEFAULT_CONFIG`, the
 *   contract configuration applied to it (built-in labels, address
 *   countries);
 * - **documents**: the ref's file check, reader and redacted version
 *   (`./documents.ts`);
 * - **Private AI on the device**: the ref's `reviewPrompt` and `SlmEngine`
 *   with the bench's Node WASM loader (`src/run/transformers-loader.ts`);
 * - **Private AI on a connected model**: the ref's `reviewPrompt` with its
 *   own connected-model client (`createHostedModelClient`), context budget
 *   and learned-example limits, as `reviewConnected` runs them. Only the
 *   transport is the harness's (`ConnectedTarget.fetch`: pacing, caching,
 *   budget);
 * - **the final redaction** when Private AI runs: a custom-label finding
 *   wins over an overlapping rule finding, then the ref's
 *   `redactReviewFindings`, as `reviewForRedaction`
 *   (`src/background/review.ts`) does. That merge lives in the service
 *   worker, so this is the one step mirrored here rather than called.
 *
 * Only completion-design refs (per-label review, since PR #26) can run
 * Private AI through the contract.
 */
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import {
  CONTRACT_VERSION,
  type BuiltinLabel,
  type ModelRequestTrace,
  type ModuleCapabilities,
  type ModuleConfig,
  type RedactionInput,
  type RedactionModule,
  type RedactionOutput,
  type RuntimeReport,
  type Span,
  type StageTiming,
} from "../../contract/types.ts";
import { documentPath, type DocumentBundle, type RangeLike } from "./documents.ts";
import { toBuiltin } from "./labels.ts";
import { machineProfile, peakRssMb } from "./machine.ts";
import type { ModuleRef } from "./materialize.ts";

// ------------------------------------------------------------ the ref's exports, as the adapter uses them

interface Detection {
  category: string;
  start: number;
  end: number;
  value?: string;
  source?: string;
  selected?: boolean;
  replacement?: string;
}
interface ReviewSpan {
  category: string;
  start: number;
  end: number;
  value?: string;
  reason?: string;
}
export interface RuleLike {
  name: string;
  label: string;
  prompt: string;
  examples: string[];
  learned: { examples: unknown[]; falseAlarms: unknown[] };
}
export interface EngineRuntime {
  backend: string;
  quantization: string;
  promptTokens: number;
  generatedTokens: number;
  finishReason: string;
  prefixReused?: boolean;
  answerProbability?: number;
}
interface Engine {
  prepare(model: string, selection: Selection, instructions: readonly string[]): Promise<unknown>;
  review(model: string, selection: Selection, request: unknown, budgetMs: number): Promise<{ output: string; runtime: EngineRuntime }>;
}
type Selection = { backend: "wasm"; quantization: "auto" };
type Client = { review(request: { instructions: string; input: string; responsePrefill?: string; subject?: { rule: RuleLike } }, model?: string, selection?: Selection): Promise<{ output: unknown; runtime?: EngineRuntime; confidence?: number }> };

export type InsustyBundle = DocumentBundle & {
  detector: { detectSensitiveData: (text: string, config: unknown) => Detection[] };
  config: {
    DEFAULT_CONFIG: Record<string, unknown> & { categories?: Record<string, boolean>; addressCountries?: string[]; localAi?: { fileReviewLimit?: number }; ocr?: { enabled: boolean; languages: string[] } };
    CATEGORIES?: string[];
    FILE_REVIEW_LIMITS?: readonly number[];
    SUPPORTED_ADDRESS_COUNTRIES?: readonly string[];
    DEFAULT_TRUSTED_TIME_LIMIT_MS?: number;
    trustedConnectionOrigin?: (connection: unknown) => string;
  };
  redaction?: DocumentBundle["redaction"] & { redactReviewFindings?: (text: string, findings: ReviewSpan[]) => { redactedText: string; replaced: ReviewSpan[] } };
  review?: {
    reviewPrompt: (text: string, client: Client, rules: RuleLike[], model?: string, selection?: Selection, contextBudget?: number, overlap?: number, learnedLimits?: unknown) => Promise<{ findings: ReviewSpan[] }>;
    reviewInstructionSets?: (rules: RuleLike[]) => string[];
    composeLabelPrefix?: unknown;
    SLM_GENERATION_BUDGET_MS?: number;
  };
  engine?: { SlmEngine: new (loader: unknown) => Engine };
  models?: { SLM_MODELS: ReadonlyArray<{ id: string; downloadBytes?: Record<string, number> }>; DEFAULT_SLM_MODEL_ID?: string };
  hostedFraming?: { HOSTED_CONTEXT_BUDGET?: number; HOSTED_LEARNED_LIMITS?: unknown };
  hostedClient?: {
    createHostedModelClient: (options: Record<string, unknown>) => Client;
    RequestPacer: new (now?: () => number) => unknown;
  };
};

// ------------------------------------------------------------ options

/** The on-device runtime the harness supplies (the ref's engine runs on it). */
export interface DeviceRuntime {
  loader: unknown;
  threads: number;
  dispose(): Promise<void>;
}

/** A connected model: the ref's own `TrustedConnection` plus how its requests leave this process. */
export interface ConnectedTarget {
  /** The id `ModuleConfig.privateAi.model` selects it by. */
  id: string;
  /** The ref's `TrustedConnection` (provider, region or baseUrl, model, displayName, format, timeLimitMs, maxRequestsPerMinute). */
  connection: { provider: string; model: string; timeLimitMs?: number } & Record<string, unknown>;
  apiKey?: string;
  /** The transport: the harness adds caching and its budget; pacing and retries stay the ref's. */
  fetch: typeof fetch;
  /** Tokens and USD of one reply, read from the provider's JSON (and the transport's response, which may mark a cached reply). */
  usage(json: unknown, response: Response): { inputTokens?: number; outputTokens?: number; usd: number; cached?: boolean } | undefined;
}

export interface InsustyOptions {
  device?: () => Promise<DeviceRuntime>;
  connected?: ConnectedTarget[];
}

export interface InsustyModule extends RedactionModule {
  ref: ModuleRef;
  /** The ref's own category names (for reports on what a ref supports). */
  refCategories: string[];
  /** The values the Private AI size threshold for files can take (`FILE_REVIEW_LIMITS`). */
  fileReviewLimits?: number[];
}

const PATTERN_REASON = "Matches the format of a label example.";
const LEARNED_REASON = "Matches a learned example.";
const SELECTION: Selection = { backend: "wasm", quantization: "auto" };

/** Imports a materialized ref and adapts it to the contract. */
export async function loadInsustyModule(ref: ModuleRef, options: InsustyOptions = {}): Promise<InsustyModule> {
  const mod = (await import(pathToFileURL(ref.bundle).href)) as InsustyBundle;
  const base = mod.config.DEFAULT_CONFIG;
  if (typeof mod.detector?.detectSensitiveData !== "function" || !base) throw new Error(`${ref.ref} does not export detectSensitiveData and DEFAULT_CONFIG.`);
  const refCategories = mod.config.CATEGORIES ?? Object.keys(base.categories ?? {});
  const builtins = [...new Set(refCategories.map(toBuiltin).filter((b): b is BuiltinLabel => b !== null))];
  const docs = documentPath(ref, mod);
  const completion = !!mod.review && typeof mod.review.composeLabelPrefix === "function";
  const deviceModels = completion && mod.engine && mod.models ? mod.models.SLM_MODELS : [];
  const defaultDevice = mod.models?.DEFAULT_SLM_MODEL_ID ?? deviceModels[0]?.id;
  const connected = completion && mod.hostedClient ? (options.connected ?? []) : [];
  const capabilities: ModuleCapabilities = {
    builtins,
    customLabels: completion,
    documents: docs.readsDocuments,
    ocr: false,
    ...(mod.config.SUPPORTED_ADDRESS_COUNTRIES ? { addressCountries: [...mod.config.SUPPORTED_ADDRESS_COUNTRIES] } : {}),
    privateAi: [...(deviceModels.length && options.device ? ["device" as const] : []), ...(connected.length ? ["connected" as const] : [])],
    models: [
      ...deviceModels.map((m) => ({ id: m.id, runsOn: "device" as const, ...(m.id === defaultDevice ? { default: true } : {}), ...(m.downloadBytes?.q8 ? { bytes: m.downloadBytes.q8 } : {}) })),
      ...connected.map((c, i) => ({ id: c.id, runsOn: "connected" as const, ...(i === 0 ? { default: true } : {}) })),
    ],
  };
  const info = { name: "insusty-prompt-coach", version: ref.sha.slice(0, 12), sha: ref.sha };

  const defaultConfig = (): ModuleConfig => ({
    builtins: Object.fromEntries(refCategories.flatMap((c) => (toBuiltin(c) ? [[toBuiltin(c)!, base.categories?.[c] !== false]] : []))),
    addressCountries: [...(base.addressCountries ?? [])],
    customLabels: [],
    privateAi: { runsOn: "off" },
    ocr: base.ocr ? { enabled: base.ocr.enabled, languages: [...base.ocr.languages] } : { enabled: false, languages: [] },
    limits: { ...docs.limits, ...(typeof base.localAi?.fileReviewLimit === "number" ? { fileReviewLimit: base.localAi.fileReviewLimit } : {}) },
  });

  /** The ref's configuration object for a contract configuration. */
  const refConfig = (config: ModuleConfig) => {
    const c = structuredClone(base);
    const categories = { ...(c.categories ?? {}) };
    for (const cat of refCategories) {
      const b = toBuiltin(cat);
      const on = b ? config.builtins[b] : undefined;
      if (on !== undefined) categories[cat] = on;
    }
    c.categories = categories;
    if (config.addressCountries.length) c.addressCountries = [...config.addressCountries];
    if (c.ocr) c.ocr = { enabled: config.ocr.enabled, languages: [...config.ocr.languages] };
    return c;
  };

  const ruleSpans = (text: string, config: ModuleConfig): { spans: Span[]; raw: Detection[]; ms: number } => {
    const c = refConfig(config);
    const t0 = performance.now();
    const raw = text ? mod.detector.detectSensitiveData(text, c) : [];
    const ms = performance.now() - t0;
    const spans: Span[] = [];
    for (const d of raw) {
      const label = toBuiltin(d.category);
      if (!label) continue;
      spans.push({
        start: d.start,
        end: d.end,
        label,
        kind: "builtin",
        ...(d.source ? { subtype: d.source } : {}),
        source: "rules",
        redacted: d.selected !== false && c.categories?.[d.category] !== false,
      });
    }
    return { spans, raw, ms };
  };

  // -------------------------------------------------- Private AI
  let engine: Engine | undefined;
  let device: DeviceRuntime | undefined;
  let loadedModel: string | undefined;
  let preparedKey: string | undefined;
  const pacers = new Map<string, unknown>();
  const rulesOf = (config: ModuleConfig): RuleLike[] =>
    config.customLabels.map((l) => ({ name: l.label, label: l.label, prompt: l.description, examples: [...l.examples], learned: { examples: [], falseAlarms: [] } }));

  interface Reviewed {
    spans: Span[];
    traces: ModelRequestTrace[];
    ms: number;
    requests: number;
    model: RuntimeReport["model"];
    backend: RuntimeReport["backend"];
    cost?: RuntimeReport["cost"];
    error?: string;
  }

  /** Loads the configuration's on-device model and prepares its label prefixes, once per model and label set. */
  const prepareDevice = async (config: ModuleConfig) => {
    const model = config.privateAi.model ?? defaultDevice;
    if (!model || !deviceModels.some((m) => m.id === model)) throw new Error(`${ref.ref} ships no on-device model ${model ?? ""}`);
    if (!options.device) throw new Error("No on-device runtime was supplied.");
    device ??= await options.device();
    engine ??= new mod.engine!.SlmEngine(device.loader);
    let loadMs: number | undefined;
    const cold = loadedModel !== model;
    if (cold) {
      const t = performance.now();
      await engine.prepare(model, SELECTION, []);
      loadMs = performance.now() - t;
      loadedModel = model;
      preparedKey = undefined;
    }
    const rules = rulesOf(config);
    let prepareMs: number | undefined;
    const key = JSON.stringify(rules);
    if (preparedKey !== key && mod.review!.reviewInstructionSets) {
      const t = performance.now();
      await engine.prepare(model, SELECTION, mod.review!.reviewInstructionSets(rules));
      prepareMs = performance.now() - t;
      preparedKey = key;
    }
    return { model, rules, cold, loadMs, prepareMs };
  };

  const reviewDevice = async (text: string, config: ModuleConfig): Promise<Reviewed> => {
    const t0 = performance.now();
    const { model, rules, cold, loadMs, prepareMs } = await prepareDevice(config);
    const setupMs = performance.now() - t0;
    const traces: ModelRequestTrace[] = [];
    const budget = mod.review!.SLM_GENERATION_BUDGET_MS ?? 30_000;
    const runtime = device!;
    const client: Client = {
      async review(request) {
        const t = performance.now();
        const r = await engine!.review(model, SELECTION, request, budget);
        traces.push({
          ...(request.responsePrefill ? { label: request.responsePrefill.replace(/:$/, "") } : {}),
          ms: performance.now() - t,
          promptTokens: r.runtime.promptTokens,
          outputTokens: r.runtime.generatedTokens,
          finishReason: r.runtime.finishReason,
          output: r.output,
          ...(r.runtime.answerProbability !== undefined ? { confidence: r.runtime.answerProbability } : {}),
        });
        return { output: r.output, runtime: r.runtime };
      },
    };
    const t1 = performance.now();
    let found: ReviewSpan[] = [];
    let error: string | undefined;
    try {
      found = (await mod.review!.reviewPrompt(text, client, rules, model, SELECTION)).findings;
    } catch (e) {
      error = (e as Error).message;
    }
    const bytes = deviceModels.find((m) => m.id === model)?.downloadBytes?.q8;
    return {
      spans: customSpans(found),
      traces,
      ms: performance.now() - t1 + setupMs,
      requests: traces.length,
      model: { id: model, ...(bytes ? { bytes } : {}), cold, ...(loadMs !== undefined ? { loadMs } : {}), ...(prepareMs !== undefined ? { prepareMs } : {}) },
      backend: { name: "wasm", threads: runtime.threads, dtype: "q8" },
      ...(error ? { error } : {}),
    };
  };

  const reviewConnected = async (text: string, config: ModuleConfig): Promise<Reviewed> => {
    const target = connected.find((c) => c.id === (config.privateAi.model ?? connected[0]?.id));
    if (!target) throw new Error(`No connected model ${config.privateAi.model ?? ""} was supplied.`);
    const rules = rulesOf(config);
    const traces: ModelRequestTrace[] = [];
    let usd = 0;
    /** The usage of the reply the transport saw last (one request at a time). */
    type Usage = { inputTokens?: number; outputTokens?: number; cached?: boolean };
    const last: { usage?: Usage } = {};
    const transport: typeof fetch = async (url, init) => {
      const response = await target.fetch(url, init);
      const json = await response.clone().json().catch(() => undefined);
      const usage = target.usage(json, response);
      if (usage) {
        usd += usage.usd;
        last.usage = usage;
      }
      return response;
    };
    const signature = JSON.stringify(target.connection);
    if (!pacers.has(signature)) pacers.set(signature, new mod.hostedClient!.RequestPacer());
    const limitMs = target.connection.timeLimitMs ?? mod.config.DEFAULT_TRUSTED_TIME_LIMIT_MS ?? 15_000;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error(`The connected model ran past its ${limitMs / 1000} s time limit.`)), limitMs);
    const origin = mod.config.trustedConnectionOrigin?.(target.connection);
    const inner = mod.hostedClient!.createHostedModelClient({
      connection: target.connection,
      ...(target.apiKey && origin ? { apiKey: { origin, key: target.apiKey } } : {}),
      fetch: transport,
      pacer: pacers.get(signature),
      signal: controller.signal,
      deadline: Date.now() + limitMs,
    });
    const client: Client = {
      async review(request, model, selection) {
        const t = performance.now();
        last.usage = undefined;
        const r = await inner.review(request, model, selection);
        const pending = last.usage as Usage | undefined; // set by the transport during the request
        traces.push({
          label: request.subject?.rule.label ?? request.responsePrefill?.replace(/:$/, "") ?? "",
          ms: performance.now() - t,
          ...(pending?.inputTokens !== undefined ? { promptTokens: pending.inputTokens } : {}),
          ...(pending?.outputTokens !== undefined ? { outputTokens: pending.outputTokens } : {}),
          finishReason: "stop",
          output: String(r.output ?? ""),
          ...(r.confidence !== undefined ? { confidence: r.confidence } : {}),
          ...(pending?.cached ? { cached: true } : {}),
        });
        return r;
      },
    };
    const t1 = performance.now();
    let found: ReviewSpan[] = [];
    let error: string | undefined;
    try {
      found = (
        await mod.review!.reviewPrompt(text, client, rules, undefined, undefined, mod.hostedFraming?.HOSTED_CONTEXT_BUDGET, undefined, mod.hostedFraming?.HOSTED_LEARNED_LIMITS)
      ).findings;
    } catch (e) {
      error = (e as Error).message;
    } finally {
      clearTimeout(timer);
    }
    return {
      spans: customSpans(found),
      traces,
      ms: performance.now() - t1,
      requests: traces.length,
      model: { id: target.id, cold: false },
      backend: { name: "api" },
      cost: { usd, provider: target.connection.provider, connected: true },
      ...(error ? { error } : {}),
    };
  };

  const customSpans = (found: ReviewSpan[]): Span[] =>
    found.map((f) => ({
      start: f.start,
      end: f.end,
      label: f.category,
      kind: "custom",
      source: f.reason === PATTERN_REASON ? "pattern" : f.reason === LEARNED_REASON ? "learned" : "model",
      redacted: true,
    }));

  /** Rule spans that a custom-label span overlaps give way to it, as `reviewForRedaction` merges them. */
  const merge = (rules: Span[], custom: Span[]): Span[] => [
    ...custom,
    ...rules.map((r) => (r.redacted && custom.some((c) => r.start < c.end && c.start < r.end) ? { ...r, redacted: false } : r)),
  ];

  const redactText = (text: string, spans: Span[], raw: Detection[], privateAi: boolean): string => {
    const redacted = spans.filter((s) => s.redacted);
    if (privateAi && mod.redaction?.redactReviewFindings)
      return mod.redaction.redactReviewFindings(text, redacted.map((s) => ({ category: s.label, start: s.start, end: s.end }))).redactedText;
    if (mod.redaction && !privateAi)
      return mod.redaction.redactPrompt(text, raw.map((d) => ({ start: d.start, end: d.end, replacement: d.replacement ?? `[${d.category}]`, selected: spans.some((s) => s.start === d.start && s.end === d.end && s.redacted) })));
    let out = "";
    let cursor = 0;
    for (const s of [...redacted].sort((a, b) => a.start - b.start || b.end - a.end)) {
      if (s.start < cursor) continue;
      out += `${text.slice(cursor, s.start)}[${s.label}]`;
      cursor = s.end;
    }
    return out + text.slice(cursor);
  };

  const runtimeOf = (t0: number, stages: StageTiming[], chars: number, reviewed?: Reviewed, pages?: number): RuntimeReport => {
    const totalMs = performance.now() - t0;
    return {
      stages,
      totalMs,
      peakRssMb: peakRssMb(),
      ...(totalMs > 0 ? { charsPerSecond: (chars / totalMs) * 1000 } : {}),
      ...(pages && totalMs > 0 ? { pagesPerMinute: (pages / totalMs) * 60_000 } : {}),
      backend: reviewed?.backend ?? { name: "native" },
      ...(reviewed?.model ? { model: reviewed.model } : {}),
      ...(reviewed?.cost ? { cost: reviewed.cost } : {}),
      ...(reviewed?.traces.length ? { requests: reviewed.traces } : {}),
      machine: machineProfile(),
    };
  };

  /** Rules, then Private AI when configured; the stages and spans for one text. */
  const checkText = async (text: string, config: ModuleConfig) => {
    const rules = ruleSpans(text, config);
    const stages: StageTiming[] = [{ stage: "rules", ms: rules.ms }];
    const runsOn = config.privateAi.runsOn;
    let reviewed: Reviewed | undefined;
    if (runsOn !== "off" && config.customLabels.length) {
      if (!capabilities.privateAi.includes(runsOn)) throw new Error(`Private AI on ${runsOn} is not available for ${ref.ref}.`);
      reviewed = runsOn === "device" ? await reviewDevice(text, config) : await reviewConnected(text, config);
      stages.push({ stage: "model", ms: reviewed.ms, requests: reviewed.requests });
    }
    return { rules, stages, reviewed, spans: reviewed ? merge(rules.spans, reviewed.spans) : rules.spans };
  };

  const redact = async (input: RedactionInput, config: ModuleConfig): Promise<RedactionOutput> => {
    const t0 = performance.now();
    if (input.kind === "text") {
      const { rules, stages, reviewed, spans } = await checkText(input.text, config);
      const any = spans.some((s) => s.redacted);
      const r0 = performance.now();
      const redactedText = any ? redactText(input.text, spans, rules.raw, !!reviewed) : undefined;
      if (any) stages.push({ stage: "redact", ms: performance.now() - r0 });
      return {
        contract: CONTRACT_VERSION,
        module: info,
        text: input.text,
        spans,
        redaction: any ? { text: redactedText, mode: "in_place", leakChecked: false } : { mode: "none", leakChecked: false },
        coverage: reviewed?.error
          ? { checked: "partial", reason: "private_ai_unavailable", gaps: ["Private AI review"], format: "text", ocrPages: 0, detail: reviewed.error }
          : { checked: "full", gaps: [], format: "text", ocrPages: 0 },
        runtime: runtimeOf(t0, stages, input.text.length, reviewed),
      };
    }
    const read = await docs.read(input.name, input.bytes);
    const stages: StageTiming[] = [{ stage: "read", ms: read.readMs, ...(read.pages !== undefined ? { pages: read.pages } : {}) }];
    const unread = read.outcome === "unchecked" || read.outcome === "error";
    const checked = unread ? { rules: { spans: [], raw: [], ms: 0 }, stages: [], reviewed: undefined, spans: [] as Span[] } : await checkText(read.text, config);
    stages.push(...checked.stages);
    const ranges: RangeLike[] = checked.spans
      .filter((s) => s.redacted)
      .sort((a, b) => a.start - b.start)
      .map((s) => ({ start: s.start, end: s.end, replacement: `[${s.label}]` }));
    const red = await docs.redact(input.name, input.bytes, read, ranges);
    if (red.mode !== "none") stages.push({ stage: "redact", ms: red.ms });
    const gaps = [...read.gaps, ...(checked.reviewed?.error ? ["Private AI review"] : [])];
    return {
      contract: CONTRACT_VERSION,
      module: info,
      text: read.text,
      parts: read.segments.map((s) => ({ start: s.start, end: s.end, where: s.where, ...(s.source.page !== undefined ? { page: s.source.page } : {}) })),
      spans: checked.spans,
      redaction: {
        mode: red.mode,
        leakChecked: false,
        ...(red.bytes ? { file: { name: red.name!, type: red.type ?? "application/octet-stream", bytes: red.bytes } } : {}),
        ...(red.failing ? { unredactable: red.failing.map((r) => ({ start: r.start, end: r.end })) } : {}),
        ...(red.error ? { error: red.error } : {}),
      },
      coverage: {
        checked: unread ? "none" : read.outcome === "partial" || gaps.length ? "partial" : "full",
        ...(read.reason ? { reason: read.reason } : read.partialText ? { reason: "text_cap" } : checked.reviewed?.error ? { reason: "private_ai_unavailable" } : {}),
        gaps,
        ...(read.readAs ? { format: read.readAs } : {}),
        ...(read.pages !== undefined ? { pages: read.pages } : {}),
        ocrPages: 0,
        signed: read.signed,
        ...(read.error ? { detail: read.error } : checked.reviewed?.error ? { detail: checked.reviewed.error } : {}),
      },
      runtime: runtimeOf(t0, stages, read.text.length, checked.reviewed, read.pages),
    };
  };

  return {
    contract: CONTRACT_VERSION,
    info,
    capabilities,
    ref,
    refCategories,
    ...(mod.config.FILE_REVIEW_LIMITS ? { fileReviewLimits: [...mod.config.FILE_REVIEW_LIMITS] } : {}),
    defaultConfig,
    redact,
    async prepare(config) {
      if (config.privateAi.runsOn !== "device" || !config.customLabels.length) return {};
      const p = await prepareDevice(config);
      return { ...(p.loadMs !== undefined ? { loadMs: p.loadMs } : {}), ...(p.prepareMs !== undefined ? { prepareMs: p.prepareMs } : {}), backend: { name: "wasm", threads: device!.threads, dtype: "q8" } };
    },
    async dispose() {
      await device?.dispose();
      engine = undefined;
      device = undefined;
      loadedModel = undefined;
    },
  };
}

/** Every built-in label on, and every address country the module declares (the extension's `SUPPORTED_ADDRESS_COUNTRIES`; until a ref exports it, its default ones). */
export function allLabelsConfig(module: Pick<RedactionModule, "defaultConfig" | "capabilities">): ModuleConfig {
  const d = module.defaultConfig();
  return {
    ...d,
    builtins: Object.fromEntries(module.capabilities.builtins.map((b) => [b, true])),
    addressCountries: module.capabilities.addressCountries ? [...module.capabilities.addressCountries] : d.addressCountries,
  };
}
