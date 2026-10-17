/**
 * The machine profile every runtime report carries, and the process memory
 * readings behind `peakRssMb`. Absolute speed and memory are comparable only
 * between runs with the same profile id: set `BENCH_MACHINE_ID` on a declared
 * reference machine; anything else reports `adhoc`.
 */
import { readFileSync, writeFileSync } from "node:fs";
import { availableParallelism, cpus, release, totalmem, type } from "node:os";
import type { MachineProfile } from "../../contract/types.ts";

let profile: MachineProfile | undefined;
export function machineProfile(): MachineProfile {
  profile ??= {
    id: process.env.BENCH_MACHINE_ID || "adhoc",
    cpu: cpus()[0]?.model.trim() ?? "unknown",
    cores: availableParallelism(),
    ramMb: Math.round(totalmem() / 1024 / 1024),
    os: `${type()} ${release()}`,
    node: process.versions.node,
    ...(process.env.BENCH_POWER_MODE
      ? { powerMode: process.env.BENCH_POWER_MODE }
      : {}),
  };
  return profile;
}

/** `VmRSS` or `VmHWM` of this process in MB (Linux), else undefined. */
export function procMemoryMb(field: "VmRSS" | "VmHWM"): number | undefined {
  try {
    const kb = Number(
      new RegExp(`${field}:\\s+(\\d+)`).exec(
        readFileSync("/proc/self/status", "utf8"),
      )?.[1],
    );
    return Number.isFinite(kb) ? Math.round(kb / 1024) : undefined;
  } catch {
    return undefined;
  }
}

/** Resets the kernel's peak-RSS counter so `VmHWM` measures from now; false where the platform cannot. */
export function resetPeakRss(): boolean {
  (globalThis as { gc?: () => void }).gc?.();
  try {
    writeFileSync("/proc/self/clear_refs", "5");
    return true;
  } catch {
    return false;
  }
}

/** Peak RSS so far: `VmHWM` where readable, else the process's maximum. */
export const peakRssMb = (): number =>
  procMemoryMb("VmHWM") ?? Math.round(process.resourceUsage().maxRSS / 1024);
