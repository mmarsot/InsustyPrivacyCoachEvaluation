import type { MachineProfile } from "../../contract/types.ts";
/**
 * Static HTML report and text summary of a document-bench run, and the
 * comparison page of two runs (`--compare`). Charts are inline SVG (no
 * script, no network). Secret-looking values are defanged in the HTML.
 */
import { defangHtml } from "../detbench/defang.ts";
import type { AiSummary } from "./ai.ts";
import type {
  DocSummary,
  PowerFit,
  SweepPoint,
  ZoneMetrics,
} from "./aggregate.ts";
import type { DocJobResult } from "./types.ts";

export interface DocRunMeta {
  name: string;
  argv: string[];
  ext: { ref: string; sha: string; subject: string; committedAt: string };
  modules: string[];
  packages: Record<string, string>;
  limits: Record<string, unknown>;
  fileReviewLimit: number | null;
  fileReviewLimits: number[] | null;
  tier: string;
  seed: number;
  configs: Array<"default" | "all">;
  /** Categories each configuration leaves off. */
  configNote: Record<string, string[]>;
  reps: number;
  datasetHash: string;
  suiteCases: number;
  sweepPoints: number;
  missing: number;
  verifier: { pdftotext: boolean };
  ai?: {
    models: string[];
    budgetUsd?: number;
    sizes: number[];
    tier?: string;
    bench: { sha: string; kind: string };
  };
  node: string;
  machine: string;
  /** The machine profile absolute times and memory were measured on (runs since the redaction contract). */
  machineProfile?: MachineProfile;
  /** The redaction contract version the module was scored through. */
  contract?: string;
  /** Peak RSS of the bench process (detbench) or of its largest worker (docbench), MB. */
  peakRssMb?: number;
  startedAt: string;
  finishedAt: string;
}

const esc = (s: unknown) =>
  String(s ?? "").replace(
    /[&<>"]/g,
    (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]!,
  );
const pct = (v: number | null | undefined) =>
  v === null || v === undefined ? "–" : `${(100 * v).toFixed(0)}%`;
const num = (v: number | null | undefined, d = 1) =>
  v === null || v === undefined ? "–" : v.toFixed(d);
const ms = (v: number | null | undefined) =>
  v === null || v === undefined
    ? "–"
    : v < 1000
      ? `${v.toFixed(v < 10 ? 1 : 0)} ms`
      : `${(v / 1000).toFixed(1)} s`;
const big = (v: number) => v.toLocaleString("en");
const cls = (v: number | null | undefined, good = 0.9, warn = 0.6) =>
  v === null || v === undefined
    ? ""
    : v >= good
      ? "good"
      : v >= warn
        ? "warn"
        : "bad";

const STYLE = `<style>
:root{--bg:#fafaf8;--ink:#1d1f23;--muted:#6b717b;--line:#e3e5e8;--good:#2f7d4f;--good-bg:#e3f1e8;--warn:#9a6a12;--warn-bg:#f8edd6;--bad:#b4442f;--bad-bg:#f6e6e2;--accent:#3b6fb6;--code:#f1f2f4}
@media (prefers-color-scheme: dark){:root{--bg:#141619;--ink:#e8eaed;--muted:#9097a1;--line:#2e3238;--good:#6cc08f;--good-bg:#1f3328;--warn:#e0b458;--warn-bg:#3a3020;--bad:#e0826e;--bad-bg:#3a2723;--accent:#6f9be0;--code:#23272c}}
body{margin:0;background:var(--bg);color:var(--ink);font:14px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:16px 20px 60px}
h1{font-size:20px}h2{font-size:16px;margin:28px 0 8px;border-bottom:1px solid var(--line);padding-bottom:4px}h3{font-size:14px;margin:18px 0 6px}
p,li{color:var(--ink);max-width:95ch}.muted{color:var(--muted)}
table{border-collapse:collapse;font-size:12.5px;margin:6px 0 14px}th,td{padding:4px 8px;border-bottom:1px solid var(--line);text-align:left;vertical-align:top}
th{font-weight:600;color:var(--muted)}td.n,th.n{text-align:right;font-variant-numeric:tabular-nums}
td.good{color:var(--good)}td.warn{color:var(--warn)}td.bad{color:var(--bad);font-weight:600}
.chip{display:inline-block;padding:0 7px;border-radius:10px;font-size:11.5px;background:var(--code);margin:1px 2px}
.chip.ok{background:var(--good-bg);color:var(--good)}.chip.bad{background:var(--bad-bg);color:var(--bad)}.chip.warn{background:var(--warn-bg);color:var(--warn)}
code{background:var(--code);padding:1px 4px;border-radius:4px;font-size:12px}
.grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(360px,1fr));gap:14px}
.card{border:1px solid var(--line);border-radius:8px;padding:10px 12px}
svg text{fill:var(--muted);font-size:10px}svg .axis{stroke:var(--line)}svg .fit{stroke-dasharray:4 3;opacity:.6}
.scroll{overflow-x:auto}
</style>`;

const PALETTE = [
  "#3b6fb6",
  "#c2652a",
  "#2f8f5b",
  "#8a4fb5",
  "#b23a4f",
  "#4a8fa8",
  "#9a7b17",
  "#5d6b7a",
  "#d14d9b",
];

/** A log-log line chart: one series per name, optional fitted lines. */
export function logChart(
  series: Array<{
    name: string;
    points: Array<[number, number]>;
    fit?: PowerFit | null;
    scatter?: boolean;
  }>,
  opts: {
    xLabel: string;
    yLabel: string;
    width?: number;
    height?: number;
    yFormat?: (v: number) => string;
    hLines?: Array<{ y: number; label: string }>;
    vLines?: Array<{ x: number; label: string }>;
  },
): string {
  const W = opts.width ?? 420;
  const H = opts.height ?? 250;
  const L = 52;
  const B = 34;
  const all = series
    .flatMap((s) => s.points)
    .filter(([x, y]) => x > 0 && y > 0);
  if (!all.length) return `<p class="muted">no data</p>`;
  const xs = all.map(([x]) => x);
  const ys = [...all.map(([, y]) => y), ...(opts.hLines ?? []).map((h) => h.y)];
  const lx0 = Math.floor(Math.log10(Math.min(...xs)));
  const lx1 = Math.ceil(
    Math.log10(Math.max(...xs, ...(opts.vLines ?? []).map((v) => v.x))),
  );
  const ly0 = Math.floor(Math.log10(Math.min(...ys)));
  const ly1 = Math.ceil(Math.log10(Math.max(...ys)));
  const X = (x: number) =>
    L + ((Math.log10(x) - lx0) / Math.max(1, lx1 - lx0)) * (W - L - 10);
  const Y = (y: number) =>
    H - B - ((Math.log10(y) - ly0) / Math.max(1, ly1 - ly0)) * (H - B - 10);
  const fmtY =
    opts.yFormat ?? ((v: number) => (v >= 1000 ? `${v / 1000}k` : `${v}`));
  let svg = `<svg viewBox="0 0 ${W} ${H}" width="100%" role="img">`;
  for (let e = lx0; e <= lx1; e++)
    svg += `<line class="axis" x1="${X(10 ** e)}" x2="${X(10 ** e)}" y1="10" y2="${H - B}"/><text x="${X(10 ** e)}" y="${H - B + 13}" text-anchor="middle">${big(10 ** e)}</text>`;
  for (let e = ly0; e <= ly1; e++)
    svg += `<line class="axis" x1="${L}" x2="${W - 10}" y1="${Y(10 ** e)}" y2="${Y(10 ** e)}"/><text x="${L - 4}" y="${Y(10 ** e) + 3}" text-anchor="end">${fmtY(10 ** e)}</text>`;
  svg += `<text x="${(L + W) / 2}" y="${H - 4}" text-anchor="middle">${esc(opts.xLabel)}</text><text x="10" y="${(H - B) / 2}" transform="rotate(-90 10 ${(H - B) / 2})" text-anchor="middle">${esc(opts.yLabel)}</text>`;
  for (const h of opts.hLines ?? [])
    svg += `<line x1="${L}" x2="${W - 10}" y1="${Y(h.y)}" y2="${Y(h.y)}" stroke="#b4442f" stroke-dasharray="2 3"/><text x="${W - 12}" y="${Y(h.y) - 3}" text-anchor="end">${esc(h.label)}</text>`;
  for (const v of opts.vLines ?? [])
    svg += `<line x1="${X(v.x)}" x2="${X(v.x)}" y1="10" y2="${H - B}" stroke="#9a6a12" stroke-dasharray="2 3"/><text x="${X(v.x) + 3}" y="20">${esc(v.label)}</text>`;
  series.forEach((s, i) => {
    const color = PALETTE[i % PALETTE.length];
    const pts = s.points
      .filter(([x, y]) => x > 0 && y > 0)
      .sort((a, b) => a[0] - b[0]);
    if (s.fit && pts.length > 1) {
      const [x0, x1] = [pts[0]![0], pts[pts.length - 1]![0]];
      svg += `<line class="fit" x1="${X(x0)}" y1="${Y(s.fit.a * x0 ** s.fit.b)}" x2="${X(x1)}" y2="${Y(s.fit.a * x1 ** s.fit.b)}" stroke="${color}" stroke-width="1.5"/>`;
    }
    if (!s.scatter)
      svg += `<polyline fill="none" stroke="${color}" stroke-width="1.8" points="${pts.map(([x, y]) => `${X(x)},${Y(y)}`).join(" ")}"/>`;
    for (const [x, y] of pts)
      svg += `<circle cx="${X(x)}" cy="${Y(y)}" r="2.8" fill="${color}"><title>${esc(s.name)}: ${big(x)} → ${num(y, 1)}</title></circle>`;
  });
  svg += `</svg><div>${series.map((s, i) => `<span class="chip" style="color:${PALETTE[i % PALETTE.length]}">● ${esc(s.name)}${s.fit ? ` (b=${s.fit.b.toFixed(2)})` : ""}</span>`).join("")}</div>`;
  return svg;
}

function zoneTable(
  rows: ZoneMetrics[],
  configs: string[],
  title: string,
): string {
  return `<h3>${esc(title)}</h3><div class="scroll"><table><tr><th>Format</th><th>Zone</th><th class="n">Docs</th><th class="n">Values</th><th class="n" title="value present in the extracted text">Extracted</th>${configs
    .map(
      (c) =>
        `<th class="n" title="detected among extracted values">Detect. recall (${c})</th><th class="n" title="detected among all placed values">Recall (${c})</th><th class="n">Precision (${c})</th><th class="n">False alarms (${c})</th>`,
    )
    .join(
      "",
    )}<th class="n" title="values redacted leak-free that an independent reader still finds in the redacted output">Leaks</th><th>Redacted as</th><th class="n" title="cases whose read did not match the expectation">Misread</th></tr>${rows
    .map(
      (z) =>
        `<tr><td>${esc(z.family)}</td><td>${esc(z.zone)}</td><td class="n">${z.cases}</td><td class="n">${z.items}</td><td class="n ${cls(z.extractionRecall)}">${pct(z.extractionRecall)}</td>${configs
          .map((c) => {
            const m = z.configs[c]!;
            return `<td class="n ${cls(m.detectionRecall, 0.85, 0.6)}">${pct(m.detectionRecall)}</td><td class="n ${cls(m.recall, 0.85, 0.6)}">${pct(m.recall)}</td><td class="n ${cls(m.precision)}">${pct(m.precision)}</td><td class="n ${m.falseAlarms ? "warn" : ""}">${m.falseAlarms}</td>`;
          })
          .join(
            "",
          )}<td class="n ${Object.values(z.configs).some((m) => m.leaked) ? "bad" : ""}">${Math.max(...Object.values(z.configs).map((m) => m.leaked))}</td><td>${Object.entries(
          z.modes,
        )
          .map(
            ([k, v]) =>
              `<span class="chip ${k === "fallback_text_copy" ? "warn" : k === "error" ? "bad" : ""}">${esc(k)} ${v}</span>`,
          )
          .join(
            "",
          )}</td><td class="n ${z.misclassified ? "bad" : ""}">${z.misclassified}</td></tr>`,
    )
    .join("")}</table></div>`;
}

function sweepSection(s: DocSummary, configs: string[]): string {
  if (!s.sweeps.length) return "";
  const types = [...new Set(s.sweeps.map((p) => p.type))];
  const fitOf = (t: string) => s.fits.find((f) => f.type === t);
  const byUnit = new Map<string, string[]>();
  for (const t of types) {
    const u = s.sweeps.find((p) => p.type === t)!.unit;
    byUnit.set(u, [...(byUnit.get(u) ?? []), t]);
  }
  const charts = [...byUnit.entries()]
    .map(
      ([unit, ts]) =>
        `<div class="card"><h3>Total check time vs ${esc(unit)}</h3>${logChart(
          ts.map((t) => ({
            name: t,
            points: s.sweeps
              .filter((p) => p.type === t)
              .map((p) => [p.size, p.totalMs] as [number, number]),
            fit: fitOf(t)?.total,
          })),
          {
            xLabel: unit,
            yLabel: "ms (read + detect + redact)",
            yFormat: (v) => (v >= 1000 ? `${v / 1000}s` : `${v}ms`),
            hLines: [
              { y: 1000, label: "1 s" },
              { y: 5000, label: "5 s" },
            ],
          },
        )}</div>`,
    )
    .join("");
  const charsChart = `<div class="card"><h3>Time vs characters of extracted text (fully read documents)</h3>${logChart(
    types.map((t) => ({
      name: t,
      points: s.sweeps
        .filter((p) => p.type === t && p.outcome === "checked")
        .map((p) => [p.chars, p.totalMs] as [number, number]),
    })),
    {
      xLabel: "characters of text",
      yLabel: "ms",
      yFormat: (v) => (v >= 1000 ? `${v / 1000}s` : `${v}ms`),
    },
  )}</div><div class="card"><h3>Peak memory over baseline vs characters</h3>${logChart(
    types.map((t) => ({
      name: t,
      points: s.sweeps
        .filter((p) => p.type === t && p.outcome === "checked" && p.deltaMb)
        .map((p) => [p.chars, Math.max(1, p.deltaMb!)] as [number, number]),
    })),
    { xLabel: "characters of text", yLabel: "MB over the worker's baseline" },
  )}</div><div class="card"><h3>Read (extraction) vs detection time</h3>${logChart(
    [
      {
        name: "read",
        scatter: true,
        points: s.sweeps
          .filter((p) => p.outcome === "checked")
          .map((p) => [p.chars, p.readMs] as [number, number]),
      },
      {
        name: `detect (${configs[0]})`,
        scatter: true,
        points: s.sweeps
          .filter((p) => p.outcome === "checked")
          .map(
            (p) => [p.chars, p.detectMs[configs[0]!] ?? 0] as [number, number],
          ),
      },
      {
        name: "redact",
        scatter: true,
        points: s.sweeps
          .filter((p) => p.outcome === "checked" && p.redactMs)
          .map((p) => [p.chars, p.redactMs!] as [number, number]),
      },
    ],
    {
      xLabel: "characters of text",
      yLabel: "ms",
      yFormat: (v) => (v >= 1000 ? `${v / 1000}s` : `${v}ms`),
    },
  )}</div>`;
  const fitRows = s.fits
    .map(
      (f) =>
        `<tr><td>${esc(f.type)}</td><td>${esc(f.unit)}</td><td class="n">${f.total ? `${f.total.a.toPrecision(3)} · n<sup>${f.total.b.toFixed(2)}</sup>` : "–"}</td><td class="n">${num(f.total?.r2, 3)}</td><td class="n">${f.read ? f.read.b.toFixed(2) : "–"}</td><td class="n">${f.detect ? f.detect.b.toFixed(2) : "–"}</td><td class="n">${f.memory ? `${num(f.memory.c, 0)} + ${f.memory.k.toPrecision(2)}·n` : "–"}</td><td class="n">${num(f.msPerKChar, 2)}</td><td class="n">${f.sizeWithin1s !== null ? `${f.within1sAtLeast ? "≥ " : ""}${big(f.sizeWithin1s)}` : "–"}</td><td class="n">${f.sizeWithin5s !== null ? `${f.within5sAtLeast ? "≥ " : ""}${big(f.sizeWithin5s)}` : "–"}</td><td class="n">${f.capped?.length ? `<span class="chip warn">${f.capped.map(big).join(", ")}</span>` : ""}</td></tr>`,
    )
    .join("");
  const points = s.sweeps
    .map(
      (p: SweepPoint) =>
        `<tr><td>${esc(p.type)}</td><td class="n">${big(p.size)} ${esc(p.unit)}</td><td class="n">${big(Math.round(p.bytes / 1024))} KB</td><td class="n">${big(p.chars)}</td><td>${esc(p.outcome)}${p.gaps.length ? ` <span class="chip warn" title="${esc(p.gaps.join("; "))}">${p.gaps.length} gap(s)</span>` : ""}</td><td class="n">${ms(p.readMs)}</td>${configs.map((c) => `<td class="n">${ms(p.detectMs[c])}</td>`).join("")}<td class="n">${ms(p.redactMs)}</td><td>${esc(p.redactionMode)}</td><td class="n">${ms(p.totalMs)}</td><td class="n">${p.peakMb ?? "–"}</td><td class="n">${p.deltaMb ?? "–"}</td><td class="n">${p.extracted}/${p.items}</td>${configs.map((c) => `<td class="n">${p.found[c]}/${p.items}</td><td class="n">${p.falseAlarms[c]}</td>`).join("")}</tr>`,
    )
    .join("");
  return `<h2>Speed and scaling</h2>
<p>Each point is one document checked in its own worker process (median of the timing repetitions), with labelled values at a fixed density. Times are the ref's own steps: <b>read</b> (classify + extract), <b>detect</b> (rules on the whole text), <b>redact</b> (the attached version). Peak memory is the worker's high-water mark during the check minus its resident size before it (the kernel counter is reset per document). Fits are power laws on the log-log points of fully read documents; <i>b</i> ≈ 1 is linear. Sizes the ref read only in part (its 2 MB text cap, its entry cap) are listed as capped and left out of the fits; "≥" means the budget was not reached at the largest size measured.</p>
<div class="grid">${charts}${charsChart}</div>
<h3>Fitted scaling per type</h3><table><tr><th>Type</th><th>Size unit</th><th class="n">Total ms ≈ a · n<sup>b</sup></th><th class="n">R²</th><th class="n">b (read)</th><th class="n">b (detect)</th><th class="n">Peak MB ≈</th><th class="n">ms / 1k chars (largest)</th><th class="n">Size within 1 s</th><th class="n">Size within 5 s</th><th class="n" title="read only in part (a text or entry cap): left out of the fits">Capped sizes</th></tr>${fitRows}</table>
<h3>Points</h3><div class="scroll"><table><tr><th>Type</th><th class="n">Size</th><th class="n">File</th><th class="n">Chars</th><th>Read as</th><th class="n">Read</th>${configs.map((c) => `<th class="n">Detect (${c})</th>`).join("")}<th class="n">Redact</th><th>Redacted as</th><th class="n">Total</th><th class="n">Peak MB</th><th class="n">Δ MB</th><th class="n">Extracted</th>${configs.map((c) => `<th class="n">Found (${c})</th><th class="n">False alarms (${c})</th>`).join("")}</tr>${points}</table></div>`;
}

function aiSection(ai: AiSummary[] | undefined, meta: DocRunMeta): string {
  if (!ai?.length) return "";
  const limits = meta.fileReviewLimits ?? [];
  return `<h2>Private AI redaction on documents</h2>
<p>Dev-split custom-label cases of the review dataset, each in the middle of a Word document of the given length, read by the ref's reader and reviewed by the model through the bench's model runner with the ref's own <code>reviewPrompt</code> (on-device models: q8, WASM, greedy; connected models: the ref's own connected-model client, the bench supplying only the transport; the ref's shipped instruction and <code>desc</code> label descriptions). The extension's size threshold for files is <code>localAi.fileReviewLimit</code> = ${meta.fileReviewLimit !== null ? big(meta.fileReviewLimit) : "–"} characters by default${limits.length ? ` (offered: ${limits.map(big).join(", ")})` : ""}: longer files skip Private AI.</p>
<div class="grid">${ai
    .map(
      (
        m,
      ) => `<div class="card"><h3>${esc(m.model.replace(/^.*\//, ""))}</h3>${logChart(
        [
          {
            name: "review time (p50)",
            points: m.bySize.map(
              (b) => [b.chars, b.reviewMsP50] as [number, number],
            ),
            fit: m.fit ? { ...m.fit, points: m.bySize.length } : null,
          },
          {
            name: "max",
            points: m.bySize.map(
              (b) => [b.chars, b.reviewMsMax] as [number, number],
            ),
          },
        ],
        {
          xLabel: "characters of document text",
          yLabel: "review ms",
          yFormat: (v) => (v >= 1000 ? `${v / 1000}s` : `${v}ms`),
          vLines: limits.map((l) => ({ x: l, label: `${l / 1000}k` })),
          hLines: [{ y: 30000, label: "30 s" }],
        },
      )}
<table><tr><th class="n">Size</th><th class="n">Chars</th><th class="n">Cases</th><th class="n">Recall</th><th class="n">FP</th><th class="n">Review p50</th><th class="n">Max</th><th class="n">Requests p50</th><th class="n">Errors</th>${m.usd !== undefined ? '<th class="n">USD</th>' : ""}</tr>${m.bySize
        .map(
          (b) =>
            `<tr><td class="n">${big(b.size)}</td><td class="n">${big(b.chars)}</td><td class="n">${b.cases}</td><td class="n ${cls(b.recall, 0.7, 0.4)}">${pct(b.recall)} (${b.found}/${b.expected})</td><td class="n">${b.falsePositives}</td><td class="n">${ms(b.reviewMsP50)}</td><td class="n">${ms(b.reviewMsMax)}</td><td class="n">${b.requestsP50}</td><td class="n">${b.errors}</td>${m.usd !== undefined ? `<td class="n">${(b.usd ?? 0).toFixed(4)}</td>` : ""}</tr>`,
        )
        .join(
          "",
        )}</table>${m.usd !== undefined ? `<p class="muted">Spent on these reviews: ${m.usd.toFixed(4)} USD (on-demand prices of the model table).</p>` : ""}<p class="muted">Fit: review ms ≈ ${m.fit ? `${m.fit.a.toPrecision(3)} · chars<sup>${m.fit.b.toFixed(2)}</sup> (R² ${m.fit.r2.toFixed(2)})` : "–"}. Largest document within 30 s / 60 s / 120 s (median): ${Object.values(
        m.within,
      )
        .map((v) =>
          v === null ? "–" : `${v.atLeast ? "≥ " : ""}${big(v.chars)}`,
        )
        .join(" / ")} characters.</p></div>`,
    )
    .join("")}</div>`;
}

export function renderDocReport(
  meta: DocRunMeta,
  s: DocSummary,
  suite: DocJobResult[],
  ai?: AiSummary[],
): string {
  const configs = meta.configs;
  const o = s.overall;
  const overview = `<table><tr><th></th>${configs.map((c) => `<th class="n">${esc(c)}</th>`).join("")}</tr>
<tr><td>Values placed in positive documents</td>${configs.map(() => `<td class="n">${big(o.items)}</td>`).join("")}</tr>
<tr><td>Extraction recall (value present in the text the ref read)</td>${configs.map(() => `<td class="n ${cls(o.extractionRecall)}">${pct(o.extractionRecall)}</td>`).join("")}</tr>
<tr><td>Detection recall among extracted values</td>${configs.map((c) => `<td class="n">${pct(o.configs[c]?.detectionRecall)}</td>`).join("")}</tr>
<tr><td>End-to-end recall / precision / F1</td>${configs.map((c) => `<td class="n">${pct(o.configs[c]?.recall)} / ${pct(o.configs[c]?.precision)} / ${pct(o.configs[c]?.f1)}</td>`).join("")}</tr>
<tr><td>Redacted values gone from the redacted file (independent reader)</td>${configs.map((c) => `<td class="n">${o.configs[c]?.removed ?? 0}/${o.configs[c]?.redactedLeakFree ?? 0}${o.configs[c]?.leaked ? ` <span class="chip bad">${o.configs[c]!.leaked} leaked</span>` : ""}</td>`).join("")}</tr>
<tr><td>Hard-negative documents with a false alarm</td>${configs.map((c) => `<td class="n">${o.negatives[c]?.docsWithFalseAlarm ?? 0}/${o.negatives[c]?.docs ?? 0} (${o.negatives[c]?.falseAlarms ?? 0} false alarms)</td>`).join("")}</tr>
<tr><td>Failure files reported correctly</td><td class="n" colspan="${configs.length}">${o.failures.ok}/${o.failures.cases}${o.failures.silentClean ? ` <span class="chip bad">${o.failures.silentClean} silent clean</span>` : ` <span class="chip ok">no silent clean</span>`}</td></tr>
<tr><td>All cases read as expected</td><td class="n" colspan="${configs.length}">${o.classification.ok}/${o.classification.cases}</td></tr>
<tr><td>PDF redaction (${esc(configs[0])}): in place / fallback to the text copy</td><td class="n" colspan="${configs.length}">${o.pdfRedaction.inPlace} / ${o.pdfRedaction.fallback} PDFs${o.pdfRedaction.error ? ` / ${o.pdfRedaction.error} errors` : ""}${
    o.pdfRedaction.failing !== undefined
      ? ` · findings the ref cannot redact in place: ${o.pdfRedaction.failing}/${o.pdfRedaction.findings} ${Object.entries(
          o.pdfRedaction.failingByCategory,
        )
          .map(([k, v]) => `<span class="chip warn">${esc(k)} ${v}</span>`)
          .join("")}`
      : ""
  }</td></tr></table>`;
  const negatives = s.negatives
    .map(
      (n) =>
        `<tr><td>${esc(n.caseId)}</td><td>${esc(n.family)}</td><td>${esc(n.zone)}</td><td class="n">${n.decoys}</td><td class="n">${n.pages ?? "–"}</td><td class="n">${n.cells !== null ? big(n.cells) : "–"}</td>${configs
          .map((c) => {
            const m = n.configs[c]!;
            return `<td class="n ${m.falseAlarms ? "warn" : ""}">${m.falseAlarms}</td><td class="n">${m.perPage !== null ? num(m.perPage, 2) : "–"}</td><td class="n">${m.per10kCells !== null ? num(m.per10kCells, 1) : "–"}</td><td class="n">${num(m.per1kWords, 2)}</td>`;
          })
          .join(
            "",
          )}<td>${n.samples.map((x) => `<span class="chip" title="${esc(x.where)}">${esc(x.category)}: ${esc(x.value)}</span>`).join("")}</td></tr>`,
    )
    .join("");
  const classification = s.classification
    .filter((c) => c.kind === "failure" || !c.ok)
    .map(
      (c) =>
        `<tr><td>${esc(c.caseId)}</td><td>${esc(c.kind)}</td><td>${esc(c.zone)}</td><td>${esc(c.expected)}</td><td><span class="chip ${c.ok ? "ok" : "bad"}">${esc(c.got)}</span>${c.silentClean ? ` <span class="chip bad">silent clean</span>` : ""}</td><td class="muted">${esc(c.gaps.join("; "))}${c.error ? ` ${esc(c.error)}` : ""}</td></tr>`,
    )
    .join("");
  const cats = s.categories
    .map(
      (c) =>
        `<tr><td>${esc(c.category)}</td><td class="n">${c.items}</td><td class="n">${pct(c.items ? c.extracted / c.items : null)}</td>${configs.map((k) => `<td class="n">${pct(c.extracted ? c.found[k]! / c.items : null)}</td>`).join("")}</tr>`,
    )
    .join("");
  const timing = s.timing
    .map(
      (t) =>
        `<tr><td>${esc(t.family)}</td><td class="n">${t.cases}</td><td class="n">${ms(t.readMsP50)}</td><td class="n">${ms(t.detectMsP50)}</td><td class="n">${ms(t.redactMsP50)}</td></tr>`,
    )
    .join("");
  const misses = suite
    .filter((r) => r.spec.kind === "positive")
    .flatMap((r) =>
      r.items
        .filter(
          (i) => !i.extracted || !i.cfg[configs[configs.length - 1]!]?.found,
        )
        .map((i) => ({ r, i })),
    )
    .slice(0, 400)
    .map(
      ({ r, i }) =>
        `<tr><td>${esc(r.jobId)}</td><td>${esc(i.category)} <span class="muted">${esc(i.kind)}</span></td><td><code>${esc(i.value.slice(0, 70))}</code></td><td>${i.extracted ? `<span class="chip">in ${esc(i.where ?? "?")}</span>` : `<span class="chip bad">not extracted</span>`}</td><td>${configs.map((c) => (i.cfg[c] ? `${esc(c)}: ${i.cfg[c]!.found ? "found" : i.cfg[c]!.redacted ? `redacted as ${esc(i.cfg[c]!.detectedAs.join("+"))}` : "missed"}` : "")).join(" · ")}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Docbench ${esc(meta.name)}</title>${STYLE}</head><body><main>
<h1>Document bench: ${esc(meta.ext.ref)} @ <code>${esc(meta.ext.sha.slice(0, 10))}</code></h1>
<p class="muted">${esc(meta.ext.subject)} · tier ${esc(meta.tier)} · seed ${meta.seed} · configs ${configs.map((c) => `<code>${esc(c)}</code>${meta.configNote[c]?.length ? ` (off: ${esc(meta.configNote[c]!.join(", "))})` : ""}`).join(", ")} · ${meta.suiteCases} suite documents, ${meta.sweepPoints} sweep points${meta.missing ? ` · <b>${meta.missing} missing</b>` : ""} · dataset ${esc(meta.datasetHash.slice(0, 10))} · ${esc(meta.machine)}${meta.machineProfile ? ` (profile ${esc(meta.machineProfile.id)})` : ""}, Node ${esc(meta.node)} · packages ${esc(
    Object.entries(meta.packages)
      .map(([k, v]) => `${k}@${v}`)
      .join(", "),
  )} · verifier: own zip walker${meta.verifier.pdftotext ? " + pdftotext" : ""} + raw PDF strings</p>
<p>Generated Word, Excel, PowerPoint, OpenDocument, PDF, text and zip files are checked the way the extension checks an attached file: the ref's <code>readFileForCheck</code> and <code>readDocument</code> (PDFium, its own Office part map), then <code>detectSensitiveData</code> on the whole text, then its redacted version (in place for text files, PDFs and archives, a text copy for Office files, or the text-copy fallback). Values come from <code>dataset/detbench</code>, placed in one zone per document; extraction and detection are scored apart.</p>
<h2>Overview</h2>${overview}
${zoneTable(s.families, configs, "Per format")}
${zoneTable(s.zones, configs, "Per format and zone")}
<h3>Per category</h3><table><tr><th>Category</th><th class="n">Values</th><th class="n">Extracted</th>${configs.map((c) => `<th class="n">Recall (${c})</th>`).join("")}</tr>${cats}</table>
<h2>Hard negatives</h2><p>Bibliographies, diagnostic dumps, invoices and numeric order sheets with no sensitive value: every detection is a false alarm. Rates per PDF page, per 10,000 cells and per 1,000 words (about 6 characters per word).</p>
<div class="scroll"><table><tr><th>Document</th><th>Format</th><th>Content</th><th class="n">Decoys</th><th class="n">Pages</th><th class="n">Cells</th>${configs.map((c) => `<th class="n">False alarms (${c})</th><th class="n">/ page</th><th class="n">/ 10k cells</th><th class="n">/ 1k words</th>`).join("")}<th>Examples</th></tr>${negatives}</table></div>
<h2>Files that cannot be fully checked</h2><p>Each must be reported as not checked (with its reason) or partly checked, never as clean. Rows also list any other case whose read did not match its expectation.</p>
<table><tr><th>Case</th><th>Kind</th><th>What</th><th>Expected</th><th>Ref reported</th><th>Gaps</th></tr>${classification}</table>
${sweepSection(s, configs)}
${aiSection(ai, meta)}
<h2>Suite timing per format</h2><table><tr><th>Format</th><th class="n">Docs read</th><th class="n">Read p50</th><th class="n">Detect p50</th><th class="n">Redact p50</th></tr>${timing}</table>
<h2>Values not extracted or not found (${esc(configs[configs.length - 1])})</h2><div class="scroll"><table><tr><th>Document</th><th>Category</th><th>Value</th><th>Extraction</th><th>Detection</th></tr>${misses}</table></div>
</main></body></html>`;
  return defangHtml(html);
}

export function renderDocCompare(
  a: { meta: DocRunMeta; summary: DocSummary; ai?: AiSummary[] },
  b: { meta: DocRunMeta; summary: DocSummary; ai?: AiSummary[] },
): string {
  const configs = a.meta.configs.filter((c) => b.meta.configs.includes(c));
  const delta = (
    x: number | null | undefined,
    y: number | null | undefined,
  ) => {
    if (x === null || x === undefined || y === null || y === undefined)
      return `<td class="n">${pct(x)} → ${pct(y)}</td>`;
    const d = y - x;
    return `<td class="n ${d > 0.005 ? "good" : d < -0.005 ? "bad" : ""}">${pct(x)} → ${pct(y)}</td>`;
  };
  const zones = a.summary.zones
    .map((za) => {
      const zb = b.summary.zones.find(
        (z) => z.family === za.family && z.zone === za.zone,
      );
      if (!zb) return "";
      return `<tr><td>${esc(za.family)}</td><td>${esc(za.zone)}</td>${delta(za.extractionRecall, zb.extractionRecall)}${configs.map((c) => `${delta(za.configs[c]?.recall, zb.configs[c]?.recall)}${delta(za.configs[c]?.precision, zb.configs[c]?.precision)}`).join("")}</tr>`;
    })
    .join("");
  const cls2 = a.summary.classification
    .map((ca) => {
      const cb = b.summary.classification.find((c) => c.caseId === ca.caseId);
      return cb && (ca.got !== cb.got || !cb.ok)
        ? `<tr><td>${esc(ca.caseId)}</td><td>${esc(ca.expected)}</td><td><span class="chip ${ca.ok ? "ok" : "bad"}">${esc(ca.got)}</span></td><td><span class="chip ${cb.ok ? "ok" : "bad"}">${esc(cb.got)}</span></td></tr>`
        : "";
    })
    .join("");
  const fits = a.summary.fits
    .map((fa) => {
      const fb = b.summary.fits.find((f) => f.type === fa.type);
      return `<tr><td>${esc(fa.type)}</td><td class="n">${num(fa.total?.b, 2)} → ${num(fb?.total?.b, 2)}</td><td class="n">${num(fa.msPerKChar, 2)} → ${num(fb?.msPerKChar, 2)}</td><td class="n">${fa.sizeWithin5s ?? "–"} → ${fb?.sizeWithin5s ?? "–"}</td></tr>`;
    })
    .join("");
  const negs = configs
    .map(
      (c) =>
        `<tr><td>${esc(c)}</td><td class="n">${a.summary.overall.negatives[c]?.falseAlarms ?? 0} → ${b.summary.overall.negatives[c]?.falseAlarms ?? 0}</td></tr>`,
    )
    .join("");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Docbench compare</title>${STYLE}</head><body><main>
<h1>Document bench: ${esc(a.meta.ext.ref)} <code>${esc(a.meta.ext.sha.slice(0, 8))}</code> → ${esc(b.meta.ext.ref)} <code>${esc(b.meta.ext.sha.slice(0, 8))}</code></h1>
<table><tr><th></th>${configs.map((c) => `<th class="n">${esc(c)}</th>`).join("")}</tr>
<tr><td>Extraction recall</td>${configs.map(() => delta(a.summary.overall.extractionRecall, b.summary.overall.extractionRecall)).join("")}</tr>
<tr><td>Recall</td>${configs.map((c) => delta(a.summary.overall.configs[c]?.recall, b.summary.overall.configs[c]?.recall)).join("")}</tr>
<tr><td>Precision</td>${configs.map((c) => delta(a.summary.overall.configs[c]?.precision, b.summary.overall.configs[c]?.precision)).join("")}</tr>
<tr><td>Leaks after redaction</td>${configs.map((c) => `<td class="n">${a.summary.overall.configs[c]?.leaked ?? 0} → ${b.summary.overall.configs[c]?.leaked ?? 0}</td>`).join("")}</tr>
<tr><td>Failure files reported correctly</td><td class="n" colspan="${configs.length}">${a.summary.overall.failures.ok}/${a.summary.overall.failures.cases} → ${b.summary.overall.failures.ok}/${b.summary.overall.failures.cases} (silent cleans ${a.summary.overall.failures.silentClean} → ${b.summary.overall.failures.silentClean})</td></tr></table>
<h2>Hard-negative false alarms</h2><table>${negs}</table>
<h2>Per format and zone</h2><div class="scroll"><table><tr><th>Format</th><th>Zone</th><th class="n">Extracted</th>${configs.map((c) => `<th class="n">Recall (${c})</th><th class="n">Precision (${c})</th>`).join("")}</tr>${zones}</table></div>
<h2>Classification changes</h2><table><tr><th>Case</th><th>Expected</th><th>${esc(a.meta.ext.ref)}</th><th>${esc(b.meta.ext.ref)}</th></tr>${cls2 || `<tr><td colspan="4" class="muted">no change</td></tr>`}</table>
<h2>Scaling</h2><table><tr><th>Type</th><th class="n">Exponent b</th><th class="n">ms / 1k chars</th><th class="n">Size within 5 s</th></tr>${fits}</table>
</main></body></html>`;
  return defangHtml(html);
}

export function docTextSummary(
  meta: DocRunMeta,
  s: DocSummary,
  ai?: AiSummary[],
): string {
  const o = s.overall;
  const lines = [
    `\nDocbench ${meta.ext.ref} @ ${meta.ext.sha.slice(0, 10)}: ${o.positives} positive documents, ${o.items} values; extraction recall ${pct(o.extractionRecall)}`,
    ...meta.configs.map(
      (c) =>
        `  [${c}] recall ${pct(o.configs[c]?.recall)} (detected ${pct(o.configs[c]?.detectionRecall)} of extracted) · precision ${pct(o.configs[c]?.precision)} · F1 ${pct(o.configs[c]?.f1)} · redacted values gone ${o.configs[c]?.removed}/${o.configs[c]?.redactedLeakFree}${o.configs[c]?.leaked ? `, ${o.configs[c]!.leaked} LEAKED` : ""} · hard-negative false alarms ${o.negatives[c]?.falseAlarms ?? 0} in ${o.negatives[c]?.docsWithFalseAlarm ?? 0}/${o.negatives[c]?.docs ?? 0} docs`,
    ),
    `  failure files reported correctly ${o.failures.ok}/${o.failures.cases}, silent cleans ${o.failures.silentClean}; all cases read as expected ${o.classification.ok}/${o.classification.cases}; PDF redaction in place ${o.pdfRedaction.inPlace}, fallback ${o.pdfRedaction.fallback} (findings failing alone ${o.pdfRedaction.failing ?? 0}/${o.pdfRedaction.findings ?? 0})`,
    ...s.families.map(
      (f) =>
        `  ${f.family.padEnd(6)} extracted ${pct(f.extractionRecall).padStart(4)} · recall ${meta.configs.map((c) => `${c} ${pct(f.configs[c]?.recall)}`).join(", ")}`,
    ),
    ...s.fits.map(
      (f) =>
        `  sweep ${f.type.padEnd(5)} total ≈ ${f.total ? `${f.total.a.toPrecision(3)}·n^${f.total.b.toFixed(2)} ms` : "–"} per ${f.unit}; ${num(f.msPerKChar, 2)} ms/1k chars; within 5 s up to ${f.sizeWithin5s !== null ? `${f.within5sAtLeast ? "≥ " : ""}${big(f.sizeWithin5s)}` : "–"} ${f.unit}${f.capped?.length ? ` (read in part at ${f.capped.map(big).join(", ")})` : ""}`,
    ),
    ...(ai ?? []).map(
      (m) =>
        `  Private AI ${m.model.replace(/^.*\//, "")}: ${m.bySize.map((b) => `${big(b.chars)} chars → recall ${pct(b.recall)}, ${ms(b.reviewMsP50)}`).join("; ")}${m.usd !== undefined ? ` · ${m.usd.toFixed(4)} USD` : ""}`,
    ),
  ];
  return lines.join("\n");
}
