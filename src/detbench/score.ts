/**
 * Scores the detector's output on one case.
 *
 * Only selected detections count: they are what the extension redacts unless
 * the user unticks them. Each detection gets one verdict:
 *   - tp:               it overlaps a ground-truth item of its own category;
 *   - wrong_category:   it overlaps only items of other (supported) categories;
 *   - unsupported_item: it overlaps only items of categories the ref does not
 *                       have; left out of precision, since the ref could not
 *                       have named them;
 *   - decoy:            it overlaps a hard negative (timestamp, SHA, price...);
 *   - fp:               it overlaps nothing.
 * Each item records:
 *   - overlap: a same-category detection overlaps it;
 *   - exact:   a same-category detection has exactly its span;
 *   - redacted: any detection overlaps it, whatever the category;
 *   - leakFree: every non-space character of it is inside some detection;
 *   - merged:  a detection overlapping it also overlaps another item (one
 *              span swallowed two values).
 * Items of unsupported categories are kept with `supported: false`; category
 * precision/recall only use supported items.
 */
import type { RefDetection } from "./ext.ts";
import type { DetCase, DetCategory } from "./schema.ts";

export type Verdict = "tp" | "wrong_category" | "unsupported_item" | "decoy" | "fp";

export interface ScoredItem {
  key: string;
  category: DetCategory;
  kind: string;
  value: string;
  start: number;
  end: number;
  supported: boolean;
  overlap: boolean;
  exact: boolean;
  redacted: boolean;
  leakFree: boolean;
  merged: boolean;
  /** Ref categories of the detections overlapping it. */
  detectedAs: string[];
}
export interface ScoredDetection {
  category: string;
  mapped: DetCategory | null;
  start: number;
  end: number;
  value: string;
  source: string;
  verdict: Verdict;
  exact: boolean;
  items: string[];
  decoyKinds: string[];
}
export interface ScoredDecoy {
  key: string;
  kind: string;
  value: string;
  flagged: boolean;
  flaggedAs: string[];
}

export interface DetScored {
  config: string;
  caseId: string;
  baseId: string;
  lang: string;
  register: string;
  type: string;
  tags: string[];
  perturbation: string;
  perturbationNote?: string;
  text: string;
  items: ScoredItem[];
  detections: ScoredDetection[];
  decoys: ScoredDecoy[];
  /** Detections the ref left unselected (category switched off). */
  unselected: number;
}

const overlaps = (a: { start: number; end: number }, b: { start: number; end: number }) => a.start < b.end && b.start < a.end;

export function scoreDetCase(c: DetCase, detections: RefDetection[], supported: readonly DetCategory[], config: string): DetScored {
  const selected = detections.filter((d) => d.selected);
  const supportedSet = new Set(supported);
  const scoredDetections: ScoredDetection[] = selected.map((d) => {
    const hits = c.gold.filter((g) => overlaps(g, d));
    const decoyKinds = [...new Set(c.decoySpans.filter((s) => overlaps(s, d)).map((s) => s.kind))];
    const own = hits.filter((g) => g.category === d.mapped);
    const verdict: Verdict = own.length
      ? "tp"
      : hits.length && hits.every((g) => !supportedSet.has(g.category))
        ? "unsupported_item"
        : hits.length
          ? "wrong_category"
          : decoyKinds.length
            ? "decoy"
            : "fp";
    return {
      category: d.category,
      mapped: d.mapped,
      start: d.start,
      end: d.end,
      value: d.value,
      source: d.source,
      verdict,
      exact: own.some((g) => g.start === d.start && g.end === d.end),
      items: [...new Set(hits.map((g) => g.key))],
      decoyKinds,
    };
  });
  const items: ScoredItem[] = c.gold.map((g) => {
    const touching = scoredDetections.filter((d) => overlaps(g, d));
    const same = touching.filter((d) => d.mapped === g.category);
    let leakFree = true;
    for (let i = g.start; i < g.end && leakFree; i++)
      if (!/\s/u.test(c.text[i]!) && !touching.some((d) => d.start <= i && i < d.end)) leakFree = false;
    return {
      key: g.key,
      category: g.category,
      kind: g.kind,
      value: g.value,
      start: g.start,
      end: g.end,
      supported: supportedSet.has(g.category),
      overlap: same.length > 0,
      exact: same.some((d) => d.start === g.start && d.end === g.end),
      redacted: touching.length > 0,
      leakFree,
      merged: touching.some((d) => d.items.some((k) => k !== g.key)),
      detectedAs: [...new Set(touching.map((d) => d.category))],
    };
  });
  const decoys: ScoredDecoy[] = c.decoySpans.map((s) => {
    const touching = scoredDetections.filter((d) => overlaps(s, d) && d.verdict === "decoy");
    return { key: s.key, kind: s.kind, value: s.value, flagged: touching.length > 0, flaggedAs: [...new Set(touching.map((d) => d.category))] };
  });
  return {
    config,
    caseId: c.id,
    baseId: c.baseId,
    lang: c.lang,
    register: c.register,
    type: c.type,
    tags: c.tags,
    perturbation: c.perturbation,
    perturbationNote: c.perturbationNote,
    text: c.text,
    items,
    detections: scoredDetections,
    decoys,
    unselected: detections.length - selected.length,
  };
}

/** Detections that count against precision. */
export const isFalsePositive = (d: ScoredDetection) => d.verdict === "wrong_category" || d.verdict === "decoy" || d.verdict === "fp";
