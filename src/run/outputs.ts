/** Writes and reads the outputs of one run (`runs/<name>/`, git-ignored). */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { RUNS_DIR } from "../paths.ts";
import { renderReport } from "../report/html.ts";
import { summarize, toCsv } from "../score/aggregate.ts";
import type { Scored } from "../score/score.ts";
import type { RunMeta } from "./meta.ts";

/**
 * Writes a run's outputs: `run.json`, `results.jsonl`,
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

/**
 * Why `dir` cannot be read as a run, or undefined when it has a `run.json`.
 * Run outputs are git-ignored and stay on the machine that wrote them, so a
 * fresh clone has none: the message says so and how to produce the run with
 * `command` (for example `npm run detbench`), at the commit sha the run's name
 * carries when it has one (`main-4d68779`, `ext-d42c466-tune96-smol360`).
 */
export function missingRun(dir: string, command: string): string | undefined {
  if (existsSync(join(dir, "run.json"))) return undefined;
  const name = basename(dir);
  const sha = /(?:^|-)([0-9a-f]{7,40})(?=-|$)/.exec(name)?.[1];
  return [
    `no run at ${dir}`,
    `Run outputs are git-ignored and stay on the machine that wrote them (${RUNS_DIR}), so a fresh clone has none.`,
    `Produce it with: ${command} -- --ref ${sha ?? "<ref>"} --name ${name} (plus any options it was first run with), or copy the folder from the machine that has it.`,
  ].join("\n");
}
