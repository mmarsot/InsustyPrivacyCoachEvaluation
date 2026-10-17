/**
 * Dataset files are downloaded into the gitignored cache at a pinned
 * revision and checked against their pinned SHA-256 before any use; they
 * are never committed. A mismatch (an upstream change or a corrupted
 * download) stops the run.
 */
import { createHash } from "node:crypto";
import { createReadStream, existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "../paths.ts";
import type { BenchmarkAdapter } from "./types.ts";

export const DATASETS_DIR = join(CACHE_DIR, "datasets");

export const datasetDir = (a: Pick<BenchmarkAdapter, "id" | "revision">) => join(DATASETS_DIR, a.id, a.revision);

export async function sha256File(file: string): Promise<string> {
  const hash = createHash("sha256");
  for await (const chunk of createReadStream(file)) hash.update(chunk as Buffer);
  return hash.digest("hex");
}

/** Downloads (once) and verifies a split's files; returns the directory holding them. */
export async function ensureDataset(a: BenchmarkAdapter, split: string, log: (line: string) => void = console.log): Promise<string> {
  const dir = datasetDir(a);
  mkdirSync(dir, { recursive: true });
  for (const f of a.files(split)) {
    const file = join(dir, f.name);
    if (!existsSync(file)) {
      log(`downloading ${a.id} ${f.name} (${(f.bytes / 1e6).toFixed(1)} MB) at ${a.revision.slice(0, 10)}`);
      const response = await fetch(f.url, { redirect: "follow" });
      if (!response.ok) throw new Error(`${f.url}: HTTP ${response.status}`);
      const part = `${file}.part-${process.pid}`;
      writeFileSync(part, new Uint8Array(await response.arrayBuffer()));
      renameSync(part, file);
    }
    const got = await sha256File(file);
    if (got !== f.sha256) {
      rmSync(file, { force: true });
      throw new Error(`${a.id} ${f.name}: SHA-256 ${got} is not the pinned ${f.sha256}; the file was removed`);
    }
  }
  return dir;
}

/** A stable, seeded sample of `limit` ids (all when `limit` is 0 or larger than the list). */
export function sampleIds(ids: string[], limit: number, seed: string): Set<string> {
  if (!limit || limit >= ids.length) return new Set(ids);
  const key = (id: string) => createHash("sha256").update(`${seed}:${id}`).digest("hex");
  return new Set([...ids].sort((x, y) => key(x).localeCompare(key(y))).slice(0, limit));
}
