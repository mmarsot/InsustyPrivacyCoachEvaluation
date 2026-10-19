/**
 * The harness's common metrics for a benchmark adapter, from contract spans.
 *
 * - **Headline**: gold spans whose label maps to a built-in label (the
 *   product's scope), whatever the system supports, so every system is
 *   measured on the same denominator. Recall counts a gold span as masked
 *   when a redacted span overlaps it (`recall`), covers it with the same
 *   boundaries (`recallExact`), or overlaps it with a label the map accepts
 *   (`recallTyped`); `partialCredit` gives 1 for exact and 0.5 for overlap
 *   (SemEval 2013 "partial"). Precision counts a redacted span as right when
 *   it overlaps any span that must be masked, of any label.
 * - **Outside the headline**: gold the map sends to custom labels (Private
 *   AI territory) and gold with no rule (`out_of_scope`), each its own row,
 *   plus the benchmark-native total over every gold span, so nothing is
 *   hidden.
 * - **Over-redaction**: characters masked outside every span that must be
 *   masked, per 1,000 characters.
 *
 * Multi-annotator gold (TAB) is micro-averaged: each annotator's mention
 * counts once.
 */
import type { RedactionOutput } from "../../../contract/types.ts";
import type { GoldCase, GoldSpan, LabelTarget } from "../../dataset.ts";

/**
 * Gold spans and how many a redacted span masked; `recall` is null without
 * gold.
 */
export interface RecallRow {
  gold: number;
  masked: number;
  recall: number | null;
}

/**
 * One system and configuration on one dataset (see the file header for each
 * metric).
 */
export interface AdapterScores {
  cases: number;
  chars: number;
  headline: RecallRow & {
    exact: number;
    typed: number;
    recallExact: number | null;
    recallTyped: number | null;
    partialCredit: number | null;
    predicted: number;
    correct: number;
    precision: number | null;
    f1: number | null;
    overRedactionPer1k: number | null;
  };
  /** Per built-in target label, then per gold label. */
  byBuiltin: Record<
    string,
    RecallRow & { typed: number; recallTyped: number | null }
  >;
  byGoldLabel: Record<
    string,
    RecallRow & { scope: "headline" | "custom" | "out_of_scope" }
  >;
  custom: RecallRow;
  outOfScope: RecallRow;
  nativeTotal: RecallRow;
  /** Gold labels the adapter's map does not list (counted out of scope). */
  unmapped: string[];
  falsePositiveSamples: Array<{ caseId: string; label: string; value: string }>;
}

const row = (gold: number, masked: number): RecallRow => ({
  gold,
  masked,
  recall: gold ? masked / gold : null,
});

/**
 * Scores a system's outputs (by case id) on an adapter's gold, through its
 * label map; cases without an output are left out.
 */
export function scoreAdapter(
  cases: GoldCase[],
  outputs: Map<string, RedactionOutput>,
  labelMap: Record<string, LabelTarget>,
): AdapterScores {
  const unmapped = new Set<string>();
  const scopeOf = (g: GoldSpan): "headline" | "custom" | "out_of_scope" => {
    const t = labelMap[g.label];
    if (t === undefined) unmapped.add(g.label);
    if (!t || t === "out_of_scope") return "out_of_scope";
    return "builtin" in t ? "headline" : "custom";
  };
  let chars = 0;
  let headGold = 0;
  let headMasked = 0;
  let headExact = 0;
  let headTyped = 0;
  let partial = 0;
  let predicted = 0;
  let correct = 0;
  let overChars = 0;
  const custom = { gold: 0, masked: 0 };
  const out = { gold: 0, masked: 0 };
  const byBuiltin: Record<
    string,
    { gold: number; masked: number; typed: number }
  > = {};
  const byGold: Record<
    string,
    {
      gold: number;
      masked: number;
      scope: "headline" | "custom" | "out_of_scope";
    }
  > = {};
  const fpSamples: AdapterScores["falsePositiveSamples"] = [];
  for (const c of cases) {
    const o = outputs.get(c.id);
    if (!o) continue;
    chars += c.text.length;
    const masked = o.spans.filter((s) => s.redacted);
    const goldCover = new Uint8Array(c.text.length);
    for (const g of c.gold) goldCover.fill(1, g.start, g.end);
    for (const g of c.gold) {
      const scope = scopeOf(g);
      const overlapping = masked.filter(
        (s) => s.start < g.end && g.start < s.end,
      );
      const hit = overlapping.length > 0;
      const bg = (byGold[g.label] ??= { gold: 0, masked: 0, scope });
      bg.gold++;
      if (hit) bg.masked++;
      if (scope === "custom") {
        custom.gold++;
        if (hit) custom.masked++;
        continue;
      }
      if (scope === "out_of_scope") {
        out.gold++;
        if (hit) out.masked++;
        continue;
      }
      const target = labelMap[g.label] as { builtin: string[] };
      const exact = overlapping.some(
        (s) => s.start === g.start && s.end === g.end,
      );
      const typed = overlapping.some(
        (s) => s.kind === "builtin" && target.builtin.includes(s.label),
      );
      headGold++;
      if (hit) headMasked++;
      if (exact) headExact++;
      if (typed) headTyped++;
      partial += exact ? 1 : hit ? 0.5 : 0;
      const key =
        target.builtin.length === 1
          ? target.builtin[0]!
          : target.builtin.join("|");
      const bb = (byBuiltin[key] ??= { gold: 0, masked: 0, typed: 0 });
      bb.gold++;
      if (hit) bb.masked++;
      if (typed) bb.typed++;
    }
    for (const s of masked) {
      predicted++;
      if (c.gold.some((g) => s.start < g.end && g.start < s.end)) correct++;
      else if (fpSamples.length < 40)
        fpSamples.push({
          caseId: c.id,
          label: s.label,
          value: c.text.slice(s.start, s.end).slice(0, 60),
        });
      for (let i = s.start; i < s.end; i++)
        if (!goldCover[i] && !/\s/u.test(c.text[i]!)) overChars++;
    }
  }
  const recall = headGold ? headMasked / headGold : null;
  const precision = predicted ? correct / predicted : null;
  const totalGold = headGold + custom.gold + out.gold;
  const totalMasked = headMasked + custom.masked + out.masked;
  return {
    cases: cases.filter((c) => outputs.has(c.id)).length,
    chars,
    headline: {
      ...row(headGold, headMasked),
      exact: headExact,
      typed: headTyped,
      recallExact: headGold ? headExact / headGold : null,
      recallTyped: headGold ? headTyped / headGold : null,
      partialCredit: headGold ? partial / headGold : null,
      predicted,
      correct,
      precision,
      f1:
        recall !== null && precision !== null && recall + precision > 0
          ? (2 * recall * precision) / (recall + precision)
          : null,
      overRedactionPer1k: chars ? (overChars / chars) * 1000 : null,
    },
    byBuiltin: Object.fromEntries(
      Object.entries(byBuiltin).map(([k, v]) => [
        k,
        {
          ...row(v.gold, v.masked),
          typed: v.typed,
          recallTyped: v.gold ? v.typed / v.gold : null,
        },
      ]),
    ),
    byGoldLabel: Object.fromEntries(
      Object.entries(byGold)
        .sort((a, b) => b[1].gold - a[1].gold)
        .map(([k, v]) => [k, { ...row(v.gold, v.masked), scope: v.scope }]),
    ),
    custom: row(custom.gold, custom.masked),
    outOfScope: row(out.gold, out.masked),
    nativeTotal: row(totalGold, totalMasked),
    unmapped: [...unmapped].sort(),
    falsePositiveSamples: fpSamples,
  };
}

/** Modules compared on the labels every one of them maps (one dataset, one configuration). */
export interface SharedComparison {
  dataset: string;
  config: string;
  labels: string[];
  rows: Array<{
    system: string;
    gold: number;
    recall: number | null;
    precision: number | null;
    f1: number | null;
  }>;
}

/**
 * For each dataset and configuration scored for two modules or more: every
 * module's headline on the labels all of them answer with built-in labels
 * (the others count as out of scope), so they compare like with like.
 */
export function sharedComparisons(
  scored: Array<{
    dataset: string;
    config: string;
    system: string;
    cases: GoldCase[];
    outputs: Map<string, RedactionOutput>;
    labelMap: Record<string, LabelTarget>;
  }>,
): SharedComparison[] {
  const out: SharedComparison[] = [];
  const keys = [...new Set(scored.map((s) => `${s.dataset}\u0000${s.config}`))];
  for (const key of keys) {
    const group = scored.filter((s) => `${s.dataset}\u0000${s.config}` === key);
    if (group.length < 2) continue;
    const builtin = (map: Record<string, LabelTarget>) =>
      Object.keys(map).filter((l) => {
        const t = map[l];
        return typeof t === "object" && "builtin" in t;
      });
    const labels = builtin(group[0]!.labelMap).filter((l) =>
      group.every((s) => builtin(s.labelMap).includes(l)),
    );
    out.push({
      dataset: group[0]!.dataset,
      config: group[0]!.config,
      labels,
      rows: group.map((s) => {
        const restricted = Object.fromEntries(
          Object.entries(s.labelMap).map(([l, t]) => [
            l,
            labels.includes(l) ? t : ("out_of_scope" as const),
          ]),
        );
        const h = scoreAdapter(s.cases, s.outputs, restricted).headline;
        return {
          system: s.system,
          gold: h.gold,
          recall: h.recall,
          precision: h.precision,
          f1: h.f1,
        };
      }),
    });
  }
  return out;
}
