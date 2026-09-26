/**
 * Compares two runs config by config (same model / instruction / label
 * variant), restricted to the cases both runs share, overall and by language.
 *   npm run compare -- runs/<A> runs/<B> [--out compare.html]
 * Writes an HTML page (default runs/compare-<A>-vs-<B>.html) and prints a text table.
 */
import { writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { RUNS_DIR } from "../paths.ts";
import { esc, pct, STYLE } from "../report/html.ts";
import { metrics, type Metrics } from "../score/aggregate.ts";
import type { Scored } from "../score/score.ts";
import { readRun } from "../run/outputs.ts";

const [aDir, bDir] = process.argv.slice(2).filter((a) => !a.startsWith("--"));
if (!aDir || !bDir) {
  console.error("usage: npm run compare -- runs/<A> runs/<B> [--out file.html]");
  process.exit(2);
}
const outIndex = process.argv.indexOf("--out");
const a = readRun(resolve(aDir));
const b = readRun(resolve(bDir));

const key = (r: Scored) => `${r.config}\u0000${r.caseId}`;
const bKeys = new Set(b.rows.map(key));
const aKeys = new Set(a.rows.map(key));
const aRows = a.rows.filter((r) => bKeys.has(key(r)));
const bRows = b.rows.filter((r) => aKeys.has(key(r)));
const configs = [...new Set(aRows.map((r) => r.config))];

const METRICS: Array<[string, (m: Metrics) => number | null, boolean]> = [
  ["F1 overlap", (m) => m.overlap.f1, true],
  ["Recall", (m) => m.overlap.recall, true],
  ["Precision", (m) => m.overlap.precision, true],
  ["Case detection", (m) => m.caseDetection, true],
  ["FP rate", (m) => m.falsePositiveRate, false],
  ["Format OK", (m) => m.compliance, true],
];
const slices: Array<[string, (r: Scored) => boolean]> = [
  ["all", () => true],
  ["en", (r) => r.lang === "en"],
  ["fr", (r) => r.lang === "fr"],
];

const htmlRows: string[] = [];
const text: string[] = [`A = ${a.meta.name} (${a.meta.ext.sha.slice(0, 7)})  B = ${b.meta.name} (${b.meta.ext.sha.slice(0, 7)})  shared results: ${aRows.length}`];
for (const config of configs)
  for (const [slice, filter] of slices) {
    const ma = metrics(aRows.filter((r) => r.config === config && filter(r)));
    const mb = metrics(bRows.filter((r) => r.config === config && filter(r)));
    if (!ma.cases) continue;
    const cells = METRICS.map(([, get, higherBetter]) => {
      const va = get(ma);
      const vb = get(mb);
      const delta = va === null || vb === null ? null : vb - va;
      const better = delta === null || Math.abs(delta) < 0.005 ? "" : (delta > 0) === higherBetter ? "▲" : "▼";
      return { va, vb, delta, better };
    });
    htmlRows.push(
      `<tr><td>${esc(config)}</td><td>${slice}</td><td class="num">${ma.cases}</td>${cells.map((c) => `<td class="num">${pct(c.va)} → ${pct(c.vb)} <b>${c.better}</b>${c.delta === null ? "" : ` ${c.delta >= 0 ? "+" : ""}${(100 * c.delta).toFixed(0)}`}</td>`).join("")}<td class="num">${ma.latencyP50 ?? "–"} → ${mb.latencyP50 ?? "–"} ms</td></tr>`,
    );
    text.push(`${config.padEnd(44)} ${slice.padEnd(3)} ${cells.map((c, i) => `${METRICS[i]![0]} ${pct(c.va)}→${pct(c.vb)}`).join("  ")}`);
  }

const out = outIndex >= 0 ? resolve(process.argv[outIndex + 1]!) : join(RUNS_DIR, `compare-${basename(aDir)}-vs-${basename(bDir)}.html`);
writeFileSync(
  out,
  `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Bench Comparison</title><style>${STYLE}</style></head><body><main>
<h1>Run comparison</h1>
<p><b>A</b> ${esc(a.meta.name)}: <code>${esc(a.meta.ext.ref)}</code> @ <code>${esc(a.meta.ext.sha.slice(0, 10))}</code>, dataset <code>${esc(a.meta.datasetHash.slice(0, 12))}</code><br><b>B</b> ${esc(b.meta.name)}: <code>${esc(b.meta.ext.ref)}</code> @ <code>${esc(b.meta.ext.sha.slice(0, 10))}</code>, dataset <code>${esc(b.meta.datasetHash.slice(0, 12))}</code></p>
<p>Only (configuration, case) pairs present in both runs are compared (${aRows.length} results). ▲ better, ▼ worse; deltas in percentage points.</p>
<div class="scroll"><table><thead><tr><th>Config</th><th>Slice</th><th class="num">Cases</th>${METRICS.map(([n]) => `<th class="num">${n}</th>`).join("")}<th class="num">p50 latency</th></tr></thead><tbody>${htmlRows.join("")}</tbody></table></div>
</main></body></html>`,
);
console.log(text.join("\n"));
console.log(`\nwrote ${out}`);
