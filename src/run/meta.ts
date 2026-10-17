import type { MachineProfile } from "../../contract/types.ts";

/** Metadata written to `runs/<name>/run.json`. */
export interface RunModelMeta {
  id: string;
  jobs: number;
  /** Jobs computed in this run (the rest came from the cache). */
  computed: number;
  loadMs?: number;
  peakRssMb?: number;
  wallMs?: number;
  threads?: number;
  /** Connected models: tokens and USD of this run's jobs (cached ones included). */
  hosted?: { requests: number; inputTokens: number; outputTokens: number; usd: number; usdPer1000Prompts: number };
}

export interface RunMeta {
  name: string;
  tier: string;
  split: string;
  cases: number;
  instructions: string[];
  labelVariants: string[];
  models: RunModelMeta[];
  /** `runtime`: inference packages the ref's lockfile pins (older runs: `transformersRange` from its package.json). */
  ext: { ref: string; sha: string; subject: string; committedAt: string; transformersRange?: string; runtime?: Record<string, string> };
  /** The redaction contract version the module was scored through (absent on runs from before the contract). */
  contract?: string;
  datasetHash: string;
  runtime: string;
  machine: string;
  /** The machine profile absolute times and memory were measured on (`src/module/machine.ts`). */
  machineProfile?: MachineProfile;
  node: string;
  startedAt: string;
  finishedAt: string;
  estimateSeconds: number;
  wallSeconds: number;
  /** Number of jobs without a result (a crashed or interrupted worker). */
  incomplete: number;
}
