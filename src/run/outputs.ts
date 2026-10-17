/** Writes and reads the committed outputs of one run (`runs/<name>/`). */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { renderReport } from "../report/html.ts";
import { summarize, toCsv } from "../score/aggregate.ts";
import type { Scored } from "../score/score.ts";
import type { RunMeta } from "./meta.ts";

/**
 * Writes a run's committed outputs: `run.json`, `results.jsonl`,
 * `metrics.json`, `metrics.csv` and `report.html`.
 */
export function writeRun(dir: string, meta: RunMeta, rows: Scored[]): void {
  mkdirSync(dir, { recursive: true });
  const summaries = summarize(rows);
  writeFileSync(join(dir, "run.json"), JSON.stringify(meta, null, 2) + "\n");
  writeFileSync(
    join(dir, "results.jsonl"),
    rows.map((r) => JSON.stringify(r)).join("\n") + "\n",
  );
  writeFileSync(
    join(dir, "metrics.json"),
    JSON.stringify(summaries, null, 1) + "\n",
  );
  writeFileSync(join(dir, "metrics.csv"), toCsv(summaries));
  writeFileSync(join(dir, "report.html"), renderReport(meta, rows));
}

/** Reads back what `writeRun` wrote, for reports and comparisons. */
export function readRun(dir: string): { meta: RunMeta; rows: Scored[] } {
  const meta = JSON.parse(
    readFileSync(join(dir, "run.json"), "utf8"),
  ) as RunMeta;
  const rows = readFileSync(join(dir, "results.jsonl"), "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Scored);
  return { meta, rows };
}
