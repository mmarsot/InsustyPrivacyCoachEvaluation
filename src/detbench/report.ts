/** Static HTML report, text summary and comparison page for detbench runs. */
import { esc, meter, pct, STYLE } from "../report/html.ts";
import { DET_CATEGORIES } from "./schema.ts";
import { PERTURBATION_INFO, type Perturbation } from "./perturb.ts";
import { defangHtml } from "./defang.ts";
import type { DetMetrics, DetSummary, LargeCaseSummary } from "./aggregate.ts";
import type { DetScored } from "./score.ts";

export interface DetRunMeta {
  name: string;
  ext: { ref: string; sha: string; subject: string; committedAt: string };
  /** npm packages bundled with the detector, at the ref's locked versions. */
  packages: Record<string, string>;
  refCategories: string[];
  supported: string[];
  configs: Record<string, { categories: unknown; addressCountries: unknown }>;
  allConfigNote: string;
  datasetHash: string;
  seed: number;
  variantsPerType: number;
  perturbations: string[];
  baseCases: number;
  variants: number;
  timing: {
    calls: number;
    p50Ms: number | null;
    p95Ms: number | null;
    maxMs: number | null;
    totalMs: number;
    /** The ten slowest base-case calls. */
    slowest?: Array<{ config: string; caseId: string; chars: number; ms: number }>;
    /** Every call on a large generated case. */
    large?: Array<{ config: string; caseId: string; chars: number; ms: number }>;
  };
  node: string;
  machine: string;
  startedAt: string;
  finishedAt: string;
}

const num = (v: number | null | undefined, digits = 0) => (v === null || v === undefined ? "–" : v.toFixed(digits));
/** A change in percentage points, rounded before its sign is chosen (no "-0"). */
const pp = (d: number | null) => {
  if (d === null) return "";
  const points = Math.round(100 * d);
  return ` <b class="${points < 0 ? "down" : points > 0 ? "up" : ""}">${points > 0 ? "+" : points < 0 ? "−" : "±"}${Math.abs(points)}</b>`;
};
const points = (d: number | null) => {
  if (d === null) return "–";
  const n = Math.round(100 * d);
  return `${n > 0 ? "+" : n < 0 ? "−" : "±"}${Math.abs(n)} pts`;
};
const delta = (a: number | null, b: number | null) => (a === null || b === null ? null : b - a);
const arrowCell = (a: number | null, b: number | null) => `<td class="num">${pct(a)} → ${pct(b)}${pp(delta(a, b))}</td>`;
const EXTRA_STYLE = `b.down{color:var(--bad)}b.up{color:var(--bar)}td.ns{color:var(--muted);font-style:italic}mark{background:var(--bar-bg);color:inherit;border-radius:3px;padding:0 1px}mark.miss{background:var(--bad-bg)}.kv div{min-width:0;overflow-wrap:anywhere}h1{overflow-wrap:anywhere}`;

const supportCell = (category: string, meta: DetRunMeta) =>
  meta.supported.includes(category) ? `<td>yes</td>` : `<td class="ns">not supported by this ref</td>`;

function metricCells(m: DetMetrics, supported: boolean): string {
  if (!supported)
    return `<td class="num">${m.items}</td><td class="num">–</td><td class="ns" colspan="6">not supported by this ref (${m.unsupportedRedacted}/${m.items} redacted under another category)</td>${meter(m.redactedRecall)}${meter(m.leakFreeRate)}<td class="num">–</td><td class="num">${m.mergedItems}</td>`;
  return `<td class="num">${m.supportedItems}</td><td class="num">${m.detections}</td>${meter(m.overlap.precision)}${meter(m.overlap.recall)}${meter(m.overlap.f1)}${meter(m.exact.precision)}${meter(m.exact.recall)}${meter(m.exact.f1)}${meter(m.redactedRecall)}${meter(m.leakFreeRate)}<td class="num">${m.wrongCategory}</td><td class="num">${m.mergedItems}</td>`;
}
const METRIC_HEAD = `<th class="num">Items</th><th class="num">Detections</th><th class="num">P overlap</th><th class="num">R overlap</th><th class="num">F1 overlap</th><th class="num">P exact</th><th class="num">R exact</th><th class="num">F1 exact</th><th class="num">Redacted (any category)</th><th class="num">Leak-free</th><th class="num">Wrong category</th><th class="num">Merged items</th>`;

function headline(summaries: DetSummary[]): string {
  const rows = summaries
    .map((s) => {
      const m = s.overall;
      return `<tr><td><b>${esc(s.config)}</b></td><td class="num">${m.cases}</td><td class="num">${m.supportedItems}</td><td class="num">${m.unsupportedItems}</td>${meter(m.overlap.f1)}${meter(m.overlap.precision)}${meter(m.overlap.recall)}${meter(m.exact.f1)}${meter(m.redactedRecall)}${meter(m.leakFreeRate)}${meter(m.negativeFpRate, true)}<td class="num">${m.decoysFlagged}/${m.decoys}</td><td class="num">${m.wrongCategory}</td><td class="num">${m.mergedItems}</td></tr>`;
    })
    .join("");
  return `<div class="scroll"><table><thead><tr><th>Config</th><th class="num">Cases</th><th class="num">Items (supported)</th><th class="num">Items not supported</th><th class="num">F1 overlap</th><th class="num">Precision</th><th class="num">Recall</th><th class="num">F1 exact</th><th class="num">Redacted (any category, all items)</th><th class="num">Leak-free</th><th class="num">FP rate (negative cases)</th><th class="num">Decoys flagged</th><th class="num">Wrong category</th><th class="num">Merged items</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function categorySection(summaries: DetSummary[], meta: DetRunMeta): string {
  const rows = summaries
    .flatMap((s) =>
      DET_CATEGORIES.filter((c) => s.byCategory[c]).map(
        (c) => `<tr><td>${esc(s.config)}</td><td><code>${c}</code></td>${supportCell(c, meta)}${metricCells(s.byCategory[c]!, meta.supported.includes(c))}</tr>`,
      ),
    )
    .join("");
  const langRows = summaries
    .flatMap((s) =>
      DET_CATEGORIES.filter((c) => s.byCategoryLang[c]).flatMap((c) =>
        Object.entries(s.byCategoryLang[c]!).map(
          ([lang, m]) => `<tr><td>${esc(s.config)}</td><td><code>${c}</code></td><td>${lang}</td>${metricCells(m, meta.supported.includes(c))}</tr>`,
        ),
      ),
    )
    .join("");
  const kinds = summaries
    .flatMap((s) =>
      Object.entries(s.byKind).map(
        ([kind, m]) =>
          `<tr><td>${esc(s.config)}</td><td><code>${esc(kind)}</code></td><td class="num">${m.items}</td>${m.supportedItems ? meter(m.overlap.recall) : `<td class="ns">not supported</td>`}${m.supportedItems ? meter(m.exact.recall) : "<td></td>"}${meter(m.redactedRecall)}${meter(m.leakFreeRate)}<td class="num">${m.mergedItems}</td></tr>`,
      ),
    )
    .join("");
  return `<h2 id="categories">Per category</h2>
<p>Base cases only. <b>Overlap</b>: a detection of the right category overlaps the item. <b>Exact</b>: same span. Precision counts every selected detection of that category; detections that land only on items of a category this ref does not have are left out of precision. <b>Redacted</b>: some detection overlaps the item, whatever its category (what the user would see replaced). <b>Leak-free</b>: no non-space character of the item is left visible. <b>Merged items</b>: items sharing one detection span with another item.</p>
<div class="scroll"><table><thead><tr><th>Config</th><th>Category</th><th>Ref support</th>${METRIC_HEAD}</tr></thead><tbody>${rows}</tbody></table></div>
<h3>Per category and language</h3>
<div class="scroll"><table><thead><tr><th>Config</th><th>Category</th><th>Lang</th>${METRIC_HEAD}</tr></thead><tbody>${langRows}</tbody></table></div>
<details><summary><b>Recall per value kind</b></summary><div class="scroll"><table><thead><tr><th>Config</th><th>Kind</th><th class="num">Items</th><th class="num">R overlap</th><th class="num">R exact</th><th class="num">Redacted</th><th class="num">Leak-free</th><th class="num">Merged</th></tr></thead><tbody>${kinds}</tbody></table></div></details>`;
}

function sliceSection(summaries: DetSummary[]): string {
  const table = (title: string, pickSlice: (s: DetSummary) => Record<string, DetMetrics>) => {
    const rows = summaries
      .flatMap((s) =>
        Object.entries(pickSlice(s)).map(
          ([value, m]) =>
            `<tr><td>${esc(s.config)}</td><td>${esc(value)}</td><td class="num">${m.cases}</td>${meter(m.overlap.f1)}${meter(m.overlap.precision)}${meter(m.overlap.recall)}${meter(m.exact.f1)}${meter(m.redactedRecall)}${meter(m.leakFreeRate)}${meter(m.negativeFpRate, true)}<td class="num">${m.wrongCategory}</td><td class="num">${m.mergedItems}</td></tr>`,
        ),
      )
      .join("");
    return `<h3>${title}</h3><div class="scroll"><table><thead><tr><th>Config</th><th>${title}</th><th class="num">Cases</th><th class="num">F1 overlap</th><th class="num">Precision</th><th class="num">Recall</th><th class="num">F1 exact</th><th class="num">Redacted</th><th class="num">Leak-free</th><th class="num">FP rate (negatives)</th><th class="num">Wrong category</th><th class="num">Merged items</th></tr></thead><tbody>${rows}</tbody></table></div>`;
  };
  const zoneRows = summaries
    .flatMap((s) =>
      Object.entries(s.byZone).map(
        ([zone, m]) =>
          `<tr><td>${esc(s.config)}</td><td>${esc(zone)}</td><td class="num">${m.supportedItems}</td><td class="num">${m.unsupportedItems}</td>${meter(m.overlap.f1)}${meter(m.overlap.precision)}${meter(m.overlap.recall)}${meter(m.exact.f1)}${meter(m.redactedRecall)}${meter(m.leakFreeRate)}<td class="num">${m.decoysFlagged}/${m.decoys}</td><td class="num">${m.wrongCategory}</td><td class="num">${m.mergedItems}</td></tr>`,
      ),
    )
    .join("");
  return `<h2 id="slices">Language, case type, register, prose vs code, tag</h2>
<p><b>multi</b> cases hold several categories in one prompt (an email, a phone, an IBAN and a key together): check <i>wrong category</i> and <i>merged items</i> (one span swallowing two values). <b>negative</b> cases hold only hard negatives and ordinary prose.</p>
${table("Language", (s) => s.byLang)}${table("Case type", (s) => s.byType)}${table("Register", (s) => s.byRegister)}
<h3>Prose vs code block</h3><p>Items, hard negatives and detections by where they sit: inside a fenced (<code>\`\`\`</code>, <code>~~~</code>) or indented code block, or in the prose around it. A detection counts where it starts.</p>
<div class="scroll"><table><thead><tr><th>Config</th><th>Zone</th><th class="num">Items (supported)</th><th class="num">Items not supported</th><th class="num">F1 overlap</th><th class="num">Precision</th><th class="num">Recall</th><th class="num">F1 exact</th><th class="num">Redacted</th><th class="num">Leak-free</th><th class="num">Decoys flagged</th><th class="num">Wrong category</th><th class="num">Merged items</th></tr></thead><tbody>${zoneRows}</tbody></table></div>
<details><summary><b>Per tag</b> (case groups from the dataset, e.g. the regression cases of one review; a case counts under each of its tags)</summary>${table("Tag", (s) => s.byTag ?? {})}</details>`;
}

function robustnessSection(summaries: DetSummary[]): string {
  const parts = summaries.map((s) => {
    const rows = Object.entries(s.perturbations)
      .map(([type, p]) => {
        const info = type === "all" ? "All perturbation types together." : PERTURBATION_INFO[type as Perturbation];
        return `<tr><td><b>${esc(type)}</b></td><td class="wrap">${esc(info)}</td><td class="num">${p.baseCases}</td><td class="num">${p.variants}</td>${arrowCell(p.base.overlap.f1, p.perturbed.overlap.f1)}${arrowCell(p.base.overlap.recall, p.perturbed.overlap.recall)}${arrowCell(p.base.overlap.precision, p.perturbed.overlap.precision)}${arrowCell(p.base.exact.f1, p.perturbed.exact.f1)}${arrowCell(p.base.redactedRecall, p.perturbed.redactedRecall)}${arrowCell(p.base.leakFreeRate, p.perturbed.leakFreeRate)}${arrowCell(p.base.negativeFpRate, p.perturbed.negativeFpRate)}</tr>`;
      })
      .join("");
    const catRows = Object.entries(s.perturbations)
      .filter(([type]) => type !== "all")
      .flatMap(([type, p]) =>
        Object.entries(p.byCategory)
          .filter(([, v]) => v.base.supportedItems > 0)
          .map(
            ([cat, v]) =>
              `<tr><td>${esc(type)}</td><td><code>${cat}</code></td><td class="num">${v.perturbed.supportedItems}</td>${arrowCell(v.base.overlap.recall, v.perturbed.overlap.recall)}${arrowCell(v.base.overlap.precision, v.perturbed.overlap.precision)}${arrowCell(v.base.exact.recall, v.perturbed.exact.recall)}${arrowCell(v.base.redactedRecall, v.perturbed.redactedRecall)}</tr>`,
          ),
      )
      .join("");
    return `<h3>${esc(s.config)}</h3>
<div class="scroll"><table><thead><tr><th>Perturbation</th><th>What changes</th><th class="num">Base cases</th><th class="num">Variants</th><th class="num">F1 overlap</th><th class="num">Recall</th><th class="num">Precision</th><th class="num">F1 exact</th><th class="num">Redacted</th><th class="num">Leak-free</th><th class="num">FP rate (negatives)</th></tr></thead><tbody>${rows}</tbody></table></div>
<details><summary>Per perturbation and category (supported categories)</summary><div class="scroll"><table><thead><tr><th>Perturbation</th><th>Category</th><th class="num">Items</th><th class="num">Recall</th><th class="num">Precision</th><th class="num">R exact</th><th class="num">Redacted</th></tr></thead><tbody>${catRows}</tbody></table></div></details>`;
  });
  return `<h2 id="robustness">Robustness to perturbations</h2>
<p>Each perturbation type rewrites the base cases it applies to (seeded, deterministic), and its variants are scored against <i>the same base cases</i>: <code>base → perturbed</code>, with the change in percentage points. A type that cannot change a case (no grouped value, no accent...) skips it.</p>${parts.join("")}`;
}

function negativesSection(summaries: DetSummary[]): string {
  const rows = summaries
    .flatMap((s) =>
      Object.entries(s.decoys).map(
        ([kind, d]) =>
          `<tr><td>${esc(s.config)}</td><td><code>${esc(kind)}</code></td><td class="num">${d.total}</td><td class="num">${d.flagged}</td>${meter(d.total ? d.flagged / d.total : null, true)}<td>${esc(Object.entries(d.flaggedAs).map(([c, n]) => `${c} ×${n}`).join(", "))}</td></tr>`,
      ),
    )
    .join("");
  return `<h2 id="negatives">Hard negatives</h2>
<p>Values that look like identifiers but are not sensitive (base cases): log timestamps, git SHAs and hashes, trace IDs and UUIDs, version numbers (<code>1.2.3.4</code>), loopback addresses and ports, prices, dates, order and tracking numbers, masked keys, public keys, base64 data, and IBAN, card, NIR or NHS look-alikes that fail their checksum. Any detection on them is a false positive.</p>
<div class="scroll"><table><thead><tr><th>Config</th><th>Decoy kind</th><th class="num">Occurrences</th><th class="num">Flagged</th><th class="num">Share</th><th>Flagged as</th></tr></thead><tbody>${rows}</tbody></table></div>`;
}

function confusionSection(summaries: DetSummary[]): string {
  const parts = summaries.map((s) => {
    const cols = [...new Set(Object.values(s.confusion).flatMap((r) => Object.keys(r)))].sort((a, b) => (a === "(missed)" ? 1 : b === "(missed)" ? -1 : a.localeCompare(b)));
    const rows = DET_CATEGORIES.filter((c) => s.confusion[c])
      .map((c) => `<tr><td><code>${c}</code></td>${cols.map((col) => `<td class="num">${s.confusion[c]![col] ?? ""}</td>`).join("")}</tr>`)
      .join("");
    return `<h3>${esc(s.config)}</h3><div class="scroll"><table><thead><tr><th>Item category ↓ / detected as →</th>${cols.map((c) => `<th class="num">${esc(c)}</th>`).join("")}</tr></thead><tbody>${rows}</tbody></table></div>`;
  });
  return `<h2 id="confusion">What each category is detected as</h2><p>Base cases; an item overlapped by detections of two categories counts in both columns.</p>${parts.join("")}`;
}

/** Texts longer than this (generated tables) show only their start, end and the context of each item. */
const LONG_TEXT = 6000;
/** Detections listed per case; the rest are counted by category. */
const MAX_LISTED_DETECTIONS = 60;

/** Escaped plain text, with the middle of long stretches replaced by a count of omitted characters. */
function clipped(text: string, from: number, to: number, long: boolean): string {
  const keepStart = from === 0 ? 1500 : 200;
  const keepEnd = to === text.length ? 500 : 200;
  if (!long || to - from <= keepStart + keepEnd + 200) return esc(text.slice(from, to));
  return `${esc(text.slice(from, from + keepStart))}<span class="muted">\n… ${(to - from - keepStart - keepEnd).toLocaleString("en")} characters omitted …\n</span>${esc(text.slice(to - keepEnd, to))}`;
}

/** The case text with items highlighted (found / missed); long texts keep each item's context. */
function highlighted(r: DetScored): string {
  const long = r.text.length > LONG_TEXT;
  const marks = [...r.items].sort((a, b) => a.start - b.start);
  let out = "";
  let at = 0;
  for (const i of marks) {
    if (i.start < at) continue;
    out += clipped(r.text, at, i.start, long);
    out += `<mark class="${i.redacted ? "" : "miss"}" title="${esc(i.category)} / ${esc(i.kind)}">${esc(r.text.slice(i.start, i.end))}</mark>`;
    at = i.end;
  }
  return out + clipped(r.text, at, r.text.length, long);
}

export function caseDetails(r: DetScored): string {
  const items = r.items
    .map(
      (i) =>
        `${i.overlap ? (i.exact ? "✓ exact" : "✓ overlap") : i.redacted ? "~ redacted as " + i.detectedAs.join("/") : i.supported ? "✗ missed" : "· not supported"}  ${i.category}/${i.kind}: ${JSON.stringify(i.value)}${i.merged ? "  [merged with another item]" : ""}${!i.leakFree && i.redacted ? "  [partly visible]" : ""}`,
    )
    .join("\n");
  // A long list shows the detections on items first, then the first false positives.
  const onItems = (d: DetScored["detections"][number]) => d.verdict === "tp" || d.verdict === "unsupported_item";
  const ordered = r.detections.length > MAX_LISTED_DETECTIONS ? [...r.detections.filter(onItems), ...r.detections.filter((d) => !onItems(d))] : r.detections;
  const listed = ordered.slice(0, MAX_LISTED_DETECTIONS);
  const rest = new Map<string, number>();
  for (const d of ordered.slice(listed.length)) rest.set(`${d.verdict} ${d.category}`, (rest.get(`${d.verdict} ${d.category}`) ?? 0) + 1);
  const dets = [
    ...listed.map((d) => `${d.verdict.padEnd(16)} ${d.category}: ${JSON.stringify(d.value)} (${d.source})${d.decoyKinds.length ? ` on ${d.decoyKinds.join(", ")}` : ""}`),
    ...(rest.size ? [`… and ${r.detections.length - listed.length} more: ${[...rest].map(([k, n]) => `${n} ${k}`).join(", ")}`] : []),
  ].join("\n");
  const flags = [
    r.items.some((i) => i.supported && !i.overlap) ? "miss" : "",
    r.items.some((i) => i.supported && i.overlap && !i.exact) ? "partial span" : "",
    r.detections.some((d) => d.verdict === "fp" || d.verdict === "decoy" || d.verdict === "wrong_category") ? "false positive" : "",
    r.items.some((i) => i.merged) ? "merged" : "",
  ].filter(Boolean);
  return `<details><summary><code>${esc(r.caseId)}</code> <span class="tag">${esc(r.type)}</span><span class="tag">${esc(r.register)}</span>${flags.map((f) => `<span class="tag bad">${f}</span>`).join("")}${r.perturbationNote ? ` <span class="muted">${esc(r.perturbationNote)}</span>` : ""}</summary><pre>${highlighted(r)}</pre><h3>Items</h3><pre>${esc(items || "(none)")}</pre><h3>Selected detections</h3><pre>${esc(dets || "(none)")}</pre></details>`;
}

const fpCategories = (l: LargeCaseSummary) =>
  Object.entries(l.fpByCategory)
    .sort(([, a], [, b]) => b - a)
    .map(([c, n]) => `${c} ${n.toLocaleString("en")}`)
    .join(", ") || "none";
const largeMs = (meta: DetRunMeta, config: string, caseId: string) => meta.timing.large?.find((t) => t.config === config && t.caseId === caseId)?.ms;

/** Large generated cases: false-positive floods and runtime, apart from the other metrics. */
function largeSection(meta: DetRunMeta, summaries: DetSummary[]): string {
  const rows = summaries.flatMap((s) =>
    (s.large ?? []).map(
      (l) =>
        `<tr><td>${esc(s.config)}</td><td><code>${esc(l.caseId)}</code></td><td class="num">${l.lines.toLocaleString("en")}</td><td class="num">${l.chars.toLocaleString("en")}</td><td class="num">${l.found}/${l.items}</td><td class="num">${l.redacted}/${l.items}</td><td class="num">${l.falsePositives.toLocaleString("en")}</td><td>${esc(fpCategories(l))}</td><td class="num">${num(largeMs(meta, s.config, l.caseId), 0)}</td></tr>`,
    ),
  );
  if (!rows.length) return "";
  return `<h2 id="large">Large generated cases</h2><p>Cases built from thousands of generated rows (<code>generated</code> in the dataset). They are left out of every metric above, so one flood does not swamp them, and are not perturbed. Found: items overlapped by their own category; false positives: every detection on no item.</p>
<div class="scroll"><table><thead><tr><th>Config</th><th>Case</th><th class="num">Lines</th><th class="num">Chars</th><th class="num">Found</th><th class="num">Redacted</th><th class="num">False positives</th><th>By category</th><th class="num">ms</th></tr></thead><tbody>${rows.join("")}</tbody></table></div>`;
}

const hasProblem = (r: DetScored) =>
  r.items.some((i) => (i.supported && (!i.exact || !i.leakFree)) || i.merged) || r.detections.some((d) => d.verdict !== "tp" && d.verdict !== "unsupported_item");

function casesSection(rows: DetScored[], summaries: DetSummary[]): string {
  const parts = summaries.map((s) => {
    const mine = rows.filter((r) => r.config === s.config);
    const base = mine.filter((r) => r.perturbation === "none");
    const problems = base.filter(hasProblem);
    // Variants that lost an item the base case found.
    const baseFound = new Map(base.map((r) => [r.caseId, new Set(r.items.filter((i) => i.overlap).map((i) => i.key))]));
    const regressions = mine.filter(
      (r) => r.perturbation !== "none" && r.items.some((i) => !i.overlap && baseFound.get(r.baseId)?.has(i.key)),
    );
    const byType = new Map<string, DetScored[]>();
    for (const r of regressions) byType.set(r.perturbation, [...(byType.get(r.perturbation) ?? []), r]);
    const regressionHtml = [...byType]
      .map(([type, list]) => `<h3>${esc(type)}: ${list.length} variant(s) lost an item the base case found</h3>${list.slice(0, 8).map(caseDetails).join("")}`)
      .join("");
    return `<h3>${esc(s.config)}: ${problems.length} of ${base.length} base cases with a miss, partial span, merge or false positive (supported categories)</h3>${problems.map(caseDetails).join("")}${regressionHtml}`;
  });
  return `<h2 id="cases">Cases</h2><p>Highlighted: ground-truth items (red when nothing redacts them). Every result is in <code>results.jsonl</code>.</p>${parts.join("")}`;
}

export function renderDetReport(meta: DetRunMeta, rows: DetScored[], summaries: DetSummary[]): string {
  const cfg = (name: string) => {
    const c = meta.configs[name];
    return c ? `${esc(JSON.stringify(c.categories))}, address countries ${esc(JSON.stringify(c.addressCountries))}` : "–";
  };
  return defangHtml(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Detector Bench ${esc(meta.name)}</title><style>${STYLE}${EXTRA_STYLE}td.wrap{white-space:normal;min-width:260px}</style></head><body><main>
<h1>Deterministic redaction bench: ${esc(meta.name)}</h1>
<p class="muted">Rule-based detector (<code>detectSensitiveData</code>) · ${meta.baseCases} base cases (EN + FR) · ${meta.variants} perturbed variants (seed ${meta.seed}, up to ${meta.variantsPerType} per type) · generated ${esc(meta.finishedAt)}</p>
<div class="kv">
<div>Extension ref</div><div><code>${esc(meta.ext.ref)}</code> @ <code>${esc(meta.ext.sha.slice(0, 10))}</code> “${esc(meta.ext.subject)}” (${esc(meta.ext.committedAt)})</div>
<div>Ref categories</div><div>${meta.refCategories.map((c) => `<code>${esc(c)}</code>`).join(" ")} → scored as ${meta.supported.map((c) => `<code>${esc(c)}</code>`).join(" ")}; not supported by this ref: ${DET_CATEGORIES.filter((c) => !meta.supported.includes(c)).map((c) => `<code>${c}</code>`).join(" ") || "none"}</div>
<div>Config <b>default</b></div><div>the ref's <code>DEFAULT_CONFIG</code>: ${cfg("default")}</div>
<div>Config <b>all</b></div><div>every category on and every address country: ${esc(meta.allConfigNote)}</div>
<div>Packages</div><div>${Object.entries(meta.packages).map(([n, v]) => `<code>${esc(n)}@${esc(v)}</code>`).join(" ")} (the ref's package-lock)</div>
<div>Dataset</div><div><code>${esc(meta.datasetHash.slice(0, 12))}</code> (<code>dataset/detbench/</code>)</div>
<div>Speed</div><div>${meta.timing.calls} calls, p50 ${num(meta.timing.p50Ms, 2)} ms, p95 ${num(meta.timing.p95Ms, 2)} ms, max ${num(meta.timing.maxMs, 1)} ms per prompt (${esc(meta.machine)}, Node ${esc(meta.node)})${meta.timing.slowest?.length ? `<br>Slowest: ${meta.timing.slowest.map((t) => `<code>${esc(t.caseId)}</code> [${esc(t.config)}] ${num(t.ms, 0)} ms for ${t.chars.toLocaleString("en")} chars`).join(", ")}` : ""}</div>
</div>
<h2 id="summary">Summary (base cases)</h2>
<p>P/R/F1 use only items of categories the ref supports; items of other categories are reported as <i>not supported by this ref</i>, not as misses. <b>Redacted</b> and <b>leak-free</b> use every item, whatever its category, so they compare refs end to end. Only selected detections count (what gets redacted without the user ticking anything).</p>
${headline(summaries)}
${categorySection(summaries, meta)}
${sliceSection(summaries)}
${robustnessSection(summaries)}
${negativesSection(summaries)}
${confusionSection(summaries)}
${largeSection(meta, summaries)}
${casesSection(rows, summaries)}
<h2>Method</h2><p>See the README section “Deterministic redaction bench” and <code>src/detbench/</code>. Ground truth: <code>dataset/detbench/*.jsonl</code> (templates with <code>{{key}}</code> placeholders; checksum-valid, fictional values).</p>
</main></body></html>`);
}

/** Plain-text summary for the terminal. */
export function textSummary(meta: DetRunMeta, summaries: DetSummary[]): string {
  const lines = [`${meta.name}: ${meta.ext.ref} @ ${meta.ext.sha.slice(0, 7)} · ${meta.baseCases} base cases, ${meta.variants} variants · p50 ${num(meta.timing.p50Ms, 2)} ms/prompt`];
  for (const s of summaries) {
    const m = s.overall;
    lines.push(
      `\n[${s.config}] F1 ${pct(m.overlap.f1)} (P ${pct(m.overlap.precision)} R ${pct(m.overlap.recall)}) · exact F1 ${pct(m.exact.f1)} · redacted ${pct(m.redactedRecall)} of all items · leak-free ${pct(m.leakFreeRate)} · negatives with FP ${pct(m.negativeFpRate)} · decoys flagged ${m.decoysFlagged}/${m.decoys}`,
    );
    for (const c of DET_CATEGORIES) {
      const cm = s.byCategory[c];
      if (!cm) continue;
      const langs = Object.entries(s.byCategoryLang[c] ?? {})
        .map(([l, lm]) => `${l} R ${pct(meta.supported.includes(c) ? lm.overlap.recall : lm.redactedRecall)}`)
        .join(", ");
      lines.push(
        meta.supported.includes(c)
          ? `  ${c.padEnd(14)} n=${String(cm.supportedItems).padStart(3)}  P ${pct(cm.overlap.precision).padStart(4)}  R ${pct(cm.overlap.recall).padStart(4)}  F1 ${pct(cm.overlap.f1).padStart(4)}  exact F1 ${pct(cm.exact.f1).padStart(4)}  (${langs})`
          : `  ${c.padEnd(14)} n=${String(cm.items).padStart(3)}  not supported by this ref; redacted under another category ${cm.unsupportedRedacted}/${cm.items}`,
      );
    }
    const zones = Object.entries(s.byZone ?? {})
      .map(([z, zm]) => `${z}: F1 ${pct(zm.overlap.f1)}, redacted ${pct(zm.redactedRecall)} of ${zm.items} items, decoys flagged ${zm.decoysFlagged}/${zm.decoys}`)
      .join(" · ");
    if (zones) lines.push(`  ${zones}`);
    const drops = Object.entries(s.perturbations)
      .filter(([t]) => t !== "all")
      .map(([t, p]) => `${t} ${pct(p.base.overlap.f1)}→${pct(p.perturbed.overlap.f1)}`)
      .join(", ");
    if (drops) lines.push(`  perturbations (F1 base→perturbed): ${drops}`);
    for (const l of s.large ?? []) {
      const ms = largeMs(meta, s.config, l.caseId);
      lines.push(
        `  large ${l.caseId} (${l.lines.toLocaleString("en")} lines, ${l.chars.toLocaleString("en")} chars): found ${l.found}/${l.items}, false positives ${l.falsePositives.toLocaleString("en")} (${fpCategories(l)})${ms === undefined ? "" : `, ${num(ms, 0)} ms`}`,
      );
    }
  }
  return lines.join("\n");
}

// ------------------------------------------------------------ comparison

export function renderDetCompare(a: { meta: DetRunMeta; summaries: DetSummary[] }, b: { meta: DetRunMeta; summaries: DetSummary[] }): string {
  const sections = a.summaries
    .map((sa) => {
      const sb = b.summaries.find((s) => s.config === sa.config);
      if (!sb) return "";
      const overall = `<tr><td><b>overall</b></td><td></td><td></td>${arrowCell(sa.overall.overlap.f1, sb.overall.overlap.f1)}${arrowCell(sa.overall.overlap.precision, sb.overall.overlap.precision)}${arrowCell(sa.overall.overlap.recall, sb.overall.overlap.recall)}${arrowCell(sa.overall.exact.f1, sb.overall.exact.f1)}${arrowCell(sa.overall.redactedRecall, sb.overall.redactedRecall)}${arrowCell(sa.overall.leakFreeRate, sb.overall.leakFreeRate)}${arrowCell(sa.overall.negativeFpRate, sb.overall.negativeFpRate)}</tr>`;
      const zones = (["prose", "code"] as const)
        .filter((z) => sa.byZone?.[z] && sb.byZone?.[z])
        .map((z) => {
          const za = sa.byZone[z]!;
          const zb = sb.byZone[z]!;
          return `<tr><td><i>in ${z}</i></td><td></td><td></td>${arrowCell(za.overlap.f1, zb.overlap.f1)}${arrowCell(za.overlap.precision, zb.overlap.precision)}${arrowCell(za.overlap.recall, zb.overlap.recall)}${arrowCell(za.exact.f1, zb.exact.f1)}${arrowCell(za.redactedRecall, zb.redactedRecall)}${arrowCell(za.leakFreeRate, zb.leakFreeRate)}<td></td></tr>`;
        })
        .join("");
      const cats = DET_CATEGORIES.filter((c) => sa.byCategory[c] || sb.byCategory[c])
        .map((c) => {
          const ma = sa.byCategory[c];
          const mb = sb.byCategory[c];
          const supA = a.meta.supported.includes(c);
          const supB = b.meta.supported.includes(c);
          const cell = (va: number | null | undefined, vb: number | null | undefined) =>
            !supA && !supB ? `<td class="ns">n/s → n/s</td>` : `<td class="num">${supA ? pct(va ?? null) : "n/s"} → ${supB ? pct(vb ?? null) : "n/s"}${supA && supB ? pp(delta(va ?? null, vb ?? null)) : ""}</td>`;
          return `<tr><td><code>${c}</code></td><td>${supA ? "yes" : "no"}</td><td>${supB ? "yes" : "no"}</td>${cell(ma?.overlap.f1, mb?.overlap.f1)}${cell(ma?.overlap.precision, mb?.overlap.precision)}${cell(ma?.overlap.recall, mb?.overlap.recall)}${cell(ma?.exact.f1, mb?.exact.f1)}${arrowCell(ma?.redactedRecall ?? null, mb?.redactedRecall ?? null)}${arrowCell(ma?.leakFreeRate ?? null, mb?.leakFreeRate ?? null)}<td></td></tr>`;
        })
        .join("");
      const perts = Object.keys({ ...sa.perturbations, ...sb.perturbations })
        .map((t) => {
          const pa = sa.perturbations[t];
          const pb = sb.perturbations[t];
          return `<tr><td>${esc(t)}</td>${arrowCell(pa?.perturbed.overlap.f1 ?? null, pb?.perturbed.overlap.f1 ?? null)}${arrowCell(pa?.perturbed.overlap.recall ?? null, pb?.perturbed.overlap.recall ?? null)}${arrowCell(pa?.perturbed.redactedRecall ?? null, pb?.perturbed.redactedRecall ?? null)}<td class="num">${points(pa ? delta(pa.base.overlap.f1, pa.perturbed.overlap.f1) : null)} → ${points(pb ? delta(pb.base.overlap.f1, pb.perturbed.overlap.f1) : null)}</td></tr>`;
        })
        .join("");
      const decoys = Object.keys({ ...sa.decoys, ...sb.decoys })
        .map((k) => `<tr><td><code>${esc(k)}</code></td><td class="num">${sa.decoys[k]?.flagged ?? "–"}/${sa.decoys[k]?.total ?? "–"} → ${sb.decoys[k]?.flagged ?? "–"}/${sb.decoys[k]?.total ?? "–"}</td></tr>`)
        .join("");
      const large = [...new Set([...(sa.large ?? []), ...(sb.large ?? [])].map((l) => l.caseId))]
        .map((id) => {
          const la = sa.large?.find((l) => l.caseId === id);
          const lb = sb.large?.find((l) => l.caseId === id);
          const msA = largeMs(a.meta, sa.config, id);
          const msB = largeMs(b.meta, sb.config, id);
          return `<tr><td><code>${esc(id)}</code></td><td class="num">${la ? `${la.found}/${la.items}` : "–"} → ${lb ? `${lb.found}/${lb.items}` : "–"}</td><td class="num">${la?.falsePositives.toLocaleString("en") ?? "–"} → ${lb?.falsePositives.toLocaleString("en") ?? "–"}</td><td class="num">${num(msA, 0)} → ${num(msB, 0)}</td></tr>`;
        })
        .join("");
      const largeHtml = large
        ? `<h3>Large generated cases</h3><div class="scroll"><table><thead><tr><th>Case</th><th class="num">Found</th><th class="num">False positives</th><th class="num">ms</th></tr></thead><tbody>${large}</tbody></table></div>`
        : "";
      return `<h2>${esc(sa.config)}</h2>
<div class="scroll"><table><thead><tr><th>Category</th><th>A supports</th><th>B supports</th><th class="num">F1 overlap</th><th class="num">Precision</th><th class="num">Recall</th><th class="num">F1 exact</th><th class="num">Redacted (any category)</th><th class="num">Leak-free</th><th class="num">FP rate (negatives)</th></tr></thead><tbody>${overall}${zones}${cats}</tbody></table></div>
<h3>Perturbed variants</h3><div class="scroll"><table><thead><tr><th>Perturbation</th><th class="num">F1 overlap</th><th class="num">Recall</th><th class="num">Redacted</th><th class="num">F1 change vs base</th></tr></thead><tbody>${perts}</tbody></table></div>
<h3>Hard negatives flagged</h3><div class="scroll"><table><thead><tr><th>Decoy kind</th><th class="num">A → B</th></tr></thead><tbody>${decoys}</tbody></table></div>${largeHtml}`;
    })
    .join("");
  const same = a.meta.datasetHash === b.meta.datasetHash;
  return defangHtml(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Detector Bench Comparison</title><style>${STYLE}${EXTRA_STYLE}</style></head><body><main>
<h1>Deterministic redaction bench: comparison</h1>
<p><b>A</b> ${esc(a.meta.name)}: <code>${esc(a.meta.ext.ref)}</code> @ <code>${esc(a.meta.ext.sha.slice(0, 10))}</code> “${esc(a.meta.ext.subject)}”<br><b>B</b> ${esc(b.meta.name)}: <code>${esc(b.meta.ext.ref)}</code> @ <code>${esc(b.meta.ext.sha.slice(0, 10))}</code> “${esc(b.meta.ext.subject)}”</p>
<p>${same ? "Same dataset and perturbations" : `<span class="tag bad">different datasets</span> (${esc(a.meta.datasetHash.slice(0, 12))} vs ${esc(b.meta.datasetHash.slice(0, 12))}, seeds ${a.meta.seed}/${b.meta.seed})`}. <b>n/s</b>: category not supported by that ref (its items are not scored as misses; <i>redacted</i> still shows whether another category covered them). Deltas in percentage points.</p>
${sections}
</main></body></html>`);
}
