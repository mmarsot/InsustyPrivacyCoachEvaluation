/** Run comparison shared by `npm run compare` and the dashboard. */
import { metrics, type Metrics } from "../score/aggregate.ts";
import type { Scored } from "../score/score.ts";

/** The metrics a comparison shows, and which direction counts as better. */
export const COMPARE_METRICS: ReadonlyArray<{
  name: string;
  get: (m: Metrics) => number | null;
  higherIsBetter: boolean;
}> = [
  { name: "F1 overlap", get: (m) => m.overlap.f1, higherIsBetter: true },
  { name: "Recall", get: (m) => m.overlap.recall, higherIsBetter: true },
  { name: "Precision", get: (m) => m.overlap.precision, higherIsBetter: true },
  { name: "Case detection", get: (m) => m.caseDetection, higherIsBetter: true },
  { name: "FP rate", get: (m) => m.falsePositiveRate, higherIsBetter: false },
  { name: "Format OK", get: (m) => m.compliance, higherIsBetter: true },
];
const SLICES: ReadonlyArray<[string, (r: Scored) => boolean]> = [
  ["all", () => true],
  ["en", (r) => r.lang === "en"],
  ["fr", (r) => r.lang === "fr"],
];

/** One metric in runs A and B; `delta` is B minus A. */
export interface CompareCell {
  a: number | null;
  b: number | null;
  delta: number | null;
  /** 1 better, -1 worse, 0 unchanged (under half a point) or unknown. */
  direction: 1 | -1 | 0;
}
/**
 * One configuration on one slice (`all`, `en`, `fr`) of the cases both runs
 * share; latencies in milliseconds.
 */
export interface CompareRow {
  config: string;
  slice: string;
  cases: number;
  cells: CompareCell[];
  latencyP50: [number | null, number | null];
}

/** Compares only (configuration, case) pairs present in both runs. */
export function compareRows(
  aAll: Scored[],
  bAll: Scored[],
): { shared: number; rows: CompareRow[] } {
  const key = (r: Scored) => `${r.config}\u0000${r.caseId}`;
  const bKeys = new Set(bAll.map(key));
  const aKeys = new Set(aAll.map(key));
  const a = aAll.filter((r) => bKeys.has(key(r)));
  const b = bAll.filter((r) => aKeys.has(key(r)));
  const rows: CompareRow[] = [];
  for (const config of [...new Set(a.map((r) => r.config))])
    for (const [slice, filter] of SLICES) {
      const ma = metrics(a.filter((r) => r.config === config && filter(r)));
      const mb = metrics(b.filter((r) => r.config === config && filter(r)));
      if (!ma.cases) continue;
      rows.push({
        config,
        slice,
        cases: ma.cases,
        cells: COMPARE_METRICS.map(({ get, higherIsBetter }) => {
          const va = get(ma);
          const vb = get(mb);
          const delta = va === null || vb === null ? null : vb - va;
          const direction =
            delta === null || Math.abs(delta) < 0.005
              ? 0
              : delta > 0 === higherIsBetter
                ? 1
                : -1;
          return { a: va, b: vb, delta, direction };
        }),
        latencyP50: [ma.latencyP50, mb.latencyP50],
      });
    }
  return { shared: a.length, rows };
}
