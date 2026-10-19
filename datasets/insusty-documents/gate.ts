/**
 * The regression gate of insusty-documents (docbench `--compare <base>
 * --gate`): a drop of half a point or more in extraction, recall, precision
 * or F1, any new leak, a failure file no longer reported, or more false
 * alarms on hard negatives fails it.
 */
import { drop, rise } from "../../engine/gates.ts";
import type { DocSummary } from "../../engine/scorers/documents/aggregate.ts";

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
