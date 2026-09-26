/**
 * Child process that runs every pending job of ONE model, then exits so the
 * operating system reclaims the whole WASM heap before the next model loads.
 * It drives the ref's own `reviewPrompt` (chunking, framing, prefill, parsing,
 * anchoring) with the ref's own `SlmEngine` (prefix cache, stop rules,
 * generation budget), and only swaps in a Node Transformers.js loader.
 *
 * Usage (spawned by src/cli/run.ts): node --import tsx src/run/worker.ts <job-spec.json>
 * Protocol: one `@@{json}` line per event on stdout.
 */
import { readFileSync } from "node:fs";
import { loadExtApi, type ModelClientLike, type RuntimeSelection } from "../ext/ref.ts";
import { appendResult, type ChunkRecord, type Job, type ResultRecord } from "./jobs.ts";

export interface WorkerSpec {
  bundle: string;
  extSha: string;
  model: string;
  resultFile: string;
  jobs: Job[];
}

export type WorkerEvent =
  | { type: "loaded"; loadMs: number; threads: number; transformers: string }
  | { type: "prepared"; instruction: string; labelVariant: string; ms: number }
  | { type: "result"; caseId: string; reviewMs: number; done: number; total: number; error?: string }
  | { type: "done"; maxRssMb: number; wallMs: number }
  | { type: "fatal"; error: string };

const emit = (event: WorkerEvent) => process.stdout.write(`@@${JSON.stringify(event)}\n`);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function main() {
  const spec = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as WorkerSpec;
  const started = performance.now();
  const api = await loadExtApi(spec.bundle);
  const { nodeWasmLoader, disposeModels, transformersVersion, WASM_THREADS } = await import("./transformers-loader.ts");
  const engine = new api.SlmEngine(nodeWasmLoader);
  const selection: RuntimeSelection = { backend: "wasm", quantization: "auto" };

  const loadStart = performance.now();
  await engine.prepare(spec.model, selection, []);
  emit({ type: "loaded", loadMs: Math.round(performance.now() - loadStart), threads: WASM_THREADS, transformers: transformersVersion });

  // Group by composed instructions so each prefix is prepared once, like the
  // extension does when settings change, and review latency excludes it.
  const groups = new Map<string, Job[]>();
  for (const job of spec.jobs) {
    const instructions = api.composeReviewInstructions(job.systemInstruction, job.rules);
    groups.set(instructions, [...(groups.get(instructions) ?? []), job]);
  }
  let done = 0;
  for (const [instructions, jobs] of groups) {
    const prepStart = performance.now();
    await engine.prepare(spec.model, selection, [instructions]);
    emit({ type: "prepared", instruction: jobs[0]!.instruction, labelVariant: jobs[0]!.labelVariant, ms: Math.round(performance.now() - prepStart) });
    for (const job of jobs) {
      const chunks: ChunkRecord[] = [];
      const client: ModelClientLike = {
        async review(request, model, sel) {
          const t = performance.now();
          try {
            const result = await engine.review(model ?? spec.model, sel ?? selection, request, api.generationBudgetMs);
            chunks.push({ output: result.output, runtime: result.runtime, ms: Math.round(performance.now() - t) });
            return { output: result.output, runtime: result.runtime };
          } catch (error) {
            chunks.push({ output: "", ms: Math.round(performance.now() - t), error: describe(error) });
            throw error;
          }
        },
      };
      const t = performance.now();
      const record: ResultRecord = {
        key: job.key,
        extSha: spec.extSha,
        model: job.model,
        instruction: job.instruction,
        labelVariant: job.labelVariant,
        caseId: job.caseId,
        findings: [],
        chunks,
        reviewMs: 0,
        at: new Date().toISOString(),
      };
      try {
        const result = await api.reviewPrompt(job.text, [], job.systemInstruction, client, undefined, undefined, job.rules, job.model, selection);
        record.findings = result.findings.map(({ category, start, end, value }) => ({ category, start, end, value }));
      } catch (error) {
        record.error = describe(error);
        record.errorKind = chunks.some((c) => c.runtime?.finishReason === "deadline") ? "deadline" : "error";
      }
      record.reviewMs = Math.round(performance.now() - t);
      appendResult(spec.resultFile, record);
      done++;
      emit({ type: "result", caseId: job.caseId, reviewMs: record.reviewMs, done, total: spec.jobs.length, ...(record.error ? { error: record.errorKind } : {}) });
    }
  }
  await disposeModels();
  emit({ type: "done", maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024), wallMs: Math.round(performance.now() - started) });
}

main().catch((error: unknown) => {
  emit({ type: "fatal", error: describe(error) });
  process.exitCode = 1;
});
