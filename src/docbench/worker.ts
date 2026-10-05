/**
 * Document-bench worker: runs a list of jobs (suite cases or sweep points)
 * against one materialized ref, in its own process, and appends each result
 * to the ref's result cache. Events go to stdout as `@@{json}` lines, like
 * the model worker (`src/run/worker.ts`).
 *
 *   node --expose-gc --import tsx src/docbench/worker.ts <spec.json>
 *
 * Memory: before each measured job the worker collects garbage and resets
 * the kernel's peak-RSS counter (`/proc/self/clear_refs`), so `VmHWM` after
 * the job is the peak of reading, detecting and redacting that document
 * alone. Sweep points run one per process for a clean measure.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { performance } from "node:perf_hooks";
import { defangJson } from "../detbench/defang.ts";
import { CACHE_DIR } from "../paths.ts";
import { buildDoc } from "./cases.ts";
import { specHash, sweepHash, type BuiltDoc, type DocSpec, type SweepSpec } from "./specs.ts";
import { loadPools } from "./content.ts";
import { loadDocReader, type DocReaderRef } from "./ext.ts";
import { detect, rangesOf, readForCheck, redactForAttach, type ConfigName } from "./pipeline.ts";
import { classify, scoreDoc } from "./score.ts";
import { buildSweepDoc } from "./sweeps.ts";
import { independentViews } from "./verify.ts";
import { writeDocx } from "./writers/ooxml.ts";
import { writePdf } from "./writers/pdf.ts";
import type { DocJob, DocJobResult } from "./types.ts";

export interface DocWorkerSpec {
  ref: DocReaderRef;
  seed: number;
  configs: ConfigName[];
  /** Timing repetitions per job (the median is kept). */
  reps: number;
  resultFile: string;
  jobs: DocJob[];
  /** Detection categories the ref supports (mapped to the dataset's). */
  supported: string[];
}

const emit = (event: Record<string, unknown>) => process.stdout.write(`@@${JSON.stringify(event)}\n`);
const procField = (field: "VmRSS" | "VmHWM") => {
  try {
    const kb = Number(new RegExp(`${field}:\\s+(\\d+)`).exec(readFileSync("/proc/self/status", "utf8"))?.[1]);
    return Number.isFinite(kb) ? Math.round(kb / 1024) : undefined;
  } catch {
    return undefined;
  }
};
const resetPeak = () => {
  (globalThis as { gc?: () => void }).gc?.();
  try {
    writeFileSync("/proc/self/clear_refs", "5");
    return true;
  } catch {
    return false;
  }
};
const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};
const round = (v: number) => Math.round(v * 100) / 100;

/** Generated documents are cached on disk by spec hash (generation is deterministic). */
export const FILES_DIR = join(CACHE_DIR, "docbench", "files");

async function documentFor(job: DocJob, seed: number, pools: () => ReturnType<typeof loadPools>): Promise<BuiltDoc> {
  const hash = job.track === "suite" ? specHash(job.spec, seed) : sweepHash(job.sweep!, seed);
  const file = join(FILES_DIR, `${hash}.json`);
  if (existsSync(file)) {
    const meta = JSON.parse(readFileSync(file, "utf8")) as Omit<BuiltDoc, "bytes">;
    return { ...meta, bytes: new Uint8Array(readFileSync(file.replace(/\.json$/, ".bin"))) };
  }
  const built = job.track === "suite" ? await buildDoc(job.spec as DocSpec, pools(), seed) : await buildSweepDoc(job.sweep as SweepSpec, pools(), seed);
  mkdirSync(FILES_DIR, { recursive: true });
  const { bytes, ...meta } = built;
  // Files over 64 MB (the scan-cap and size failure cases) are rebuilt each time rather than stored.
  if (bytes.length < 64 * 1024 * 1024) {
    writeFileSync(file.replace(/\.json$/, ".bin"), bytes);
    writeFileSync(file, JSON.stringify(meta));
  }
  return built;
}

async function main() {
  const spec = JSON.parse(readFileSync(process.argv[2]!, "utf8")) as DocWorkerSpec;
  const api = await loadDocReader(spec.ref);
  let poolCache: ReturnType<typeof loadPools> | undefined;
  const pools = () => (poolCache ??= loadPools());
  // Warm up: PDFium's first load and the detector's first call are not part of any document's time.
  if (api.readDocument) {
    for (const [name, bytes] of [
      ["warm.pdf", await writePdf({ blocks: [{ type: "p", text: "Warm up page." }] })],
      ["warm.docx", writeDocx({ body: [{ type: "p", text: "Warm up." }] })],
    ] as const) {
      const r = await readForCheck(api, name, bytes);
      if (r.doc && api.redactDocument && name.endsWith(".pdf")) await redactForAttach(api, name, bytes, r, [{ start: 0, end: 4, replacement: "[X]" }]).catch(() => undefined);
    }
  }
  for (const c of spec.configs) api.detect("warm up 06 12 34 56 78 jo@example.org", c);
  emit({ type: "loaded", rssMb: procField("VmRSS") });
  mkdirSync(dirname(spec.resultFile), { recursive: true });
  let done = 0;
  for (const job of spec.jobs) {
    const t0 = performance.now();
    try {
      const doc = await documentFor(job, spec.seed, pools);
      const peakResettable = resetPeak();
      const baseline = procField("VmRSS");
      const readTimes: number[] = [];
      const detectTimes: Record<string, number[]> = {};
      const redactTimes: number[] = [];
      let read = await readForCheck(api, doc.name, doc.bytes);
      readTimes.push(read.readMs);
      const perConfig: Parameters<typeof scoreDoc>[2] = {};
      for (const config of spec.configs) {
        const d = detect(api, read.text, config);
        detectTimes[config] = [d.ms];
        const redaction = await redactForAttach(api, doc.name, doc.bytes, read, rangesOf(d.detections));
        if (redaction.mode !== "none") redactTimes.push(redaction.ms);
        perConfig[config] = { detections: d.detections, ms: d.ms, redaction };
      }
      for (let rep = 1; rep < spec.reps; rep++) {
        read = await readForCheck(api, doc.name, doc.bytes);
        readTimes.push(read.readMs);
        for (const config of spec.configs) {
          const d = detect(api, read.text, config);
          detectTimes[config]!.push(d.ms);
          if (config === spec.configs[0]) {
            const r = await redactForAttach(api, doc.name, doc.bytes, read, rangesOf(d.detections));
            if (r.mode !== "none") redactTimes.push(r.ms);
          }
        }
      }
      const peak = procField("VmHWM");
      // Verification reads the redacted outputs with an independent reader (not timed, not in the peak).
      for (const config of spec.configs) {
        const run = perConfig[config]!;
        if (run.redaction?.bytes) run.outputViews = independentViews(run.redaction.bytes);
        run.ms = median(detectTimes[config]!);
      }
      const scored = scoreDoc(doc, read, perConfig, spec.supported as never);
      const classification = classify(read, doc.spec.expect);
      const small = read.text.length <= 60_000;
      const result: DocJobResult = {
        key: job.key,
        jobId: job.id,
        track: job.track,
        extSha: spec.ref.sha,
        seed: spec.seed,
        spec: doc.spec,
        ...(job.sweep ? { sweep: job.sweep } : {}),
        name: doc.name,
        bytes: doc.bytes.length,
        size: doc.size,
        read: {
          outcome: read.outcome,
          ...(read.reason ? { reason: read.reason } : {}),
          ...(read.readAs ? { readAs: read.readAs } : {}),
          gaps: read.gaps,
          signed: read.signed,
          ...(read.pages !== undefined ? { pages: read.pages } : {}),
          ...(read.partialText ? { partialText: true } : {}),
          ...(read.redaction ? { redaction: read.redaction } : {}),
          chars: read.text.length,
          segments: read.segments.length,
          ...(read.error ? { error: read.error.slice(0, 300) } : {}),
        },
        classification,
        items: scored.items,
        decoys: scored.decoys,
        configs: scored.configs,
        timing: {
          reps: spec.reps,
          readMs: round(median(readTimes)),
          readMinMs: round(Math.min(...readTimes)),
          detectMs: Object.fromEntries(Object.entries(detectTimes).map(([c, xs]) => [c, round(median(xs))])),
          redactMs: redactTimes.length ? round(median(redactTimes)) : null,
        },
        memory: { baselineMb: baseline ?? null, peakMb: peak ?? null, deltaMb: peak !== undefined && baseline !== undefined && peakResettable ? peak - baseline : null, peakResettable },
        ...(job.track === "suite" && small ? { text: read.text, segments: read.segments.map((s) => ({ where: s.where, start: s.start, end: s.end })) } : {}),
        wallMs: Math.round(performance.now() - t0),
        at: new Date().toISOString(),
      };
      appendFileSync(spec.resultFile, defangJson(JSON.stringify(result)) + "\n");
      done++;
      emit({ type: "result", id: job.id, done, total: spec.jobs.length, outcome: read.outcome, readMs: result.timing.readMs, peakMb: peak });
    } catch (error) {
      done++;
      emit({ type: "result", id: job.id, done, total: spec.jobs.length, error: (error as Error).stack?.slice(0, 500) ?? String(error) });
    }
  }
  emit({ type: "done", maxRssMb: procField("VmHWM") });
}

main().catch((error) => {
  emit({ type: "fatal", error: String((error as Error).stack ?? error) });
  process.exit(1);
});
