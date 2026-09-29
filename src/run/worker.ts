/**
 * Child process that runs every pending job of ONE model, then exits so the
 * operating system reclaims the whole WASM heap before the next model loads.
 * It drives the ref's own `reviewPrompt` (chunking, framing, prefill, parsing,
 * anchoring) with the ref's own `SlmEngine` (prefix cache, stop rules,
 * generation budget), and only swaps in a Node Transformers.js loader.
 *
 * A hosted model (src/hosted/models.ts: Bedrock or an OpenAI-compatible
 * server) replaces the engine with a client that sends the ref's per-label
 * request to its API (src/hosted/client.ts): the ref's `reviewPrompt` still
 * does everything else (pagination, code-fence skip, parsing, anchoring,
 * patterns, and the confidence filter when the provider returns token log
 * probabilities). Its latency excludes throttling retries and backoff.
 *
 * Usage (spawned by src/cli/run.ts): node --import tsx src/run/worker.ts <job-spec.json>
 * Protocol: one `@@{json}` line per event on stdout.
 */
import { readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { loadExtApi, type ModelClientLike, type ReviewRequestLike, type RuntimeReportLike, type RuntimeSelection } from "../ext/ref.ts";
import { HostedError, reviewHosted } from "../hosted/client.ts";
import { describeTarget, findHostedModel } from "../hosted/models.ts";
import { appendResult, type ChunkRecord, type Job, type ResultRecord } from "./jobs.ts";

export interface WorkerSpec {
  bundle: string;
  extSha: string;
  model: string;
  resultFile: string;
  jobs: Job[];
  /** Hosted models: USD this worker may spend before it stops (the rest stays pending). */
  budgetUsd?: number;
}

export type WorkerEvent =
  | { type: "loaded"; loadMs: number; threads: number; transformers: string }
  | { type: "prepared"; instruction: string; labelVariant: string; ms: number }
  | { type: "result"; caseId: string; reviewMs: number; done: number; total: number; error?: string; costUsd?: number }
  | { type: "done"; maxRssMb: number; wallMs: number }
  | { type: "fatal"; error: string };

// Die with the parent run: never keep a model loaded without its RSS guard.
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) process.exit(3);
}, 2000).unref();

const emit = (event: WorkerEvent) => process.stdout.write(`@@${JSON.stringify(event)}\n`);
const describe = (error: unknown) => (error instanceof Error ? error.message : String(error));

async function main() {
  const spec = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as WorkerSpec;
  const started = performance.now();
  const api = await loadExtApi(spec.bundle);
  const hosted = findHostedModel(spec.model);
  const selection: RuntimeSelection = { backend: "wasm", quantization: "auto" };
  type Review = (request: ReviewRequestLike, model: string, sel: RuntimeSelection) => Promise<{ output: string; runtime: RuntimeReportLike; ms?: number; usage?: ChunkRecord["usage"] }>;
  let review: Review;
  let prepare: (instructions: string[]) => Promise<unknown> = async () => undefined;
  let dispose = async () => undefined as unknown;
  /** Hosted native framings read the job's rules. */
  let setRules: (rules: Job["rules"]) => void = () => undefined;
  if (hosted) {
    if (api.kind !== "completion") throw new Error(`${hosted.short} needs a completion-design ref (per-label requests); ${api.kind} refs are not supported`);
    const bundle = (await import(pathToFileURL(spec.bundle).href)) as { generation?: { SLM_COMPLETION_MAX_NEW_TOKENS?: number }; review: { frameReviewInput?: (text: string) => string } };
    const maxTokens = hosted.maxTokens ?? bundle.generation?.SLM_COMPLETION_MAX_NEW_TOKENS ?? 48;
    // Native framings: the request's rule is found by its answer cue, its text by undoing the input framing.
    const [framePre, framePost] = (bundle.review.frameReviewInput?.("\u0000") ?? "Text: \u0000\n").split("\u0000") as [string, string];
    let rules: Job["rules"] = [];
    setRules = (r) => (rules = r);
    review = async (request) => {
      let native: { label: { label: string; description: string; examples: string[] }; text: string } | undefined;
      if (hosted.framing === "native") {
        const rule = rules.find((r) => `${r.label}:` === request.responsePrefill);
        if (!rule || !request.input.startsWith(framePre) || !request.input.endsWith(framePost)) throw new Error("native framing: cannot map the request to its label and text");
        native = { label: { label: rule.label, description: rule.prompt, examples: rule.examples ?? [] }, text: request.input.slice(framePre.length, request.input.length - framePost.length) };
      }
      const r = await reviewHosted(hosted, { instructions: request.instructions, input: request.input, responsePrefill: request.responsePrefill ?? "", ...(native ? { native } : {}) }, { maxTokens, stopAtNewline: true });
      const finishReason = r.cut ? "line" : r.stopReason === "length" ? "length" : "eos";
      return {
        output: r.output,
        runtime: { backend: hosted.provider, quantization: hosted.framing, promptTokens: r.inputTokens, generatedTokens: r.outputTokens, finishReason, ...(r.answerProbability === undefined ? {} : { answerProbability: r.answerProbability }) },
        ms: r.ms,
        usage: { inputTokens: r.inputTokens, outputTokens: r.outputTokens, costUsd: r.costUsd, serverMs: r.serverMs, totalMs: r.totalMs, attempts: r.attempts },
      };
    };
    emit({ type: "loaded", loadMs: 0, threads: 0, transformers: `${describeTarget(hosted)}, ${hosted.framing} framing` });
  } else {
    const { nodeWasmLoader, disposeModels, transformersVersion, WASM_THREADS } = await import("./transformers-loader.ts");
    const engine = new api.SlmEngine(nodeWasmLoader);
    const loadStart = performance.now();
    await engine.prepare(spec.model, selection, []);
    emit({ type: "loaded", loadMs: Math.round(performance.now() - loadStart), threads: WASM_THREADS, transformers: transformersVersion });
    review = (request, model, sel) => engine.review(model, sel, request, api.generationBudgetMs);
    prepare = (instructions) => engine.prepare(spec.model, selection, instructions);
    dispose = disposeModels;
  }

  // Group by composed instructions so each prefix is prepared once, like the
  // extension does when settings change, and review latency excludes it.
  const groups = new Map<string, Job[]>();
  for (const job of spec.jobs) {
    const instructions = JSON.stringify(api.preparedInstructions(job.systemInstruction, job.rules));
    groups.set(instructions, [...(groups.get(instructions) ?? []), job]);
  }
  let done = 0;
  let spentUsd = 0;
  jobs: for (const [instructions, jobs] of groups) {
    const prepStart = performance.now();
    await prepare(JSON.parse(instructions) as string[]);
    emit({ type: "prepared", instruction: jobs[0]!.instruction, labelVariant: jobs[0]!.labelVariant, ms: Math.round(performance.now() - prepStart) });
    for (const job of jobs) {
      if (spec.budgetUsd !== undefined && spentUsd >= spec.budgetUsd) {
        emit({ type: "fatal", error: `hosted budget reached (${spentUsd.toFixed(4)} USD in this run); the remaining jobs stay pending` });
        break jobs;
      }
      setRules(job.rules);
      const chunks: ChunkRecord[] = [];
      /** A hosted request that ran out of retries: the job is not cached, so a rerun computes it. */
      let transient = false;
      const client: ModelClientLike = {
        async review(request, model, sel) {
          const t = performance.now();
          try {
            const result = await review(request, model ?? spec.model, sel ?? selection);
            chunks.push({ output: result.output, runtime: result.runtime, ms: result.ms ?? Math.round(performance.now() - t), ...(request.responsePrefill ? { prefill: request.responsePrefill } : {}), ...(result.usage ? { usage: result.usage } : {}) });
            spentUsd += result.usage?.costUsd ?? 0;
            return { output: result.output, runtime: result.runtime };
          } catch (error) {
            if (error instanceof HostedError && !error.retryable) {
              // Access, auth or validation: nothing else will work either.
              emit({ type: "fatal", error: error.message });
              process.exit(1);
            }
            if (error instanceof HostedError) transient = true;
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
        const result = await api.runReview(job.text, job.systemInstruction, client, job.rules, job.model, selection, hosted?.contextBudget);
        record.findings = result.findings.map(({ category, start, end, value }) => ({ category, start, end, value }));
      } catch (error) {
        record.error = describe(error);
        record.errorKind = chunks.some((c) => c.runtime?.finishReason === "deadline") ? "deadline" : "error";
      }
      // Hosted: time lost to throttled attempts and backoff is not the model's latency.
      const throttledMs = chunks.reduce((a, c) => a + (c.usage ? c.usage.totalMs - c.ms : 0), 0);
      record.reviewMs = Math.round(performance.now() - t - throttledMs);
      const costUsd = chunks.reduce((a, c) => a + (c.usage?.costUsd ?? 0), 0);
      if (transient) {
        emit({ type: "result", caseId: job.caseId, reviewMs: record.reviewMs, done, total: spec.jobs.length, error: "not cached (API retries exhausted)", ...(hosted ? { costUsd } : {}) });
        continue;
      }
      appendResult(spec.resultFile, record);
      done++;
      emit({ type: "result", caseId: job.caseId, reviewMs: record.reviewMs, done, total: spec.jobs.length, ...(record.error ? { error: record.errorKind } : {}), ...(hosted ? { costUsd } : {}) });
    }
  }
  await dispose();
  emit({ type: "done", maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024), wallMs: Math.round(performance.now() - started) });
}

main().catch((error: unknown) => {
  emit({ type: "fatal", error: describe(error) });
  process.exitCode = 1;
});
