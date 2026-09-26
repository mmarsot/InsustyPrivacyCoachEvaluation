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
import { spawn } from "node:child_process";
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
import { buildMessages, configCategories, jsonToLines, CONTENT_MARKER, type LabConfig, type RefTexts } from "./config.ts";
import { LAB_CONFIGS } from "./configs.ts";
import { findLabModel, type LabModel } from "./models.ts";
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
}

const slug = (s: string) => s.replace(/^.*\//, "").replace(/[^A-Za-z0-9.-]+/g, "_");
const noPrefixCache = flag("no-prefix-cache");
const cacheFileFor = (model: string, dtype: string) => join(LAB_DIR, `${slug(model)}-${dtype}${noPrefixCache ? "-nopkv" : ""}.jsonl`);
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
      const built = buildMessages(config, profile, refTexts);
      const rendered = String(
        tokenizer.apply_chat_template(built.messages as never, { tokenize: false, add_generation_prompt: true, ...config.templateKwargs } as never),
      );
      const at = rendered.indexOf(CONTENT_MARKER);
      if (at < 0 || rendered.indexOf(CONTENT_MARKER, at + 1) >= 0) fail(`${model.short}/${config.id}: template did not place the content once`);
      const tail = rendered.slice(at + CONTENT_MARKER.length);
      const instructions = built.instructions;
      const userContent = built.userContent(c.text);
      const suffix = `${userContent}${tail}${config.prefill}`;
      const prefix = rendered.slice(0, at);
      const gen = { maxNewTokens: config.maxNewTokens, deadlineMs: config.deadlineMs, repetitionPenalty: config.repetitionPenalty, noRepeatNgram: config.noRepeatNgram, lineStop: config.output === "lines" };
      // Keys omit defaults added after the first runs, so cached results stay valid.
      const { lineStop, ...keyGen } = gen;
      const key = createHash("sha256").update(JSON.stringify({ model: model.id, dtype, prefix, suffix, gen: lineStop ? keyGen : gen })).digest("hex").slice(0, 32);
      out.push({ model, dtype, config, c, profile, prefix, suffix, key, gen, instructions });
    }
  }
  return out;
}

// ------------------------------------------------------------------ run
const readMem = () => {
  const info = readFileSync("/proc/meminfo", "utf8");
  const kb = (k: string) => Number(new RegExp(`${k}:\\s+(\\d+)`).exec(info)?.[1] ?? 0);
  return Math.round(kb("MemAvailable") / 1024);
};
const readRss = (pid: number, field: "VmRSS" | "VmHWM") => {
  try {
    const kb = Number(new RegExp(`${field}:\\s+(\\d+)`).exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
    return Number.isFinite(kb) ? Math.round(kb / 1024) : 0;
  } catch {
    return 0;
  }
};

async function waitForMemory(model: LabModel): Promise<boolean> {
  const need = model.peakRssMb + minFreeMb;
  for (let waited = 0; ; waited += 30) {
    const available = readMem();
    if (available >= need) return true;
    if (waited >= 600) {
      console.error(`[${model.short}] only ${available} MB available, need ${need} MB (peak ~${model.peakRssMb} + ${minFreeMb} margin); skipping.`);
      return false;
    }
    if (waited === 0) console.log(`[${model.short}] waiting for memory: ${available} MB available, need ${need} MB`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

async function runWorker(model: LabModel, dtype: string, pending: Planned[]): Promise<void> {
  const groups = new Map<string, LabGroup>();
  for (const p of pending) {
    const g = groups.get(p.prefix) ?? { prefix: p.prefix, jobs: [] };
    if (!g.jobs.some((j) => j.key === p.key)) g.jobs.push({ key: p.key, caseId: p.c.id, suffix: p.suffix, gen: p.gen });
    groups.set(p.prefix, g);
  }
  const spec: LabWorkerSpec = { bundle: ext.bundle, model: model.id, dtype: dtype as LabWorkerSpec["dtype"], resultFile: cacheFileFor(model.id, dtype), groups: [...groups.values()], noPrefixCache };
  const specFile = join(CACHE_DIR, "tmp", `lab-${process.pid}-${model.short}.json`);
  mkdirSync(join(CACHE_DIR, "tmp"), { recursive: true });
  mkdirSync(LAB_DIR, { recursive: true });
  writeFileSync(specFile, JSON.stringify(spec));
  const total = spec.groups.reduce((a, g) => a + g.jobs.length, 0);
  console.log(`[${model.short}] ${total} generations in ${spec.groups.length} prefix group(s); ${readMem()} MB available`);
  const t0 = performance.now();
  await new Promise<void>((resolveRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src/lab/worker.ts"), specFile], { cwd: ROOT, stdio: ["ignore", "pipe", "inherit"] });
    let peak = 0;
    const kill = (why: string) => {
      console.error(`[${model.short}] ${why}; killing the worker.`);
      child.kill("SIGKILL");
    };
    const timer = setInterval(() => {
      const rss = readRss(child.pid!, "VmRSS");
      peak = Math.max(peak, readRss(child.pid!, "VmHWM"), rss);
      if (rss > maxRssMb) kill(`RSS ${rss} MB exceeds ${maxRssMb} MB`);
      else if (readMem() < 600) kill(`system MemAvailable below 600 MB`);
    }, 250);
    let buffer = "";
    let last = 0;
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("@@")) continue;
        const e = JSON.parse(line.slice(2)) as LabEvent;
        if (e.type === "loaded") console.log(`[${model.short}] loaded in ${(e.loadMs / 1000).toFixed(1)} s, context ${e.contextLength}, rss ${readRss(child.pid!, "VmRSS")} MB (peak ${peak})`);
        else if (e.type === "result") {
          const now = performance.now();
          if (now - last > 20_000 || e.done === e.total) {
            last = now;
            console.log(`[${model.short}] ${e.done}/${e.total} ${e.caseId} ${e.ms} ms ${e.tokens} tok ${e.finish} · ${Math.round((now - t0) / 1000)} s`);
          }
        } else if (e.type === "fatal") console.error(`[${model.short}] worker failed: ${e.error}`);
        else if (e.type === "done") peak = Math.max(peak, e.maxRssMb);
      }
    });
    child.on("exit", (code) => {
      clearInterval(timer);
      console.log(`[${model.short}] worker exit ${code}, peak RSS ${peak} MB, ${Math.round((performance.now() - t0) / 1000)} s`);
      resolveRun();
    });
  });
}

// ------------------------------------------------------------------ score
interface Row extends Scored {
  output: string;
}

function score(p: Planned, r: LabRecord): Row {
  const deadline = r.finishReason === "deadline";
  const categories = configCategories(p.config, p.profile, refTexts);
  const parsed = p.config.output === "json" ? jsonToLines(r.output) : r.output;
  const findings = deadline ? [] : validateModelOutput(parsed, { text: p.c.text, offset: 0 }, 0, categories);
  const record: ResultRecord = {
    key: p.key,
    extSha: ext.sha,
    model: p.model.id,
    instruction: p.config.id,
    labelVariant: p.config.labelVariant,
    caseId: p.c.id,
    findings: findings.map(({ category, start, end, value }) => ({ category, start, end, value })),
    chunks: [{ output: parsed, ms: r.ms, runtime: { backend: "wasm", quantization: p.dtype, promptTokens: r.promptTokens, generatedTokens: r.generatedTokens, finishReason: r.finishReason } }],
    ...(deadline ? { error: "deadline", errorKind: "deadline" as const } : {}),
    reviewMs: r.ms,
    at: r.at,
  };
  return { ...scoreResult(p.c, p.profile, record, builtinLabels, p.instructions), output: r.output };
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
  const cache = loadLabCache(cacheFileFor(model.id, dtype));
  const pending = ps.filter((p) => !cache.has(p.key));
  const unique = new Set(pending.map((p) => p.key)).size;
  console.log(`[${model.short} ${dtype}] ${ps.length} jobs, ${unique} to compute (~${Math.round((unique * model.secondsPerCase) / 60)} min)`);
  if (flag("dry-run") || !unique) continue;
  if (!(await waitForMemory(model))) continue;
  await runWorker(model, dtype, pending);
}

for (const ps of planned) {
  const model = ps[0]!.model;
  const dtype = ps[0]!.dtype;
  const cache = loadLabCache(cacheFileFor(model.id, dtype));
  for (const cfg of configs) {
    const rows = ps.filter((p) => p.config.id === cfg.id && cache.has(p.key)).map((p) => score(p, cache.get(p.key)!));
    allRows.push(...rows);
    if (!rows.length) continue;
    summary.push({ model: model.short, dtype, config: cfg.id, note: cfg.note, overall: metrics(rows), en: metrics(rows.filter((r) => r.lang === "en")), fr: metrics(rows.filter((r) => r.lang === "fr")) });
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
          config: r.config.split(" | ")[1],
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
