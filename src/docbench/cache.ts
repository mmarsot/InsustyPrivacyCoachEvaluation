/** The document bench's result cache and run folders, shared by the CLI and the (read-only) dashboard. */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, RUNS_DIR } from "../paths.ts";
import type { DocJobResult } from "./types.ts";

/**
 * Docbench runs, `runs/docbench/<name>/` (git-ignored, local; under
 * `BENCH_RUNS_DIR` when set).
 */
export const DOCBENCH_RUNS_DIR = join(RUNS_DIR, "docbench");
/** Cached docbench results, one JSONL file per extension commit. */
export const DOC_RESULTS_DIR = join(CACHE_DIR, "docbench", "results");
/** The docbench result cache of one extension commit. */
export const docCacheFile = (sha: string) =>
  join(DOC_RESULTS_DIR, `${sha}.jsonl`);

/** Cached results of one ref, by job key (the last line for a key wins). */
export function loadDocCache(sha: string): Map<string, DocJobResult> {
  const map = new Map<string, DocJobResult>();
  const file = docCacheFile(sha);
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, "utf8").split("\n"))
    if (line.trim())
      try {
        const r = JSON.parse(line) as DocJobResult;
        map.set(r.key, r);
      } catch {
        /* a line cut by a killed worker */
      }
  return map;
}
