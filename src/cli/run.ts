/**
 * Runs the benchmark.
 *
 *   npm run bench -- [--tier smoke|quick|full] [--models all|smollm2-135m,...]
 *                    [--instructions current,strict,short|all] [--labels desc,desc_ex3|all]
 *                    [--split dev|test|all] [--profiles sales,dev] [--langs en,fr]
 *                    [--ref <git ref>] [--ext-repo <path>] [--name <run name>]
 *                    [--max-rss-mb 3800] [--allow-missing-split] [--dry-run]
 *
 * Prints the plan and a runtime estimate first. Models run one at a time, each
 * in its own child process (so its WASM heap is fully released before the
 * next one loads). Results are cached per job; re-runs only compute what
 * changed. Outputs go to runs/<name>/.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { compileDataset } from "../dataset/load.ts";
import type { CompiledCase, Split } from "../dataset/schema.ts";
import { loadExtApi, materializeExtRef, resolveExtRefName, resolveExtRepo } from "../ext/ref.ts";
import { CACHE_DIR, MODELS_FILE, ROOT, RUNS_DIR } from "../paths.ts";
import { cachedTimings, cacheFile, jobKey, loadCache, rulesFor, selectCases, TIERS, type Job, type Tier } from "../run/jobs.ts";
import type { RunMeta, RunModelMeta } from "../run/meta.ts";
import { writeRun } from "../run/outputs.ts";
import type { WorkerEvent, WorkerSpec } from "../run/worker.ts";
import { percentile } from "../score/aggregate.ts";
import { scoreResult, type Scored } from "../score/score.ts";
import { INSTRUCTION_VARIANTS, isLabelVariant, LABEL_VARIANTS, type LabelVariantId } from "../variants.ts";

// ------------------------------------------------------------------ args
const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const opt = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
const list = (value: string | undefined) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);

interface ModelInfo {
  id: string;
  short: string;
  priorSecondsPerCase: number;
  priorLoadSeconds: number;
}
const MODELS = (JSON.parse(readFileSync(MODELS_FILE, "utf8")) as { models: ModelInfo[] }).models;

const tier = (opt("tier", "quick") ?? "quick") as Tier;
if (!TIERS.includes(tier)) throw new Error(`--tier must be one of ${TIERS.join(", ")}`);
const modelArg = opt("models", "all")!;
const models = modelArg === "all" ? MODELS : list(modelArg).map((m) => MODELS.find((x) => x.short === m || x.id === m) ?? fail(`unknown model ${m}`));
const instrArg = opt("instructions", "current")!;
const instructions = instrArg === "all" ? INSTRUCTION_VARIANTS : list(instrArg).map((i) => INSTRUCTION_VARIANTS.find((v) => v.id === i) ?? fail(`unknown instruction variant ${i}`));
const labelArg = opt("labels", "desc,desc_ex3")!;
const labelVariants: LabelVariantId[] = labelArg === "all" ? LABEL_VARIANTS.map((v) => v.id) : list(labelArg).map((l) => (isLabelVariant(l) ? l : fail(`unknown label variant ${l}`)));
const splitArg = opt("split") as Split | "all" | undefined;
const profilesArg = list(opt("profiles"));
const langsArg = list(opt("langs"));
const maxRssMb = Number(opt("max-rss-mb", "3800"));
const dryRun = flag("dry-run");

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

// ------------------------------------------------------------------ plan
const { dataset, issues } = compileDataset({ requireSplit: !flag("allow-missing-split"), profiles: profilesArg });
if (!dataset) {
  for (const i of issues.filter((x) => x.level === "error").slice(0, 20)) console.error(`ERROR ${i.where}: ${i.message}`);
  fail("dataset is invalid: run `npm run validate`");
}
const extRepo = resolveExtRepo(opt("ext-repo"));
const ext = await materializeExtRef(extRepo, resolveExtRefName(opt("ref")));
const api = await loadExtApi(ext.bundle);
for (const m of models) if (!api.modelIds.includes(m.id)) console.warn(`warning: ${m.id} is not bundled by ${ext.ref}`);
const installedTransformers = (JSON.parse(readFileSync(join(ROOT, "node_modules/@huggingface/transformers/package.json"), "utf8")) as { version: string }).version;
if (ext.transformersRange && ext.transformersRange.replace(/^[\^~=]/, "") !== installedTransformers)
  console.warn(`warning: the ref declares @huggingface/transformers ${ext.transformersRange}; the bench runs ${installedTransformers}`);

let cases: CompiledCase[] = selectCases(dataset, tier, splitArg);
if (profilesArg.length) cases = cases.filter((c) => profilesArg.includes(c.profile));
if (langsArg.length) cases = cases.filter((c) => langsArg.includes(c.lang));
if (!cases.length) fail("no case selected");
const profiles = new Map(dataset.profiles.map((p) => [p.id, p]));

const jobsByModel = new Map<string, Job[]>();
for (const model of models) {
  const jobs: Job[] = [];
  for (const variant of instructions)
    for (const labelVariant of labelVariants)
      for (const c of cases) {
        const systemInstruction = variant.text ?? api.defaultPrompt;
        const rules = rulesFor(profiles.get(c.profile)!, labelVariant);
        jobs.push({
          key: jobKey({ extSha: ext.sha, model: model.id, systemInstruction, rules, caseId: c.id, text: c.text }),
          caseId: c.id,
          model: model.id,
          instruction: variant.id,
          labelVariant,
          systemInstruction,
          rules,
          text: c.text,
        });
      }
  jobsByModel.set(model.id, jobs);
}

const secondsPerCase = (m: ModelInfo) => {
  const timings = cachedTimings(m.id);
  return timings.length >= 10 ? percentile(timings, 50)! / 1000 : m.priorSecondsPerCase;
};
const estimate = (m: ModelInfo, pending: number) => (pending ? m.priorLoadSeconds + pending * secondsPerCase(m) * 1.1 : 0);
const fmt = (s: number) => (s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`);

const splitLabel = splitArg ?? (tier === "full" ? "all" : "dev");
console.log(`Extension ${ext.ref} @ ${ext.sha.slice(0, 10)} "${ext.subject}"`);
console.log(`Tier ${tier}, split ${splitLabel}: ${cases.length} cases x ${instructions.length} instruction(s) [${instructions.map((i) => i.id).join(",")}] x ${labelVariants.length} label variant(s) [${labelVariants.join(",")}]`);
let totalEstimate = 0;
const pendingByModel = new Map<string, Job[]>();
for (const m of models) {
  const cache = loadCache(ext.sha, m.id);
  const jobs = jobsByModel.get(m.id)!;
  const pending = jobs.filter((j) => !cache.has(j.key));
  pendingByModel.set(m.id, pending);
  const est = estimate(m, pending.length);
  totalEstimate += est;
  console.log(`  ${m.short.padEnd(14)} ${String(jobs.length).padStart(6)} jobs, ${String(pending.length).padStart(6)} to compute, ~${secondsPerCase(m).toFixed(1)} s/case -> ~${fmt(est)}`);
}
console.log(`Estimated runtime: ~${fmt(totalEstimate)} (sequential, one model at a time)`);
if (dryRun) process.exit(0);

// ------------------------------------------------------------------ run
const startedAt = new Date();
const runName = opt("name") ?? `${startedAt.toISOString().slice(0, 10)}-${tier}-${ext.sha.slice(0, 7)}`;
const tmpDir = join(CACHE_DIR, "tmp");
mkdirSync(tmpDir, { recursive: true });
const modelMeta: RunModelMeta[] = [];

const readRssMb = (pid: number, field: "VmRSS" | "VmHWM") => {
  try {
    const status = readFileSync(`/proc/${pid}/status`, "utf8");
    const kb = Number(new RegExp(`${field}:\\s+(\\d+)`).exec(status)?.[1]);
    return Number.isFinite(kb) ? Math.round(kb / 1024) : undefined;
  } catch {
    return undefined;
  }
};

for (const m of models) {
  const jobs = jobsByModel.get(m.id)!;
  const pending = pendingByModel.get(m.id)!;
  const meta: RunModelMeta = { id: m.id, jobs: jobs.length, computed: 0 };
  modelMeta.push(meta);
  if (!pending.length) continue;
  const spec: WorkerSpec = { bundle: ext.bundle, extSha: ext.sha, model: m.id, resultFile: cacheFile(ext.sha, m.id), jobs: pending };
  const specFile = join(tmpDir, `jobs-${process.pid}-${m.short}.json`);
  writeFileSync(specFile, JSON.stringify(spec));
  console.log(`\n[${m.short}] ${pending.length} jobs`);
  const t0 = performance.now();
  await new Promise<void>((resolveRun) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, "src/run/worker.ts"), specFile], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let peak = 0;
    const timer = setInterval(() => {
      const rss = readRssMb(child.pid!, "VmRSS") ?? 0;
      peak = Math.max(peak, readRssMb(child.pid!, "VmHWM") ?? rss);
      if (rss > maxRssMb) {
        console.error(`[${m.short}] RSS ${rss} MB exceeds --max-rss-mb ${maxRssMb}; stopping this model.`);
        child.kill("SIGKILL");
      }
    }, 500);
    let buffer = "";
    let lastLog = 0;
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("@@")) continue;
        const event = JSON.parse(line.slice(2)) as WorkerEvent;
        if (event.type === "loaded") {
          meta.loadMs = event.loadMs;
          meta.threads = event.threads;
          console.log(`[${m.short}] loaded in ${(event.loadMs / 1000).toFixed(1)} s (${event.threads} WASM threads, transformers ${event.transformers})`);
        } else if (event.type === "prepared") {
          console.log(`[${m.short}] prepared ${event.instruction}/${event.labelVariant} prefix in ${event.ms} ms`);
        } else if (event.type === "result") {
          meta.computed = event.done;
          const now = performance.now();
          if (event.error || event.done === event.total || now - lastLog > 15_000) {
            lastLog = now;
            const elapsed = (now - t0) / 1000;
            const eta = (elapsed / event.done) * (event.total - event.done);
            console.log(`[${m.short}] ${event.done}/${event.total} ${event.caseId} ${event.reviewMs} ms${event.error ? ` (${event.error})` : ""} · elapsed ${fmt(elapsed)}, eta ${fmt(eta)}, rss ${readRssMb(child.pid!, "VmRSS") ?? "?"} MB`);
          }
        } else if (event.type === "done") {
          meta.wallMs = event.wallMs;
          peak = Math.max(peak, event.maxRssMb);
        } else if (event.type === "fatal") {
          console.error(`[${m.short}] worker failed: ${event.error}`);
        }
      }
    });
    child.on("exit", (code) => {
      clearInterval(timer);
      meta.peakRssMb = peak || undefined;
      if (code) console.error(`[${m.short}] worker exited with code ${code}`);
      console.log(`[${m.short}] done: ${meta.computed}/${pending.length} computed, peak RSS ${peak} MB, ${fmt((performance.now() - t0) / 1000)}`);
      resolveRun();
    });
  });
}

// ------------------------------------------------------------------ score
const byId = new Map(cases.map((c) => [c.id, c]));
const builtin = api.reviewCategories([]);
const rows: Scored[] = [];
let missing = 0;
for (const m of models) {
  const cache = loadCache(ext.sha, m.id);
  for (const job of jobsByModel.get(m.id)!) {
    const record = cache.get(job.key);
    if (!record) {
      missing++;
      continue;
    }
    const c = byId.get(job.caseId)!;
    rows.push(scoreResult(c, profiles.get(c.profile)!, record, builtin, api.composeReviewInstructions(job.systemInstruction, job.rules)));
  }
}
const finishedAt = new Date();
const meta: RunMeta = {
  name: runName,
  tier,
  split: splitLabel,
  cases: cases.length,
  instructions: instructions.map((i) => i.id),
  labelVariants,
  models: modelMeta,
  ext: { ref: ext.ref, sha: ext.sha, subject: ext.subject, committedAt: ext.committedAt, transformersRange: ext.transformersRange },
  datasetHash: dataset.hash,
  runtime: `onnxruntime-web WASM (q8) in Node ${process.versions.node} via @huggingface/transformers; deterministic greedy decoding; generation budget ${api.generationBudgetMs / 1000} s per request (from the ref)`,
  machine: `${cpus()[0]?.model ?? "cpu"} x${cpus().length}, ${(totalmem() / 2 ** 30).toFixed(1)} GiB RAM, ${process.platform}`,
  node: process.versions.node,
  startedAt: startedAt.toISOString(),
  finishedAt: finishedAt.toISOString(),
  estimateSeconds: Math.round(totalEstimate),
  wallSeconds: Math.round((finishedAt.getTime() - startedAt.getTime()) / 1000),
  incomplete: missing,
};
const runDir = join(RUNS_DIR, runName);
writeRun(runDir, meta, rows);
console.log(`\nWrote ${runDir}/ (report.html, results.jsonl, metrics.csv, metrics.json)${missing ? ` - ${missing} job(s) missing` : ""}`);
