/** Models the lab can run: the local models `modules/insusty-privacy/models.json` describes (today the extension's shipped SmolLM2-360M). */
import { MODELS } from "../../../engine/plan.ts";

/** A model as the lab runs it; times in seconds, memory in MB. */
export interface LabModel {
  id: string;
  short: string;
  dtype: string;
  bundled: boolean;
  /** Measured (or estimated) peak RSS of a worker, in MB: the lab waits for this much plus a margin. */
  peakRssMb: number;
  secondsPerCase: number;
}

/** Measured in this repository (modules/insusty-privacy/README.md). */
const BUNDLED_PEAK: Record<string, number> = { "smollm2-360m": 1900 };

/**
 * The models the lab can run, q8 like the bench. Unmeasured models assume a
 * 3,000 MB peak, so the memory wait errs on the safe side.
 */
export const LAB_MODELS: LabModel[] = MODELS.map((m) => ({
  id: m.id,
  short: m.short,
  dtype: "q8",
  bundled: true,
  peakRssMb: BUNDLED_PEAK[m.short] ?? 3000,
  secondsPerCase: Math.min(10, m.priorSecondsPerCase),
}));

/** A lab model by short name or id. */
export const findLabModel = (name: string) =>
  LAB_MODELS.find((m) => m.short === name || m.id === name);
