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

/** Waits (up to 10 min) until MemAvailable covers the model's peak plus a margin. */
export async function waitForMemory(model: LabModel, minFreeMb: number): Promise<boolean> {
  const need = model.peakRssMb + minFreeMb;
  for (let waited = 0; ; waited += 30) {
    const available = readMemAvailableMb();
    if (available >= need) return true;
    if (waited >= 600) {
      console.error(`[${model.short}] only ${available} MB available, need ${need} MB (peak ~${model.peakRssMb} + ${minFreeMb} margin); skipping.`);
      return false;
    }
    if (waited === 0) console.log(`[${model.short}] waiting for memory: ${available} MB available, need ${need} MB`);
    await new Promise((r) => setTimeout(r, 30_000));
  }
}

/**
 * Runs one worker script with `@@{json}` events on stdout, under the RSS and
 * MemAvailable guards. Resolves with the peak RSS when the worker exits.
 */
export function runGuardedWorker(
  script: string,
  specFile: string,
  env: Record<string, string>,
  label: string,
  maxRssMb: number,
  onEvent: (event: { type: string } & Record<string, unknown>, rssMb: number) => void,
): Promise<number> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, ["--import", "tsx", join(ROOT, script), specFile], {
      cwd: ROOT,
      stdio: ["ignore", "pipe", "inherit"],
      env: { ...process.env, ...env },
    });
    let peak = 0;
    const timer = setInterval(() => {
      const rss = readRssMb(child.pid!, "VmRSS");
      peak = Math.max(peak, readRssMb(child.pid!, "VmHWM"), rss);
      const why = rss > maxRssMb ? `RSS ${rss} MB exceeds ${maxRssMb} MB` : readMemAvailableMb() < 600 ? "system MemAvailable below 600 MB" : "";
      if (why) {
        console.error(`[${label}] ${why}; killing the worker.`);
        child.kill("SIGKILL");
      }
    }, 250);
    let buffer = "";
    child.stdout.on("data", (data: Buffer) => {
      buffer += data.toString();
      let nl: number;
      while ((nl = buffer.indexOf("\n")) >= 0) {
        const line = buffer.slice(0, nl);
        buffer = buffer.slice(nl + 1);
        if (!line.startsWith("@@")) continue;
        const event = JSON.parse(line.slice(2)) as { type: string } & Record<string, unknown>;
        if (event.type === "done") peak = Math.max(peak, Number(event.maxRssMb) || 0);
        onEvent(event, readRssMb(child.pid!, "VmRSS"));
      }
    });
    child.on("exit", (code) => {
      clearInterval(timer);
      if (code) console.error(`[${label}] worker exited with code ${code}`);
      resolve(peak);
    });
  });
}
