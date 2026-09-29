/**
 * Runs the benchmark.
 *
 *   npm run bench -- [--tier smoke|quick|full] [--cases-per-profile 2]
 *                    [--models all|smollm2-135m,...] [--instructions current,strict,short|all]
 *                    [--label-variants desc,desc_ex3|all] [--split dev|test|all]
 *                    [--profiles sales,dev] [--langs en,fr] [--ref main] [--ext-repo <path>]
 *                    [--name <run name>] [--max-rss-mb 3800] [--allow-missing-split]
 *                    [--dry-run] [--cached-only] [--budget-usd 5]
 *
 * Prints the plan and a runtime estimate first (`--dry-run` stops there).
 * Models run one at a time, each in its own child process (so its WASM heap
 * is fully released before the next one loads). Results are cached per job;
 * re-runs only compute what changed, and `--cached-only` computes nothing and
 * reports what is cached (a partial run is marked incomplete). Outputs go to
 * runs/<name>/.
 *
 * Hosted models (`--models nova-micro-prefill`, src/hosted/models.ts; never
 * part of `all`) send the ref's requests to an API (Bedrock or an
 * OpenAI-compatible server): the plan prints their cost estimate, and the run
 * refuses to start when the hosted spend so far plus the estimate passes
 * `--budget-usd`. A model served by a local server (Ollama) waits for its RSS
 * plus the memory margin and is unloaded after its run.
 */
import { spawn } from "node:child_process";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join } from "node:path";
import { compileDataset } from "../dataset/load.ts";
import { loadExtApi, materializeExtRef, resolveExtRefName, resolveExtRepo } from "../ext/ref.ts";
import { ACTIVE_RUNS_DIR, CACHE_DIR, ROOT, RUNS_DIR } from "../paths.ts";
import { cacheFile, loadCache, type Job } from "../run/jobs.ts";
import type { RunMeta, RunModelMeta } from "../run/meta.ts";
import { writeRun } from "../run/outputs.ts";
import { estimateSeconds, formatDuration as fmt, parseBenchArgs, planJobs, secondsPerCase, splitLabel } from "../run/plan.ts";
import type { WorkerEvent, WorkerSpec } from "../run/worker.ts";
import { releaseHostedModel } from "../hosted/client.ts";
import { costOf, describeTarget, findHostedModel, hostedSpentUsd } from "../hosted/models.ts";
import { findLabModel } from "../lab/models.ts";
import { readMemAvailableMb, waitForMemory } from "../lab/runtime.ts";
import { scoreResult, type Scored } from "../score/score.ts";

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const argv = process.argv.slice(2);
let options;
try {
  options = parseBenchArgs(argv);
} catch (error) {
  fail((error as Error).message);
}
const { tier, models, instructions, labelVariants, maxRssMb } = options;

// ------------------------------------------------------------------ plan
const { dataset, issues } = compileDataset({ requireSplit: !options.allowMissingSplit, profiles: options.profiles });
if (!dataset) {
  for (const i of issues.filter((x) => x.level === "error").slice(0, 20)) console.error(`ERROR ${i.where}: ${i.message}`);
  fail("dataset is invalid: run `npm run validate`");
}
const extRepo = resolveExtRepo(options.extRepo);
const ext = await materializeExtRef(extRepo, resolveExtRefName(options.ref));
const api = await loadExtApi(ext.bundle);
for (const m of models) if (!m.hosted && !api.modelIds.includes(m.id)) console.warn(`warning: ${m.id} is not bundled by ${ext.ref}`);
const installedTransformers = (JSON.parse(readFileSync(join(ROOT, "node_modules/@huggingface/transformers/package.json"), "utf8")) as { version: string }).version;
if (ext.transformersRange && ext.transformersRange.replace(/^[\^~=]/, "") !== installedTransformers)
  console.warn(`warning: the ref declares @huggingface/transformers ${ext.transformersRange}; the bench runs ${installedTransformers}`);

const { cases, jobsByModel } = planJobs(dataset, options, ext.sha, api.defaultPrompt, api.kind === "completion");
if (!cases.length) fail("no case selected");
const profiles = new Map(dataset.profiles.map((p) => [p.id, p]));

console.log(`Extension ${ext.ref} @ ${ext.sha.slice(0, 10)} "${ext.subject}"`);
console.log(`Extension review design: ${api.kind}`);
console.log(`${options.set ? `Set ${options.set}, ` : ""}Tier ${tier}${tier === "quick" ? ` (${options.casesPerProfile} per profile and language)` : ""}, split ${splitLabel(options)}: ${cases.length} cases x ${instructions.length} instruction(s) [${instructions.map((i) => i.id).join(",")}] x ${labelVariants.length} label variant(s) [${labelVariants.join(",")}]`);
let totalEstimate = 0;
const pendingByModel = new Map<string, Job[]>();
for (const m of models) {
  const cache = loadCache(ext.sha, m.id);
  const jobs = jobsByModel.get(m.id)!;
  const pending = jobs.filter((j) => !cache.has(j.key));
  pendingByModel.set(m.id, pending);
  const est = estimateSeconds(m, pending.length);
  totalEstimate += est;
  console.log(`  ${m.short.padEnd(14)} ${String(jobs.length).padStart(6)} jobs, ${String(pending.length).padStart(6)} to compute, ~${secondsPerCase(m).toFixed(1)} s/case -> ~${fmt(est)}`);
}
// Hosted models: cost estimate (characters / 3 per input token, every answer at its token cap).
let hostedEstimateUsd = 0;
for (const m of models.filter((x) => x.hosted)) {
  const h = findHostedModel(m.id)!;
  let inputTokens = 0;
  let requests = 0;
  for (const job of pendingByModel.get(m.id)!) {
    const prefixes = api.preparedInstructions(job.systemInstruction, job.rules);
    const perLabel = prefixes.reduce((a, p) => a + p.length, 0) / Math.max(1, prefixes.length);
    requests += job.rules.length;
    inputTokens += job.rules.length * Math.ceil((perLabel + job.text.length + 40) / 3);
  }
  const cap = h.maxTokens ?? 48;
  const usd = costOf(h, inputTokens, requests * cap);
  hostedEstimateUsd += usd;
  console.log(`  ${m.short.padEnd(14)} ~${requests} requests, ~${inputTokens} input + <=${requests * cap} output tokens: <=${usd.toFixed(4)} USD (${describeTarget(h)})`);
}
const hostedSpent = models.some((m) => m.hosted) ? hostedSpentUsd() : 0;
if (models.some((m) => m.hosted)) {
  console.log(`Hosted spend so far ${hostedSpent.toFixed(4)} USD + this run <=${hostedEstimateUsd.toFixed(4)} USD; budget ${options.budgetUsd} USD`);
  if (!options.cachedOnly && hostedSpent + hostedEstimateUsd > options.budgetUsd) fail("The hosted cost estimate would pass --budget-usd; nothing was sent.");
}
console.log(`Estimated runtime: ~${fmt(totalEstimate)} (sequential, one model at a time)`);
if (options.dryRun) process.exit(0);
if (options.cachedOnly) {
  for (const m of models) pendingByModel.set(m.id, []);
  totalEstimate = 0;
  console.log("--cached-only: nothing is computed; reporting cached results.");
}

// ------------------------------------------------------------------ run
const startedAt = new Date();
const runName = options.name ?? `${startedAt.toISOString().slice(0, 10)}-${tier}-${ext.sha.slice(0, 7)}`;
const tmpDir = join(CACHE_DIR, "tmp");
mkdirSync(tmpDir, { recursive: true });
// Lets `npm run dashboard` find this run and recompute its plan.
mkdirSync(ACTIVE_RUNS_DIR, { recursive: true });
const activeFile = join(ACTIVE_RUNS_DIR, `${process.pid}.json`);
writeFileSync(activeFile, JSON.stringify({ pid: process.pid, name: runName, argv, startedAt: startedAt.toISOString() }));
process.on("exit", () => rmSync(activeFile, { force: true }));
const modelMeta: RunModelMeta[] = [];
/** Hosted spend of this run so far (all models). */
let runUsd = 0;

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
  // Same memory rule as the lab: wait (with a heartbeat) until the model's
  // peak plus a 1.5 GB margin is available, else skip it explicitly.
  const hostedModel = m.hosted ? findHostedModel(m.id) : undefined;
  const labModel = m.hosted && !hostedModel?.localServer ? undefined : findLabModel(m.id);
  if (labModel && !(await waitForMemory(labModel, Number(process.env.BENCH_MIN_FREE_MB ?? 1500)))) continue;
  const spec: WorkerSpec = { bundle: ext.bundle, extSha: ext.sha, model: m.id, resultFile: cacheFile(ext.sha, m.id), jobs: pending, ...(m.hosted ? { budgetUsd: Math.max(0, options.budgetUsd - hostedSpentUsd()) } : {}) };
  const specFile = join(tmpDir, `jobs-${process.pid}-${m.short}.json`);
  writeFileSync(specFile, JSON.stringify(spec));
  console.log(`\n[${m.short}] ${pending.length} jobs`);
  const t0 = performance.now();
  await new Promise<void>((resolveRun) => {
    const child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", join(ROOT, "src/run/worker.ts"), specFile], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
    });
    let peak = 0;
    const timer = setInterval(() => {
      const rss = readRssMb(child.pid!, "VmRSS") ?? 0;
      peak = Math.max(peak, readRssMb(child.pid!, "VmHWM") ?? rss);
      // A hosted worker holds no model (~100 MB): the memory guards are for local models.
      if (m.hosted) return;
      if (rss > maxRssMb) {
        console.error(`[${m.short}] RSS ${rss} MB exceeds --max-rss-mb ${maxRssMb}; stopping this model.`);
        child.kill("SIGKILL");
      } else if (readMemAvailableMb() < 600) {
        console.error(`[${m.short}] system MemAvailable below 600 MB; stopping this model.`);
        child.kill("SIGKILL");
      }
    }, 500);
    let buffer = "";
    let lastLog = 0;
    const usdBefore = runUsd;
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
          runUsd += event.costUsd ?? 0;
          const now = performance.now();
          if (event.error || event.done === event.total || now - lastLog > 15_000) {
            lastLog = now;
            const elapsed = (now - t0) / 1000;
            const eta = (elapsed / event.done) * (event.total - event.done);
            const cost = m.hosted ? `, ${(runUsd - usdBefore).toFixed(4)} USD for this model (${(hostedSpent + runUsd).toFixed(4)} USD in all)` : `, rss ${readRssMb(child.pid!, "VmRSS") ?? "?"} MB`;
            console.log(`[${m.short}] ${event.done}/${event.total} ${event.caseId} ${event.reviewMs} ms${event.error ? ` (${event.error})` : ""} · elapsed ${fmt(elapsed)}, eta ${fmt(eta)}${cost}`);
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
      if (hostedModel) void releaseHostedModel(hostedModel);
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
  const usage = { requests: 0, inputTokens: 0, outputTokens: 0, usd: 0, prompts: 0 };
  for (const job of jobsByModel.get(m.id)!) {
    const record = cache.get(job.key);
    if (!record) {
      missing++;
      continue;
    }
    usage.prompts++;
    for (const chunk of record.chunks)
      if (chunk.usage) {
        usage.requests++;
        usage.inputTokens += chunk.usage.inputTokens;
        usage.outputTokens += chunk.usage.outputTokens;
        usage.usd += chunk.usage.costUsd;
      }

    const c = byId.get(job.caseId)!;
    rows.push(scoreResult(c, profiles.get(c.profile)!, record, builtin, api.composeReviewInstructions(job.systemInstruction, job.rules), api.kind === "completion"));
  }
  const mm = modelMeta.find((x) => x.id === m.id);
  if (m.hosted && mm && usage.prompts)
    mm.hosted = { requests: usage.requests, inputTokens: usage.inputTokens, outputTokens: usage.outputTokens, usd: Math.round(usage.usd * 1e6) / 1e6, usdPer1000Prompts: Math.round((usage.usd / usage.prompts) * 1000 * 1e4) / 1e4 };
}
const finishedAt = new Date();
const meta: RunMeta = {
  name: runName,
  tier,
  split: splitLabel(options),
  cases: cases.length,
  instructions: instructions.map((i) => i.id),
  labelVariants,
  models: modelMeta,
  ext: { ref: ext.ref, sha: ext.sha, subject: ext.subject, committedAt: ext.committedAt, transformersRange: ext.transformersRange },
  datasetHash: dataset.hash,
  runtime: `onnxruntime-web WASM (q8) in Node ${process.versions.node} via @huggingface/transformers; deterministic greedy decoding; generation budget ${api.generationBudgetMs / 1000} s per request (from the ref)${models.some((m) => m.hosted) ? `; hosted models: Amazon Bedrock Converse or an OpenAI-compatible API (temperature 0, topK 1 on Bedrock, 48-token cap or the model's own, first line), latency per request network included, throttling retries excluded` : ""}`,
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
