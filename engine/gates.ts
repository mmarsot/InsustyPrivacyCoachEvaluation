/**
 * Shared pieces of the regression gates: `head` against `base` on the same
 * dataset, for CI (`--compare <base> --gate`). What counts as a regression is
 * each dataset's (`datasets/insusty-builtin/gate.ts`,
 * `datasets/insusty-documents/gate.ts`): a drop of half a point or more in a
 * rate, or a count that rises. Speed is not gated (CI runners are not
 * controlled hardware).
 */

/** Half a percentage point: the smallest drop in a rate that fails a gate. */
export const POINT = 0.005;
/** A report line when `head` is at least half a point below `base`. */
export const drop = (
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
/** A report line when `head` is above `base` by more than `tolerance`. */
export const rise = (
  what: string,
  head: number | undefined,
  base: number | undefined,
  tolerance = 0,
) =>
  head !== undefined && base !== undefined && head - base > tolerance
    ? [`${what} ${base} → ${head}`]
    : [];
