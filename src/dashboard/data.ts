/**
 * Data layer of the dashboard. Everything here only READS: the dataset, the
 * result cache (`cache/results/`), active-run markers and finished runs. It
 * never writes, so it is safe to use while a bench run is in progress.
 * The functions taking plain data (progress, matrix status, grouping, case
 * detail) are pure so they can be unit-tested without a model.
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { CompiledCase } from "../dataset/schema.ts";
import { ACTIVE_RUNS_DIR, RUNS_DIR } from "../paths.ts";
import { cacheFile, type Job, type ResultRecord } from "../run/jobs.ts";
import type { RunMeta } from "../run/meta.ts";
import { percentile, metrics, type Metrics } from "../score/aggregate.ts";
import {
  FAILURE_MODES,
  type FailureMode,
  type Scored,
} from "../score/score.ts";

// ------------------------------------------------------------ cache reading

const fileCache = new Map<
  string,
  { size: number; mtimeMs: number; records: Map<string, ResultRecord> }
>();

/** Reads one result-cache file, re-parsing only when it changed. Tolerates a torn last line. */
export function readCacheFile(file: string): Map<string, ResultRecord> {
  if (!existsSync(file)) return new Map();
  const { size, mtimeMs } = statSync(file);
  const hit = fileCache.get(file);
  if (hit && hit.size === size && hit.mtimeMs === mtimeMs) return hit.records;
  const records = new Map<string, ResultRecord>();
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as ResultRecord;
      records.set(record.key, record);
    } catch {
      /* torn line from a write in progress */
    }
  }
  fileCache.set(file, { size, mtimeMs, records });
  return records;
}
/**
 * A model's cached results at a commit, re-read only when the file changed
 * (size or mtime), so polling a run in progress stays cheap.
 */
export const readModelCache = (extSha: string, model: string) =>
  readCacheFile(cacheFile(extSha, model));

// ------------------------------------------------------------ active runs

/**
 * A bench process in progress, from its `cache/active-runs/` marker; markers of
 * dead processes are ignored.
 */
export interface ActiveRun {
  pid: number;
  name?: string;
  argv: string[];
  startedAt?: string;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

/**
 * Extracts the bench arguments from a process command line, if it is
 * `src/cli/run.ts` or `src/cli/docbench.ts`. A document-bench run's
 * arguments always start with `--track docbench` (as its marker file writes
 * them), so both ways of starting it give the same argv.
 */
export function benchArgsFromCmdline(
  cmdline: readonly string[],
): string[] | undefined {
  const doc = cmdline.findIndex((part) =>
    /(^|\/)src\/cli\/docbench\.ts$/.test(part),
  );
  if (doc >= 0)
    return normalizeTrack(["--track", "docbench", ...cmdline.slice(doc + 1)]);
  const at = cmdline.findIndex((part) => /(^|\/)src\/cli\/run\.ts$/.test(part));
  return at >= 0 ? normalizeTrack(cmdline.slice(at + 1)) : undefined;
}

/** Moves a `--track docbench` pair to the front (and keeps one). */
export function normalizeTrack(argv: readonly string[]): string[] {
  const rest: string[] = [];
  let doc = false;
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--track" && argv[i + 1] === "docbench") {
      doc = true;
      i++;
    } else rest.push(argv[i]!);
  }
  return doc ? ["--track", "docbench", ...rest] : rest;
}

/**
 * Bench processes in progress: marker files written by `npm run bench`, plus a
 * /proc scan (Linux) for runs started before markers existed. Deduplicated on
 * argv, keeping the process that actually runs node.
 */
export function findActiveRuns(): ActiveRun[] {
  const runs: ActiveRun[] = [];
  if (existsSync(ACTIVE_RUNS_DIR))
    for (const file of readdirSync(ACTIVE_RUNS_DIR).filter((f) =>
      f.endsWith(".json"),
    ))
      try {
        const run = JSON.parse(
          readFileSync(join(ACTIVE_RUNS_DIR, file), "utf8"),
        ) as ActiveRun;
        if (alive(run.pid))
          runs.push({ ...run, argv: normalizeTrack(run.argv) });
      } catch {
        /* ignore */
      }
  if (existsSync("/proc"))
    for (const entry of readdirSync("/proc")) {
      if (!/^\d+$/.test(entry)) continue;
      try {
        const cmdline = readFileSync(`/proc/${entry}/cmdline`, "utf8")
          .split("\0")
          .filter(Boolean);
        if (!/node$/.test(cmdline[0] ?? "")) continue;
        const argv = benchArgsFromCmdline(cmdline);
        if (!argv || argv.includes("--dry-run")) continue;
        const startedAt = new Date(
          statSync(`/proc/${entry}`).mtimeMs,
        ).toISOString();
        runs.push({ pid: Number(entry), argv, startedAt });
      } catch {
        /* process vanished */
      }
    }
  const byArgv = new Map<string, ActiveRun>();
  for (const run of runs) {
    const key = run.argv.join("\u0000");
    const existing = byArgv.get(key);
    byArgv.set(
      key,
      existing
        ? {
            ...existing,
            name: existing.name ?? run.name,
            startedAt: existing.startedAt ?? run.startedAt,
          }
        : run,
    );
  }
  return [...byArgv.values()];
}

// ------------------------------------------------------------ progress

/** Progress of one (model, instruction, label variant) cell of a live run. */
export interface ProgressCell {
  model: string;
  instruction: string;
  labelVariant: string;
  total: number;
  done: number;
  timeouts: number;
  errors: number;
  failures: Partial<Record<FailureMode, number>>;
}
/**
 * Progress of one model of a live run; times in milliseconds, ETA in seconds.
 */
export interface ModelProgress {
  model: string;
  total: number;
  done: number;
  status: "done" | "running" | "pending";
  /** Results per minute over the last 10 minutes of activity. */
  throughputPerMin: number | null;
  medianMs: number | null;
  etaSeconds: number;
  lastAt?: string;
}
/**
 * A live run's progress: per cell, per model, overall, and the latest results.
 */
export interface Progress {
  cells: ProgressCell[];
  models: ModelProgress[];
  total: number;
  done: number;
  etaSeconds: number;
  recent: Array<{
    at: string;
    model: string;
    caseId: string;
    instruction: string;
    labelVariant: string;
    reviewMs: number;
    failure: FailureMode;
  }>;
}

/**
 * Progress of one planned run. `records` maps job keys to cached results;
 * `failureOf` classifies a result (scoring); `fallbackSeconds` estimates a
 * model with no timing yet. `now` is injectable for tests.
 */
export function computeProgress(
  jobsByModel: Map<string, Job[]>,
  records: (model: string) => Map<string, ResultRecord>,
  failureOf: (job: Job, record: ResultRecord) => FailureMode,
  fallbackSeconds: (model: string) => number,
  now = Date.now(),
): Progress {
  const cells = new Map<string, ProgressCell>();
  const models: ModelProgress[] = [];
  const recent: Progress["recent"] = [];
  let seenRunning = false;
  for (const [model, jobs] of jobsByModel) {
    const cache = records(model);
    const done: ResultRecord[] = [];
    for (const job of jobs) {
      const key = `${model}\u0000${job.instruction}\u0000${job.labelVariant}`;
      const cell = cells.get(key) ?? {
        model,
        instruction: job.instruction,
        labelVariant: job.labelVariant,
        total: 0,
        done: 0,
        timeouts: 0,
        errors: 0,
        failures: {},
      };
      cells.set(key, cell);
      cell.total++;
      const record = cache.get(job.key);
      if (!record) continue;
      cell.done++;
      done.push(record);
      const failure = failureOf(job, record);
      cell.failures[failure] = (cell.failures[failure] ?? 0) + 1;
      if (record.errorKind === "deadline") cell.timeouts++;
      else if (record.error) cell.errors++;
      recent.push({
        at: record.at,
        model,
        caseId: job.caseId,
        instruction: job.instruction,
        labelVariant: job.labelVariant,
        reviewMs: record.reviewMs,
        failure,
      });
    }
    const times = done
      .map((r) => Date.parse(r.at))
      .filter(Number.isFinite)
      .sort((a, b) => a - b);
    const lastAt = times.at(-1);
    const windowStart = Math.max(
      (lastAt ?? now) - 10 * 60_000,
      times[0] ?? now,
    );
    const inWindow = times.filter((t) => t >= windowStart).length;
    const spanMin = ((lastAt ?? now) - windowStart) / 60_000;
    const throughputPerMin =
      inWindow >= 2 && spanMin > 0 ? (inWindow - 1) / spanMin : null;
    const recentMs = done.slice(-30).map((r) => r.reviewMs);
    const medianMs = percentile(recentMs, 50);
    const remaining = jobs.length - done.length;
    const status: ModelProgress["status"] =
      remaining === 0
        ? "done"
        : !seenRunning &&
            (done.length > 0 || models.every((m) => m.status === "done"))
          ? "running"
          : "pending";
    if (status === "running") seenRunning = true;
    const perCase = throughputPerMin
      ? 60 / throughputPerMin
      : medianMs !== null
        ? medianMs / 1000
        : fallbackSeconds(model);
    models.push({
      model,
      total: jobs.length,
      done: done.length,
      status,
      throughputPerMin,
      medianMs,
      etaSeconds: Math.round(remaining * perCase),
      ...(lastAt ? { lastAt: new Date(lastAt).toISOString() } : {}),
    });
  }
  recent.sort((a, b) => b.at.localeCompare(a.at));
  return {
    cells: [...cells.values()],
    models,
    total: models.reduce((a, m) => a + m.total, 0),
    done: models.reduce((a, m) => a + m.done, 0),
    etaSeconds: models.reduce((a, m) => a + m.etaSeconds, 0),
    recent: recent.slice(0, 15),
  };
}

// ------------------------------------------------------------ experiment matrix

/**
 * One cell of the Experiments view: how much of a (tier, model, instruction,
 * label variant) combination is cached.
 */
export interface MatrixRow {
  tier: string;
  model: string;
  instruction: string;
  labelVariant: string;
  total: number;
  done: number;
  status: "done" | "running" | "partial" | "pending";
  estimateSeconds: number;
}

/** Status of every (tier, model, instruction, label variant) cell. */
export function matrixStatus(
  tier: string,
  jobsByModel: Map<string, Job[]>,
  isDone: (model: string, key: string) => boolean,
  isActive: (model: string, key: string) => boolean,
  secondsPerCase: (model: string) => number,
): MatrixRow[] {
  const rows = new Map<string, MatrixRow & { active: boolean }>();
  for (const [model, jobs] of jobsByModel)
    for (const job of jobs) {
      const id = `${model}\u0000${job.instruction}\u0000${job.labelVariant}`;
      const row = rows.get(id) ?? {
        tier,
        model,
        instruction: job.instruction,
        labelVariant: job.labelVariant,
        total: 0,
        done: 0,
        status: "pending" as const,
        estimateSeconds: 0,
        active: false,
      };
      rows.set(id, row);
      row.total++;
      if (isDone(model, job.key)) row.done++;
      else if (isActive(model, job.key)) row.active = true;
    }
  return [...rows.values()].map(({ active, ...row }) => ({
    ...row,
    status:
      row.done === row.total
        ? "done"
        : active
          ? "running"
          : row.done > 0
            ? "partial"
            : "pending",
    estimateSeconds: Math.round(
      (row.total - row.done) * secondsPerCase(row.model) * 1.1,
    ),
  }));
}

// ------------------------------------------------------------ committed runs

/** A run as the run pickers list it, committed or in progress. */
export interface RunListing {
  id: string;
  name: string;
  kind: "committed" | "live";
  tier?: string;
  ref?: string;
  sha?: string;
  finishedAt?: string;
  results?: number;
}

/**
 * Finished bench runs (`runs/<name>/` with `run.json` and `results.jsonl`;
 * git-ignored, so empty on a fresh clone), newest first.
 */
export function listCommittedRuns(): RunListing[] {
  if (!existsSync(RUNS_DIR)) return [];
  return readdirSync(RUNS_DIR)
    .filter(
      (d) =>
        existsSync(join(RUNS_DIR, d, "run.json")) &&
        existsSync(join(RUNS_DIR, d, "results.jsonl")),
    )
    .map((d) => {
      const meta = JSON.parse(
        readFileSync(join(RUNS_DIR, d, "run.json"), "utf8"),
      ) as RunMeta;
      return {
        id: `run:${d}`,
        name: meta.name,
        kind: "committed" as const,
        tier: meta.tier,
        ref: meta.ext.ref,
        sha: meta.ext.sha,
        finishedAt: meta.finishedAt,
      };
    })
    .sort((a, b) => (b.finishedAt ?? "").localeCompare(a.finishedAt ?? ""));
}

const runRowsCache = new Map<string, { mtimeMs: number; rows: Scored[] }>();
/**
 * A committed run's scored rows, cached until `results.jsonl` changes. A name
 * with characters other than `[\w.-]` (a slash) reads as empty.
 */
export function readCommittedRows(name: string): Scored[] {
  const file = join(RUNS_DIR, name, "results.jsonl");
  if (!/^[\w.-]+$/.test(name) || !existsSync(file)) return [];
  const { mtimeMs } = statSync(file);
  const hit = runRowsCache.get(name);
  if (hit && hit.mtimeMs === mtimeMs) return hit.rows;
  const rows = readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim())
    .map((l) => JSON.parse(l) as Scored);
  runRowsCache.set(name, { mtimeMs, rows });
  return rows;
}

// ------------------------------------------------------------ results navigation

/** Dimensions results can be filtered and grouped by. */
export const RESULT_DIMENSIONS: Record<string, (r: Scored) => string> = {
  model: (r) => r.model.replace(/^.*\//, "").replace(/-ONNX$/, ""),
  instruction: (r) => r.instruction,
  labelVariant: (r) => r.labelVariant,
  lang: (r) => r.lang,
  langMixed: (r) => (r.mixed ? `${r.lang}+mixed` : r.lang),
  profile: (r) => r.profile,
  type: (r) => r.type,
  difficulty: (r) => r.difficulty,
  lengthBucket: (r) => r.lengthBucket,
  register: (r) => r.register,
  errors: (r) => r.errors,
  split: (r) => r.split,
  failure: (r) => r.failure,
};

/**
 * Selected values per result dimension; an empty list or an unknown dimension
 * filters nothing.
 */
export type Filters = Record<string, string[]>;

/** Rows matching every active filter. */
export function filterRows(rows: Scored[], filters: Filters): Scored[] {
  const active = Object.entries(filters).filter(
    ([dim, values]) => RESULT_DIMENSIONS[dim] && values.length,
  );
  return rows.filter((r) =>
    active.every(([dim, values]) =>
      values.includes(RESULT_DIMENSIONS[dim]!(r)),
    ),
  );
}

/** Distinct values per dimension, for filter controls. */
export function filterOptions(rows: Scored[]): Record<string, string[]> {
  return Object.fromEntries(
    Object.entries(RESULT_DIMENSIONS).map(([dim, get]) => [
      dim,
      [...new Set(rows.map(get))].sort(),
    ]),
  );
}

/** Metrics of the rows sharing one combination of dimension values. */
export interface Group {
  keys: string[];
  metrics: Metrics;
}

/** Metrics per combination of up to two dimensions. */
export function groupMetrics(rows: Scored[], dims: string[]): Group[] {
  const getters = dims
    .filter((d) => RESULT_DIMENSIONS[d])
    .map((d) => RESULT_DIMENSIONS[d]!);
  const groups = new Map<string, Scored[]>();
  for (const r of rows) {
    const key = getters.map((g) => g(r)).join("\u0000");
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([key, members]) => ({
      keys: getters.length ? key.split("\u0000") : ["all"],
      metrics: metrics(members),
    }));
}

/** A case-level verdict (`caseVerdict`). */
export type Verdict = "TP" | "FP" | "FN" | "TN";

/** Case-level verdict: any found passage makes a positive a TP; any finding on a negative is a FP. */
export const caseVerdict = (r: Scored): Verdict =>
  r.positive ? (r.detected ? "TP" : "FN") : r.falsePositiveCase ? "FP" : "TN";

/** One row of the case list: its verdict and passage counts. */
export interface CaseListItem {
  caseId: string;
  config: string;
  verdict: Verdict;
  failure: FailureMode;
  type: string;
  lang: string;
  tp: number;
  fp: number;
  fn: number;
  reviewMs: number;
}

/**
 * The scored cases, optionally of one verdict; `total` counts them all, `items`
 * holds the first `limit`.
 */
export function listCases(
  rows: Scored[],
  verdict?: string,
  limit = 200,
): { total: number; items: CaseListItem[] } {
  const items = rows
    .map((r) => ({
      caseId: r.caseId,
      config: r.config,
      verdict: caseVerdict(r),
      failure: r.failure,
      type: r.type,
      lang: r.lang,
      tp: r.predicted.filter((p) => p.overlap).length,
      fp: r.predicted.filter((p) => !p.overlap).length,
      fn: r.expected.filter((e) => !e.overlap).length,
      reviewMs: r.reviewMs,
    }))
    .filter((i) => !verdict || i.verdict === verdict);
  return { total: items.length, items: items.slice(0, limit) };
}

/** A range of the case text the case view marks (UTF-16 offsets). */
export interface Highlight {
  start: number;
  end: number;
  kind: "expected-hit" | "expected-miss" | "predicted-fp";
  label: string;
}

/**
 * Everything the case view shows: the request as sent, the expected and
 * predicted passages, the raw answer and its failure mode.
 */
export interface CaseDetail {
  caseId: string;
  config: string;
  model: string;
  instruction: string;
  labelVariant: string;
  systemInstruction: string;
  rules: Array<{ label: string; prompt: string }>;
  text: string;
  meta: Pick<
    CompiledCase,
    | "profile"
    | "lang"
    | "mixed"
    | "type"
    | "difficulty"
    | "style"
    | "tags"
    | "note"
    | "split"
    | "lengthBucket"
  >;
  expected: Array<{
    label: string;
    passage: string;
    verdict: "TP" | "FN";
    exact: boolean;
  }>;
  predicted: Array<{
    label: string;
    value: string;
    verdict: "TP" | "FP";
    exact: boolean;
  }>;
  highlights: Highlight[];
  verdict: Verdict;
  failure: FailureMode;
  format: string;
  raw: string;
  reviewMs: number;
  generatedTokens: number;
  finishReasons: string[];
  error?: string;
}

const occurrencesCi = (text: string, needle: string) => {
  const out: number[] = [];
  if (!needle) return out;
  const hay = text.toLocaleLowerCase();
  const n = needle.toLocaleLowerCase();
  for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + n.length))
    out.push(i);
  return out;
};

/** Everything the drill-down shows for one (configuration, case). */
export function caseDetail(
  row: Scored,
  c: CompiledCase,
  rules: Array<{ label: string; prompt: string }>,
  systemInstruction: string,
): CaseDetail {
  const highlights: Highlight[] = [];
  for (const e of row.expected)
    for (const s of c.spans.filter(
      (s) => s.label === e.label && s.passage === e.passage,
    ))
      highlights.push({
        start: s.start,
        end: s.end,
        kind: e.overlap ? "expected-hit" : "expected-miss",
        label: e.label,
      });
  for (const p of row.predicted.filter((p) => !p.overlap))
    for (const start of occurrencesCi(c.text, p.value))
      highlights.push({
        start,
        end: start + p.value.length,
        kind: "predicted-fp",
        label: p.label,
      });
  highlights.sort((a, b) => a.start - b.start || b.end - a.end);
  return {
    caseId: row.caseId,
    config: row.config,
    model: row.model,
    instruction: row.instruction,
    labelVariant: row.labelVariant,
    systemInstruction,
    rules,
    text: c.text,
    meta: {
      profile: c.profile,
      lang: c.lang,
      mixed: c.mixed,
      type: c.type,
      difficulty: c.difficulty,
      style: c.style,
      tags: c.tags,
      note: c.note,
      split: c.split,
      lengthBucket: c.lengthBucket,
    },
    expected: row.expected.map((e) => ({
      label: e.label,
      passage: e.passage,
      verdict: e.overlap ? "TP" : "FN",
      exact: e.exact,
    })),
    predicted: row.predicted.map((p) => ({
      label: p.label,
      value: p.value,
      verdict: p.overlap ? "TP" : "FP",
      exact: p.exact,
    })),
    highlights,
    verdict: caseVerdict(row),
    failure: row.failure,
    format: row.format,
    raw: row.raw,
    reviewMs: row.reviewMs,
    generatedTokens: row.generatedTokens,
    finishReasons: row.finishReasons,
    ...(row.error ? { error: row.error } : {}),
  };
}

export { FAILURE_MODES };
