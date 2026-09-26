import { fileURLToPath } from "node:url";
import { join } from "node:path";

/** Repository root, resolved from this file so commands work from any cwd. */
export const ROOT = fileURLToPath(new URL("..", import.meta.url));
export const DATASET_DIR = join(ROOT, "dataset");
export const PROFILES_DIR = join(DATASET_DIR, "profiles");
export const CASES_DIR = join(DATASET_DIR, "cases");
export const CACHE_DIR = join(ROOT, "cache");
export const MODEL_CACHE_DIR = join(CACHE_DIR, "models");
export const EXT_CACHE_DIR = join(CACHE_DIR, "ext");
export const RESULT_CACHE_DIR = join(CACHE_DIR, "results");
/** One JSON file per bench process in progress (pid, name, argv), for the dashboard. */
export const ACTIVE_RUNS_DIR = join(CACHE_DIR, "active-runs");
export const RUNS_DIR = join(ROOT, "runs");
export const MODELS_FILE = join(ROOT, "models", "models.json");
export const LOCAL_CONFIG_FILE = join(ROOT, "bench.local.json");
