/**
 * Local dashboard server: plain node:http, JSON endpoints plus one static
 * page (src/dashboard/page.ts). Read-only: it never writes to the cache or
 * the runs, so it can watch a bench run without affecting it.
 */
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { compileDataset } from "../dataset/load.ts";
import type { CompiledCase, CompiledDataset } from "../dataset/schema.ts";
import { loadExtApi, materializeExtRef, resolveExtRefName, resolveExtRepo, type ExtApi, type ExtRef } from "../ext/ref.ts";
import { HOSTED_MODELS } from "../hosted/bedrock.ts";
import { EXT_CACHE_DIR, MODELS_FILE, ROOT } from "../paths.ts";
import { DEFAULT_QUICK_CASES_PER_PROFILE, rulesFor, selectCases, type Job, type ResultRecord } from "../run/jobs.ts";
import { findBenchModel, MODELS, parseBenchArgs, planJobs, secondsPerCase, splitLabel, type Plan } from "../run/plan.ts";
import { compareRows, COMPARE_METRICS } from "../report/compare-data.ts";
import { scoreResult, type Scored } from "../score/score.ts";
import { INSTRUCTION_VARIANTS, LABEL_VARIANTS } from "../variants.ts";
import {
  caseDetail,
  computeProgress,
  filterOptions,
  filterRows,
  findActiveRuns,
  groupMetrics,
  listCases,
  listCommittedRuns,
  matrixStatus,
  readCommittedRows,
  readModelCache,
  RESULT_DIMENSIONS,
  type ActiveRun,
  type Filters,
  type MatrixRow,
  type RunListing,
} from "./data.ts";
import { PAGE_HTML } from "./page.ts";
import { BusyError, PlaygroundHost } from "../playground/manager.ts";
import { DEFAULT_SETTINGS } from "../playground/logic.ts";
import { composeLabelDescription } from "../variants.ts";

interface LoadedExt {
  ext: ExtRef;
  api: ExtApi;
}

interface LiveRun {
  id: string;
  run: ActiveRun;
  ext?: LoadedExt;
  plan?: Plan;
  tier?: string;
  split?: string;
  error?: string;
}

export class Dashboard {
  readonly dataset: CompiledDataset;
  /** At most one chat-playground model, in its own process. */
  readonly playground = new PlaygroundHost();
  readonly cases: Map<string, CompiledCase>;
  private readonly exts = new Map<string, Promise<LoadedExt>>();
  private readonly scored = new Map<string, Scored>();
  private readonly instructionsMemo = new Map<string, string>();
  private matrixMemo?: { at: number; rows: MatrixRow[] };
  private plansMemo = new Map<string, { quick: Plan; full: Plan }>();
  private liveMemo = new Map<string, LiveRun>();

  constructor(private readonly options: { extRepo?: string; ref?: string } = {}) {
    const { dataset, issues } = compileDataset({ requireSplit: false });
    if (!dataset) throw new Error(`dataset invalid: ${issues.find((i) => i.level === "error")?.message}`);
    this.dataset = dataset;
    this.cases = new Map(dataset.cases.map((c) => [c.id, c]));
  }

  /** Loads (and caches) an extension ref; undefined when no clone is configured. */
  async ext(ref = resolveExtRefName(this.options.ref), extRepo = this.options.extRepo): Promise<LoadedExt | undefined> {
    const id = `${extRepo ?? ""}\u0000${ref}`;
    if (!this.exts.has(id))
      this.exts.set(
        id,
        (async () => {
          const ext = await materializeExtRef(resolveExtRepo(extRepo), ref);
          return { ext, api: await loadExtApi(ext.bundle) };
        })(),
      );
    try {
      return await this.exts.get(id)!;
    } catch {
      this.exts.delete(id);
      return undefined;
    }
  }

  /** Default prompt of an already-materialized commit, for committed runs. */
  private async defaultPromptFor(sha: string): Promise<string> {
    const bundle = join(EXT_CACHE_DIR, sha, "bench-ext.mjs");
    if (existsSync(bundle)) return (await loadExtApi(bundle)).defaultPrompt;
    return (await this.ext())?.api.defaultPrompt ?? "(the extension's default prompt)";
  }

  private instructionsFor(api: ExtApi, job: Job): string {
    const id = `${job.systemInstruction}\u0000${JSON.stringify(job.rules)}`;
    let text = this.instructionsMemo.get(id);
    if (text === undefined) {
      text = api.composeReviewInstructions(job.systemInstruction, job.rules);
      this.instructionsMemo.set(id, text);
    }
    return text;
  }

  score(api: ExtApi, job: Job, record: ResultRecord): Scored {
    const id = `${record.key}\u0000${record.at}`;
    let row = this.scored.get(id);
    if (!row) {
      const c = this.cases.get(job.caseId)!;
      const profile = this.dataset.profiles.find((p) => p.id === c.profile)!;
      row = scoreResult(c, profile, record, api.reviewCategories([]), this.instructionsFor(api, job), api.kind === "completion");
      this.scored.set(id, row);
    }
    return row;
  }

  // ---------------------------------------------------------- live runs

  async liveRuns(): Promise<LiveRun[]> {
    const out: LiveRun[] = [];
    for (const run of findActiveRuns()) {
      const id = `live:${run.pid}`;
      const memo = this.liveMemo.get(id);
      if (memo && memo.run.argv.join(" ") === run.argv.join(" ")) {
        out.push(memo);
        continue;
      }
      const live: LiveRun = { id, run };
      try {
        const o = parseBenchArgs(run.argv);
        live.tier = o.tier;
        live.split = splitLabel(o);
        live.ext = await this.ext(o.ref ?? resolveExtRefName(this.options.ref), o.extRepo ?? this.options.extRepo);
        if (!live.ext) throw new Error("extension clone not available");
        const { dataset } = compileDataset({ requireSplit: !o.allowMissingSplit, profiles: o.profiles });
        if (!dataset) throw new Error("dataset invalid for this run's options");
        live.plan = planJobs(dataset, o, live.ext.ext.sha, live.ext.api.defaultPrompt, live.ext.api.kind === "completion");
      } catch (error) {
        live.error = (error as Error).message;
      }
      this.liveMemo.set(id, live);
      out.push(live);
    }
    return out;
  }

  async progress() {
    const runs = await this.liveRuns();
    return runs.map((live) => {
      const base = { id: live.id, pid: live.run.pid, name: live.run.name, argv: live.run.argv, startedAt: live.run.startedAt, tier: live.tier, split: live.split };
      if (!live.plan || !live.ext) return { ...base, error: live.error ?? "no plan" };
      const { ext, api } = live.ext;
      const jobs = new Map<string, Job>();
      for (const list of live.plan.jobsByModel.values()) for (const j of list) jobs.set(j.key, j);
      const progress = computeProgress(
        live.plan.jobsByModel,
        (model) => readModelCache(ext.sha, model),
        (job, record) => this.score(api, job, record).failure,
        (model) => secondsPerCase(findBenchModel(model) ?? MODELS[0]!),
      );
      return { ...base, ref: ext.ref, sha: ext.sha, cases: live.plan.cases.length, ...progress };
    });
  }

  /** Scored results of a live run so far. */
  async liveRows(id: string): Promise<Scored[]> {
    const live = (await this.liveRuns()).find((r) => r.id === id);
    if (!live?.plan || !live.ext) return [];
    const rows: Scored[] = [];
    for (const [model, jobs] of live.plan.jobsByModel) {
      const cache = readModelCache(live.ext.ext.sha, model);
      for (const job of jobs) {
        const record = cache.get(job.key);
        if (record) rows.push(this.score(live.ext.api, job, record));
      }
    }
    return rows;
  }

  // ---------------------------------------------------------- matrix

  private plansFor(loaded: LoadedExt) {
    let plans = this.plansMemo.get(loaded.ext.sha);
    if (!plans) {
      const all = { casesPerProfile: DEFAULT_QUICK_CASES_PER_PROFILE, cachedOnly: false, models: MODELS, instructions: [...INSTRUCTION_VARIANTS], labelVariants: LABEL_VARIANTS.map((v) => v.id), profiles: [], langs: [], maxRssMb: 0, dryRun: false, allowMissingSplit: false, budgetUsd: 0 };
      plans = {
        quick: planJobs(this.dataset, { ...all, tier: "quick" }, loaded.ext.sha, loaded.api.defaultPrompt, loaded.api.kind === "completion"),
        full: planJobs(this.dataset, { ...all, tier: "full" }, loaded.ext.sha, loaded.api.defaultPrompt, loaded.api.kind === "completion"),
      };
      this.plansMemo.set(loaded.ext.sha, plans);
    }
    return plans;
  }

  async matrix() {
    const loaded = await this.ext();
    if (!loaded) return { error: "Extension clone not configured: set bench.local.json, INSUSTY_EXT_REPO or --ext-repo." };
    if (!this.matrixMemo || Date.now() - this.matrixMemo.at > 5_000) {
      const plans = this.plansFor(loaded);
      const live = await this.liveRuns();
      const activeKeys = new Set<string>();
      for (const l of live) if (l.plan) for (const jobs of l.plan.jobsByModel.values()) for (const j of jobs) activeKeys.add(j.key);
      const perCase = new Map(MODELS.map((m) => [m.id, secondsPerCase(m)]));
      const caches = new Map(MODELS.map((m) => [m.id, readModelCache(loaded.ext.sha, m.id)]));
      const isDone = (model: string, key: string) => caches.get(model)?.has(key) ?? false;
      const isActive = (_model: string, key: string) => activeKeys.has(key);
      this.matrixMemo = {
        at: Date.now(),
        rows: [
          ...matrixStatus("quick", plans.quick.jobsByModel, isDone, isActive, (m) => perCase.get(m) ?? 20),
          ...matrixStatus("full", plans.full.jobsByModel, isDone, isActive, (m) => perCase.get(m) ?? 20),
        ],
      };
    }
    return { ref: loaded.ext.ref, sha: loaded.ext.sha, subject: loaded.ext.subject, rows: this.matrixMemo.rows, secondsPerCase: Object.fromEntries(MODELS.map((m) => [m.id, secondsPerCase(m)])) };
  }

  // ---------------------------------------------------------- results

  async runs(): Promise<RunListing[]> {
    const live = (await this.liveRuns()).filter((l) => l.plan).map((l) => ({ id: l.id, name: `LIVE ${l.run.name ?? l.run.argv.join(" ")}`, kind: "live" as const, tier: l.tier, ref: l.ext?.ext.ref, sha: l.ext?.ext.sha }));
    return [...live, ...listCommittedRuns()];
  }

  async rows(runId: string): Promise<Scored[]> {
    if (runId.startsWith("live:")) return this.liveRows(runId);
    if (runId.startsWith("run:")) return readCommittedRows(runId.slice(4));
    return [];
  }

  async caseDetail(runId: string, config: string, caseId: string) {
    const row = (await this.rows(runId)).find((r) => r.config === config && r.caseId === caseId);
    const c = this.cases.get(caseId);
    if (!row || !c) return { notFound: `No result for ${caseId} with ${config} in this run.` };
    const profile = this.dataset.profiles.find((p) => p.id === c.profile)!;
    const variant = INSTRUCTION_VARIANTS.find((v) => v.id === row.instruction);
    const sha = runId.startsWith("run:") ? listCommittedRuns().find((r) => r.id === runId)?.sha : (await this.liveRuns()).find((l) => l.id === runId)?.ext?.ext.sha;
    const systemInstruction = variant?.text ?? (sha ? await this.defaultPromptFor(sha) : "(default prompt)");
    const rules = LABEL_VARIANTS.some((v) => v.id === row.labelVariant) ? rulesFor(profile, row.labelVariant as never) : [];
    return caseDetail(row, c, rules, systemInstruction);
  }
}

// ------------------------------------------------------------ playground

async function playgroundPresets(dash: Dashboard) {
  const loaded = await dash.ext();
  const api = loaded?.api;
  return {
    ext: loaded ? { ref: loaded.ext.ref, sha: loaded.ext.sha, subject: loaded.ext.subject } : null,
    models: MODELS.map((m) => ({ id: m.id, short: m.short })),
    settings: DEFAULT_SETTINGS,
    defaultPrompt: api?.defaultPrompt ?? null,
    kind: api?.kind ?? null,
    outputSchema: api?.outputSchema ?? null,
    replyPrefill: api?.replyPrefill ?? null,
    generationBudgetMs: api?.generationBudgetMs ?? null,
    framedExample: api?.frameReviewChunk?.("<the user's prompt>") ?? null,
    labelVariants: LABEL_VARIANTS,
    profiles: dash.dataset.profiles.map((p) => ({
      id: p.id,
      name: p.name,
      rules: Object.fromEntries(
        LABEL_VARIANTS.map((v) => [v.id, p.labels.map((l) => ({ label: l.label, prompt: composeLabelDescription(l, v.id), examples: l.examples.slice(0, 3) }))]),
      ),
    })),
    // Dev-split cases only: the test split stays held out.
    examples: selectCases(dash.dataset, "quick", "dev", 2).map((c) => ({ id: c.id, profile: c.profile, lang: c.lang, type: c.type, text: c.text, expected: c.expected })),
  };
}

const readBody = (req: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve, reject) => {
    let body = "";
    req.on("data", (chunk: Buffer) => {
      body += chunk.toString();
      if (body.length > 2_000_000) reject(new Error("request too large"));
    });
    req.on("end", () => {
      try {
        resolve(body ? (JSON.parse(body) as Record<string, unknown>) : {});
      } catch {
        reject(new Error("invalid JSON body"));
      }
    });
    req.on("error", reject);
  });

async function handlePlayground(dash: Dashboard, path: string, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const host = dash.playground;
  if (path === "/api/playground/status") return send(res, 200, host.getStatus());
  if (path === "/api/playground/presets") return send(res, 200, await playgroundPresets(dash));
  if (req.method !== "POST") return send(res, 405, { error: "POST required" });
  const body = await readBody(req);
  try {
    switch (path) {
      case "/api/playground/load": {
        const model = MODELS.find((m) => m.id === body.model || m.short === body.model);
        if (!model) return send(res, 400, { error: "unknown model" });
        const loaded = await dash.ext();
        if (!loaded) return send(res, 400, { error: "extension clone not configured (needed for the review preset and engine)" });
        return send(res, 200, await host.load(model.id, loaded.ext.bundle));
      }
      case "/api/playground/unload":
        await host.unload();
        return send(res, 200, host.getStatus());
      case "/api/playground/chat":
        return send(res, 200, await host.request("chat", { messages: body.messages, prefill: body.prefill, settings: body.settings }));
      case "/api/playground/review":
        return send(res, 200, await host.request("review", { request: body }));
      default:
        return send(res, 404, { error: "not found" });
    }
  } catch (error) {
    return send(res, error instanceof BusyError ? 409 : 400, { error: (error as Error).message });
  }
}

// ------------------------------------------------------------ HTTP

/** Bundled models (models/models.json) and hosted ones (src/hosted/bedrock.ts), for language support next to results. */
const MODEL_META = [
  ...(JSON.parse(readFileSync(MODELS_FILE, "utf8")) as { models: unknown[] }).models,
  ...HOSTED_MODELS.map((h) => ({ id: h.id, short: h.short, hosted: true, languages: h.languages })),
];

const parseFilters = (params: URLSearchParams): Filters => {
  const filters: Filters = {};
  for (const dim of Object.keys(RESULT_DIMENSIONS)) {
    const value = params.get(`f.${dim}`);
    if (value) filters[dim] = value.split(",");
  }
  return filters;
};

/** Lab runs (npm run lab) are small JSON files under experiments/runs/. */
const LAB_RUNS_DIR = join(ROOT, "experiments", "runs");
const labRuns = () =>
  existsSync(LAB_RUNS_DIR)
    ? readdirSync(LAB_RUNS_DIR)
        .filter((f) => f.endsWith(".json"))
        .map((f) => {
          const run = JSON.parse(readFileSync(join(LAB_RUNS_DIR, f), "utf8")) as { name: string; at: string; set: unknown; summary: unknown[]; inProgress?: string };
          return { name: run.name, at: run.at, set: run.set, summary: run.summary, ...(run.inProgress ? { inProgress: run.inProgress } : {}) };
        })
        .sort((a, b) => a.at.localeCompare(b.at))
    : [];
const labRun = (name: string) => {
  if (!/^[\w.-]+$/.test(name)) throw new Error("bad run name");
  return JSON.parse(readFileSync(join(LAB_RUNS_DIR, `${name}.json`), "utf8")) as unknown;
};

const send = (res: ServerResponse, status: number, body: unknown, type = "application/json") => {
  res.writeHead(status, { "content-type": `${type}; charset=utf-8`, "cache-control": "no-store" });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};

export async function handle(dash: Dashboard, req: IncomingMessage, res: ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://localhost");
  const p = url.searchParams;
  try {
    if (url.pathname.startsWith("/api/playground/")) return await handlePlayground(dash, url.pathname, req, res);
    switch (url.pathname) {
      case "/":
        return send(res, 200, PAGE_HTML, "text/html");
      case "/api/overview": {
        const loaded = await dash.ext();
        return send(res, 200, {
          ext: loaded ? { ref: loaded.ext.ref, sha: loaded.ext.sha, subject: loaded.ext.subject } : null,
          dataset: { hash: dash.dataset.hash, cases: dash.dataset.cases.length, profiles: dash.dataset.profiles.map((pr) => ({ id: pr.id, name: pr.name, labels: pr.labels.map((l) => l.label) })) },
          models: MODEL_META,
          instructions: INSTRUCTION_VARIANTS,
          labelVariants: LABEL_VARIANTS,
          dimensions: Object.keys(RESULT_DIMENSIONS),
          compareMetrics: COMPARE_METRICS.map((m) => m.name),
        });
      }
      case "/api/progress":
        return send(res, 200, { runs: await dash.progress() });
      case "/api/matrix":
        return send(res, 200, await dash.matrix());
      case "/api/runs":
        return send(res, 200, { runs: await dash.runs() });
      case "/api/results": {
        const all = await dash.rows(p.get("run") ?? "");
        const rows = filterRows(all, parseFilters(p));
        const dims = (p.get("groupBy") ?? "model").split(",").filter(Boolean).slice(0, 2);
        return send(res, 200, { total: all.length, filtered: rows.length, options: filterOptions(all), dims, groups: groupMetrics(rows, dims) });
      }
      case "/api/cases": {
        const rows = filterRows(await dash.rows(p.get("run") ?? ""), parseFilters(p));
        return send(res, 200, listCases(rows, p.get("verdict") ?? undefined, Number(p.get("limit") ?? 200)));
      }
      case "/api/case":
        return send(res, 200, await dash.caseDetail(p.get("run") ?? "", p.get("config") ?? "", p.get("case") ?? ""));
      case "/api/lab/runs":
        return send(res, 200, { runs: labRuns() });
      case "/api/lab/run":
        return send(res, 200, labRun(p.get("name") ?? ""));
      case "/api/compare": {
        const [a, b] = await Promise.all([dash.rows(p.get("a") ?? ""), dash.rows(p.get("b") ?? "")]);
        return send(res, 200, compareRows(a, b));
      }
      default:
        return send(res, 404, { error: "not found" });
    }
  } catch (error) {
    return send(res, 500, { error: (error as Error).message });
  }
}

export function startServer(dash: Dashboard, port: number, host = "127.0.0.1") {
  const server = createServer((req, res) => void handle(dash, req, res));
  return new Promise<typeof server>((resolve) => server.listen(port, host, () => resolve(server)));
}
