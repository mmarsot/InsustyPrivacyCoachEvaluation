/**
 * The grid's Run button. The dashboard writes no results itself: it starts
 * the same `npm run bench -- --module --config --dataset` a person would type,
 * as a child process, and the Live view follows it like any bench run.
 *
 * - At most one bench process at a time: a start is refused while the
 *   dashboard's own run is going or any other bench run is active (this
 *   machine has room for one model process). The runner's own memory waits
 *   and guards still apply.
 * - A paid configuration (a connected model) starts only with an explicit
 *   confirmation, after the plan with its cost estimate and the
 *   `--budget-usd` cap has been shown.
 * - The child's output goes to a log under `cache/tmp/dashboard-runs/`.
 */
import { spawn, spawnSync, type ChildProcess } from "node:child_process";
import { closeSync, mkdirSync, openSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, ROOT } from "../engine/paths.ts";
import { readModuleManifest, resolveModuleId } from "../engine/registry.ts";
import { routeBench } from "../engine/route.ts";
import { BusyError } from "./playground/manager.ts";

/** What the Run button asks for. */
export interface RunRequest {
  module: string;
  configuration: string;
  dataset: string;
  /** A tier of the dataset's contract (or the runner's own tier names). */
  tier?: string;
  ref?: string;
}

const LOG_DIR = join(CACHE_DIR, "tmp", "dashboard-runs");
const BENCH = join(ROOT, "engine", "cli", "bench.ts");

/** The `npm run bench` arguments of a request (validated: no free-form flags). */
export function benchArgs(r: RunRequest): string[] {
  const safe = (v: string, what: string) => {
    if (!/^[\w.@/#:-]+$/.test(v)) throw new Error(`bad ${what}`);
    return v;
  };
  const args = [
    "--module",
    safe(r.module, "module"),
    "--config",
    safe(r.configuration, "configuration"),
    "--dataset",
    safe(r.dataset, "dataset"),
  ];
  if (r.tier) args.push("--tier", safe(r.tier, "tier"));
  if (r.ref) args.push("--ref", safe(r.ref, "ref"));
  const configuration = readModuleManifest(
    resolveModuleId(r.module),
  ).configurations.find((c) => c.id === r.configuration);
  if (configuration?.paid && configuration.budgetUsd !== undefined)
    args.push("--budget-usd", String(configuration.budgetUsd));
  routeBench(args); // throws, with the reason, when the cell cannot run
  return args;
}

/** Whether a request's configuration is paid. */
export const isPaid = (r: RunRequest) =>
  Boolean(
    readModuleManifest(resolveModuleId(r.module)).configurations.find(
      (c) => c.id === r.configuration,
    )?.paid,
  );

/** Owns at most one bench child process. */
export class RunLauncher {
  private child?: ChildProcess;
  private current?: {
    command: string;
    startedAt: string;
    log: string;
    exitCode?: number | null;
    pid?: number;
  };

  /** The dashboard's own run: running or finished, its command and the end of its log. */
  status() {
    if (!this.current) return { running: false };
    let tail = "";
    try {
      tail = readFileSync(this.current.log, "utf8")
        .split("\n")
        .slice(-40)
        .join("\n");
    } catch {
      /* not written yet */
    }
    return {
      running: Boolean(this.child),
      pid: this.current.pid,
      command: this.current.command,
      startedAt: this.current.startedAt,
      exitCode: this.current.exitCode,
      log: tail,
    };
  }

  /** The plan and estimate (`--dry-run`): no model loads, nothing is written. */
  plan(r: RunRequest): { command: string; output: string; code: number } {
    const args = benchArgs(r);
    const result = spawnSync(
      process.execPath,
      ["--import", "tsx", BENCH, ...args, "--dry-run"],
      { cwd: ROOT, encoding: "utf8", timeout: 180_000 },
    );
    return {
      command: `npm run bench -- ${args.join(" ")}`,
      output: `${result.stdout ?? ""}${result.stderr ?? ""}`.trim(),
      code: result.status ?? 1,
    };
  }

  /**
   * Starts a run. `othersActive`: whether another bench process is running;
   * `confirmed`: the person confirmed a paid run.
   */
  start(r: RunRequest, othersActive: boolean, confirmed: boolean) {
    const args = benchArgs(r);
    if (this.child)
      throw new BusyError("the dashboard's previous run is still going");
    if (othersActive)
      throw new BusyError(
        "another bench run is active; one bench process at a time",
      );
    if (isPaid(r) && !confirmed)
      throw new Error(
        "a paid (connected) configuration needs a confirmation after its plan",
      );
    mkdirSync(LOG_DIR, { recursive: true });
    const startedAt = new Date().toISOString();
    const log = join(LOG_DIR, `${startedAt.replace(/[:.]/g, "-")}.log`);
    const fd = openSync(log, "a");
    const child = spawn(process.execPath, ["--import", "tsx", BENCH, ...args], {
      cwd: ROOT,
      stdio: ["ignore", fd, fd],
    });
    closeSync(fd);
    this.child = child;
    this.current = {
      command: `npm run bench -- ${args.join(" ")}`,
      startedAt,
      log,
      pid: child.pid,
    };
    child.on("exit", (code) => {
      if (this.current) this.current.exitCode = code;
      this.child = undefined;
    });
    return this.status();
  }
}
