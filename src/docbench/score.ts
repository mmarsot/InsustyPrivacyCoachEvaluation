/**
 * Scores one document read by a ref.
 *
 * - **Extraction**: each placed value is looked for in the extracted text,
 *   whitespace-insensitive (a value wrapped over two lines still counts; one
 *   broken by a hyphen does not, since the detector sees it broken). A value
 *   that repeats in a document is matched by count, in text order.
 * - **Detection**: the located values become ground-truth spans and the
 *   ref's selected detections are scored with detbench's `scoreDetCase`
 *   (same verdicts: tp, wrong_category, unsupported_item, decoy, fp). Any
 *   detection that is not on a placed value is a false alarm.
 * - **Classification**: what the user would be told (`checked`, `partial`,
 *   `unchecked` + reason, signed) against the case's expectation; a file
 *   that should be partly or not checked but reads as fully checked is a
 *   **silent clean**, the failure that matters most.
 * - **Redaction**: in the redacted output, read by an independent reader
 *   (`verify.ts`), every value the ref redacted completely must be gone.
 */
import { mapCategory } from "../detbench/ext.ts";
import { scoreDetCase, isFalsePositive } from "../detbench/score.ts";
import type {
  DetCase,
  DetCategory,
  GoldSpan,
  DecoySpan,
  Zone,
} from "../detbench/schema.ts";
import type { Unit } from "./content.ts";
import type { BuiltDoc, Expectation } from "./specs.ts";
import type {
  ConfigName,
  DocSegmentLike,
  PipelineRead,
  PipelineRedaction,
} from "./pipeline.ts";
import { normalizeSpaces, type Views } from "./verify.ts";

/** What one configuration did to one placed value. */
export interface ItemConfigResult {
  /** A detection of the item's own category overlaps it. */
  found: boolean;
  exact: boolean;
  /** Any detection overlaps it. */
  redacted: boolean;
  /** Every non-space character of it is inside a detection. */
  leakFree: boolean;
  detectedAs: string[];
  /** Redacted leak-free and absent from the redacted output (independent read); undefined when not redacted or no output. */
  removed?: boolean;
}
/**
 * One placed value: whether the read extracted it, where (`where`, offsets into
 * the extracted text), and per configuration what the detector did.
 */
export interface DocItemResult {
  unit: string;
  key: string;
  category: DetCategory;
  kind: string;
  value: string;
  extracted: boolean;
  where?: string;
  start?: number;
  end?: number;
  cfg: Partial<Record<ConfigName, ItemConfigResult>>;
}
/**
 * One placed hard negative, `flagged` per configuration when a detection
 * overlaps it.
 */
export interface DocDecoyResult {
  unit: string;
  kind: string;
  value: string;
  extracted: boolean;
  flagged: Partial<Record<ConfigName, boolean>>;
}
/** A detection on no placed value, for the report's samples. */
export interface FalseAlarm {
  category: string;
  value: string;
  where: string;
  verdict: string;
}
/**
 * One configuration on one document: detection counts and the redaction check
 * (milliseconds, bytes).
 */
export interface DocConfigResult {
  detectMs: number;
  detections: number;
  selected: number;
  tp: number;
  falseAlarms: number;
  wrongCategory: number;
  decoyHits: number;
  unsupported: number;
  /** The first false alarms, for the report. */
  falseAlarmSamples: FalseAlarm[];
  redaction: {
    mode: PipelineRedaction["mode"];
    ms: number;
    error?: string;
    outputBytes?: number;
    /** Values redacted leak-free that are gone from the output. */
    removed: number;
    /** Values redacted leak-free that an independent reader still finds in the output. */
    leaked: number;
    leakedValues: string[];
    /** A PDF that fell back to its text copy: the findings that cannot be redacted in place, each tried alone. */
    failing?: Array<{ category: string; value: string }>;
  };
}

/**
 * The read's outcome (`got`, e.g. `unchecked:encrypted` or `checked+signed`)
 * against the expectation.
 */
export interface Classification {
  expected: Expectation;
  got: string;
  ok: boolean;
  /** Expected partly or not checked, read as fully checked. */
  silentClean: boolean;
}

/**
 * Compares a read with the expectation; a read that threw counts as
 * `unchecked:failed`. The reason and the signature are compared only when the
 * expectation states them.
 */
export function classify(
  read: PipelineRead,
  expected: Expectation,
): Classification {
  const outcome = read.outcome === "error" ? "unchecked" : read.outcome;
  const reason = read.outcome === "error" ? "failed" : read.reason;
  const got =
    outcome === "unchecked"
      ? `unchecked:${reason}`
      : `${outcome}${read.signed ? "+signed" : ""}`;
  const ok =
    outcome === expected.outcome &&
    (expected.reason === undefined || reason === expected.reason) &&
    (expected.signed === undefined || read.signed === expected.signed);
  return {
    expected,
    got,
    ok,
    silentClean: expected.outcome !== "checked" && outcome === "checked",
  };
}

/** Whitespace-collapsed text with a map back to raw offsets. */
function normalized(text: string): { norm: string; map: number[] } {
  let norm = "";
  const map: number[] = [];
  let space = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i]!;
    if (/\s/u.test(ch)) {
      if (!space && norm) {
        norm += " ";
        map.push(i);
      }
      space = true;
    } else {
      norm += ch;
      map.push(i);
      space = false;
    }
  }
  return { norm, map };
}

/** Raw spans of every non-overlapping occurrence of `value` (whitespace-insensitive). */
function occurrences(
  n: { norm: string; map: number[] },
  value: string,
): Array<[number, number]> {
  const v = normalizeSpaces(value);
  if (!v) return [];
  const out: Array<[number, number]> = [];
  let at = n.norm.indexOf(v);
  while (at >= 0) {
    out.push([n.map[at]!, n.map[at + v.length - 1]! + 1]);
    at = n.norm.indexOf(v, at + v.length);
  }
  return out;
}

const segmentAt = (segments: DocSegmentLike[], at: number) =>
  segments.find((s) => s.start <= at && at < s.end)?.where;

/** Locates every placed item and decoy in the extracted text. */
export function locate(
  text: string,
  segments: DocSegmentLike[],
  units: Unit[],
) {
  const n = normalized(text);
  const cache = new Map<string, Array<[number, number]>>();
  const used = new Map<string, number>();
  const take = (value: string): [number, number] | undefined => {
    if (!cache.has(value)) cache.set(value, occurrences(n, value));
    const list = cache.get(value)!;
    const i = used.get(value) ?? 0;
    used.set(value, i + 1);
    return list[i];
  };
  const items: DocItemResult[] = [];
  const gold: GoldSpan[] = [];
  const decoys: DocDecoyResult[] = [];
  const decoySpans: DecoySpan[] = [];
  units.forEach((u, ui) => {
    for (const it of u.items) {
      const span = take(it.value);
      const key = `${ui}:${it.key}:${items.length}`;
      items.push({
        unit: u.source,
        key,
        category: it.category,
        kind: it.kind,
        value: it.value,
        extracted: !!span,
        ...(span
          ? {
              where: segmentAt(segments, span[0]),
              start: span[0],
              end: span[1],
            }
          : {}),
        cfg: {},
      });
      if (span)
        gold.push({
          key,
          category: it.category,
          kind: it.kind,
          start: span[0],
          end: span[1],
          value: text.slice(span[0], span[1]),
          zone: "prose" as Zone,
        });
    }
    for (const d of u.decoys) {
      const span = take(d.value);
      const key = `${ui}:${d.key}:${decoys.length}`;
      decoys.push({
        unit: u.source,
        kind: d.kind,
        value: d.value,
        extracted: !!span,
        flagged: {},
      });
      if (span)
        decoySpans.push({
          key,
          kind: d.kind as DecoySpan["kind"],
          start: span[0],
          end: span[1],
          value: text.slice(span[0], span[1]),
          zone: "prose" as Zone,
        });
    }
  });
  return { items, gold, decoys, decoySpans };
}

/** A document's placed values and decoys, and each configuration's result. */
export interface ScoredDoc {
  items: DocItemResult[];
  decoys: DocDecoyResult[];
  configs: Partial<Record<ConfigName, DocConfigResult>>;
}

/** Scores the detections of each configuration and verifies its redacted output. */
export function scoreDoc(
  doc: BuiltDoc,
  read: PipelineRead,
  perConfig: Partial<
    Record<
      ConfigName,
      {
        detections: Array<{
          category: string;
          start: number;
          end: number;
          value: string;
          selected: boolean;
        }>;
        ms: number;
        redaction?: PipelineRedaction;
        outputViews?: Views;
      }
    >
  >,
  supported: DetCategory[],
): ScoredDoc {
  const { items, gold, decoys, decoySpans } = locate(
    read.text,
    read.segments,
    doc.units,
  );
  const norm = normalized(read.text);
  const configs: ScoredDoc["configs"] = {};
  for (const [config, run] of Object.entries(perConfig) as Array<
    [ConfigName, NonNullable<(typeof perConfig)[ConfigName]>]
  >) {
    const det: DetCase = {
      id: doc.spec.id,
      baseId: doc.spec.id,
      lang: doc.spec.lang,
      register: doc.spec.zone,
      type: items.length ? "single" : "negative",
      tags: [],
      perturbation: "none",
      items: {},
      decoys: {},
      parts: [],
      text: read.text,
      gold,
      decoySpans,
    };
    const scored = scoreDetCase(
      det,
      run.detections.map((d) => ({
        category: d.category,
        mapped: mapCategory(d.category),
        start: d.start,
        end: d.end,
        value: d.value,
        source: "",
        selected: d.selected,
      })),
      supported,
      config,
    );
    const byKey = new Map(scored.items.map((s) => [s.key, s]));
    // Raw bytes (the "text" view of a PDF) are full of numbers: a short value is only looked for in the text views.
    const views = run.outputViews
      ? Object.fromEntries(
          Object.entries(run.outputViews).map(([k, v]) => [
            k,
            normalizeSpaces(v),
          ]),
        )
      : undefined;
    const outs = views
      ? [...new Set(Object.values(views).filter(Boolean))]
      : undefined;
    const outsFor = (value: string) =>
      views && normalizeSpaces(value).length < 8
        ? [...new Set([views.strings!, views.pdftotext!].filter(Boolean))]
        : outs!;
    let removed = 0;
    let leaked = 0;
    const leakedValues: string[] = [];
    for (const item of items) {
      const s = byKey.get(item.key);
      if (s)
        item.cfg[config] = {
          found: s.overlap,
          exact: s.exact,
          redacted: s.redacted,
          leakFree: s.leakFree,
          detectedAs: s.detectedAs,
        };
    }
    if (outs !== undefined) {
      // By count: a value may also sit, unredacted and rightly so, elsewhere (as a decoy, in another unit).
      // Occurrences left = occurrences in the text that no selected detection covers; more than that in the output is a leak.
      const covered = (start: number, end: number) => {
        for (let i = start; i < end; i++)
          if (
            !/\s/u.test(read.text[i]!) &&
            !run.detections.some((d) => d.selected && d.start <= i && i < d.end)
          )
            return false;
        return true;
      };
      const byValue = new Map<string, DocItemResult[]>();
      for (const item of items)
        if (item.cfg[config]?.redacted && item.cfg[config]?.leakFree)
          byValue.set(item.value, [...(byValue.get(item.value) ?? []), item]);
      for (const [value, list] of byValue) {
        const occ = occurrences(norm, value);
        const left = occ.filter(([a, b]) => !covered(a, b)).length;
        const v = normalizeSpaces(value);
        // The most occurrences any one reading method finds.
        let inOutput = 0;
        for (const out of outsFor(value)) {
          let n = 0;
          for (
            let at = out.indexOf(v);
            at >= 0;
            at = out.indexOf(v, at + v.length)
          )
            n++;
          inOutput = Math.max(inOutput, n);
        }
        let leaks = Math.max(0, inOutput - left);
        for (const item of list) {
          const r = item.cfg[config]!;
          r.removed = leaks === 0;
          if (leaks > 0) {
            leaks--;
            leaked++;
            if (leakedValues.length < 10) leakedValues.push(value);
          } else removed++;
        }
      }
    }
    scored.decoys.forEach((d, i) => {
      const target = decoys.filter((x) => x.extracted)[i];
      if (target) target.flagged[config] = d.flagged;
    });
    const fa = scored.detections.filter(isFalsePositive);
    configs[config] = {
      detectMs: Math.round(run.ms * 100) / 100,
      detections: run.detections.length,
      selected: scored.detections.length,
      tp: scored.detections.filter((d) => d.verdict === "tp").length,
      falseAlarms: fa.length,
      wrongCategory: scored.detections.filter(
        (d) => d.verdict === "wrong_category",
      ).length,
      decoyHits: scored.detections.filter((d) => d.verdict === "decoy").length,
      unsupported: scored.detections.filter(
        (d) => d.verdict === "unsupported_item",
      ).length,
      falseAlarmSamples: fa.slice(0, 12).map((d) => ({
        category: d.category,
        value: d.value.slice(0, 80),
        where: segmentAt(read.segments, d.start) ?? "",
        verdict: d.verdict,
      })),
      redaction: {
        mode: run.redaction?.mode ?? "none",
        ms: Math.round((run.redaction?.ms ?? 0) * 10) / 10,
        ...(run.redaction?.error
          ? { error: run.redaction.error.slice(0, 200) }
          : {}),
        ...(run.redaction?.bytes
          ? { outputBytes: run.redaction.bytes.length }
          : {}),
        removed,
        leaked,
        leakedValues,
        ...(run.redaction?.failing
          ? {
              failing: run.redaction.failing.map((r) => ({
                category: r.replacement.slice(1, -1),
                value: read.text.slice(r.start, r.end).slice(0, 80),
              })),
            }
          : {}),
      },
    };
  }
  return { items, decoys, configs };
}
