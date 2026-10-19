/**
 * The regression gate of insusty-builtin (detbench `--compare <base> --gate`):
 * per configuration both runs scored, a drop of half a point or more in F1,
 * recall or precision, any new leak, or more flagged hard negatives fails it.
 */
import { drop, rise } from "../../engine/gates.ts";
import type { DetSummary } from "../../engine/scorers/builtin-spans/aggregate.ts";

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
