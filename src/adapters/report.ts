/** Static HTML report of a literature run (runs/literature/<name>/report.html). */
import type { MachineProfile, ModuleInfo } from "../../contract/types.ts";
import { defangHtml } from "../detbench/defang.ts";
import { esc, pct, STYLE } from "../report/html.ts";
import type { AdapterScores } from "./score.ts";
import type { LabelTarget } from "./types.ts";

export interface LiteratureRun {
  name: string;
  argv: string[];
  contract: string;
  datasets: Array<{
    id: string;
    title: string;
    revision: string;
    split: string;
    cases: number;
    total: number;
    sample: { limit: number; seed: string } | null;
    files: Array<{ name: string; url: string; sha256: string }>;
    license: { spdx: string; url: string; note: string };
    homepage: string;
    citation: string;
    labelMap: Record<string, LabelTarget>;
  }>;
  results: Array<{
    system: ModuleInfo & { contract: string };
    dataset: string;
    split: string;
    config: string;
    scores: AdapterScores;
    native?: Record<string, number | null>;
    efficiency: { cases: number; computed: number; totalMs: number; p50Ms: number | null; p95Ms: number | null; charsPerSecond: number | null; rulesMs: number };
  }>;
  machine: MachineProfile;
  peakRssMb: number;
  startedAt: string;
  finishedAt: string;
}

const p1 = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${(100 * v).toFixed(1)}%`);
const target = (t: LabelTarget | undefined) => (!t || t === "out_of_scope" ? "out of scope" : "builtin" in t ? t.builtin.join(" | ") : `custom: ${t.custom}`);

export function renderLiteratureReport(run: LiteratureRun): string {
  const sections = run.datasets
    .map((d) => {
      const rows = run.results.filter((r) => r.dataset === d.id);
      const head = rows
        .map((r) => {
          const h = r.scores.headline;
          return `<tr><td>${esc(r.system.name)} <code>${esc(r.system.version)}</code></td><td>${esc(r.config)}</td><td class="num">${h.gold}</td><td class="num">${p1(h.recall)}</td><td class="num">${p1(h.recallTyped)}</td><td class="num">${p1(h.recallExact)}</td><td class="num">${p1(h.precision)}</td><td class="num"><b>${p1(h.f1)}</b></td><td class="num">${h.overRedactionPer1k?.toFixed(2) ?? "–"}</td>${r.native ? `<td>${Object.entries(r.native).map(([k, v]) => `${esc(k)} ${p1(v)}`).join("<br>")}</td>` : "<td>–</td>"}</tr>`;
        })
        .join("");
      const scope = rows
        .map((r) => `<tr><td>${esc(r.system.name)}</td><td>${esc(r.config)}</td><td class="num">${pct(r.scores.custom.recall)} of ${r.scores.custom.gold}</td><td class="num">${pct(r.scores.outOfScope.recall)} of ${r.scores.outOfScope.gold}</td><td class="num">${pct(r.scores.nativeTotal.recall)} of ${r.scores.nativeTotal.gold}</td></tr>`)
        .join("");
      const builtins = [...new Set(rows.flatMap((r) => Object.keys(r.scores.byBuiltin)))].sort();
      const per = builtins
        .map((b) => `<tr><td><code>${esc(b)}</code></td>${rows.map((r) => { const x = r.scores.byBuiltin[b]; return `<td class="num">${x ? `${pct(x.recall)} / ${pct(x.recallTyped)} (${x.gold})` : "–"}</td>`; }).join("")}</tr>`)
        .join("");
      const labels = Object.keys(rows[0]?.scores.byGoldLabel ?? {});
      const native = labels
        .map((l) => `<tr><td><code>${esc(l)}</code></td><td>${esc(target(d.labelMap[l]))}</td>${rows.map((r) => { const x = r.scores.byGoldLabel[l]; return `<td class="num">${x ? `${pct(x.recall)} (${x.gold})` : "–"}</td>`; }).join("")}</tr>`)
        .join("");
      const eff = rows
        .map((r) => `<tr><td>${esc(r.system.name)}</td><td>${esc(r.config)}</td><td class="num">${r.efficiency.cases}</td><td class="num">${(r.efficiency.totalMs / 1000).toFixed(2)} s</td><td class="num">${r.efficiency.p50Ms?.toFixed(2) ?? "–"} / ${r.efficiency.p95Ms?.toFixed(2) ?? "–"} ms</td><td class="num">${r.efficiency.charsPerSecond ? Math.round(r.efficiency.charsPerSecond).toLocaleString("en") : "–"}</td></tr>`)
        .join("");
      const cols = rows.map((r) => `<th>${esc(r.system.name)} · ${esc(r.config)}</th>`).join("");
      const unmapped = [...new Set(rows.flatMap((r) => r.scores.unmapped))];
      return `<h2 id="${esc(d.id)}">${esc(d.title)}</h2>
<p class="muted">${esc(d.split)} split, ${d.cases.toLocaleString("en")} cases${d.sample ? ` (seeded sample of ${d.total.toLocaleString("en")}; seed <code>${esc(d.sample.seed)}</code>)` : ""} · revision <code>${esc(d.revision.slice(0, 12))}</code> · licence <b>${esc(d.license.spdx)}</b>: ${esc(d.license.note)} · <a href="${esc(d.homepage)}">source</a> · files ${d.files.map((f) => `<code>${esc(f.name)}</code> sha256 <code>${esc(f.sha256.slice(0, 16))}…</code>`).join(", ")}</p>
<h3>Headline: gold the product's built-in labels cover</h3>
<table><tr><th>System</th><th>Config</th><th>Gold</th><th>Recall</th><th>Typed</th><th>Exact</th><th>Precision</th><th>F1</th><th>Over-redaction / 1k chars</th><th>Benchmark-native</th></tr>${head}</table>
<h3>Outside the headline</h3>
<p class="muted">Custom-label gold is Private AI territory (names, organisations); out-of-scope gold has no rule in the product. Both still count in the benchmark-native total. A mask there came from a built-in rule that overlapped it.</p>
<table><tr><th>System</th><th>Config</th><th>Custom-label gold masked</th><th>Out-of-scope gold masked</th><th>Native total masked</th></tr>${scope}</table>
<h3>Per built-in label (recall / typed recall, gold)</h3>
<table><tr><th>Label</th>${cols}</tr>${per}</table>
<details><summary>Per dataset label</summary><table><tr><th>Dataset label</th><th>Maps to</th>${cols}</tr>${native}</table>${unmapped.length ? `<p>Labels missing from the map (counted out of scope): ${unmapped.map((u) => `<code>${esc(u)}</code>`).join(" ")}</p>` : ""}</details>
<h3>Efficiency</h3>
<p class="muted">Machine profile <code>${esc(run.machine.id)}</code>: ${esc(run.machine.cpu)}, ${run.machine.cores} cores, ${run.machine.ramMb.toLocaleString("en")} MB RAM, ${esc(run.machine.os)}. Absolute times compare only within one profile.</p>
<table><tr><th>System</th><th>Config</th><th>Cases</th><th>Total</th><th>p50 / p95 per case</th><th>Chars / s</th></tr>${eff}</table>
<p class="muted">${esc(d.citation)}</p>`;
    })
    .join("\n");
  return defangHtml(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Literature ${esc(run.name)}</title><style>${STYLE}td.num{text-align:right;white-space:nowrap}</style></head><body><main>
<h1>Literature benchmarks: ${esc(run.name)}</h1>
<p class="muted">Deterministic track · redaction contract ${esc(run.contract)} · Private AI off · generated ${esc(run.finishedAt)} · peak RSS ${run.peakRssMb} MB (${esc(run.machine.id)})</p>
<p>Recall counts a gold span as masked when a redacted span overlaps it; <i>typed</i> also needs a label the adapter's map accepts; <i>exact</i> the same boundaries. Precision counts a redacted span as right when it overlaps any span that must be masked. The headline covers only gold the product's built-in labels map to; everything else is reported below it and in the native total.</p>
${sections}
</main></body></html>`);
}
