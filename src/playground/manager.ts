/**
 * Parent side of the playground: owns at most one model host process, sends
 * it one request at a time, and reports its state and memory.
 */
import { fork, type ChildProcess } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../paths.ts";

export type HostState = "empty" | "loading" | "ready" | "busy" | "error";

export interface HostStatus {
  state: HostState;
  model?: string;
  loadMs?: number;
  rssMb?: number;
  peakRssMb?: number;
  info?: Record<string, unknown>;
  error?: string;
  /** What the host is doing right now and since when (ms since epoch). */
  activity?: { kind: string; since: number };
}

export class BusyError extends Error {}

const readRssMb = (pid: number | undefined, field: "VmRSS" | "VmHWM") => {
  if (!pid) return undefined;
  try {
    const kb = Number(new RegExp(`${field}:\\s+(\\d+)`).exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
    return Number.isFinite(kb) ? Math.round(kb / 1024) : undefined;
  } catch {
    return undefined;
  }
};

export class PlaygroundHost {
  private child?: ChildProcess;
  private nextId = 1;
  private pending = new Map<number, { resolve(v: unknown): void; reject(e: Error): void }>();
  private status: HostStatus = { state: "empty" };
  private peak = 0;

  constructor(private readonly hostScript = join(ROOT, "src/playground/host.ts")) {}

  getStatus(): HostStatus {
    const rss = readRssMb(this.child?.pid, "VmRSS");
    const hwm = readRssMb(this.child?.pid, "VmHWM");
    this.peak = Math.max(this.peak, hwm ?? 0, rss ?? 0);
    return { ...this.status, ...(rss === undefined ? {} : { rssMb: rss }), ...(this.peak ? { peakRssMb: this.peak } : {}) };
  }

  /** Kills the host (freeing all model memory) and resolves once it has exited. */
  async unload(): Promise<void> {
    const child = this.child;
    this.child = undefined;
    this.status = { state: "empty" };
    this.peak = 0;
    for (const p of this.pending.values()) p.reject(new Error("model unloaded"));
    this.pending.clear();
    if (!child || child.exitCode !== null) return;
    await new Promise<void>((resolve) => {
      child.once("exit", () => resolve());
      child.kill("SIGKILL");
    });
  }

  async load(model: string, bundle: string): Promise<HostStatus> {
    if (this.status.activity) throw new BusyError(`busy: ${this.status.activity.kind}`);
    await this.unload();
    const child = fork(this.hostScript, [], { cwd: ROOT, execArgv: ["--import", "tsx"], stdio: ["ignore", "inherit", "inherit", "ipc"] });
    this.child = child;
    child.on("message", (msg: { id: number; ok: boolean; result?: unknown; error?: string }) => {
      const p = this.pending.get(msg.id);
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.ok) p.resolve(msg.result);
      else p.reject(new Error(msg.error));
    });
    child.on("exit", (code) => {
      if (this.child !== child) return;
      this.child = undefined;
      this.status = { state: "error", model: this.status.model, error: `model process exited (code ${code})` };
      for (const p of this.pending.values()) p.reject(new Error("model process exited"));
      this.pending.clear();
    });
    this.status = { state: "loading", model, activity: { kind: "load", since: Date.now() } };
    try {
      const info = (await this.send({ type: "load", model, bundle })) as Record<string, unknown>;
      this.status = { state: "ready", model, loadMs: Number(info.loadMs), info };
    } catch (error) {
      // An unload during the load already reset the state; keep it.
      if (this.child !== child) return this.getStatus();
      this.status = { state: "error", model, error: (error as Error).message };
      await this.unloadChildOnly();
    }
    return this.getStatus();
  }

  private async unloadChildOnly() {
    const child = this.child;
    this.child = undefined;
    child?.kill("SIGKILL");
  }

  /** Runs one chat or review request; rejects with BusyError while another runs. */
  async request(type: "chat" | "review", payload: Record<string, unknown>): Promise<unknown> {
    if (this.status.state !== "ready") throw new BusyError(this.status.state === "busy" ? `busy: ${this.status.activity?.kind}` : "load a model first");
    const previous = this.status;
    this.status = { ...previous, state: "busy", activity: { kind: type, since: Date.now() } };
    try {
      return await this.send({ type, ...payload });
    } finally {
      if (this.status.state === "busy") this.status = { ...previous, state: "ready" };
    }
  }

  private send(msg: Record<string, unknown>): Promise<unknown> {
    const child = this.child;
    if (!child) return Promise.reject(new Error("no model process"));
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      child.send({ id, ...msg });
    });
  }
}
