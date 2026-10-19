/**
 * Re-renders a run's metrics and HTML report from its results.jsonl (for
 * example after changing the report code).
 *   npm run report -- results/runs/<name>
 */
import { resolve } from "node:path";
import { missingRun, readRun, writeRun } from "../outputs.ts";

const dir = process.argv[2];
if (!dir) {
  console.error("usage: npm run report -- results/runs/<name>");
  process.exit(2);
}
const missing = missingRun(resolve(dir), "npm run bench");
if (missing) {
  console.error(missing);
  process.exit(2);
}
const { meta, rows } = readRun(resolve(dir));
writeRun(resolve(dir), meta, rows);
console.log(`re-rendered ${dir}/report.html from ${rows.length} results`);
