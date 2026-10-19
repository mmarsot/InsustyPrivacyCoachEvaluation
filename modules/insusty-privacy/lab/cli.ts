/**
 * Prompt-engineering lab: runs named configurations (modules/insusty-privacy/lab/configs.ts) on a
 * small fixed case set, one model process at a time, and prints a compact
 * comparison. Built for fast iteration; the bench (`npm run bench`) stays the
 * reference for what the extension ships.
 *
 *   npm run lab -- --configs ref,rp1 [--models smollm2-360m]
 *                  [--set iter32 | --cases id,id] [--dtype q8] [--name label]
 *                  [--show-prompt] [--dry-run] [--max-rss-mb 3500] [--min-free-mb 1500]
 *
 * Requests are rendered here with the model's tokenizer only (no weights), and
 * cached by a hash of (model, dtype, rendered prompt, generation settings), so
 * two configurations that render the same prompt share results. Findings come
 * from the ref's own `validateModelOutput` (parsing + anchoring), and a
 * generation that hits the deadline yields no findings, as in the extension.
 * Summaries go to experiments/runs/<name>.json.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AutoTokenizer, env } from "@huggingface/transformers";
import { compileDataset } from "../../../datasets/insusty-custom/load.ts";
import type {
  CompiledCase,
  Profile,
} from "../../../datasets/insusty-custom/schema.ts";
import {
  loadExtApi,
  materializeExtRef,
  resolveExtRefName,
  resolveExtRepo,
} from "../ref.ts";
import {
  CACHE_DIR,
  EXPERIMENTS_DIR,
  LAB_CACHE_DIR,
  MODEL_CACHE_DIR,
  ROOT,
} from "../../../engine/paths.ts";
import type { ResultRecord } from "../../../engine/jobs.ts";
import {
  metrics,
  type Metrics,
} from "../../../engine/scorers/custom-passages/aggregate.ts";
import {
  scoreResult,
  type Scored,
} from "../../../engine/scorers/custom-passages/score.ts";
import {
  answerConfidence,
  buildMessages,
  buildRaw,
  configCategories,
  filterLines,
  plausibleLines,
  withExtraStopWords,
  maskPassages,
  isRequestLike,
  shapeSimilarity,
  jsonToLines,
  passagesToLines,
  relaxLines,
  CONTENT_MARKER,
  type LabConfig,
  type RefTexts,
} from "./config.ts";
import { LAB_CONFIGS } from "./configs.ts";
import { findLabModel, type LabModel } from "./models.ts";
import { labelPatterns, patternFindings } from "./patterns.ts";
import {
  readMemAvailableMb,
  runGuardedWorker,
  waitForMemory,
} from "../../../engine/memory.ts";
import { segmentText, type Segment } from "./segments.ts";
import type {
  LabEvent,
  LabGroup,
  LabJob,
  LabRecord,
  LabWorkerSpec,
} from "./worker.ts";

env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = false;

const LAB_DIR = LAB_CACHE_DIR;
const EXP_DIR = EXPERIMENTS_DIR;

// ------------------------------------------------------------------ args
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);
const list = (value: string | undefined) =>
  (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

const configIds = list(opt("configs") ?? "ref");
const configs = configIds.map(
  (id) =>
    LAB_CONFIGS[id] ??
    fail(`unknown config ${id}; known: ${Object.keys(LAB_CONFIGS).join(", ")}`),
);
const models = list(opt("models") ?? "smollm2-360m").map(
  (m) => findLabModel(m) ?? fail(`unknown model ${m}`),
);
const dtypeOverride = opt("dtype");
const maxRssMb = Number(opt("max-rss-mb") ?? 3500);
const minFreeMb = Number(opt("min-free-mb") ?? 1500);

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

// ------------------------------------------------------------------ data
const { dataset } = compileDataset({ requireSplit: true });
if (!dataset) fail("dataset is invalid: run `npm run validate`");
const setName = opt("set") ?? (opt("cases") ? undefined : "iter32");
const caseIds = setName
  ? (
      JSON.parse(
        readFileSync(join(EXP_DIR, "sets", `${setName}.json`), "utf8"),
      ) as { cases: string[] }
    ).cases
  : list(opt("cases"));
const cases = caseIds.map(
  (id) => dataset.cases.find((c) => c.id === id) ?? fail(`unknown case ${id}`),
);
if (cases.some((c) => c.split === "test") && !flag("allow-test"))
  fail("the lab never runs held-out test cases (use the dev split)");
const profiles = new Map(dataset.profiles.map((p) => [p.id, p]));

const ext = await materializeExtRef(
  resolveExtRepo(opt("ext-repo")),
  resolveExtRefName(opt("ref")),
);
const api = await loadExtApi(ext.bundle);
const refModule = (await import(new URL(`file://${ext.bundle}`).href)) as {
  review: Record<string, unknown>;
};
const validateModelOutput = refModule.review.validateModelOutput as (
  raw: unknown,
  chunk: { text: string; offset: number },
  offset: number,
  categories: readonly string[],
) => Array<{ category: string; start: number; end: number; value?: string }>;
const descriptions = refModule.review
  .DETERMINISTIC_LABEL_DESCRIPTIONS as Record<string, string>;
/** The shipped plausibility filter (configs with `plausibilityFilter`), when the ref has one. */
const refPlausible = refModule.review.isPlausiblePassage as
  ((passage: string) => boolean) | undefined;
const refTexts: RefTexts = {
  defaultPrompt: api.defaultPrompt,
  outputSchema: String(refModule.review.SLM_OUTPUT_SCHEMA),
  labelHeader: String(refModule.review.SLM_LABEL_LIST_HEADER),
  builtin: api
    .reviewCategories([])
    .map((label) => ({ label, description: descriptions[label] ?? "" })),
};
const builtinLabels = refTexts.builtin.map((b) => b.label);

// ------------------------------------------------------------------ render
interface Planned {
  model: LabModel;
  dtype: string;
  config: LabConfig;
  c: CompiledCase;
  profile: Profile;
  prefix: string;
  suffix: string;
  key: string;
  gen: LabJob["gen"];
  instructions: string;
  /** Per-label pass: the only custom label of this request. */
  part?: string;
  /** Profile as seen by this request (one label for a per-label pass). */
  scope: Profile;
  /** Iteration round of a per-label pass (1 = first ask). */
  round?: number;
  /** Raw configurations: the answer cue that ends `suffix` (the request's assistant prefill). */
  cue?: string;
}

const isPending = (p: Planned, cache: Map<string, LabRecord>) =>
  !cache.has(p.key);

const slug = (s: string) =>
  s.replace(/^.*\//, "").replace(/[^A-Za-z0-9.-]+/g, "_");
const noPrefixCache = flag("no-prefix-cache");
/** Rescore with relaxed anchoring (modules/insusty-privacy/lab/config.ts relaxLines); summaries get a "+relax" suffix. */
const relaxedAnchor = opt("anchor") === "relaxed";
/**
 * Scoring-time post-processing (no recompute): `basic` = filterLines,
 * `dedup` = drop a passage claimed by two or more labels, `basic,dedup` = both.
 * Summaries get a "+<filter>" suffix.
 */
const postFilters = list(opt("filter"));
const filterSuffix = postFilters.length ? `+${postFilters.join("+")}` : "";
const skipPrefix = (_model: LabModel) => noPrefixCache;
/** `--backend webgpu`: score results produced in Chrome by modules/insusty-privacy/lab/browser/ (separate cache file). */
const backend = opt("backend") ?? "wasm";
const cacheFileFor = (model: LabModel, dtype: string) =>
  join(
    LAB_DIR,
    `${slug(model.id)}-${dtype}${skipPrefix(model) ? "-nopkv" : ""}${backend === "wasm" ? "" : `-${backend}`}.jsonl`,
  );
const loadLabCache = (file: string) => {
  const map = new Map<string, LabRecord>();
  if (existsSync(file))
    for (const line of readFileSync(file, "utf8").split("\n"))
      if (line.trim()) {
        const r = JSON.parse(line) as LabRecord;
        map.set(r.key, r);
      }
  return map;
};

/**
 * Renders every request of every (configuration, case) pair, per label for
 * per-label configurations, with the model's tokenizer. A request's key hashes
 * the model, dtype, rendered prompt and generation settings, so identical
 * requests run once across configurations.
 */
async function plan(
  model: LabModel,
  cache: Map<string, LabRecord> = new Map(),
): Promise<Planned[]> {
  const tokenizer = await AutoTokenizer.from_pretrained(model.id);
  const dtype = dtypeOverride ?? model.dtype;
  const out: Planned[] = [];
  for (const config of configs) {
    for (const c of cases) {
      const profile = profiles.get(c.profile)!;
      const parts: Array<{ part?: string; scope: Profile }> = config.perLabel
        ? profile.labels.map((l) => ({
            part: l.label,
            scope: { ...profile, labels: [l] },
          }))
        : [{ scope: profile }];
      for (const { part, scope } of parts) {
        const cfg = config.perLabel
          ? { ...config, builtinLabels: false }
          : config;
        let prefix: string;
        let suffix: string;
        let instructions: string;
        let cue: string | undefined;
        if (cfg.raw) {
          const raw = buildRaw(cfg, scope, refTexts, c.text);
          ({ prefix, instructions } = raw);
          suffix = raw.suffix(c.text);
          cue = raw.prefill;
        } else {
          const built = buildMessages(cfg, scope, refTexts, c.text);
          const rendered = String(
            tokenizer.apply_chat_template(
              built.messages as never,
              {
                tokenize: false,
                add_generation_prompt: true,
                ...config.templateKwargs,
              } as never,
            ),
          );
          const at = rendered.indexOf(CONTENT_MARKER);
          if (at < 0 || rendered.indexOf(CONTENT_MARKER, at + 1) >= 0)
            fail(
              `${model.short}/${config.id}: template did not place the content once`,
            );
          const tail = rendered.slice(at + CONTENT_MARKER.length);
          suffix = `${built.userContent(c.text)}${tail}${built.prefill}`;
          prefix = rendered.slice(0, at);
          instructions = built.instructions;
        }
        const gen = {
          maxNewTokens: config.maxNewTokens,
          deadlineMs: config.deadlineMs,
          repetitionPenalty: config.repetitionPenalty,
          noRepeatNgram: config.noRepeatNgram,
          lineStop: config.output === "lines" && !config.stopAtNewline,
          ...(config.stopAtNewline ? { stopAtNewline: true } : {}),
          ...(config.noneGate !== null ? { scoreNone: true } : {}),
          ...(config.minNewTokens ? { minNewTokens: config.minNewTokens } : {}),
          ...(config.answerRepetitionPenalty
            ? { answerRepetitionPenalty: config.answerRepetitionPenalty }
            : {}),
          ...(config.recordConfidence ? { scoreConfidence: true } : {}),
        };
        // Keys omit defaults added after the first runs, so cached results stay valid.
        const makeKey = (sfx: string) => {
          const { lineStop, ...keyGen } = gen;
          return createHash("sha256")
            .update(
              JSON.stringify({
                model: model.id,
                dtype,
                prefix,
                suffix: sfx,
                gen: lineStop ? keyGen : gen,
              }),
            )
            .digest("hex")
            .slice(0, 32);
        };
        const key = makeKey(suffix);
        out.push({
          model,
          dtype,
          config: cfg,
          c,
          profile,
          prefix,
          suffix,
          key,
          gen,
          instructions,
          part,
          scope,
          round: 1,
          cue,
        });
        // Follow-up rounds: re-ask the label with the passages found so far masked.
        if (cfg.raw && part && cfg.iterations > 1) {
          let prevKey = key;
          let masked = c.text;
          const found: string[] = [];
          for (let round = 2; round <= cfg.iterations; round++) {
            const prev = cache.get(prevKey);
            if (!prev) break;
            const passages = filterLines(passagesToLines(prev.output, part))
              .split("\n")
              .map((l) => l.replace(/^[^:]*:\s*/u, "").trim())
              .filter(
                (x) =>
                  x &&
                  !/^NONE$/iu.test(x) &&
                  !found.some((f) => f.toLowerCase() === x.toLowerCase()),
              )
              .filter((x) => maskPassages(masked, [x]) !== masked);
            if (!passages.length) break;
            found.push(...passages);
            masked = maskPassages(masked, passages);
            const sfx = buildRaw(cfg, scope, refTexts, masked, c.text).suffix(
              masked,
            );
            prevKey = makeKey(sfx);
            out.push({
              model,
              dtype,
              config: cfg,
              c,
              profile,
              prefix,
              suffix: sfx,
              key: prevKey,
              gen,
              instructions,
              part,
              scope,
              round,
              cue,
            });
          }
        }
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ run
/** Called every ~30 s while a worker runs (main writes the partial run file). */
let progressHook: ((progress: string) => void) | undefined;

/**
 * Runs the pending requests in one worker process, grouped by prompt prefix so
 * each prefix is prefilled once, under the memory guards of `runtime.ts`.
 */
async function runWorker(
  model: LabModel,
  dtype: string,
  pending: Planned[],
): Promise<void> {
  const groups = new Map<string, LabGroup>();
  for (const p of pending) {
    const g = groups.get(p.prefix) ?? { prefix: p.prefix, jobs: [] };
    if (!g.jobs.some((j) => j.key === p.key))
      g.jobs.push({ key: p.key, caseId: p.c.id, suffix: p.suffix, gen: p.gen });
    groups.set(p.prefix, g);
  }
  const spec: LabWorkerSpec = {
    bundle: ext.bundle,
    model: model.id,
    dtype: dtype as LabWorkerSpec["dtype"],
    resultFile: cacheFileFor(model, dtype),
    groups: [...groups.values()],
    noPrefixCache: skipPrefix(model),
  };
  const specFile = join(
    CACHE_DIR,
    "tmp",
    `lab-${process.pid}-${model.short}.json`,
  );
  mkdirSync(join(CACHE_DIR, "tmp"), { recursive: true });
  mkdirSync(LAB_DIR, { recursive: true });
  writeFileSync(specFile, JSON.stringify(spec));
  const total = spec.groups.reduce((a, g) => a + g.jobs.length, 0);
  console.log(
    `[${model.short}] ${total} generations in ${spec.groups.length} prefix group(s); ${readMemAvailableMb()} MB available`,
  );
  const t0 = performance.now();
  let last = 0;
  let lastWrite = performance.now();
  const peak = await runGuardedWorker(
    "modules/insusty-privacy/lab/worker.ts",
    specFile,
    {},
    model.short,
    maxRssMb,
    (event, rss) => {
      const e = event as unknown as LabEvent;
      if (e.type === "loaded")
        console.log(
          `[${model.short}] loaded in ${(e.loadMs / 1000).toFixed(1)} s, ort-web ${e.ort}, context ${e.contextLength}, rss ${rss} MB`,
        );
      else if (e.type === "result") {
        const now = performance.now();
        if (now - last > 20_000 || e.done === e.total) {
          last = now;
          console.log(
            `[${model.short}] ${e.done}/${e.total} ${e.caseId} ${e.ms} ms ${e.tokens} tok ${e.finish} · ${Math.round((now - t0) / 1000)} s`,
          );
        }
        // Partial results for the dashboard's Lab view while the worker runs.
        if (now - lastWrite > 30_000 && e.done < e.total) {
          lastWrite = now;
          progressHook?.(`${model.short}: ${e.done}/${e.total} generations`);
        }
      } else if (e.type === "fatal")
        console.error(`[${model.short}] worker failed: ${e.error}`);
    },
  );
  console.log(
    `[${model.short}] worker done, peak RSS ${peak} MB, ${Math.round((performance.now() - t0) / 1000)} s`,
  );
}

// ------------------------------------------------------------------ score
interface Row extends Scored {
  output: string;
  seg: SegCase;
}

/** Segment view of one scored case. */
interface SegCase {
  segments: number;
  /** Segments that overlap an expected passage (any label). */
  positive: number;
  /** Segments overlapped by a finding. */
  flagged: number;
  flaggedPositive: number;
  /** Non-whitespace characters covered by findings, and those outside every expected passage. */
  redacted: number;
  redactedOutside: number;
  /** Model requests this review needed. */
  requests: number;
}

const overlaps = (
  a: { start: number; end: number },
  b: { start: number; end: number },
) => a.start < b.end && b.start < a.end;

/** Scores one case from its request(s): one, or one per label for per-label configurations. */
function score(
  parts: Planned[],
  cache: Map<string, LabRecord>,
  agree?: Set<string>,
): Row {
  const p = parts[0]!;
  const records = parts.map((part) => cache.get(part.key)!);
  const deadline = records.some((r) => r.finishReason === "deadline");
  const chunks: ResultRecord["chunks"] = [];
  const findings: ReturnType<typeof validateModelOutput> = [];
  parts.forEach((part, i) => {
    const r = records[i]!;
    const confFilter = postFilters.find((f) => /^(conf|cmin)\d/.test(f));
    const confOf = () => {
      // Tokens of the first answer line: stop at the first probability of a line break is not
      // known here, so use the tokens up to the generated count on the first line (<= all).
      const probs = (r.tokenProbs ?? []).slice(
        0,
        Math.max(1, r.generatedTokens - 1),
      );
      if (!probs.length) return 1;
      return confFilter!.startsWith("cmin")
        ? Math.min(...probs)
        : probs.reduce((a, b) => a + b, 0) / probs.length;
    };
    const lowConfidence =
      confFilter !== undefined &&
      r.tokenProbs !== undefined &&
      confOf() < Number(confFilter.replace(/^(conf|cmin)/, ""));
    // The shipped confidence filter (extension PR #32): an answer without recorded probabilities is kept.
    const minP = part.config.minAnswerProbability;
    const shippedConfidence =
      minP !== null && r.tokenProbs !== undefined
        ? answerConfidence(r.tokenProbs, r.generatedTokens)
        : undefined;
    const unconfident =
      minP !== null &&
      shippedConfidence !== undefined &&
      shippedConfidence < minP;
    const gated =
      lowConfidence ||
      unconfident ||
      (part.config.noneGate !== null && (r.pNone ?? 0) >= part.config.noneGate);
    const json = gated
      ? "NONE"
      : part.config.output === "json"
        ? jsonToLines(r.output)
        : r.output;
    const lines =
      part.part && part.config.passageOnly
        ? passagesToLines(json, part.part)
        : json;
    const relaxed = relaxedAnchor ? relaxLines(lines, p.c.text) : lines;
    const isPlausible =
      refPlausible &&
      withExtraStopWords(refPlausible, part.config.extraStopWords);
    const shipped = part.config.plausibilityFilter
      ? plausibleLines(relaxed, isPlausible)
      : relaxed;
    const basic = postFilters.includes("basic")
      ? filterLines(shipped)
      : shipped;
    const parsed = postFilters.includes("request")
      ? basic
          .split("\n")
          .filter((l) => !isRequestLike(l.replace(/^[^:]*:\s*/u, "")))
          .join("\n") || "NONE"
      : basic;
    const categories = configCategories(part.config, part.scope, refTexts);
    if (!deadline)
      findings.push(
        ...validateModelOutput(
          parsed,
          { text: p.c.text, offset: 0 },
          0,
          categories,
        ),
      );
    chunks.push({
      output: parsed,
      ms: r.ms,
      runtime: {
        backend: "wasm",
        quantization: p.dtype,
        promptTokens: r.promptTokens,
        generatedTokens: r.generatedTokens,
        finishReason: r.finishReason,
      },
    });
  });
  if (agree)
    findings.splice(
      0,
      findings.length,
      ...findings.filter((f) =>
        agree.has(`${f.category}\u0000${(f.value ?? "").toLowerCase()}`),
      ),
    );
  // Example-derived patterns (modules/insusty-privacy/lab/patterns.ts): `patterns` (or a config's
  // `examplePatterns`) adds their matches to the model's findings, `patonly` keeps only them.
  if (
    p.config.examplePatterns ||
    postFilters.includes("patterns") ||
    postFilters.includes("patonly")
  ) {
    const matches = deadline
      ? []
      : patternFindings(
          p.c.text,
          labelPatterns(p.profile.labels, {
            figures: postFilters.includes("figs"),
          }),
        );
    if (postFilters.includes("patonly")) findings.splice(0, findings.length);
    for (const m of matches)
      if (
        !findings.some(
          (f) =>
            f.category === m.category && f.start === m.start && f.end === m.end,
        )
      )
        findings.push(m);
  }
  if (postFilters.includes("shape")) {
    // A passage claimed by several labels keeps only the label whose examples
    // it resembles most; a tie drops it.
    const byValue = new Map<string, typeof findings>();
    for (const f of findings) {
      const k = (f.value ?? "").toLocaleLowerCase();
      byValue.set(k, [...(byValue.get(k) ?? []), f]);
    }
    const keep = new Set<(typeof findings)[number]>();
    for (const [value, group] of byValue) {
      const labels = [...new Set(group.map((f) => f.category))];
      if (labels.length < 2) {
        group.forEach((f) => keep.add(f));
        continue;
      }
      const scored = labels
        .map((label) => ({
          label,
          s: shapeSimilarity(
            value,
            p.profile.labels.find((l) => l.label === label)?.examples ?? [],
          ),
        }))
        .sort((a, b) => b.s - a.s);
      if (scored[0]!.s > scored[1]!.s)
        group
          .filter((f) => f.category === scored[0]!.label)
          .forEach((f) => keep.add(f));
    }
    findings.splice(0, findings.length, ...findings.filter((f) => keep.has(f)));
  }
  if (postFilters.includes("dedup")) {
    const labelsByValue = new Map<string, Set<string>>();
    for (const f of findings) {
      const k = (f.value ?? "").toLocaleLowerCase();
      labelsByValue.set(k, (labelsByValue.get(k) ?? new Set()).add(f.category));
    }
    findings.splice(
      0,
      findings.length,
      ...findings.filter(
        (f) =>
          (labelsByValue.get((f.value ?? "").toLocaleLowerCase())?.size ?? 0) <
          2,
      ),
    );
  }
  const reviewMs = records.reduce((a, r) => a + r.ms, 0);
  const record: ResultRecord = {
    key: p.key,
    extSha: ext.sha,
    model: p.model.id,
    instruction: p.config.id,
    labelVariant: p.config.labelVariant,
    caseId: p.c.id,
    findings: findings.map(({ category, start, end, value }) => ({
      category,
      start,
      end,
      value,
    })),
    chunks,
    ...(deadline ? { error: "deadline", errorKind: "deadline" as const } : {}),
    reviewMs,
    at: records[0]?.at ?? "",
  };
  const output =
    parts.length > 1
      ? records.map((r, i) => `[${parts[i]!.part}] ${r.output}`).join("\n")
      : (records[0]?.output ?? "");
  // Segment view: which segments the findings touch, and how much text they cover outside expected passages.
  const custom = new Set(p.profile.labels.map((l) => l.label));
  const customFindings = findings.filter((f) => custom.has(f.category));
  const segments = segmentText(p.c.text);
  const expectedAt = new Uint8Array(p.c.text.length);
  for (const s of p.c.spans) expectedAt.fill(1, s.start, s.end);
  const redactedAt = new Uint8Array(p.c.text.length);
  for (const f of customFindings) redactedAt.fill(1, f.start, f.end);
  let redacted = 0;
  let redactedOutside = 0;
  for (let i = 0; i < p.c.text.length; i++)
    if (redactedAt[i] && /\S/u.test(p.c.text[i]!)) {
      redacted++;
      if (!expectedAt[i]) redactedOutside++;
    }
  const isPositive = (s: Segment) => p.c.spans.some((sp) => overlaps(sp, s));
  const isFlagged = (s: Segment) => customFindings.some((f) => overlaps(f, s));
  const seg: SegCase = {
    segments: segments.length,
    positive: segments.filter(isPositive).length,
    flagged: segments.filter(isFlagged).length,
    flaggedPositive: segments.filter((s) => isFlagged(s) && isPositive(s))
      .length,
    redacted,
    redactedOutside,
    requests: records.length,
  };
  const instructions = parts.map((x) => x.instructions).join("\n");
  return {
    ...scoreResult(p.c, p.profile, record, builtinLabels, instructions),
    output,
    seg,
  };
}

/** Aggregate segment view of scored cases. */
function segMetrics(rows: Row[]) {
  const sum = (k: keyof SegCase) => rows.reduce((a, r) => a + r.seg[k], 0);
  const ratio = (n: number, d: number) => (d ? n / d : null);
  return {
    segments: sum("segments"),
    segPrecision: ratio(sum("flaggedPositive"), sum("flagged")),
    segRecall: ratio(sum("flaggedPositive"), sum("positive")),
    overRedaction: ratio(sum("redactedOutside"), sum("redacted")),
    redactedChars: sum("redacted"),
    requestsPerPrompt: ratio(sum("requests"), rows.length),
  };
}
type SegSummary = ReturnType<typeof segMetrics>;

const pct = (v: number | null) =>
  v === null ? "  - " : `${Math.round(v * 100)}`.padStart(4);
function line(m: Metrics) {
  const f = m.failures;
  const fails = Object.entries(f)
    .filter(([k, v]) => k !== "ok" && v)
    .map(
      ([k, v]) =>
        `${k.replace("echo_instructions", "echoI").replace("hallucinated", "halluc").replace("unknown_label", "unkL")}${v}`,
    )
    .join(" ");
  return `${pct(m.overlap.f1)} ${pct(m.overlap.precision)} ${pct(m.overlap.recall)} ${pct(m.exact.f1)} ${pct(m.caseDetection)} ${pct(m.falsePositiveRate)} ${pct(m.compliance)} ${String(Math.round((m.latencyP50 ?? 0) / 100) / 10).padStart(5)} ${String(Math.round(m.meanGeneratedTokens ?? 0)).padStart(4)}  ${fails}`;
}

// ------------------------------------------------------------------ main
type Summary = {
  model: string;
  dtype: string;
  config: string;
  note?: string;
  overall: Metrics;
  en: Metrics;
  fr: Metrics;
  seg: SegSummary;
};
const planned: Planned[][] = [];
const runName =
  opt("name") ??
  `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
for (const model of models)
  planned.push(
    await plan(
      model,
      loadLabCache(cacheFileFor(model, dtypeOverride ?? model.dtype)),
    ),
  );

if (opt("export-jobs")) {
  // Requests for the browser bench (modules/insusty-privacy/lab/browser/): same keys as the lab cache.
  const jobs = planned.flat().map((p) => ({
    key: p.key,
    caseId: p.c.id,
    prompt: p.prefix + p.suffix,
    gen: p.gen,
  }));
  writeFileSync(
    opt("export-jobs")!,
    JSON.stringify({
      model: models[0]!.id,
      dtype: dtypeOverride ?? models[0]!.dtype,
      jobs,
    }),
  );
  console.log(`exported ${jobs.length} requests to ${opt("export-jobs")}`);
  process.exit(0);
}
if (flag("show-prompt")) {
  for (const ps of planned)
    for (const cfg of configs) {
      const p = ps.find((x) => x.config.id === cfg.id)!;
      console.log(
        `\n===== ${p.model.short} / ${cfg.id} / ${p.c.id} =====\n${p.prefix}\x1b[33m${p.suffix}\x1b[0m`,
      );
    }
}
if (!flag("dry-run"))
  progressHook = (progress) => {
    try {
      const partial = scoreAll();
      if (partial.summary.length)
        writeRun(partial.summary, partial.allRows, progress);
    } catch (error) {
      console.error(
        `partial run file not written: ${(error as Error).message}`,
      );
    }
  };
for (let m = 0; m < planned.length; m++) {
  // Iterative configs add rounds once the previous round is cached: re-plan
  // after each worker run until nothing is pending (at most maxRounds runs).
  const maxRounds = Math.max(...configs.map((c) => c.iterations));
  for (let pass = 0; pass < maxRounds; pass++) {
    const ps = planned[m]!;
    const model = ps[0]!.model;
    const dtype = ps[0]!.dtype;
    const cache = loadLabCache(cacheFileFor(model, dtype));
    const pending = ps.filter((p) => isPending(p, cache));
    const unique = new Set(pending.map((p) => p.key)).size;
    console.log(
      `[${model.short} ${dtype}] ${ps.length} jobs, ${unique} to compute (~${Math.round((unique * model.secondsPerCase) / 60)} min)`,
    );
    if (flag("dry-run") || !unique) break;
    if (!(await waitForMemory(model, minFreeMb))) break;
    await runWorker(model, dtype, pending);
    planned[m] = await plan(model, loadLabCache(cacheFileFor(model, dtype)));
  }
}

/** Scores every case whose requests are all cached (complete or partial runs). */
function scoreAll() {
  const allRows: Row[] = [];
  const summary: Summary[] = [];
  for (const ps of planned) {
    const model = ps[0]!.model;
    const dtype = ps[0]!.dtype;
    const cache = loadLabCache(cacheFileFor(model, dtype));
    for (const cfg of configs) {
      const casesOf = (id: string) => {
        const byCase = new Map<string, Planned[]>();
        for (const p of ps)
          if (p.config.id === id)
            byCase.set(p.c.id, [...(byCase.get(p.c.id) ?? []), p]);
        return byCase;
      };
      const byCase = casesOf(cfg.id);
      let agreeing: Map<string, Set<string>> | undefined;
      if (cfg.agreeWith) {
        // Findings of the partner configuration, per case, as label + value.
        agreeing = new Map();
        for (const [caseId, parts] of casesOf(cfg.agreeWith))
          if (parts.every((p) => !isPending(p, cache)))
            agreeing.set(
              caseId,
              new Set(
                score(parts, cache).predicted.map(
                  (x) => `${x.label}\u0000${x.value.toLowerCase()}`,
                ),
              ),
            );
      }
      const rows = [...byCase.values()]
        .filter(
          (parts) =>
            parts.every((p) => !isPending(p, cache)) &&
            (!agreeing || agreeing.has(parts[0]!.c.id)),
        )
        .map((parts) => score(parts, cache, agreeing?.get(parts[0]!.c.id)));
      allRows.push(...rows);
      if (!rows.length) continue;
      summary.push({
        model: model.short,
        dtype,
        config: `${cfg.id}${relaxedAnchor ? "+relax" : ""}${filterSuffix}`,
        note: cfg.note,
        overall: metrics(rows),
        en: metrics(rows.filter((r) => r.lang === "en")),
        fr: metrics(rows.filter((r) => r.lang === "fr")),
        seg: segMetrics(rows),
      });
    }
  }
  return { allRows, summary };
}
const { allRows, summary } = scoreAll();

console.log(
  `\nset ${setName ?? "custom"} (${cases.length} cases), ref ${ext.ref}@${ext.sha.slice(0, 7)}`,
);
for (const row of summary)
  if (row.overall.cases < cases.length)
    console.log(
      `INCOMPLETE: ${row.model}/${row.config} has ${row.overall.cases} of ${cases.length} cases (missing generations; rerun to complete)`,
    );
console.log(
  `${"model/config".padEnd(34)}  F1o    P    R  F1x  det  FPR comp  p50s  tok  failures`,
);
for (const s of summary) {
  console.log(`${`${s.model}/${s.config}`.padEnd(34)} ${line(s.overall)}`);
  if (flag("by-lang")) {
    console.log(`${"   en".padEnd(34)} ${line(s.en)}`);
    console.log(`${"   fr".padEnd(34)} ${line(s.fr)}`);
  }
}
// Segment view (every configuration): segment precision/recall against "segment holds an expected
// passage", over-redaction (share of redacted characters outside expected passages), requests and
// latency per prompt.
console.log(
  `\n${"segment view".padEnd(34)} segP segR over  req/p   p50s   p95s`,
);
for (const s of summary) {
  const g = s.seg;
  const sec = (ms: number | null) =>
    String(Math.round((ms ?? 0) / 100) / 10).padStart(6);
  console.log(
    `${`${s.model}/${s.config}`.padEnd(34)} ${pct(g.segPrecision)} ${pct(g.segRecall)} ${pct(g.overRedaction)} ${(g.requestsPerPrompt ?? 0).toFixed(1).padStart(5)} ${sec(s.overall.latencyP50)} ${sec(s.overall.latencyP95)}`,
  );
}
if (flag("cases")) {
  for (const r of allRows) {
    const exp = r.expected
      .map((e) => `${e.overlap ? "+" : "-"}${e.label}:${e.passage}`)
      .join(" | ");
    const pred = r.predicted
      .map((p) => `${p.overlap ? "✓" : "✗"}${p.label}:${p.value}`)
      .join(" | ");
    console.log(
      `${r.model.replace(/^.*\//, "").slice(0, 14)} ${r.config.split(" | ")[1]} ${r.caseId.padEnd(18)} ${r.failure.padEnd(10)} exp[${exp}] pred[${pred}] raw=${JSON.stringify(r.output.slice(0, 160))}`,
    );
  }
}

if (!flag("dry-run") && summary.length)
  console.log(`\nwrote ${writeRun(summary, allRows).replace(ROOT, "")}`);

/** Writes experiments/runs/<name>.json; `inProgress` marks a partial file written while a worker runs. */
function writeRun(
  summary: Summary[],
  allRows: Row[],
  inProgress?: string,
): string {
  const name = runName;
  mkdirSync(join(EXP_DIR, "runs"), { recursive: true });
  const file = join(EXP_DIR, "runs", `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        name,
        set: setName ?? caseIds,
        ext: { ref: ext.ref, sha: ext.sha },
        at: new Date().toISOString(),
        ...(inProgress ? { inProgress } : {}),
        summary: summary.map((s) => ({
          model: s.model,
          dtype: s.dtype,
          config: s.config,
          note: s.note,
          ...(s.overall.cases < cases.length
            ? { incomplete: `${s.overall.cases}/${cases.length} cases` }
            : {}),
          overall: compact(s.overall),
          en: compact(s.en),
          fr: compact(s.fr),
          seg: Object.fromEntries(
            Object.entries(s.seg).map(([k, v]) => [
              k,
              v === null ? null : Math.round(v * 1000) / 1000,
            ]),
          ),
        })),
        cases: allRows.map((r) => ({
          model: findLabModel(r.model)?.short ?? r.model,
          config: `${r.config.split(" | ")[1]}${relaxedAnchor ? "+relax" : ""}${filterSuffix}`,
          caseId: r.caseId,
          failure: r.failure,
          found: r.expected.filter((e) => e.overlap).length,
          expected: r.expected.length,
          predicted: r.predicted.map(
            (p) => `${p.overlap ? "+" : "-"}${p.label}: ${p.value}`,
          ),
          ms: r.reviewMs,
          output: r.output.slice(0, 600),
        })),
      },
      null,
      1,
    ) + "\n",
  );
  return file;
}

function compact(m: Metrics) {
  const r = (v: number | null) =>
    v === null ? null : Math.round(v * 1000) / 1000;
  return {
    cases: m.cases,
    f1: r(m.overlap.f1),
    precision: r(m.overlap.precision),
    recall: r(m.overlap.recall),
    exactF1: r(m.exact.f1),
    exactPrecision: r(m.exact.precision),
    exactRecall: r(m.exact.recall),
    detection: r(m.caseDetection),
    fpr: r(m.falsePositiveRate),
    compliance: r(m.compliance),
    p50ms: m.latencyP50,
    p95ms: m.latencyP95,
    tokens:
      m.meanGeneratedTokens === null ? null : Math.round(m.meanGeneratedTokens),
    failures: Object.fromEntries(
      Object.entries(m.failures).filter(([, v]) => v),
    ),
  };
}
