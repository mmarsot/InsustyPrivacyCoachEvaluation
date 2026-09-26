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
}

export interface RunMeta {
  name: string;
  tier: string;
  split: string;
  cases: number;
  instructions: string[];
  labelVariants: string[];
  models: RunModelMeta[];
  ext: { ref: string; sha: string; subject: string; committedAt: string; transformersRange?: string };
  datasetHash: string;
  runtime: string;
  machine: string;
  node: string;
  startedAt: string;
  finishedAt: string;
  estimateSeconds: number;
  wallSeconds: number;
  /** Number of jobs without a result (a crashed or interrupted worker). */
  incomplete: number;
}
