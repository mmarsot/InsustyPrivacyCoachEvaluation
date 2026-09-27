/** Models the lab can run: the bundled ones (models/models.json) and candidates (models/candidates.json). */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../paths.ts";
import { MODELS } from "../run/plan.ts";

export interface LabModel {
  id: string;
  short: string;
  dtype: string;
  bundled: boolean;
  /** Measured (or estimated) peak RSS of a worker, in MB: the lab waits for this much plus a margin. */
  peakRssMb: number;
  secondsPerCase: number;
  /** onnxruntime-web build: `pinned` (the extension's) or `next` (see src/lab/ort-next-hooks.mjs). */
  ort: "pinned" | "next";
  /** Plain completion prompts must start with the tokenizer's BOS token (LFM2, Gemma). */
  rawBos: boolean;
  /**
   * Whether a prefilled prefix KV cache can be reused. False for LFM2: with
   * Transformers.js 3.8.1 its conv-state cache breaks when the prompt is
   * prefilled in two parts (garbage output), so every request runs whole.
   */
  prefixCache: boolean;
}

/** Measured in this repository (docs/approach.md; Qwen2.5-0.5B with the GC after load, experiments/LOG.md E5a). */
const BUNDLED_PEAK: Record<string, number> = { "smollm2-135m": 1100, "smollm2-360m": 1900, "qwen2.5-0.5b": 3150 };

interface Candidate {
  id: string;
  short: string;
  dtype: string;
  peakRssMb: number;
  secondsPerCase: number;
  ort?: "pinned" | "next";
  rawBos?: boolean;
  prefixCache?: boolean;
}
const candidates = (JSON.parse(readFileSync(join(ROOT, "models", "candidates.json"), "utf8")) as { models: Candidate[] }).models;

export const LAB_MODELS: LabModel[] = [
  ...MODELS.map((m) => ({
    id: m.id,
    short: m.short,
    dtype: "q8",
    bundled: true,
    peakRssMb: BUNDLED_PEAK[m.short] ?? 3000,
    secondsPerCase: Math.min(10, m.priorSecondsPerCase),
    ort: "pinned" as const,
    rawBos: false,
    prefixCache: true,
  })),
  ...candidates.map((c) => ({ id: c.id, short: c.short, dtype: c.dtype, bundled: false, peakRssMb: c.peakRssMb, secondsPerCase: c.secondsPerCase, ort: c.ort ?? "pinned", rawBos: c.rawBos ?? false, prefixCache: c.prefixCache ?? true })),
];

export const findLabModel = (name: string) => LAB_MODELS.find((m) => m.short === name || m.id === name);
