/**
 * Process-level guards shared by the lab CLIs: wait until the system has
 * room for a model, spawn exactly one worker, and kill it if its RSS or the
 * system's available memory crosses a limit.
 */
import { spawn } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { ROOT } from "../paths.ts";
import type { LabModel } from "./models.ts";

export const readMemAvailableMb = () => {
  const info = readFileSync("/proc/meminfo", "utf8");
  return Math.round(Number(/MemAvailable:\s+(\d+)/.exec(info)?.[1] ?? 0) / 1024);
};

export const readRssMb = (pid: number, field: "VmRSS" | "VmHWM") => {
  try {
    const kb = Number(new RegExp(`${field}:\\s+(\\d+)`).exec(readFileSync(`/proc/${pid}/status`, "utf8"))?.[1]);
    return Number.isFinite(kb) ? Math.round(kb / 1024) : 0;
  } catch {
    return 0;
  }
};

/**
 * Waits until MemAvailable covers the model's peak plus a margin, logging a
 * heartbeat line on every poll so a wait never looks like a hang, and gives up
 * after `maxWaitS` (LAB_MEM_WAIT_S, default 180 s): the model is then skipped
 * with an explicit message.
 */
export async function waitForMemory(model: LabModel, minFreeMb: number, maxWaitS = Number(process.env.LAB_MEM_WAIT_S ?? 180)): Promise<boolean> {
  const need = model.peakRssMb + minFreeMb;
  for (let waited = 0; ; waited += 15) {
    const available = readMemAvailableMb();
    if (available >= need) return true;
    if (waited >= maxWaitS) {
      console.error(`[${model.short}] SKIPPED: only ${available} MB available after ${waited} s, need ${need} MB (peak ~${model.peakRssMb} + ${minFreeMb} margin).`);
      return false;
    }
    console.log(`[${model.short}] waiting for memory (${waited}/${maxWaitS} s): ${available} MB available, need ${need} MB`);
    await new Promise((r) => setTimeout(r, 15_000));
  }
}

/**
 * Runs one worker script with `@@{json}` events on stdout, under the RSS and
 * MemAvailable guards, and resolves with the peak RSS when the worker exits.
 * Watchdogs make a broken worker fail fast instead of hanging the run: a spawn
 * error resolves at once, a worker that has not reported `loaded` after
 * `startupS` (default 300 s) is killed, and so is one that emits no event for
 * `idleS` (default 120 s; every generation is bounded by its deadline).
 */
export function runGuardedWorker(
  script: string,
  specFile: string,
  env: Record<string, string>,
  label: string,
  maxRssMb: number,
  onEvent: (event: { type: string } & Record<string, unknown>, rssMb: number) => void,
  { startupS = 300, idleS = 120 }: { startupS?: number; idleS?: number } = {},
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--expose-gc", "--import", "tsx", join(ROOT, script), specFile], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, ...env },
    });
    let peak = 0;
    let loaded = false;
    let lastEvent = Date.now();
    const started = Date.now();
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      clearInterval(timer);
      resolve(peak);
    };
    const kill = (why: string) => {
      console.error(`[${label}] ${why}; killing the worker.`);
      child.kill("SIGKILL");
    };
    const timer = setInterval(() => {
      const rss = readRssMb(child.pid!, "VmRSS");
      peak = Math.max(peak, readRssMb(child.pid!, "VmHWM"), rss);
      if (rss > maxRssMb) kill(`RSS ${rss} MB exceeds ${maxRssMb} MB`);
      else if (readMemAvailableMb() < 600) kill("system MemAvailable below 600 MB");
      else if (!loaded && Date.now() - started > startupS * 1000) kill(`no "loaded" event after ${startupS} s`);
      else if (loaded && Date.now() - lastEvent > idleS * 1000) kill(`no progress for ${idleS} s`);
    }, 250);
    child.on("error", (error) => {
      console.error(`[${label}] could not start the worker: ${error.message}`);
      finish();
    });
    let buffer = "";
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("@@")) continue;
        const event = JSON.parse(line.slice(2)) as { type: string } & Record<string, unknown>;
        lastEvent = Date.now();
        if (event.type === "loaded") loaded = true;
        if (event.type === "done") peak = Math.max(peak, Number(event.maxRssMb) || 0);
        onEvent(event, readRssMb(child.pid!, "VmRSS"));
      }
    });
    child.on("exit", (code, signal) => {
      if (code || signal) console.error(`[${label}] worker exited with ${signal ?? `code ${code}`}`);
      finish();
    });
  });
}
