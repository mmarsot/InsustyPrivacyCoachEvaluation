/** Aggregates scored cases into metrics, overall and per breakdown dimension. */
import { FAILURE_MODES, type FailureMode, type Scored } from "./score.ts";

export interface Prf {
  tp: number;
  predicted: number;
  expected: number;
  found: number;
  precision: number | null;
  recall: number | null;
  f1: number | null;
}

export interface Metrics {
  cases: number;
  positives: number;
  negatives: number;
  exact: Prf;
  overlap: Prf;
  /** Share of expected passages overlapped by any finding, whatever its label. */
  anyLabelRecall: number | null;
  /** Positive cases with at least one expected passage found (overlap, right label). */
  caseDetection: number | null;
  /** Negative cases with at least one custom-label finding. */
  falsePositiveRate: number | null;
  compliance: number | null;
  failures: Record<FailureMode, number>;
  timeouts: number;
  builtinFindings: number;
  latencyP50: number | null;
  latencyP95: number | null;
  meanGeneratedTokens: number | null;
}

const ratio = (n: number, d: number) => (d ? n / d : null);
const prf = (
  tp: number,
  predicted: number,
  found: number,
  expected: number,
): Prf => {
  const precision = ratio(tp, predicted);
  const recall = ratio(found, expected);
  const f1 =
    precision !== null && recall !== null && precision + recall > 0
      ? (2 * precision * recall) / (precision + recall)
      : precision !== null && recall !== null
        ? 0
        : null;
  return { tp, predicted, expected, found, precision, recall, f1 };
};
export const percentile = (values: number[], p: number): number | null => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return sorted[
    Math.min(
      sorted.length - 1,
      Math.max(0, Math.ceil((p / 100) * sorted.length) - 1),
    )
  ]!;
};

export function metrics(rows: Scored[], label?: string): Metrics {
  const preds = rows
    .flatMap((r) => r.predicted)
    .filter((p) => !label || p.label === label);
  const exps = rows
    .flatMap((r) => r.expected)
    .filter((e) => !label || e.label === label);
  const positives = rows.filter((r) => r.positive);
  const negatives = rows.filter((r) => !r.positive);
  const failures = Object.fromEntries(
    FAILURE_MODES.map((m) => [m, 0]),
  ) as Record<FailureMode, number>;
  for (const r of rows) failures[r.failure]++;
  return {
    cases: rows.length,
    positives: positives.length,
    negatives: negatives.length,
    exact: prf(
      preds.filter((p) => p.exact).length,
      preds.length,
      exps.filter((e) => e.exact).length,
      exps.length,
    ),
    overlap: prf(
      preds.filter((p) => p.overlap).length,
      preds.length,
      exps.filter((e) => e.overlap).length,
      exps.length,
    ),
    anyLabelRecall: ratio(exps.filter((e) => e.anyLabel).length, exps.length),
    caseDetection: ratio(
      positives.filter((r) => r.detected).length,
      positives.length,
    ),
    falsePositiveRate: ratio(
      negatives.filter((r) => r.falsePositiveCase).length,
      negatives.length,
    ),
    compliance: ratio(rows.filter((r) => r.compliant).length, rows.length),
    failures,
    timeouts: rows.filter((r) => r.timeout).length,
    builtinFindings: rows.reduce((a, r) => a + r.builtinPredicted, 0),
    latencyP50: percentile(
      rows.map((r) => r.reviewMs),
      50,
    ),
    latencyP95: percentile(
      rows.map((r) => r.reviewMs),
      95,
    ),
    meanGeneratedTokens: rows.length
      ? rows.reduce((a, r) => a + r.generatedTokens, 0) / rows.length
      : null,
  };
}

/** Dimensions every report breaks results down by. */
export const DIMENSIONS: ReadonlyArray<{
  id: string;
  title: string;
  get(r: Scored): string;
}> = [
  { id: "lang", title: "Language", get: (r) => r.lang },
  {
    id: "langMixed",
    title: "Language (mixed-language cases separated)",
    get: (r) => (r.mixed ? `${r.lang}+mixed` : r.lang),
  },
  { id: "profile", title: "Profile", get: (r) => r.profile },
  { id: "type", title: "Case type", get: (r) => r.type },
  { id: "difficulty", title: "Difficulty", get: (r) => r.difficulty },
  { id: "lengthBucket", title: "Length", get: (r) => r.lengthBucket },
  { id: "register", title: "Style: register", get: (r) => r.register },
  { id: "errors", title: "Style: error level", get: (r) => r.errors },
];

export interface ConfigSummary {
  config: string;
  model: string;
  instruction: string;
  labelVariant: string;
  overall: Metrics;
  byLabel: Record<string, Metrics>;
  breakdowns: Record<string, Record<string, Metrics>>;
}

export function summarize(rows: Scored[]): ConfigSummary[] {
  const configs = [...new Set(rows.map((r) => r.config))];
  return configs.map((config) => {
    const mine = rows.filter((r) => r.config === config);
    const first = mine[0]!;
    const labels = [
      ...new Set(
        mine.flatMap((r) => [
          ...r.expected.map((e) => e.label),
          ...r.predicted.map((p) => p.label),
        ]),
      ),
    ].sort();
    const breakdowns: ConfigSummary["breakdowns"] = {};
    for (const dim of DIMENSIONS) {
      const values = [...new Set(mine.map(dim.get))].sort();
      breakdowns[dim.id] = Object.fromEntries(
        values.map((v) => [v, metrics(mine.filter((r) => dim.get(r) === v))]),
      );
    }
    return {
      config,
      model: first.model,
      instruction: first.instruction,
      labelVariant: first.labelVariant,
      overall: metrics(mine),
      byLabel: Object.fromEntries(labels.map((l) => [l, metrics(mine, l)])),
      breakdowns,
    };
  });
}

/** Long-format CSV: config, dimension, value, metric, number. */
export function toCsv(summaries: ConfigSummary[]): string {
  const lines = [
    "config,model,instruction,label_variant,dimension,value,metric,number",
  ];
  const flat = (m: Metrics): Array<[string, number | null]> => [
    ["cases", m.cases],
    ["exact_precision", m.exact.precision],
    ["exact_recall", m.exact.recall],
    ["exact_f1", m.exact.f1],
    ["overlap_precision", m.overlap.precision],
    ["overlap_recall", m.overlap.recall],
    ["overlap_f1", m.overlap.f1],
    ["any_label_recall", m.anyLabelRecall],
    ["case_detection", m.caseDetection],
    ["false_positive_rate", m.falsePositiveRate],
    ["format_compliance", m.compliance],
    ["latency_p50_ms", m.latencyP50],
    ["latency_p95_ms", m.latencyP95],
    ["mean_generated_tokens", m.meanGeneratedTokens],
    ...FAILURE_MODES.map(
      (f) => [`failure_${f}`, m.failures[f]] as [string, number],
    ),
  ];
  const esc = (s: string) =>
    /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
  const push = (s: ConfigSummary, dim: string, value: string, m: Metrics) => {
    for (const [metric, n] of flat(m))
      lines.push(
        [
          s.config,
          s.model,
          s.instruction,
          s.labelVariant,
          dim,
          value,
          metric,
          n === null ? "" : String(Number(n.toFixed(4))),
        ]
          .map(esc)
          .join(","),
      );
  };
  for (const s of summaries) {
    push(s, "overall", "all", s.overall);
    for (const [label, m] of Object.entries(s.byLabel))
      push(s, "label", label, m);
    for (const [dim, values] of Object.entries(s.breakdowns))
      for (const [value, m] of Object.entries(values)) push(s, dim, value, m);
  }
  return lines.join("\n") + "\n";
}
