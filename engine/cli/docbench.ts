/**
 * Document bench: runs an extension ref's file check (its own file readers,
 * detector and redaction) on generated Word, Excel, PowerPoint,
 * OpenDocument, PDF, text and zip files, and optionally its Private AI
 * review on documents of growing length.
 *
 *   npm run docbench -- [--ref main] [--compare <ref B> [--gate]] [--ext-repo <path>]
 *                       [--tier smoke|quick|full] [--tracks suite,sweep,ai]
 *                       [--formats docx,pdf,...] [--kinds positive,negative,failure]
 *                       [--sweep-types txt,csv,docx,xlsx,pptx,pdf,odt,ods,zip|all]
 *                       [--configs default,all] [--seed 1] [--reps 3]
 *                       [--ai [default,<local or connected model>,...]] [--ai-tier smoke|quick|full] [--budget-usd 5] [--ai-sizes 1000,5000,20000,50000]
 *                       [--name <run name>] [--max-rss-mb 3000] [--dry-run] [--cached-only]
 *   npm run bench -- --track docbench ...        (same arguments)
 *   npm run docbench -- --compare-runs results/runs/docbench/<A> results/runs/docbench/<B>
 *   npm run docbench -- --validate                (generate every case and check its ground truth)
 *
 * Documents are generated from the seed and `datasets/insusty-builtin/cases/` (nothing
 * binary is committed) and cached in `cache/docbench/files/`. Results are
 * cached per ref commit in `results/jobs/documents/<sha>.jsonl`; a rerun
 * computes only what is missing. Writes results/runs/docbench/<name>/ (report.html,
 * results.jsonl, sweeps.jsonl, metrics.json, metrics.csv, run.json and,
 * with --ai, ai.json).
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { compileDataset } from "../../datasets/insusty-custom/load.ts";
import { defangJson } from "../../datasets/insusty-builtin/defang.ts";
import type { DET_CATEGORIES } from "../../datasets/insusty-builtin/schema.ts";
import { mapCategory } from "../scorers/builtin-spans/detector.ts";
import {
  aiCases,
  aiJobs,
  aiSpecs,
  readAiDocs,
  scoreAi,
  summarizeAi,
  type AiPoint,
  type AiSummary,
} from "../../datasets/insusty-documents/ai.ts";
import {
  docCsv,
  powerFit,
  summarizeDocs,
  type DocSummary,
} from "../scorers/documents/aggregate.ts";
import {
  DOCBENCH_RUNS_DIR,
  docCacheFile,
  loadDocCache,
} from "../scorers/documents/cache.ts";
import { buildDoc } from "../../datasets/insusty-documents/cases.ts";
import { loadPools } from "../../datasets/insusty-documents/content.ts";
import { docRegressions } from "../../datasets/insusty-documents/gate.ts";
import {
  renderDocCompare,
  renderDocReport,
  docTextSummary,
  type DocRunMeta,
} from "../scorers/documents/report.ts";
import { suiteSpecs } from "../../datasets/insusty-documents/specs.ts";
import type {
  DocJob,
  DocJobResult,
} from "../../datasets/insusty-documents/types.ts";
import { independentViews, pdftotext } from "../scorers/documents/verify.ts";
import type { DocWorkerSpec } from "../workers/document.ts";
import {
  refReview,
  resolveExtRefName,
  resolveExtRepo,
  type RefReview,
} from "../../modules/insusty-privacy/ref.ts";
import { loadInsustyModule } from "../../modules/insusty-privacy/insusty.ts";
import { allLabelsConfig } from "../module.ts";
import { machineProfile } from "../machine.ts";
import { materializeModule } from "../../modules/insusty-privacy/materialize.ts";
import {
  connectedSpentUsd,
  findConnectedModel,
} from "../../modules/insusty-privacy/connected.ts";
import { findLabModel } from "../../modules/insusty-privacy/lab/models.ts";
import {
  readMemAvailableMb,
  runGuardedWorker,
  waitForMemory,
} from "../memory.ts";
import { ACTIVE_RUNS_DIR, CACHE_DIR } from "../paths.ts";
import { cacheFile, loadCache } from "../jobs.ts";
import { missingRun } from "../outputs.ts";
import {
  formatDuration as fmt,
  localModel,
  parseDocbenchArgs,
  planDocbench,
  type DocbenchOptions,
} from "../plan.ts";
import type { WorkerSpec } from "../workers/model.ts";

/** Rough seconds per job before anything is cached (suite: per case; sweeps: per point, by type). */
const PRIOR_SUITE_S = 0.15;
const PRIOR_SWEEP_S: Record<string, number> = {
  txt: 4,
  csv: 4,
  docx: 5,
  xlsx: 8,
  pptx: 6,
  pdf: 15,
  odt: 5,
  ods: 8,
  zip: 5,
};

interface RunOutput {
  meta: DocRunMeta;
  summary: DocSummary;
  ai?: AiSummary[];
}

const SUPPORTED = (refCategories: string[]) => [
  ...new Set(
    refCategories
      .map(mapCategory)
      .filter((c): c is (typeof DET_CATEGORIES)[number] => c !== null),
  ),
];

/**
 * Runs one ref's planned docbench jobs (cached ones reused), the Private AI
 * track when asked, and writes the run.
 */
async function runRef(
  o: DocbenchOptions,
  repo: string,
  refName: string,
  argv: string[],
): Promise<RunOutput | undefined> {
  const ref = await materializeModule(repo, refName);
  const module = await loadInsustyModule(ref);
  const moduleConfigs = {
    default: module.defaultConfig(),
    all: allLabelsConfig(module),
  };
  const limits = module.defaultConfig().limits ?? {};
  const plan = planDocbench(o, ref.sha);
  const cache = loadDocCache(ref.sha);
  const pendingSuite = plan.suite.filter((j) => !cache.has(j.key));
  const pendingSweeps = plan.sweeps.filter((j) => !cache.has(j.key));
  const sweepPrior = (j: DocJob) => {
    const sizes = plan.sweeps
      .filter((s) => s.sweep!.type === j.sweep!.type)
      .map((s) => s.sweep!.size);
    return (
      (PRIOR_SWEEP_S[j.sweep!.type] ?? 5) *
        (j.sweep!.size / Math.max(...sizes)) *
        o.reps +
      2
    );
  };
  const estimate =
    pendingSuite.length * PRIOR_SUITE_S +
    (pendingSuite.length ? 5 : 0) +
    pendingSweeps.reduce((n, j) => n + sweepPrior(j), 0);
  console.log(
    `Extension ${ref.ref} @ ${ref.sha.slice(0, 10)} "${ref.subject}"`,
  );
  console.log(
    `  packages ${Object.entries(ref.packages)
      .map(([k, v]) => `${k}@${v}`)
      .join(
        ", ",
      )}${ref.pdfium ? "" : " (no PDFium: PDFs are not read by this ref)"}`,
  );
  console.log(
    `  suite: ${plan.suite.length} documents (${pendingSuite.length} to compute); sweeps: ${plan.sweeps.length} points (${pendingSweeps.length} to compute); configs ${o.configs.join(",")}; seed ${o.seed}`,
  );
  console.log(`  estimated runtime without Private AI: ~${fmt(estimate)}`);

  // Private AI track: documents read now (cheap); the model jobs run below.
  let ai:
    | {
        ext: typeof ref;
        review: RefReview;
        docs: Awaited<ReturnType<typeof readAiDocs>>;
        dataset: NonNullable<ReturnType<typeof compileDataset>["dataset"]>;
      }
    | undefined;
  let aiModels = o.aiModels;
  let hostedEstimateUsd = 0;
  let hostedSpent = 0;
  if (o.tracks.includes("ai")) {
    const { dataset } = compileDataset({ requireSplit: true });
    if (!dataset) throw new Error("dataset is invalid: run `npm run validate`");
    const ext = ref;
    const review = await refReview(ext);
    if (o.aiDefault || !aiModels.length) {
      // The ref's own default model, as a new user gets it.
      const own = localModel(review.defaultModelId);
      aiModels = [own, ...aiModels.filter((m) => m.id !== own.id)];
    }
    const docs = await readAiDocs(
      aiSpecs(aiCases(dataset, o.aiTier), o.aiSizes),
      dataset,
      module,
      o.seed,
    );
    ai = { ext, review, docs, dataset };
    for (const m of aiModels) {
      const jobs = aiJobs(docs, dataset, ext, m.id);
      const done = loadCache(ext.sha, m.id);
      const pending = jobs.filter((j) => !done.has(j.key));
      console.log(
        `  Private AI ${m.short}: ${jobs.length} documents (${docs.length / o.aiSizes.length} cases x sizes ${o.aiSizes.join(",")} chars), ${pending.length} to compute`,
      );
      const h = m.hosted ? findConnectedModel(m.id) : undefined;
      if (h) {
        // Every label of every pending document in one request (the ref's 25,000-token connected budget covers these sizes), every answer at a 128-token cap.
        const requests = pending.flatMap((j) =>
          j.rules.map(
            (r) =>
              Math.ceil(
                (j.text.length +
                  r.prompt.length +
                  (r.examples ?? []).join(" | ").length +
                  200) /
                  3,
              ) + 20,
          ),
        );
        const inputTokens = requests.reduce((a, b) => a + b, 0);
        const usd =
          (inputTokens * h.usdPerMInput +
            requests.length * 128 * h.usdPerMOutput) /
          1e6;
        hostedEstimateUsd += usd;
        console.log(
          `    connected ${h.connection.provider} ${h.connection.model}: ~${inputTokens} input + <=${requests.length * 128} output tokens, <=${usd.toFixed(4)} USD`,
        );
      }
    }
    if (aiModels.some((m) => m.hosted)) {
      hostedSpent = connectedSpentUsd();
      console.log(
        `  Connected spend so far ${hostedSpent.toFixed(4)} USD + this run <=${hostedEstimateUsd.toFixed(4)} USD; budget ${o.budgetUsd} USD`,
      );
      if (
        !o.cachedOnly &&
        !o.dryRun &&
        hostedSpent + hostedEstimateUsd > o.budgetUsd
      )
        throw new Error(
          "The connected cost estimate would pass --budget-usd; nothing was sent.",
        );
    }
  }
  if (o.dryRun) return undefined;

  const startedAt = new Date();
  const runName =
    o.name ?? `${refName.replace(/[^\w.-]+/g, "-")}-${ref.sha.slice(0, 7)}`;
  mkdirSync(ACTIVE_RUNS_DIR, { recursive: true });
  const activeFile = join(ACTIVE_RUNS_DIR, `${process.pid}.json`);
  writeFileSync(
    activeFile,
    JSON.stringify({
      pid: process.pid,
      name: runName,
      argv: ["--track", "docbench", ...argv],
      track: "docbench",
      startedAt: startedAt.toISOString(),
    }),
  );
  const cleanup = () => rmSync(activeFile, { force: true });
  process.on("exit", cleanup);
  for (const signal of ["SIGINT", "SIGTERM"] as const)
    process.once(signal, () => {
      cleanup();
      process.exit(130);
    });
  const tmp = join(CACHE_DIR, "tmp");
  mkdirSync(tmp, { recursive: true });
  const supported = SUPPORTED(module.capabilities.builtins);
  const minFree = Number(process.env.BENCH_MIN_FREE_MB ?? 1500);
  /** Largest peak RSS of this run's document workers (MB). */
  let workerPeakMb = 0;
  const runWorker = async (label: string, jobs: DocJob[], needMb: number) => {
    for (
      let waited = 0;
      readMemAvailableMb() < needMb + minFree;
      waited += 15
    ) {
      if (waited >= Number(process.env.LAB_MEM_WAIT_S ?? 180)) {
        console.error(
          `[${label}] SKIPPED: only ${readMemAvailableMb()} MB available, need ${needMb + minFree} MB.`,
        );
        return;
      }
      console.log(
        `[${label}] waiting for memory: ${readMemAvailableMb()} MB available, need ${needMb + minFree} MB`,
      );
      await new Promise((r) => setTimeout(r, 15_000));
    }
    const spec: DocWorkerSpec = {
      ref,
      seed: o.seed,
      configs: o.configs,
      reps: label === "suite" ? 1 : o.reps,
      resultFile: docCacheFile(ref.sha),
      jobs,
      supported,
    };
    const specFile = join(tmp, `docbench-${process.pid}-${label}.json`);
    writeFileSync(specFile, JSON.stringify(spec));
    let last = 0;
    const peak = await runGuardedWorker(
      "engine/workers/document.ts",
      specFile,
      {},
      label,
      o.maxRssMb,
      (event) => {
        if (event.type === "result") {
          if (event.error)
            console.error(
              `[${label}] ${event.id}: ${String(event.error).split("\n")[0]}`,
            );
          else if (Date.now() - last > 10_000 || event.done === event.total) {
            last = Date.now();
            console.log(
              `[${label}] ${event.done}/${event.total} ${event.id} ${event.outcome} read ${event.readMs} ms${event.peakMb ? `, peak ${event.peakMb} MB` : ""}`,
            );
          }
        } else if (event.type === "fatal")
          console.error(`[${label}] worker failed: ${event.error}`);
      },
      { startupS: 120, idleS: 900 },
    );
    rmSync(specFile, { force: true });
    if (typeof peak === "number") workerPeakMb = Math.max(workerPeakMb, peak);
    return peak;
  };
  if (!o.cachedOnly) {
    if (pendingSuite.length) {
      console.log(`\n[suite] ${pendingSuite.length} documents`);
      await runWorker("suite", pendingSuite, 800);
    }
    for (const job of pendingSweeps) {
      const big =
        job.sweep!.size /
        Math.max(
          ...plan.sweeps
            .filter((s) => s.sweep!.type === job.sweep!.type)
            .map((s) => s.sweep!.size),
        );
      // Measured peaks on the full tier stay under ~600 MB (a 100,000-row sheet); the margin is added on top.
      await runWorker(job.id, [job], Math.round(250 + 450 * big));
    }
  }

  // ------------------------------------------------------------ Private AI
  let aiPoints: AiPoint[] = [];
  if (ai) {
    for (const m of aiModels) {
      const jobs = aiJobs(ai.docs, ai.dataset, ai.ext, m.id);
      const pending = jobs.filter(
        (j) => !loadCache(ai.ext.sha, m.id).has(j.key),
      );
      if (pending.length && !o.cachedOnly) {
        // A connected model holds no weights here.
        const labModel = m.hosted ? undefined : findLabModel(m.id);
        if (labModel && !(await waitForMemory(labModel, minFree))) continue;
        const spec: WorkerSpec = {
          ref,
          model: m.id,
          resultFile: cacheFile(ai.ext.sha, m.id),
          jobs: pending,
          ...(m.hosted ? { budgetUsd: o.budgetUsd } : {}),
          ...(ai.review.spanModelIds.includes(m.id) ? { spanModel: true } : {}),
        };
        const specFile = join(
          tmp,
          `docbench-ai-${process.pid}-${m.short}.json`,
        );
        writeFileSync(specFile, JSON.stringify(spec));
        console.log(`\n[ai ${m.short}] ${pending.length} documents`);
        await runGuardedWorker(
          "engine/workers/model.ts",
          specFile,
          {},
          `ai ${m.short}`,
          Math.max(o.maxRssMb, 3800),
          (event) => {
            if (event.type === "loaded")
              console.log(
                `[ai ${m.short}] loaded in ${(Number(event.loadMs) / 1000).toFixed(1)} s`,
              );
            else if (event.type === "result")
              console.log(
                `[ai ${m.short}] ${event.done}/${event.total} ${event.caseId} ${event.reviewMs} ms${event.costUsd !== undefined ? `, ${Number(event.costUsd).toFixed(5)} USD` : ""}${event.error ? ` (${event.error})` : ""}`,
              );
            else if (event.type === "fatal")
              console.error(`[ai ${m.short}] worker failed: ${event.error}`);
          },
          { startupS: 600, idleS: 3600 },
        );
        rmSync(specFile, { force: true });
      }
      aiPoints = [
        ...aiPoints,
        ...(await scoreAi(
          ai.docs,
          jobs,
          loadCache(ai.ext.sha, m.id),
          ai.dataset,
          ai.review,
        )),
      ];
    }
  }

  // ------------------------------------------------------------ report
  const results = loadDocCache(ref.sha);
  const rows = [...plan.suite, ...plan.sweeps]
    .map((j) => results.get(j.key))
    .filter((r): r is DocJobResult => !!r);
  const missing = plan.suite.length + plan.sweeps.length - rows.length;
  const summary = summarizeDocs(rows, o.configs, {
    ref: refName,
    sha: ref.sha,
  });
  const aiSummary = aiPoints.length
    ? summarizeAi(aiPoints, powerFit)
    : undefined;
  const pools = loadPools();
  const meta: DocRunMeta = {
    name: runName,
    argv,
    ext: {
      ref: refName,
      sha: ref.sha,
      subject: ref.subject,
      committedAt: ref.committedAt,
    },
    modules: ["insusty-prompt-coach/redaction"],
    packages: ref.packages,
    limits: Object.fromEntries(
      Object.entries(limits).filter(([k]) => k !== "fileReviewLimit"),
    ),
    fileReviewLimit: limits.fileReviewLimit ?? null,
    // The package does not export the threshold's choices (`FILE_REVIEW_LIMITS`).
    fileReviewLimits: null,
    tier: o.tier,
    seed: o.seed,
    configs: o.configs,
    configNote: Object.fromEntries(
      o.configs.map((c) => [
        c,
        Object.entries(moduleConfigs[c].builtins)
          .filter(([, on]) => !on)
          .map(([k]) => k),
      ]),
    ),
    reps: o.reps,
    datasetHash: pools.hash,
    suiteCases: plan.suite.length,
    sweepPoints: plan.sweeps.length,
    missing,
    verifier: { pdftotext: !!pdftotext() },
    ...(ai
      ? {
          ai: {
            models: aiModels.map((m) => m.id),
            ...(aiModels.some((m) => m.hosted)
              ? { budgetUsd: o.budgetUsd }
              : {}),
            sizes: o.aiSizes,
            tier: o.aiTier,
            bench: { sha: ai.ext.sha, kind: "completion" },
          },
        }
      : {}),
    node: process.versions.node,
    machine: `${cpus()[0]?.model ?? "cpu"} x${cpus().length}, ${(totalmem() / 2 ** 30).toFixed(1)} GiB RAM, ${process.platform}`,
    machineProfile: machineProfile(),
    contract: module.contract,
    ...(workerPeakMb ? { peakRssMb: workerPeakMb } : {}),
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
  };
  const dir = join(DOCBENCH_RUNS_DIR, runName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify(meta, null, 2) + "\n");
  const suiteRows = rows.filter((r) => r.track === "suite");
  writeFileSync(
    join(dir, "results.jsonl"),
    suiteRows.map((r) => defangJson(JSON.stringify(r))).join("\n") + "\n",
  );
  // Sweep rows without their item lists (counts are in metrics.json).
  writeFileSync(
    join(dir, "sweeps.jsonl"),
    rows
      .filter((r) => r.track === "sweep")
      .map((r) =>
        defangJson(
          JSON.stringify({
            ...r,
            items: undefined,
            itemsOmitted: r.items.length,
            decoys: undefined,
          }),
        ),
      )
      .join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "metrics.json"),
    defangJson(JSON.stringify(summary, null, 1)) + "\n",
  );
  writeFileSync(join(dir, "metrics.csv"), docCsv(summary));
  if (aiSummary)
    writeFileSync(
      join(dir, "ai.json"),
      JSON.stringify({ summary: aiSummary, points: aiPoints }, null, 1) + "\n",
    );
  else rmSync(join(dir, "ai.json"), { force: true });
  writeFileSync(
    join(dir, "report.html"),
    renderDocReport(meta, summary, suiteRows, aiSummary),
  );
  console.log(docTextSummary(meta, summary, aiSummary));
  console.log(
    `wrote ${join(dir, "report.html")}${missing ? ` (${missing} job(s) missing)` : ""}\n`,
  );
  cleanup();
  return { meta, summary, ...(aiSummary ? { ai: aiSummary } : {}) };
}

const readRunDir = (dir: string): RunOutput => {
  const aiFile = join(dir, "ai.json");
  return {
    meta: JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as DocRunMeta,
    summary: JSON.parse(
      readFileSync(join(dir, "metrics.json"), "utf8"),
    ) as DocSummary,
    ...(existsSync(aiFile)
      ? {
          ai: (
            JSON.parse(readFileSync(aiFile, "utf8")) as { summary: AiSummary[] }
          ).summary,
        }
      : {}),
  };
};

function writeCompare(a: RunOutput, b: RunOutput, out?: string): void {
  const file = out
    ? resolve(out)
    : join(DOCBENCH_RUNS_DIR, `compare-${a.meta.name}-vs-${b.meta.name}.html`);
  writeFileSync(file, renderDocCompare(a, b));
  const pct = (v: number | null | undefined) =>
    v === null || v === undefined ? "–" : `${(100 * v).toFixed(0)}%`;
  for (const c of a.meta.configs) {
    const x = a.summary.overall.configs[c];
    const y = b.summary.overall.configs[c];
    if (x && y)
      console.log(
        `[${c}] extraction ${pct(a.summary.overall.extractionRecall)} → ${pct(b.summary.overall.extractionRecall)} · recall ${pct(x.recall)} → ${pct(y.recall)} · precision ${pct(x.precision)} → ${pct(y.precision)} · leaks ${x.leaked} → ${y.leaked}`,
      );
  }
  console.log(
    `failure classification ${a.summary.overall.failures.ok}/${a.summary.overall.failures.cases} → ${b.summary.overall.failures.ok}/${b.summary.overall.failures.cases} · silent cleans ${a.summary.overall.failures.silentClean} → ${b.summary.overall.failures.silentClean}`,
  );
  console.log(`wrote ${file}`);
}

/** Generates every suite case and checks its ground truth: each placed value is in the file (independent reader), except where the case hides it on purpose. */
async function validate(seed: number): Promise<number> {
  const pools = loadPools();
  let problems = 0;
  for (const spec of suiteSpecs()) {
    const doc = await buildDoc(spec, pools, seed);
    if (spec.kind === "failure") continue;
    const views = independentViews(doc.bytes);
    const all = Object.values(views).join("\n").replace(/\s+/g, " ");
    const xml = all
      .replace(/&amp;/g, "&")
      .replace(/&lt;/g, "<")
      .replace(/&gt;/g, ">")
      .replace(/&quot;/g, '"');
    const values = doc.units
      .flatMap((u) => [...u.items, ...u.decoys])
      .map((v) => v.value.replace(/\s+/g, " "));
    // PDF text is drawn as glyph codes and wrapped, and split runs cut values across XML elements: no raw view sees them.
    const missing =
      spec.family === "pdf" || spec.zone === "split_runs"
        ? []
        : values.filter((v) => !xml.includes(v));
    if (!doc.units.length && spec.kind === "positive") {
      console.log(`${spec.id}: no unit placed`);
      problems++;
    }
    if (missing.length) {
      console.log(
        `${spec.id}: ${missing.length} value(s) not found in the generated file: ${missing.slice(0, 3).join(" | ")}`,
      );
      problems++;
    }
  }
  console.log(
    problems
      ? `${problems} problem(s)`
      : `docbench cases OK: ${suiteSpecs().length} specs, seed ${seed}`,
  );
  return problems ? 1 : 0;
}

/**
 * The docbench CLI as a function, so `npm run bench -- --track docbench` runs
 * it in process; resolves to the exit code.
 */
export async function main(argv: string[]): Promise<number> {
  const compareRuns = argv.indexOf("--compare-runs");
  if (compareRuns >= 0) {
    const [a, b] = argv.slice(compareRuns + 1, compareRuns + 3);
    if (!a || !b) {
      console.error(
        "usage: npm run docbench -- --compare-runs results/runs/docbench/<A> results/runs/docbench/<B> [--out file.html]",
      );
      return 2;
    }
    for (const dir of [a, b]) {
      const missing = missingRun(resolve(dir), "npm run docbench");
      if (missing) {
        console.error(missing);
        return 2;
      }
    }
    const outAt = argv.indexOf("--out");
    writeCompare(
      readRunDir(resolve(a)),
      readRunDir(resolve(b)),
      outAt >= 0 ? argv[outAt + 1] : undefined,
    );
    return 0;
  }
  let o: DocbenchOptions;
  try {
    o = parseDocbenchArgs(argv);
  } catch (error) {
    console.error((error as Error).message);
    return 2;
  }
  if (argv.includes("--validate")) return validate(o.seed);
  const repo = resolveExtRepo(o.extRepo);
  const refA = resolveExtRefName(o.ref);
  const a = await runRef(o, repo, refA, argv);
  if (o.compare) {
    const b = await runRef({ ...o, name: undefined }, repo, o.compare, argv);
    if (a && b) {
      writeCompare(a, b);
      if (argv.includes("--gate")) {
        const regressions = docRegressions(a.summary, b.summary);
        for (const r of regressions) console.error(`REGRESSION ${r}`);
        console.log(
          regressions.length
            ? `docbench gate: ${regressions.length} regression(s) against ${o.compare}`
            : `docbench gate: no regression against ${o.compare}`,
        );
        return regressions.length ? 1 : 0;
      }
    }
  }
  return 0;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  mkdirSync(DOCBENCH_RUNS_DIR, { recursive: true });
  process.exitCode = await main(process.argv.slice(2));
}
