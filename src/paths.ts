/**
 * Every path the bench reads or writes, resolved from the repository root. Only
 * `RUNS_DIR` moves (`BENCH_RUNS_DIR`); everything under `CACHE_DIR` is
 * reproducible and never committed.
 */
import { fileURLToPath } from "node:url";
import { join, resolve } from "node:path";

/** Repository root, resolved from this file so commands work from any cwd. */
export const ROOT = fileURLToPath(new URL("..", import.meta.url));
/**
 * The Private AI review dataset (`docs/dataset.md`); the detbench prompts live
 * in its `detbench/` folder.
 */
export const DATASET_DIR = join(ROOT, "dataset");
/** One `Profile` per file, `<profile>.json`. */
export const PROFILES_DIR = join(DATASET_DIR, "profiles");
/** One `Case` per line, `<profile>.<lang>.jsonl`. */
export const CASES_DIR = join(DATASET_DIR, "cases");
/**
 * Model weights, materialized refs and result caches: safe to delete, rebuilt
 * on demand.
 */
export const CACHE_DIR = join(ROOT, "cache");
/**
 * Downloaded model weights, shared by the bench, the lab and the playground.
 */
export const MODEL_CACHE_DIR = join(CACHE_DIR, "models");
/**
 * Per-job results of `npm run bench`, one folder per extension commit sha
 * (`cacheFile`).
 */
export const RESULT_CACHE_DIR = join(CACHE_DIR, "results");
/** One JSON file per bench process in progress (pid, name, argv), for the dashboard. */
export const ACTIVE_RUNS_DIR = join(CACHE_DIR, "active-runs");
/** Run outputs; `BENCH_RUNS_DIR` sends them elsewhere (CI and scratch runs, so the committed runs/ stays clean). */
export const RUNS_DIR = process.env.BENCH_RUNS_DIR
  ? resolve(process.env.BENCH_RUNS_DIR)
  : join(ROOT, "runs");
/**
 * Descriptions of the local models (sizes, priors, advertised languages); the
 * ref decides which models exist.
 */
export const MODELS_FILE = join(ROOT, "models", "models.json");
/**
 * Untracked machine-local settings, such as `extRepo`, the path to the
 * extension clone; never commit it.
 */
export const LOCAL_CONFIG_FILE = join(ROOT, "bench.local.json");
