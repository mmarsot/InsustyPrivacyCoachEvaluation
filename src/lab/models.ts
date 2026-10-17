/** Models the lab can run: the local models `models/models.json` describes (today the extension's shipped SmolLM2-360M). */
import { MODELS } from "../run/plan.ts";

export interface LabModel {
  id: string;
  short: string;
  dtype: string;
  bundled: boolean;
  /** Measured (or estimated) peak RSS of a worker, in MB: the lab waits for this much plus a margin. */
  peakRssMb: number;
  secondsPerCase: number;
}

/** Measured in this repository (docs/approach.md). */
const BUNDLED_PEAK: Record<string, number> = { "smollm2-360m": 1900 };

export const LAB_MODELS: LabModel[] = MODELS.map((m) => ({
  id: m.id,
  short: m.short,
  dtype: "q8",
  bundled: true,
  peakRssMb: BUNDLED_PEAK[m.short] ?? 3000,
  secondsPerCase: Math.min(10, m.priorSecondsPerCase),
}));

export const findLabModel = (name: string) => LAB_MODELS.find((m) => m.short === name || m.id === name);
