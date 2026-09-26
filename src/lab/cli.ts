/**
 * Prompt-engineering lab: runs named configurations (src/lab/configs.ts) on a
 * small fixed case set, one model process at a time, and prints a compact
 * comparison. Built for fast iteration; the bench (`npm run bench`) stays the
 * reference for what the extension ships.
 *
 *   npm run lab -- --configs ref,rp1 [--models smollm2-360m,qwen2.5-0.5b]
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
import { compileDataset } from "../dataset/load.ts";
import type { CompiledCase, Profile } from "../dataset/schema.ts";
import { loadExtApi, materializeExtRef, resolveExtRefName, resolveExtRepo } from "../ext/ref.ts";
import { CACHE_DIR, MODEL_CACHE_DIR, ROOT } from "../paths.ts";
import type { ResultRecord } from "../run/jobs.ts";
import { metrics, type Metrics } from "../score/aggregate.ts";
import { scoreResult, type Scored } from "../score/score.ts";
import { buildMessages, buildRaw, configCategories, filterLines, jsonToLines, passagesToLines, relaxLines, CONTENT_MARKER, type LabConfig, type RefTexts } from "./config.ts";
import { LAB_CONFIGS } from "./configs.ts";
import { findLabModel, type LabModel } from "./models.ts";
import { readMemAvailableMb, runGuardedWorker, waitForMemory } from "./runtime.ts";
import type { LabEvent, LabGroup, LabJob, LabRecord, LabWorkerSpec } from "./worker.ts";

env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = false;

const LAB_DIR = join(CACHE_DIR, "lab");
const EXP_DIR = join(ROOT, "experiments");

// ------------------------------------------------------------------ args
const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);
const list = (value: string | undefined) => (value ?? "").split(",").map((s) => s.trim()).filter(Boolean);

const configIds = list(opt("configs") ?? "ref");
const configs = configIds.map((id) => LAB_CONFIGS[id] ?? fail(`unknown config ${id}; known: ${Object.keys(LAB_CONFIGS).join(", ")}`));
const models = list(opt("models") ?? "smollm2-360m").map((m) => findLabModel(m) ?? fail(`unknown model ${m}`));
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
const caseIds = setName ? (JSON.parse(readFileSync(join(EXP_DIR, "sets", `${setName}.json`), "utf8")) as { cases: string[] }).cases : list(opt("cases"));
const cases = caseIds.map((id) => dataset.cases.find((c) => c.id === id) ?? fail(`unknown case ${id}`));
if (cases.some((c) => c.split === "test") && !flag("allow-test")) fail("the lab never runs held-out test cases (use the dev split)");
const profiles = new Map(dataset.profiles.map((p) => [p.id, p]));

const ext = await materializeExtRef(resolveExtRepo(opt("ext-repo")), resolveExtRefName(opt("ref")));
const api = await loadExtApi(ext.bundle);
const refModule = (await import(new URL(`file://${ext.bundle}`).href)) as { review: Record<string, unknown> };
const validateModelOutput = refModule.review.validateModelOutput as (
  raw: unknown,
  chunk: { text: string; offset: number },
  offset: number,
  categories: readonly string[],
) => Array<{ category: string; start: number; end: number; value?: string }>;
const descriptions = refModule.review.DETERMINISTIC_LABEL_DESCRIPTIONS as Record<string, string>;
const refTexts: RefTexts = {
  defaultPrompt: api.defaultPrompt,
  outputSchema: String(refModule.review.SLM_OUTPUT_SCHEMA),
  labelHeader: String(refModule.review.SLM_LABEL_LIST_HEADER),
  builtin: api.reviewCategories([]).map((label) => ({ label, description: descriptions[label] ?? "" })),
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
}

const slug = (s: string) => s.replace(/^.*\//, "").replace(/[^A-Za-z0-9.-]+/g, "_");
const noPrefixCache = flag("no-prefix-cache");
/** Rescore with relaxed anchoring (src/lab/config.ts relaxLines); summaries get a "+relax" suffix. */
const relaxedAnchor = opt("anchor") === "relaxed";
/**
 * Scoring-time post-processing (no recompute): `basic` = filterLines,
 * `dedup` = drop a passage claimed by two or more labels, `basic,dedup` = both.
 * Summaries get a "+<filter>" suffix.
 */
const postFilters = list(opt("filter"));
const filterSuffix = postFilters.length ? `+${postFilters.join("+")}` : "";
/** onnxruntime-web build: `pinned` (the extension's, default) or `next` (1.24.3, needed by newer ONNX exports). */
const ortOverride = opt("ort");
const ortFor = (model: LabModel) => ortOverride ?? model.ort;
const skipPrefix = (model: LabModel) => noPrefixCache || !model.prefixCache;
const cacheFileFor = (model: LabModel, dtype: string) =>
  join(LAB_DIR, `${slug(model.id)}-${dtype}${ortFor(model) === "next" ? "-ortnext" : ""}${skipPrefix(model) ? "-nopkv" : ""}.jsonl`);
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


async function plan(model: LabModel): Promise<Planned[]> {
  const tokenizer = await AutoTokenizer.from_pretrained(model.id);
  const dtype = dtypeOverride ?? model.dtype;
  const out: Planned[] = [];
  for (const config of configs) {
    for (const c of cases) {
      const profile = profiles.get(c.profile)!;
      const parts: Array<{ part?: string; scope: Profile }> = config.perLabel
        ? profile.labels.map((l) => ({ part: l.label, scope: { ...profile, labels: [l] } }))
        : [{ scope: profile }];
      for (const { part, scope } of parts) {
        const cfg = config.perLabel ? { ...config, builtinLabels: false } : config;
        let prefix: string;
        let suffix: string;
        let instructions: string;
        if (cfg.raw) {
          const raw = buildRaw(cfg, scope, refTexts, c.text);
          ({ prefix, instructions } = raw);
          if (model.rawBos) prefix = `${String((tokenizer as unknown as { bos_token?: string }).bos_token ?? "")}${prefix}`;
          suffix = raw.suffix(c.text);
        } else {
          const built = buildMessages(cfg, scope, refTexts);
          const rendered = String(
            tokenizer.apply_chat_template(built.messages as never, { tokenize: false, add_generation_prompt: true, ...config.templateKwargs } as never),
          );
          const at = rendered.indexOf(CONTENT_MARKER);
          if (at < 0 || rendered.indexOf(CONTENT_MARKER, at + 1) >= 0) fail(`${model.short}/${config.id}: template did not place the content once`);
          const tail = rendered.slice(at + CONTENT_MARKER.length);
          suffix = `${built.userContent(c.text)}${tail}${config.prefill}`;
          prefix = rendered.slice(0, at);
          instructions = built.instructions;
        }
        const gen = { maxNewTokens: config.maxNewTokens, deadlineMs: config.deadlineMs, repetitionPenalty: config.repetitionPenalty, noRepeatNgram: config.noRepeatNgram, lineStop: config.output === "lines" && !config.stopAtNewline, ...(config.stopAtNewline ? { stopAtNewline: true } : {}), ...(config.noneGate !== null ? { scoreNone: true } : {}), ...(config.minNewTokens ? { minNewTokens: config.minNewTokens } : {}) };
        // Keys omit defaults added after the first runs, so cached results stay valid.
        const { lineStop, ...keyGen } = gen;
        const key = createHash("sha256").update(JSON.stringify({ model: model.id, dtype, prefix, suffix, gen: lineStop ? keyGen : gen })).digest("hex").slice(0, 32);
        out.push({ model, dtype, config: cfg, c, profile, prefix, suffix, key, gen, instructions, part, scope });
      }
    }
  }
  return out;
}

// ------------------------------------------------------------------ run
async function runWorker(model: LabModel, dtype: string, pending: Planned[]): Promise<void> {
  const groups = new Map<string, LabGroup>();
  for (const p of pending) {
    const g = groups.get(p.prefix) ?? { prefix: p.prefix, jobs: [] };
    if (!g.jobs.some((j) => j.key === p.key)) g.jobs.push({ key: p.key, caseId: p.c.id, suffix: p.suffix, gen: p.gen });
    groups.set(p.prefix, g);
  }
  const spec: LabWorkerSpec = { bundle: ext.bundle, model: model.id, dtype: dtype as LabWorkerSpec["dtype"], resultFile: cacheFileFor(model, dtype), groups: [...groups.values()], noPrefixCache: skipPrefix(model) };
  const specFile = join(CACHE_DIR, "tmp", `lab-${process.pid}-${model.short}.json`);
  mkdirSync(join(CACHE_DIR, "tmp"), { recursive: true });
  mkdirSync(LAB_DIR, { recursive: true });
  writeFileSync(specFile, JSON.stringify(spec));
  const total = spec.groups.reduce((a, g) => a + g.jobs.length, 0);
  console.log(`[${model.short}] ${total} generations in ${spec.groups.length} prefix group(s); ${readMemAvailableMb()} MB available`);
  const t0 = performance.now();
  let last = 0;
  const peak = await runGuardedWorker("src/lab/worker.ts", specFile, { LAB_ORT: ortFor(model) }, model.short, maxRssMb, (event, rss) => {
    const e = event as unknown as LabEvent;
    if (e.type === "loaded") console.log(`[${model.short}] loaded in ${(e.loadMs / 1000).toFixed(1)} s, ort-web ${e.ort}, context ${e.contextLength}, rss ${rss} MB`);
    else if (e.type === "result") {
      const now = performance.now();
      if (now - last > 20_000 || e.done === e.total) {
        last = now;
        console.log(`[${model.short}] ${e.done}/${e.total} ${e.caseId} ${e.ms} ms ${e.tokens} tok ${e.finish} · ${Math.round((now - t0) / 1000)} s`);
      }
    } else if (e.type === "fatal") console.error(`[${model.short}] worker failed: ${e.error}`);
  });
  console.log(`[${model.short}] worker done, peak RSS ${peak} MB, ${Math.round((performance.now() - t0) / 1000)} s`);
}

// ------------------------------------------------------------------ score
interface Row extends Scored {
  output: string;
}

/** Scores one case from its request(s): one, or one per label for per-label configurations. */
function score(parts: Planned[], cache: Map<string, LabRecord>): Row {
  const p = parts[0]!;
  const records = parts.map((part) => cache.get(part.key)!);
  const deadline = records.some((r) => r.finishReason === "deadline");
  const chunks: ResultRecord["chunks"] = [];
  const findings: ReturnType<typeof validateModelOutput> = [];
  parts.forEach((part, i) => {
    const r = records[i]!;
    const gated = part.config.noneGate !== null && (r.pNone ?? 0) >= part.config.noneGate;
    const json = gated ? "NONE" : part.config.output === "json" ? jsonToLines(r.output) : r.output;
    const lines = part.part && part.config.passageOnly ? passagesToLines(json, part.part) : json;
    const relaxed = relaxedAnchor ? relaxLines(lines, p.c.text) : lines;
    const parsed = postFilters.includes("basic") ? filterLines(relaxed) : relaxed;
    const categories = configCategories(part.config, part.scope, refTexts);
    if (!deadline) findings.push(...validateModelOutput(parsed, { text: p.c.text, offset: 0 }, 0, categories));
    chunks.push({ output: parsed, ms: r.ms, runtime: { backend: "wasm", quantization: p.dtype, promptTokens: r.promptTokens, generatedTokens: r.generatedTokens, finishReason: r.finishReason } });
  });
  if (postFilters.includes("dedup")) {
    const labelsByValue = new Map<string, Set<string>>();
    for (const f of findings) {
      const k = (f.value ?? "").toLocaleLowerCase();
      labelsByValue.set(k, (labelsByValue.get(k) ?? new Set()).add(f.category));
    }
    findings.splice(0, findings.length, ...findings.filter((f) => (labelsByValue.get((f.value ?? "").toLocaleLowerCase())?.size ?? 0) < 2));
  }
  const reviewMs = records.reduce((a, r) => a + r.ms, 0);
  const record: ResultRecord = {
    key: p.key,
    extSha: ext.sha,
    model: p.model.id,
    instruction: p.config.id,
    labelVariant: p.config.labelVariant,
    caseId: p.c.id,
    findings: findings.map(({ category, start, end, value }) => ({ category, start, end, value })),
    chunks,
    ...(deadline ? { error: "deadline", errorKind: "deadline" as const } : {}),
    reviewMs,
    at: records[0]!.at,
  };
  const output = parts.length > 1 ? records.map((r, i) => `[${parts[i]!.part}] ${r.output}`).join("\n") : records[0]!.output;
  return { ...scoreResult(p.c, p.profile, record, builtinLabels, parts.map((x) => x.instructions).join("\n")), output };
}

const pct = (v: number | null) => (v === null ? "  - " : `${Math.round(v * 100)}`.padStart(4));
function line(m: Metrics) {
  const f = m.failures;
  const fails = Object.entries(f)
    .filter(([k, v]) => k !== "ok" && v)
    .map(([k, v]) => `${k.replace("echo_instructions", "echoI").replace("hallucinated", "halluc").replace("unknown_label", "unkL")}${v}`)
    .join(" ");
  return `${pct(m.overlap.f1)} ${pct(m.overlap.precision)} ${pct(m.overlap.recall)} ${pct(m.exact.f1)} ${pct(m.caseDetection)} ${pct(m.falsePositiveRate)} ${pct(m.compliance)} ${String(Math.round((m.latencyP50 ?? 0) / 100) / 10).padStart(5)} ${String(Math.round(m.meanGeneratedTokens ?? 0)).padStart(4)}  ${fails}`;
}

// ------------------------------------------------------------------ main
const allRows: Row[] = [];
const summary: Array<{ model: string; dtype: string; config: string; note?: string; overall: Metrics; en: Metrics; fr: Metrics }> = [];
const planned: Planned[][] = [];
for (const model of models) planned.push(await plan(model));

if (flag("show-prompt")) {
  for (const ps of planned) for (const cfg of configs) {
    const p = ps.find((x) => x.config.id === cfg.id)!;
    console.log(`\n===== ${p.model.short} / ${cfg.id} / ${p.c.id} =====\n${p.prefix}\x1b[33m${p.suffix}\x1b[0m`);
  }
}
for (const ps of planned) {
  const model = ps[0]!.model;
  const dtype = ps[0]!.dtype;
  const cache = loadLabCache(cacheFileFor(model, dtype));
  const pending = ps.filter((p) => !cache.has(p.key));
  const unique = new Set(pending.map((p) => p.key)).size;
  console.log(`[${model.short} ${dtype}] ${ps.length} jobs, ${unique} to compute (~${Math.round((unique * model.secondsPerCase) / 60)} min)`);
  if (flag("dry-run") || !unique) continue;
  if (!(await waitForMemory(model, minFreeMb))) continue;
  await runWorker(model, dtype, pending);
}

for (const ps of planned) {
  const model = ps[0]!.model;
  const dtype = ps[0]!.dtype;
  const cache = loadLabCache(cacheFileFor(model, dtype));
  for (const cfg of configs) {
    const byCase = new Map<string, Planned[]>();
    for (const p of ps) if (p.config.id === cfg.id) byCase.set(p.c.id, [...(byCase.get(p.c.id) ?? []), p]);
    const rows = [...byCase.values()].filter((parts) => parts.every((p) => cache.has(p.key))).map((parts) => score(parts, cache));
    allRows.push(...rows);
    if (!rows.length) continue;
    summary.push({ model: model.short, dtype, config: `${cfg.id}${relaxedAnchor ? "+relax" : ""}${filterSuffix}`, note: cfg.note, overall: metrics(rows), en: metrics(rows.filter((r) => r.lang === "en")), fr: metrics(rows.filter((r) => r.lang === "fr")) });
  }
}

console.log(`\nset ${setName ?? "custom"} (${cases.length} cases), ref ${ext.ref}@${ext.sha.slice(0, 7)}`);
console.log(`${"model/config".padEnd(34)}  F1o    P    R  F1x  det  FPR comp  p50s  tok  failures`);
for (const s of summary) {
  console.log(`${`${s.model}/${s.config}`.padEnd(34)} ${line(s.overall)}`);
  if (flag("by-lang")) {
    console.log(`${"   en".padEnd(34)} ${line(s.en)}`);
    console.log(`${"   fr".padEnd(34)} ${line(s.fr)}`);
  }
}
if (flag("cases")) {
  for (const r of allRows) {
    const exp = r.expected.map((e) => `${e.overlap ? "+" : "-"}${e.label}:${e.passage}`).join(" | ");
    const pred = r.predicted.map((p) => `${p.overlap ? "✓" : "✗"}${p.label}:${p.value}`).join(" | ");
    console.log(`${r.model.replace(/^.*\//, "").slice(0, 14)} ${r.config.split(" | ")[1]} ${r.caseId.padEnd(18)} ${r.failure.padEnd(10)} exp[${exp}] pred[${pred}] raw=${JSON.stringify(r.output.slice(0, 160))}`);
  }
}

if (!flag("dry-run") && summary.length) {
  const name = opt("name") ?? `${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
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
        summary: summary.map((s) => ({
          model: s.model,
          dtype: s.dtype,
          config: s.config,
          note: s.note,
          overall: compact(s.overall),
          en: compact(s.en),
          fr: compact(s.fr),
        })),
        cases: allRows.map((r) => ({
          model: findLabModel(r.model)?.short ?? r.model,
          config: `${r.config.split(" | ")[1]}${relaxedAnchor ? "+relax" : ""}${filterSuffix}`,
          caseId: r.caseId,
          failure: r.failure,
          found: r.expected.filter((e) => e.overlap).length,
          expected: r.expected.length,
          predicted: r.predicted.map((p) => `${p.overlap ? "+" : "-"}${p.label}: ${p.value}`),
          ms: r.reviewMs,
          output: r.output.slice(0, 300),
        })),
      },
      null,
      1,
    ) + "\n",
  );
  console.log(`\nwrote ${file.replace(ROOT, "")}`);
}

function compact(m: Metrics) {
  const r = (v: number | null) => (v === null ? null : Math.round(v * 1000) / 1000);
  return {
    cases: m.cases,
    f1: r(m.overlap.f1),
    precision: r(m.overlap.precision),
    recall: r(m.overlap.recall),
    exactF1: r(m.exact.f1),
    detection: r(m.caseDetection),
    fpr: r(m.falsePositiveRate),
    compliance: r(m.compliance),
    p50ms: m.latencyP50,
    p95ms: m.latencyP95,
    tokens: m.meanGeneratedTokens === null ? null : Math.round(m.meanGeneratedTokens),
    failures: Object.fromEntries(Object.entries(m.failures).filter(([, v]) => v)),
  };
}
