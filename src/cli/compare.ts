/**
 * Compares two runs config by config (same model / instruction / label
 * variant), restricted to the cases both runs share, overall and by language.
 *   npm run compare -- runs/<A> runs/<B> [--out compare.html]
 * Writes an HTML page (default runs/compare-<A>-vs-<B>.html) and prints a text table.
 */
import { writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { RUNS_DIR } from "../paths.ts";
import { COMPARE_METRICS, compareRows } from "../report/compare-data.ts";
import { esc, pct, STYLE } from "../report/html.ts";
import { missingRun, readRun } from "../run/outputs.ts";

const [aDir, bDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!aDir || !bDir) {
  console.error(
    "usage: npm run compare -- runs/<A> runs/<B> [--out file.html]",
  );
  process.exit(2);
}
for (const dir of [aDir, bDir]) {
  const missing = missingRun(resolve(dir), "npm run bench");
  if (missing) {
    console.error(missing);
    process.exit(2);
  }
}
const outIndex = process.argv.indexOf("--out");
const a = readRun(resolve(aDir));
const b = readRun(resolve(bDir));
const { shared, rows } = compareRows(a.rows, b.rows);
const arrow = (d: number) => (d > 0 ? "▲" : d < 0 ? "▼" : "");

const htmlRows = rows.map(
  (r) =>
    `<tr><td>${esc(r.config)}</td><td>${r.slice}</td><td class="num">${r.cases}</td>${r.cells
      .map(
        (c) =>
          `<td class="num">${pct(c.a)} → ${pct(c.b)} <b>${arrow(c.direction)}</b>${c.delta === null ? "" : ` ${c.delta >= 0 ? "+" : ""}${(100 * c.delta).toFixed(0)}`}</td>`,
      )
      .join(
        "",
      )}<td class="num">${r.latencyP50[0] ?? "–"} → ${r.latencyP50[1] ?? "–"} ms</td></tr>`,
);
const text = [
  `A = ${a.meta.name} (${a.meta.ext.sha.slice(0, 7)})  B = ${b.meta.name} (${b.meta.ext.sha.slice(0, 7)})  shared results: ${shared}`,
  ...rows.map(
    (r) =>
      `${r.config.padEnd(44)} ${r.slice.padEnd(3)} ${r.cells.map((c, i) => `${COMPARE_METRICS[i]!.name} ${pct(c.a)}→${pct(c.b)}`).join("  ")}`,
  ),
];

const out =
  outIndex >= 0
    ? resolve(process.argv[outIndex + 1]!)
    : join(RUNS_DIR, `compare-${basename(aDir)}-vs-${basename(bDir)}.html`);
writeFileSync(
  out,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bench Comparison</title><style>${STYLE}</style></head><body><main>
<h1>Run comparison</h1>
<p><b>A</b> ${esc(a.meta.name)}: <code>${esc(a.meta.ext.ref)}</code> @ <code>${esc(a.meta.ext.sha.slice(0, 10))}</code>, dataset <code>${esc(a.meta.datasetHash.slice(0, 12))}</code><br><b>B</b> ${esc(b.meta.name)}: <code>${esc(b.meta.ext.ref)}</code> @ <code>${esc(b.meta.ext.sha.slice(0, 10))}</code>, dataset <code>${esc(b.meta.datasetHash.slice(0, 12))}</code></p>
<p>Only (configuration, case) pairs present in both runs are compared (${shared} results). ▲ better, ▼ worse; deltas in percentage points.</p>
<div class="scroll"><table><thead><tr><th>Config</th><th>Slice</th><th class="num">Cases</th>${COMPARE_METRICS.map((m) => `<th class="num">${m.name}</th>`).join("")}<th class="num">p50 latency</th></tr></thead><tbody>${htmlRows.join("")}</tbody></table></div>
</main></body></html>`,
);
console.log(text.join("\n"));
console.log(`\nwrote ${out}`);
