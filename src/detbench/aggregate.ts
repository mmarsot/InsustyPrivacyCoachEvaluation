/** Aggregates scored detbench cases into metrics per configuration and slice. */
import { DET_CATEGORIES, type DetCategory, type Zone } from "./schema.ts";
import { PERTURBATIONS } from "./perturb.ts";
import { isFalsePositive, type DetScored } from "./score.ts";

export interface DetMetrics {
  cases: number;
  /** Ground-truth items, all categories. */
  items: number;
  /** Items in categories this ref supports (the P/R/F1 base). */
  supportedItems: number;
  unsupportedItems: number;
  /** Detections counted for precision (detections on unsupported items left out). */
  detections: number;
  tp: number;
  exactTp: number;
  found: number;
  foundExact: number;
  overlap: {
    precision: number | null;
    recall: number | null;
    f1: number | null;
  };
  exact: { precision: number | null; recall: number | null; f1: number | null };
  /** Items overlapped by any detection, whatever its category (all items). */
  redactedRecall: number | null;
  /** Items with no visible non-space character left (all items). */
  leakFreeRate: number | null;
  /** Unsupported items redacted under another category. */
  unsupportedRedacted: number;
  wrongCategory: number;
  /** Items sharing a detection span with another item. */
  mergedItems: number;
  falsePositives: number;
  decoys: number;
  decoysFlagged: number;
  negatives: number;
  /** Negative cases (no item) with at least one false-positive detection. */
  negativeFpCases: number;
  negativeFpRate: number | null;
}

const ratio = (n: number, d: number) => (d ? n / d : null);
const f1 = (p: number | null, r: number | null) =>
  p === null || r === null ? null : p + r > 0 ? (2 * p * r) / (p + r) : 0;

export interface MetricFilter {
  category?: DetCategory;
  kind?: string;
  /** Items, decoys and detections (by where they start) in prose or in code blocks. */
  zone?: Zone;
}

export function detMetrics(
  rows: DetScored[],
  filter: MetricFilter = {},
): DetMetrics {
  const inZone = (x: { zone: Zone }) => !filter.zone || x.zone === filter.zone;
  const items = rows
    .flatMap((r) => r.items)
    .filter(
      (i) =>
        (!filter.category || i.category === filter.category) &&
        (!filter.kind || i.kind === filter.kind) &&
        inZone(i),
    );
  // Precision is per detection category; a kind filter has no detection side.
  const detections = filter.kind
    ? []
    : rows
        .flatMap((r) => r.detections)
        .filter(
          (d) =>
            d.verdict !== "unsupported_item" &&
            (!filter.category || d.mapped === filter.category) &&
            inZone(d),
        );
  const supported = items.filter((i) => i.supported);
  const unsupported = items.filter((i) => !i.supported);
  const tp = detections.filter((d) => d.verdict === "tp").length;
  const exactTp = detections.filter(
    (d) => d.verdict === "tp" && d.exact,
  ).length;
  const found = supported.filter((i) => i.overlap).length;
  const foundExact = supported.filter((i) => i.exact).length;
  const pOverlap = filter.kind ? null : ratio(tp, detections.length);
  const rOverlap = ratio(found, supported.length);
  const pExact = filter.kind ? null : ratio(exactTp, detections.length);
  const rExact = ratio(foundExact, supported.length);
  const decoys =
    filter.category || filter.kind
      ? []
      : rows.flatMap((r) => r.decoys).filter(inZone);
  const negatives = rows.filter((r) => r.type === "negative");
  const negativeFpCases = negatives.filter((r) =>
    r.detections.some(
      (d) =>
        isFalsePositive(d) &&
        (!filter.category || d.mapped === filter.category) &&
        inZone(d),
    ),
  ).length;
  return {
    cases: rows.length,
    items: items.length,
    supportedItems: supported.length,
    unsupportedItems: unsupported.length,
    detections: detections.length,
    tp,
    exactTp,
    found,
    foundExact,
    overlap: {
      precision: pOverlap,
      recall: rOverlap,
      f1: filter.kind ? null : f1(pOverlap, rOverlap),
    },
    exact: {
      precision: pExact,
      recall: rExact,
      f1: filter.kind ? null : f1(pExact, rExact),
    },
    redactedRecall: ratio(items.filter((i) => i.redacted).length, items.length),
    leakFreeRate: ratio(items.filter((i) => i.leakFree).length, items.length),
    unsupportedRedacted: unsupported.filter((i) => i.redacted).length,
    wrongCategory: detections.filter((d) => d.verdict === "wrong_category")
      .length,
    mergedItems: items.filter((i) => i.merged).length,
    falsePositives: detections.filter(isFalsePositive).length,
    decoys: decoys.length,
    decoysFlagged: decoys.filter((d) => d.flagged).length,
    negatives: negatives.length,
    negativeFpCases,
    negativeFpRate: ratio(negativeFpCases, negatives.length),
  };
}

export interface PerturbationSummary {
  /** Base cases the perturbation applied to. */
  baseCases: number;
  variants: number;
  base: DetMetrics;
  perturbed: DetMetrics;
  /** Recall (overlap, same category) per category: base vs perturbed. */
  byCategory: Record<string, { base: DetMetrics; perturbed: DetMetrics }>;
}

export interface DecoySummary {
  total: number;
  flagged: number;
  flaggedAs: Record<string, number>;
}

/** One large generated case, scored apart so its flood does not swamp the other metrics. */
export interface LargeCaseSummary {
  caseId: string;
  lang: string;
  chars: number;
  lines: number;
  items: number;
  /** Items overlapped by a detection of their own category. */
  found: number;
  /** Items overlapped by any detection. */
  redacted: number;
  /** False-positive detections (fp, decoy and wrong category), in all and per ref category. */
  falsePositives: number;
  fpByCategory: Record<string, number>;
}

export interface DetSummary {
  config: string;
  /** Base (unperturbed) cases only. */
  overall: DetMetrics;
  byCategory: Record<string, DetMetrics>;
  byCategoryLang: Record<string, Record<string, DetMetrics>>;
  byKind: Record<string, DetMetrics>;
  byLang: Record<string, DetMetrics>;
  byType: Record<string, DetMetrics>;
  byRegister: Record<string, DetMetrics>;
  /** Per dataset tag (a case counts under each of its tags); absent in runs made before tags were sliced. */
  byTag?: Record<string, DetMetrics>;
  /** Items, decoys and detections in prose vs inside code blocks. */
  byZone: Record<string, DetMetrics>;
  decoys: Record<string, DecoySummary>;
  /** Gold category -> ref category of overlapping detections ("(missed)" when none). */
  confusion: Record<string, Record<string, number>>;
  /** All variants together, and per perturbation type, against the same base cases. */
  perturbations: Record<string, PerturbationSummary>;
  /** Large generated cases, left out of every metric above (absent in runs made before they existed). */
  large?: LargeCaseSummary[];
}

export function largeCaseSummary(r: DetScored): LargeCaseSummary {
  const fps = r.detections.filter(isFalsePositive);
  const fpByCategory: Record<string, number> = {};
  for (const d of fps)
    fpByCategory[d.category] = (fpByCategory[d.category] ?? 0) + 1;
  return {
    caseId: r.caseId,
    lang: r.lang,
    chars: r.text.length,
    lines: r.text.split("\n").length,
    items: r.items.length,
    found: r.items.filter((i) => i.overlap).length,
    redacted: r.items.filter((i) => i.redacted).length,
    falsePositives: fps.length,
    fpByCategory,
  };
}

const groupBy = <T>(rows: T[], key: (r: T) => string): Map<string, T[]> => {
  const out = new Map<string, T[]>();
  for (const r of rows) {
    const k = key(r);
    out.set(k, [...(out.get(k) ?? []), r]);
  }
  return out;
};
const mapValues = <T, U>(
  m: Map<string, T>,
  f: (v: T, k: string) => U,
): Record<string, U> =>
  Object.fromEntries(
    [...m].sort(([a], [b]) => a.localeCompare(b)).map(([k, v]) => [k, f(v, k)]),
  );

export function summarizeConfig(config: string, all: DetScored[]): DetSummary {
  const rows = all.filter((r) => !r.large);
  const base = rows.filter((r) => r.perturbation === "none");
  const variants = rows.filter((r) => r.perturbation !== "none");
  const kinds = [
    ...new Set(base.flatMap((r) => r.items.map((i) => i.kind))),
  ].sort();
  const decoys: Record<string, DecoySummary> = {};
  for (const d of base.flatMap((r) => r.decoys)) {
    const s = (decoys[d.kind] ??= { total: 0, flagged: 0, flaggedAs: {} });
    s.total++;
    if (d.flagged) s.flagged++;
    for (const c of d.flaggedAs) s.flaggedAs[c] = (s.flaggedAs[c] ?? 0) + 1;
  }
  const confusion: Record<string, Record<string, number>> = {};
  for (const i of base.flatMap((r) => r.items)) {
    const row = (confusion[i.category] ??= {});
    for (const c of i.detectedAs.length ? i.detectedAs : ["(missed)"])
      row[c] = (row[c] ?? 0) + 1;
  }
  const perturbation = (subset: DetScored[]): PerturbationSummary => {
    const ids = new Set(subset.map((r) => r.baseId));
    const bases = base.filter((r) => ids.has(r.baseId));
    return {
      baseCases: bases.length,
      variants: subset.length,
      base: detMetrics(bases),
      perturbed: detMetrics(subset),
      byCategory: Object.fromEntries(
        DET_CATEGORIES.filter((c) =>
          subset.some((r) => r.items.some((i) => i.category === c)),
        ).map((c) => [
          c,
          {
            base: detMetrics(bases, { category: c }),
            perturbed: detMetrics(subset, { category: c }),
          },
        ]),
      ),
    };
  };
  const perturbations: Record<string, PerturbationSummary> = {};
  if (variants.length) perturbations.all = perturbation(variants);
  for (const type of PERTURBATIONS) {
    const subset = variants.filter((r) => r.perturbation === type);
    if (subset.length) perturbations[type] = perturbation(subset);
  }
  const categories = DET_CATEGORIES.filter((c) =>
    base.some((r) => r.items.some((i) => i.category === c)),
  );
  return {
    config,
    overall: detMetrics(base),
    byCategory: Object.fromEntries(
      categories.map((c) => [c, detMetrics(base, { category: c })]),
    ),
    byCategoryLang: Object.fromEntries(
      categories.map((c) => [
        c,
        mapValues(
          groupBy(base, (r) => r.lang),
          (rs) => detMetrics(rs, { category: c }),
        ),
      ]),
    ),
    byKind: Object.fromEntries(
      kinds.map((k) => [k, detMetrics(base, { kind: k })]),
    ),
    byLang: mapValues(
      groupBy(base, (r) => r.lang),
      (rs) => detMetrics(rs),
    ),
    byType: mapValues(
      groupBy(base, (r) => r.type),
      (rs) => detMetrics(rs),
    ),
    byRegister: mapValues(
      groupBy(base, (r) => r.register),
      (rs) => detMetrics(rs),
    ),
    byZone: Object.fromEntries(
      (["prose", "code"] as const).map((z) => [
        z,
        detMetrics(base, { zone: z }),
      ]),
    ),
    byTag: Object.fromEntries(
      [...new Set(base.flatMap((r) => r.tags))]
        .sort()
        .map((t) => [t, detMetrics(base.filter((r) => r.tags.includes(t)))]),
    ),
    decoys,
    confusion,
    perturbations,
    large: all
      .filter((r) => r.large && r.perturbation === "none")
      .map(largeCaseSummary),
  };
}

export function summarizeDet(rows: DetScored[]): DetSummary[] {
  return [...groupBy(rows, (r) => r.config)].map(([config, rs]) =>
    summarizeConfig(config, rs),
  );
}

/** Long-format CSV: config, slice, value, metric, number. */
export function detCsv(summaries: DetSummary[]): string {
  const lines = ["config,slice,value,metric,number"];
  const emit = (
    config: string,
    slice: string,
    value: string,
    m: DetMetrics,
  ) => {
    const flat: Record<string, number | null> = {
      cases: m.cases,
      items: m.items,
      supported_items: m.supportedItems,
      unsupported_items: m.unsupportedItems,
      detections: m.detections,
      precision_overlap: m.overlap.precision,
      recall_overlap: m.overlap.recall,
      f1_overlap: m.overlap.f1,
      precision_exact: m.exact.precision,
      recall_exact: m.exact.recall,
      f1_exact: m.exact.f1,
      redacted_recall: m.redactedRecall,
      leak_free_rate: m.leakFreeRate,
      unsupported_redacted: m.unsupportedRedacted,
      wrong_category: m.wrongCategory,
      merged_items: m.mergedItems,
      false_positives: m.falsePositives,
      decoys: m.decoys,
      decoys_flagged: m.decoysFlagged,
      negative_fp_rate: m.negativeFpRate,
    };
    for (const [metric, n] of Object.entries(flat))
      if (n !== null) lines.push(`${config},${slice},${value},${metric},${n}`);
  };
  for (const s of summaries) {
    emit(s.config, "overall", "all", s.overall);
    for (const [k, m] of Object.entries(s.byCategory))
      emit(s.config, "category", k, m);
    for (const [c, langs] of Object.entries(s.byCategoryLang))
      for (const [l, m] of Object.entries(langs))
        emit(s.config, "category_lang", `${c}:${l}`, m);
    for (const [k, m] of Object.entries(s.byKind)) emit(s.config, "kind", k, m);
    for (const [k, m] of Object.entries(s.byLang)) emit(s.config, "lang", k, m);
    for (const [k, m] of Object.entries(s.byType)) emit(s.config, "type", k, m);
    for (const [k, m] of Object.entries(s.byRegister))
      emit(s.config, "register", k, m);
    for (const [k, m] of Object.entries(s.byZone)) emit(s.config, "zone", k, m);
    for (const [k, m] of Object.entries(s.byTag ?? {}))
      emit(s.config, "tag", k, m);
    for (const [k, p] of Object.entries(s.perturbations)) {
      emit(s.config, "perturbation_base", k, p.base);
      emit(s.config, "perturbation", k, p.perturbed);
    }
    for (const l of s.large ?? []) {
      for (const metric of [
        "chars",
        "items",
        "found",
        "redacted",
        "falsePositives",
      ] as const)
        lines.push(
          `${s.config},large,${l.caseId},${metric === "falsePositives" ? "false_positives" : metric},${l[metric]}`,
        );
      for (const [c, n] of Object.entries(l.fpByCategory))
        lines.push(`${s.config},large,${l.caseId},false_positives_${c},${n}`);
    }
    for (const [k, d] of Object.entries(s.decoys)) {
      lines.push(`${s.config},decoy,${k},total,${d.total}`);
      lines.push(`${s.config},decoy,${k},flagged,${d.flagged}`);
    }
  }
  return lines.join("\n") + "\n";
}
