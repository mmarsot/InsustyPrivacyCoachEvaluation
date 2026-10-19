/**
 * Child process that runs every pending Private AI job of ONE model, then
 * exits so the operating system reclaims the whole WASM heap before the next
 * model loads. Each job is one `redact()` call on the extension's module at
 * the ref (`modules/insusty-privacy/insusty.ts`), with the case's custom labels and
 * Private AI on:
 *
 * - an on-device model runs on the ref's own `reviewPrompt` and `SlmEngine`
 *   (prefix cache, stop rules, generation budget), with the bench's Node
 *   Transformers.js loader;
 * - a connected model (`modules/insusty-privacy/connected.ts`) runs on the ref's own
 *   connected-model client; the bench supplies the transport (reply cache,
 *   cost, budget). Its latency includes the ref's pacing and retries.
 *
 * The findings are the output's custom-label spans; the request traces
 * become the cached chunks the scorer reads (format compliance, failure
 * modes, confidence).
 *
 * Usage (spawned by engine/cli/review.ts): node --import tsx engine/workers/model.ts <job-spec.json>
 * Protocol: one `@@{json}` line per event on stdout.
 */
import { readFileSync } from "node:fs";
import type { ModuleConfig } from "../../contract/types.ts";
import {
  connectedSpentUsd,
  connectedTarget,
  findConnectedModel,
} from "../../modules/insusty-privacy/connected.ts";
import { loadInsustyModule } from "../../modules/insusty-privacy/insusty.ts";
import type { ModuleRef } from "../../modules/insusty-privacy/materialize.ts";
import {
  appendResult,
  type ChunkRecord,
  type Job,
  type ResultRecord,
} from "../jobs.ts";

/**
 * The job file `engine/cli/review.ts` writes for one model's worker. Results go to
 * `resultFile` as they complete.
 */
export interface WorkerSpec {
  ref: ModuleRef;
  model: string;
  resultFile: string;
  jobs: Job[];
  /** Connected models: USD the whole hosted evaluation may spend (cached spend included). */
  budgetUsd?: number;
}

/**
 * One `@@{json}` stdout line to the parent: progress, then `done` with the
 * worker's peak memory, or `fatal`.
 */
export type WorkerEvent =
  | { type: "loaded"; loadMs: number; threads: number; transformers: string }
  | { type: "prepared"; instruction: string; labelVariant: string; ms: number }
  | {
      type: "result";
      caseId: string;
      reviewMs: number;
      done: number;
      total: number;
      error?: string;
      costUsd?: number;
    }
  | { type: "done"; maxRssMb: number; wallMs: number }
  | { type: "fatal"; error: string };

// Die with the parent run: never keep a model loaded without its RSS guard.
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) process.exit(3);
}, 2000).unref();

const emit = (event: WorkerEvent) =>
  process.stdout.write(`@@${JSON.stringify(event)}\n`);
const describe = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

async function main() {
  const spec = JSON.parse(
    readFileSync(process.argv[2] ?? "", "utf8"),
  ) as WorkerSpec;
  const started = performance.now();
  const connected = findConnectedModel(spec.model);
  let transformers = "";
  const module = await loadInsustyModule(spec.ref, {
    ...(connected
      ? {
          connected: [
            connectedTarget(connected, {
              budgetUsd: spec.budgetUsd ?? 0,
              spentUsd: () => connectedSpentUsd(),
            }),
          ],
        }
      : {
          device: async () => {
            const {
              nodeWasmLoader,
              disposeModels,
              transformersVersion,
              WASM_THREADS,
            } =
              await import("../../modules/insusty-privacy/runtime/transformers-loader.ts");
            transformers = transformersVersion;
            return {
              loader: nodeWasmLoader,
              threads: WASM_THREADS,
              dispose: disposeModels,
            };
          },
        }),
  });
  const runsOn = connected ? "connected" : "device";
  if (!module.capabilities.privateAi.includes(runsOn))
    throw new Error(
      `${spec.ref.ref} cannot run ${spec.model} through the contract (Private AI: ${module.capabilities.privateAi.join(", ") || "none"}; refs before the per-label design of PR #26 are not supported)`,
    );
  const configFor = (job: Job): ModuleConfig => ({
    ...module.defaultConfig(),
    customLabels: job.rules.map((r) => ({
      label: r.label,
      description: r.prompt,
      examples: r.examples ?? [],
    })),
    privateAi: { runsOn, model: spec.model },
  });
  // Group by labels so each configuration is prepared once, like the extension does when settings change,
  // and review latency excludes it.
  const groups = new Map<string, Job[]>();
  for (const job of spec.jobs)
    groups.set(JSON.stringify(job.rules), [
      ...(groups.get(JSON.stringify(job.rules)) ?? []),
      job,
    ]);
  let loaded = false;
  let done = 0;
  for (const jobs of groups.values()) {
    const prep = await module.prepare!(configFor(jobs[0]!));
    if (!loaded) {
      emit({
        type: "loaded",
        loadMs: Math.round(prep.loadMs ?? 0),
        threads: prep.backend?.threads ?? 0,
        transformers: connected
          ? `${connected.connection.provider} ${connected.connection.model} (the ref's connected-model client)`
          : transformers,
      });
      loaded = true;
    }
    emit({
      type: "prepared",
      instruction: jobs[0]!.instruction,
      labelVariant: jobs[0]!.labelVariant,
      ms: Math.round(prep.prepareMs ?? 0),
    });
    for (const job of jobs) {
      const record: ResultRecord = {
        key: job.key,
        extSha: spec.ref.sha,
        model: job.model,
        instruction: job.instruction,
        labelVariant: job.labelVariant,
        caseId: job.caseId,
        findings: [],
        chunks: [],
        reviewMs: 0,
        at: new Date().toISOString(),
      };
      let costUsd = 0;
      try {
        const out = await module.redact(
          { kind: "text", text: job.text },
          configFor(job),
        );
        const model = out.runtime.model;
        const stage = out.runtime.stages.find((s) => s.stage === "model");
        record.reviewMs = Math.round(
          (stage?.ms ?? 0) - (model?.loadMs ?? 0) - (model?.prepareMs ?? 0),
        );
        record.findings = out.spans
          .filter((s) => s.kind === "custom")
          .map((s) => ({
            category: s.label,
            start: s.start,
            end: s.end,
            value: out.text.slice(s.start, s.end),
          }));
        const backend = out.runtime.backend;
        record.chunks = (out.runtime.requests ?? []).map((r): ChunkRecord => {
          const usd = connected
            ? ((r.promptTokens ?? 0) * connected.usdPerMInput +
                (r.outputTokens ?? 0) * connected.usdPerMOutput) /
              1e6
            : 0;
          if (!r.cached) costUsd += usd;
          return {
            output: r.output ?? "",
            runtime: {
              backend: backend?.name ?? "",
              quantization:
                backend?.dtype ??
                (connected ? connected.connection.format : ""),
              promptTokens: r.promptTokens ?? 0,
              generatedTokens: r.outputTokens ?? 0,
              finishReason: r.finishReason ?? "",
              ...(r.confidence !== undefined
                ? { answerProbability: r.confidence }
                : {}),
            },
            ms: Math.round(r.ms),
            ...(r.label !== undefined ? { prefill: `${r.label}:` } : {}),
            ...(connected
              ? {
                  usage: {
                    inputTokens: r.promptTokens ?? 0,
                    outputTokens: r.outputTokens ?? 0,
                    costUsd: usd,
                    serverMs: 0,
                    totalMs: Math.round(r.ms),
                    attempts: 1,
                  },
                }
              : {}),
          };
        });
        if (out.coverage.reason === "private_ai_unavailable") {
          record.error = out.coverage.detail ?? "Private AI review failed";
          record.errorKind = record.chunks.some(
            (c) => c.runtime?.finishReason === "deadline",
          )
            ? "deadline"
            : "error";
          // A connected model that failed (network, quota, time limit) is not cached, so a rerun computes it.
          if (connected) {
            emit({
              type: "result",
              caseId: job.caseId,
              reviewMs: record.reviewMs,
              done,
              total: spec.jobs.length,
              error: `not cached (${record.error})`,
              costUsd,
            });
            if (/budget/.test(record.error)) {
              emit({ type: "fatal", error: record.error });
              process.exit(1);
            }
            continue;
          }
        }
      } catch (error) {
        record.error = describe(error);
        record.errorKind = "error";
      }
      appendResult(spec.resultFile, record);
      done++;
      emit({
        type: "result",
        caseId: job.caseId,
        reviewMs: record.reviewMs,
        done,
        total: spec.jobs.length,
        ...(record.error ? { error: record.errorKind } : {}),
        ...(connected ? { costUsd } : {}),
      });
    }
  }
  await module.dispose?.();
  emit({
    type: "done",
    maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024),
    wallMs: Math.round(performance.now() - started),
  });
}

main().catch((error: unknown) => {
  emit({ type: "fatal", error: describe(error) });
  process.exitCode = 1;
});
