/**
 * Static, self-contained HTML report for one run (no external assets).
 * Tables are the primary view; single-hue meter bars only show magnitude.
 */
import { readFileSync } from "node:fs";
import { HOSTED_MODELS } from "../hosted/models.ts";
import { MODELS_FILE } from "../paths.ts";
import { DIMENSIONS, summarize, type ConfigSummary, type Metrics } from "../score/aggregate.ts";
import { FAILURE_MODES, type Scored } from "../score/score.ts";
import type { RunMeta } from "../run/meta.ts";

interface ModelMeta {
  id: string;
  short: string;
  extensionLabel: string;
  weightsBytes: number;
  languages: { advertised: string[]; fr: string; summary: string; source: string };
}
export const loadModelsMeta = (): ModelMeta[] => [
  ...(JSON.parse(readFileSync(MODELS_FILE, "utf8")) as { models: ModelMeta[] }).models,
  ...HOSTED_MODELS.map((h) => ({ id: h.id, short: h.short, extensionLabel: "hosted", weightsBytes: 0, languages: h.languages })),
];

export const esc = (s: unknown) =>
  String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
export const pct = (v: number | null | undefined) => (v === null || v === undefined ? "–" : `${(100 * v).toFixed(0)}%`);
const ms = (v: number | null) => (v === null ? "–" : v >= 10_000 ? `${(v / 1000).toFixed(0)} s` : `${(v / 1000).toFixed(1)} s`);
/** A percentage cell with a meter bar. `invert` for metrics where lower is better. */
export const meter = (v: number | null | undefined, invert = false) =>
  v === null || v === undefined
    ? `<td class="num muted">–</td>`
    : `<td class="num"><span class="meter${invert ? " inv" : ""}"><span style="width:${Math.round(100 * v)}%"></span></span>${pct(v)}</td>`;

export const STYLE = `
:root{--bg:#fbfbfa;--surface:#ffffff;--ink:#1d1f23;--ink2:#4a4f57;--muted:#7a808a;--line:#e3e5e8;--bar:#3b6fb6;--bar-bg:#e8edf5;--bad:#b4442f;--bad-bg:#f6e6e2;--code:#f3f4f6}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--bg:#15171a;--surface:#1c1f23;--ink:#e8eaed;--ink2:#b9bec6;--muted:#8a919b;--line:#30343a;--bar:#6f9be0;--bar-bg:#27303d;--bad:#e0826e;--bad-bg:#3a2723;--code:#23272c}}
:root[data-theme="dark"]{--bg:#15171a;--surface:#1c1f23;--ink:#e8eaed;--ink2:#b9bec6;--muted:#8a919b;--line:#30343a;--bar:#6f9be0;--bar-bg:#27303d;--bad:#e0826e;--bad-bg:#3a2723;--code:#23272c}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:17px;margin:36px 0 8px;padding-top:8px;border-top:1px solid var(--line)}h3{font-size:14px;margin:20px 0 6px;color:var(--ink2)}
p,li{color:var(--ink2);max-width:80ch}.muted{color:var(--muted)}
code{background:var(--code);padding:1px 4px;border-radius:4px;font-size:12.5px}
.scroll{overflow-x:auto;margin:8px 0}
table{border-collapse:collapse;background:var(--surface);font-size:12.5px;min-width:100%}
th,td{padding:5px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top;white-space:nowrap}
th{font-weight:600;color:var(--ink2);position:sticky;top:0;background:var(--surface)}
td.num,th.num{text-align:right;font-variant-numeric:tabular-nums}
.meter{display:inline-block;width:46px;height:6px;border-radius:3px;background:var(--bar-bg);margin-right:6px;vertical-align:middle;overflow:hidden}
.meter span{display:block;height:100%;background:var(--bar);border-radius:3px}
.meter.inv span{background:var(--bad)}
.kv{display:grid;grid-template-columns:max-content 1fr;gap:2px 16px;font-size:13px}.kv div:nth-child(odd){color:var(--muted)}
details{margin:6px 0;background:var(--surface);border:1px solid var(--line);border-radius:6px;padding:6px 10px}
summary{cursor:pointer;color:var(--ink2)}
pre{white-space:pre-wrap;word-break:break-word;background:var(--code);padding:8px;border-radius:6px;font-size:12px;max-height:260px;overflow:auto}
.tag{display:inline-block;padding:0 6px;border-radius:10px;background:var(--bar-bg);font-size:11.5px;margin-right:4px}
.tag.bad{background:var(--bad-bg);color:var(--bad)}
`;

const configHeader = `<th>Model</th><th>Instruction</th><th>Labels</th>`;
const configCells = (s: ConfigSummary) =>
  `<td>${esc(s.model.replace(/^.*\//, "").replace(/-ONNX$/, ""))}</td><td>${esc(s.instruction)}</td><td>${esc(s.labelVariant)}</td>`;

const headlineCells = (m: Metrics) =>
  `<td class="num">${m.cases}</td>${meter(m.overlap.f1)}${meter(m.overlap.precision)}${meter(m.overlap.recall)}${meter(m.exact.f1)}${meter(m.caseDetection)}${meter(m.falsePositiveRate, true)}${meter(m.compliance)}<td class="num">${m.timeouts}</td><td class="num">${ms(m.latencyP50)}</td><td class="num">${ms(m.latencyP95)}</td><td class="num">${m.meanGeneratedTokens?.toFixed(1) ?? "–"}</td>`;
const headlineHeader = `<th class="num">Cases</th><th class="num">F1 (overlap)</th><th class="num">Precision</th><th class="num">Recall</th><th class="num">F1 (exact)</th><th class="num">Case detection</th><th class="num">FP rate (negatives)</th><th class="num">Format OK</th><th class="num">Timeouts</th><th class="num">p50</th><th class="num">p95</th><th class="num">Gen. tokens</th>`;

function langSection(summaries: ConfigSummary[], models: ModelMeta[]): string {
  const rows: string[] = [];
  for (const s of summaries) {
    const meta = models.find((m) => m.id === s.model);
    for (const [value, m] of Object.entries(s.breakdowns.langMixed ?? {})) {
      const lang = value.split("+")[0]!;
      const support = lang === "en" ? "advertised" : (meta?.languages.fr ?? "?");
      rows.push(
        `<tr>${configCells(s)}<td>${esc(value)}</td><td><span class="tag${support === "advertised" ? "" : " bad"}">${esc(support)}</span></td><td class="num">${m.cases}</td>${meter(m.overlap.f1)}${meter(m.overlap.recall)}${meter(m.caseDetection)}${meter(m.falsePositiveRate, true)}${meter(m.compliance)}<td class="num">${ms(m.latencyP50)}</td></tr>`,
      );
    }
  }
  const cards = models
    .map((m) => `<li><b>${esc(m.short)}</b> (${esc(m.extensionLabel)}): ${esc(m.languages.summary)} <a href="${esc(m.languages.source)}">model card</a></li>`)
    .join("");
  return `<h2 id="language">Results by language vs advertised support</h2>
<p>Advertised language support comes from each model card (see <code>models/models.json</code>). <code>fr+mixed</code> rows are French cases that mix in English codenames, code or franglais.</p>
<ul>${cards}</ul>
<div class="scroll"><table><thead><tr>${configHeader}<th>Language</th><th>Advertised</th><th class="num">Cases</th><th class="num">F1 (overlap)</th><th class="num">Recall</th><th class="num">Case detection</th><th class="num">FP rate</th><th class="num">Format OK</th><th class="num">p50</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

function failureSection(summaries: ConfigSummary[]): string {
  const rows = summaries
    .map((s) => {
      const total = s.overall.cases || 1;
      return `<tr>${configCells(s)}${FAILURE_MODES.map((f) => meter(s.overall.failures[f] / total, f !== "ok")).join("")}<td class="num">${s.overall.builtinFindings}</td></tr>`;
    })
    .join("");
  return `<h2 id="failures">Output format and failure modes</h2>
<p>Share of cases per primary failure mode (first match wins, in column order after <code>ok</code>): <b>timeout</b> hit the ref's generation budget; <b>empty</b> produced no text; <b>echo</b> copied the prompt back; <b>echo_instructions</b> copied the label list or instructions back; <b>answered</b> answered or continued the prompt instead of scanning it; <b>unknown_label</b> used labels that are not configured; <b>hallucinated</b> used a configured label with a passage not found in the text (dropped by anchoring). <i>Built-in findings</i> counts accepted findings with EMAIL/PHONE/ADDRESS/API_KEY labels, which this dataset does not target.</p>
<div class="scroll"><table><thead><tr>${configHeader}${FAILURE_MODES.map((f) => `<th class="num">${f}</th>`).join("")}<th class="num">Built-in findings</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function labelSection(summaries: ConfigSummary[]): string {
  const rows = summaries
    .flatMap((s) =>
      Object.entries(s.byLabel).map(
        ([label, m]) =>
          `<tr>${configCells(s)}<td><code>${esc(label)}</code></td><td class="num">${m.exact.expected}</td><td class="num">${m.overlap.predicted}</td>${meter(m.overlap.precision)}${meter(m.overlap.recall)}${meter(m.overlap.f1)}${meter(m.exact.precision)}${meter(m.exact.recall)}${meter(m.exact.f1)}</tr>`,
      ),
    )
    .join("");
  return `<h2 id="labels">Per label (passage level)</h2>
<div class="scroll"><table><thead><tr>${configHeader}<th>Label</th><th class="num">Expected</th><th class="num">Predicted</th><th class="num">P overlap</th><th class="num">R overlap</th><th class="num">F1 overlap</th><th class="num">P exact</th><th class="num">R exact</th><th class="num">F1 exact</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function breakdownSection(summaries: ConfigSummary[]): string {
  const parts = DIMENSIONS.filter((d) => d.id !== "langMixed").map((dim) => {
    const values = [...new Set(summaries.flatMap((s) => Object.keys(s.breakdowns[dim.id] ?? {})))].sort();
    const rows = summaries
      .flatMap((s) =>
        values.map((v) => {
          const m = s.breakdowns[dim.id]?.[v];
          if (!m) return "";
          return `<tr>${configCells(s)}<td>${esc(v)}</td><td class="num">${m.cases}</td>${meter(m.overlap.f1)}${meter(m.overlap.recall)}${meter(m.caseDetection)}${meter(m.falsePositiveRate, true)}${meter(m.compliance)}<td class="num">${ms(m.latencyP50)}</td></tr>`;
        }),
      )
      .join("");
    return `<details><summary><b>${esc(dim.title)}</b></summary><div class="scroll"><table><thead><tr>${configHeader}<th>${esc(dim.title)}</th><th class="num">Cases</th><th class="num">F1 (overlap)</th><th class="num">Recall</th><th class="num">Case detection</th><th class="num">FP rate</th><th class="num">Format OK</th><th class="num">p50</th></tr></thead><tbody>${rows}</tbody></table></div></details>`;
  });
  return `<h2 id="breakdowns">Breakdowns</h2><p>Every metric split by profile, case type, difficulty, length and writing style. Small groups are noisy: check the case counts.</p>${parts.join("")}`;
}

function examplesSection(rows: Scored[], summaries: ConfigSummary[], perConfig = 6): string {
  const parts = summaries.map((s) => {
    const mine = rows.filter((r) => r.config === s.config);
    const pick = [
      ...mine.filter((r) => r.detected).slice(0, 2),
      ...mine.filter((r) => r.positive && !r.detected).slice(0, 2),
      ...mine.filter((r) => r.falsePositiveCase).slice(0, 1),
      ...mine.filter((r) => r.failure !== "ok" && !r.positive).slice(0, 1),
    ].slice(0, perConfig);
    const items = pick
      .map((r) => {
        const exp = r.expected.map((e) => `${e.label}: ${e.passage}${e.overlap ? " ✓" : " ✗"}`).join("\n") || "(negative)";
        const pred = r.predicted.map((p) => `${p.label}: ${p.value}${p.overlap ? " ✓" : " ✗"}`).join("\n") || "(none)";
        return `<details><summary><code>${esc(r.caseId)}</code> <span class="tag">${esc(r.type)}</span><span class="tag${r.failure === "ok" ? "" : " bad"}">${esc(r.failure)}</span> ${r.detected ? "detected" : r.falsePositiveCase ? "false positive" : ""} · ${ms(r.reviewMs)}</summary><h3>Expected</h3><pre>${esc(exp)}</pre><h3>Accepted findings</h3><pre>${esc(pred)}</pre><h3>Raw model output</h3><pre>${esc(r.raw || "(empty)")}</pre></details>`;
      })
      .join("");
    return `<h3>${esc(s.config)}</h3>${items || '<p class="muted">No cases.</p>'}`;
  });
  return `<h2 id="examples">Sample raw outputs</h2><p>A few hits, misses and false positives per configuration. Every raw output is in <code>results.jsonl</code>.</p>${parts.join("")}`;
}

export function renderReport(meta: RunMeta, rows: Scored[]): string {
  const summaries = summarize(rows);
  const models = loadModelsMeta();
  const headline = summaries.map((s) => `<tr>${configCells(s)}${headlineCells(s.overall)}</tr>`).join("");
  const modelRows = meta.models
    .map(
      (m) =>
        `<tr><td>${esc(m.id.replace(/^.*\//, ""))}</td><td class="num">${m.jobs}</td><td class="num">${m.computed}</td><td class="num">${m.loadMs === undefined ? "cached" : ms(m.loadMs)}</td><td class="num">${m.peakRssMb === undefined ? "–" : `${m.peakRssMb} MB`}</td><td class="num">${m.wallMs === undefined ? "–" : ms(m.wallMs)}</td><td class="num">${m.hosted ? `${m.hosted.usd.toFixed(4)} USD (${m.hosted.usdPer1000Prompts.toFixed(4)} per 1,000 prompts, ${m.hosted.requests} requests)` : "–"}</td></tr>`,
    )
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Review Bench ${esc(meta.name)}</title><style>${STYLE}</style></head><body><main>
<h1>InsustyReviewBench: ${esc(meta.name)}</h1>
<p class="muted">Local AI review benchmark · tier <b>${esc(meta.tier)}</b> · split ${esc(meta.split)} · ${meta.cases} cases · ${rows.length} results · generated ${esc(meta.finishedAt)}</p>
<div class="kv">
<div>Extension ref</div><div><code>${esc(meta.ext.ref)}</code> @ <code>${esc(meta.ext.sha.slice(0, 10))}</code> “${esc(meta.ext.subject)}” (${esc(meta.ext.committedAt)})</div>
<div>Dataset</div><div><code>${esc(meta.datasetHash.slice(0, 12))}</code></div>
<div>Runtime</div><div>${esc(meta.runtime)}</div>
<div>Machine</div><div>${esc(meta.machine)}</div>
<div>Axes</div><div>models: ${esc(meta.models.map((m) => m.id.replace(/^.*\//, "")).join(", "))} · instructions: ${esc(meta.instructions.join(", "))} · label descriptions: ${esc(meta.labelVariants.join(", "))}</div>
${meta.incomplete ? `<div>Status</div><div><span class="tag bad">incomplete: ${meta.incomplete} job(s) missing</span></div>` : ""}
</div>
<h2 id="summary">Summary</h2>
<p><b>F1/precision/recall</b> are passage-level: a passage counts as found when an accepted finding with the right label overlaps it (<i>exact</i>: identical text). <b>Case detection</b>: positive cases with at least one expected passage found. <b>FP rate</b>: negative cases with any custom-label finding. <b>Format OK</b>: output is only valid <code>LABEL: passage</code> lines or <code>NONE</code>. Latency is per case on WASM, instruction prefix already prepared.</p>
<div class="scroll"><table><thead><tr>${configHeader}${headlineHeader}</tr></thead><tbody>${headline}</tbody></table></div>
<h3>Per model</h3>
<div class="scroll"><table><thead><tr><th>Model</th><th class="num">Jobs</th><th class="num">Computed this run</th><th class="num">Load</th><th class="num">Peak RSS</th><th class="num">Wall time</th><th class="num">API cost</th></tr></thead><tbody>${modelRows}</tbody></table></div>
${langSection(summaries, models)}
${failureSection(summaries)}
${labelSection(summaries)}
${breakdownSection(summaries)}
${examplesSection(rows, summaries)}
<h2>Method</h2><p>See the repository README and <code>docs/</code>. The instruction variants are listed in <code>src/variants.ts</code>; the label descriptions are built from <code>dataset/profiles/*.json</code>.</p>
</main></body></html>`;
}
