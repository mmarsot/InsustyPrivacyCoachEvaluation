/**
 * Regression gates of the deterministic track: `head` against `base` on the
 * same dataset, for CI. A drop of half a point or more in F1, recall or
 * precision, any new leak, a failure file no longer reported, or more false
 * alarms on hard negatives fails the gate. Speed is not gated (CI runners are
 * not controlled hardware).
 */
import type { DetSummary } from "../detbench/aggregate.ts";
import type { DocSummary } from "../docbench/aggregate.ts";

/** Half a percentage point: the smallest drop in a rate that fails a gate. */
const POINT = 0.005;
const drop = (
  what: string,
  head: number | null | undefined,
  base: number | null | undefined,
) =>
  head !== null &&
  head !== undefined &&
  base !== null &&
  base !== undefined &&
  base - head >= POINT
    ? [`${what} ${(100 * base).toFixed(1)}% → ${(100 * head).toFixed(1)}%`]
    : [];
const rise = (
  what: string,
  head: number | undefined,
  base: number | undefined,
  tolerance = 0,
) =>
  head !== undefined && base !== undefined && head - base > tolerance
    ? [`${what} ${base} → ${head}`]
    : [];

/**
 * The detbench regressions of `head` against `base`, per configuration both
 * ran, as report lines; empty when the gate passes.
 */
export function detRegressions(
  head: DetSummary[],
  base: DetSummary[],
): string[] {
  const out: string[] = [];
  for (const h of head) {
    const b = base.find((x) => x.config === h.config);
    if (!b) continue;
    const at = (s: string) => `[${h.config}] ${s}`;
    out.push(
      ...drop(
        at("F1 (overlap)"),
        h.overall.overlap.f1,
        b.overall.overlap.f1,
      ).concat(
        drop(
          at("redacted recall"),
          h.overall.redactedRecall,
          b.overall.redactedRecall,
        ),
        drop(
          at("precision"),
          h.overall.overlap.precision,
          b.overall.overlap.precision,
        ),
      ),
    );
    out.push(
      ...rise(
        at("hard negatives flagged"),
        h.overall.decoysFlagged,
        b.overall.decoysFlagged,
        2,
      ),
      ...rise(
        at("negative prompts with a false positive"),
        h.overall.negativeFpCases,
        b.overall.negativeFpCases,
      ),
    );
    for (const l of h.large ?? []) {
      const lb = b.large?.find((x) => x.caseId === l.caseId);
      if (lb && l.found < lb.found)
        out.push(at(`large ${l.caseId}: found ${lb.found} → ${l.found}`));
    }
  }
  return out;
}

/**
 * The docbench regressions of `head` against `base`, as report lines; empty
 * when the gate passes.
 */
export function docRegressions(head: DocSummary, base: DocSummary): string[] {
  const out: string[] = [
    ...drop(
      "extraction recall",
      head.overall.extractionRecall,
      base.overall.extractionRecall,
    ),
  ];
  for (const [config, h] of Object.entries(head.overall.configs)) {
    const b = base.overall.configs[config];
    if (!b) continue;
    out.push(
      ...drop(`[${config}] recall`, h.recall, b.recall),
      ...drop(`[${config}] precision`, h.precision, b.precision),
      ...rise(
        `[${config}] values left in the redacted file`,
        h.leaked,
        b.leaked,
      ),
    );
  }
  const ok = (s: DocSummary) => s.classification.filter((c) => c.ok).length;
  const silent = (s: DocSummary) =>
    s.classification.filter((c) => c.silentClean).length;
  out.push(
    ...rise(
      "silent cleans (a failure file reported as fully checked)",
      silent(head),
      silent(base),
    ),
  );
  if (ok(head) < ok(base))
    out.push(`files read as expected ${ok(base)} → ${ok(head)}`);
  return out;
}
