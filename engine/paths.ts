/**
 * Every path the bench reads or writes, resolved from the repository root.
 *
 * - `cache/`: cheap to rebuild (module builds, model weights, dataset
 *   downloads, scratch files).
 * - `results/`: local and git-ignored like `cache/`, but costly to rebuild:
 *   run folders and the job caches (model answers, paid replies).
 *
 * Before the modules/datasets layout, run folders lived in `runs/` and the job
 * caches under `cache/`. A machine that still has them keeps using them
 * (`kept`), so nothing it computed becomes invisible or reruns.
 */
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

/** Repository root, resolved from this file so commands work from any cwd. */
export const ROOT = fileURLToPath(new URL("..", import.meta.url));
/** Redaction modules, one folder each (`modules/<id>/manifest.json`). */
export const MODULES_DIR = join(ROOT, "modules");
/** Datasets, one folder each (`datasets/<id>/manifest.json`, `contract.json`). */
export const DATASETS_ROOT = join(ROOT, "datasets");
/** The Private AI review dataset (its README has the schema). */
export const CUSTOM_DATASET_DIR = join(DATASETS_ROOT, "insusty-custom");
/** One `Profile` per file, `<profile>.json`. */
export const PROFILES_DIR = join(CUSTOM_DATASET_DIR, "profiles");
/** One `Case` per line, `<profile>.<lang>.jsonl`. */
export const CASES_DIR = join(CUSTOM_DATASET_DIR, "cases");
/** Fixed case sets of the review dataset (tune96, confirm48, heldout-test...). */
export const SETS_DIR = join(CUSTOM_DATASET_DIR, "sets");
/** The extension module's folder: lab, models, experiments. */
export const INSUSTY_DIR = join(MODULES_DIR, "insusty-privacy");
/** The lab's experiment log, report, ablations and run summaries (committed). */
export const EXPERIMENTS_DIR = join(INSUSTY_DIR, "lab", "experiments");
/**
 * Module builds, model weights, dataset downloads and scratch files: safe to
 * delete, rebuilt on demand.
 */
export const CACHE_DIR = join(ROOT, "cache");
/** Run folders and job caches: git-ignored, costly to rebuild. */
export const RESULTS_DIR = join(ROOT, "results");

/**
 * `next`, unless only the pre-restructure location `legacy` exists on this
 * machine: then `legacy`, so its results stay readable without a move.
 */
export function kept(next: string, legacy: string): string {
  return !existsSync(next) && existsSync(legacy) ? legacy : next;
}

/**
 * Downloaded model weights, shared by the bench, the lab and the playground.
 */
export const MODEL_CACHE_DIR = join(CACHE_DIR, "models");
/**
 * Per-job results of the review bench, one folder per extension commit sha
 * (`cacheFile`).
 */
export const RESULT_CACHE_DIR = kept(
  join(RESULTS_DIR, "jobs", "review"),
  join(CACHE_DIR, "results"),
);
/** One JSON file per bench process in progress (pid, name, argv), for the dashboard. */
export const ACTIVE_RUNS_DIR = join(CACHE_DIR, "active-runs");
/**
 * Run outputs, kept locally and git-ignored (they copy every case's text), so
 * a fresh clone has none; `BENCH_RUNS_DIR` sends them elsewhere (CI and
 * scratch runs).
 */
export const RUNS_DIR = process.env.BENCH_RUNS_DIR
  ? resolve(process.env.BENCH_RUNS_DIR)
  : kept(join(RESULTS_DIR, "runs"), join(ROOT, "runs"));
/**
 * Descriptions of insusty-privacy's local models (sizes, priors, advertised
 * languages); the ref decides which models exist.
 */
export const MODELS_FILE = join(INSUSTY_DIR, "models.json");
/** The prompt lab's generation caches (one file per model and dtype). */
export const LAB_CACHE_DIR = kept(
  join(RESULTS_DIR, "jobs", "lab"),
  join(CACHE_DIR, "lab"),
);
/**
 * Untracked machine-local settings, such as `extRepo`, the path to the
 * extension clone; never commit it.
 */
export const LOCAL_CONFIG_FILE = join(ROOT, "bench.local.json");
