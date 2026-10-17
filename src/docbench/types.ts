/** Shared types of the document bench: jobs (planned by `src/run/plan.ts`) and their cached results. */
import type { BuiltDoc, DocSpec, SweepSpec } from "./specs.ts";
import type {
  Classification,
  DocConfigResult,
  DocDecoyResult,
  DocItemResult,
} from "./score.ts";

/** One document to check: a suite case or a sweep point. */
export interface DocJob {
  /** Cache key: hash of (ref sha, generator and scorer versions, seed, configs, spec). */
  key: string;
  id: string;
  track: "suite" | "sweep";
  spec?: DocSpec;
  sweep?: SweepSpec;
}

/**
 * One cached line of a ref's docbench results: the document, how the module
 * read it, and its scores per configuration.
 */
export interface DocJobResult {
  key: string;
  jobId: string;
  track: "suite" | "sweep";
  extSha: string;
  seed: number;
  spec: DocSpec;
  sweep?: SweepSpec;
  name: string;
  bytes: number;
  size: BuiltDoc["size"];
  read: {
    outcome: "checked" | "partial" | "unchecked" | "error";
    reason?: string;
    readAs?: string;
    gaps: string[];
    signed: boolean;
    pages?: number;
    partialText?: boolean;
    redaction?: string;
    chars: number;
    segments: number;
    error?: string;
  };
  classification: Classification;
  items: DocItemResult[];
  decoys: DocDecoyResult[];
  configs: Partial<Record<"default" | "all", DocConfigResult>>;
  timing: {
    reps: number;
    readMs: number;
    readMinMs: number;
    detectMs: Record<string, number>;
    redactMs: number | null;
  };
  memory: {
    baselineMb: number | null;
    peakMb: number | null;
    deltaMb: number | null;
    peakResettable: boolean;
  };
  /** Suite cases with at most 60,000 characters: the extracted text and its parts, for the drill-down. */
  text?: string;
  segments?: Array<{ where: string; start: number; end: number }>;
  wallMs: number;
  at: string;
}
