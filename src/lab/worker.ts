/**
 * Lab child process: loads ONE model and runs pre-rendered requests, grouped
 * by prompt prefix so each prefix is prefilled once and its KV cache reused,
 * like the extension's engine. It only generates and records raw output;
 * parsing and scoring happen in the parent with the ref's own parser, so a
 * parser or scorer change never needs a recompute.
 *
 * Stop rules: the ref's `LineOutputTracker` (NONE, blank line after findings,
 * repeated line), EOS, an optional token cap, and the wall-clock deadline.
 *
 * Usage (spawned by src/lab/cli.ts): node --import tsx src/lab/worker.ts <spec.json>
 */
import { appendFileSync, readFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { register } from "node:module";
import type { PreTrainedModel, Tensor } from "@huggingface/transformers";

// Candidate models whose ONNX exports need a newer onnxruntime-web run with
// `LAB_ORT=next` (set by the lab CLI); the hook must be registered before
// Transformers.js is imported.
if (process.env.LAB_ORT === "next") register(new URL("./ort-next-hooks.mjs", import.meta.url));
const { ones, StoppingCriteria, StoppingCriteriaList, LogitsProcessor, LogitsProcessorList, Tensor: TensorClass } = await import("@huggingface/transformers");
const { eosIds, idsTensor, loadPretrained, WASM_THREADS, transformersVersion } = await import("../run/transformers-loader.ts");

export interface LabGen {
  maxNewTokens: number;
  deadlineMs: number;
  /** null = the model's generation_config default (what the extension gets). */
  repetitionPenalty: number | null;
  noRepeatNgram: number | null;
  /** Stop with the ref's line-protocol tracker (off for JSON output). */
  lineStop: boolean;
  /** Stop at the first line break after some output. */
  stopAtNewline?: boolean;
  /** Record P(answer starts with NONE) at the first generated token (for confidence gating). */
  scoreNone?: boolean;
  /** Forbid EOS before this many tokens (some chat models end a plain-text answer at once). */
  minNewTokens?: number;
  /**
   * Repetition penalty applied only to tokens the model generated in this
   * answer (not to the prompt, so copying from the scanned text stays free).
   */
  answerRepetitionPenalty?: number;
}
export interface LabJob {
  key: string;
  caseId: string;
  suffix: string;
  gen: LabGen;
}
export interface LabGroup {
  prefix: string;
  jobs: LabJob[];
}
export interface LabWorkerSpec {
  bundle: string;
  model: string;
  dtype: "q8" | "q4" | "q4f16" | "fp16" | "fp32";
  resultFile: string;
  groups: LabGroup[];
  /** Run every request from scratch (checks that prefix KV reuse does not change outputs). */
  noPrefixCache?: boolean;
}
export type LabFinish = "eos" | "line" | "length" | "deadline" | "context";
export interface LabRecord {
  key: string;
  model: string;
  dtype: string;
  caseId: string;
  output: string;
  promptTokens: number;
  generatedTokens: number;
  finishReason: LabFinish;
  /** P(first generated token starts "NONE"), when the job asked for it. */
  pNone?: number;
  ms: number;
  at: string;
}
export type LabEvent =
  | { type: "loaded"; loadMs: number; threads: number; transformers: string; ort: string; contextLength: number }
  | { type: "prefix"; tokens: number; ms: number }
  | { type: "result"; caseId: string; ms: number; tokens: number; finish: LabFinish; done: number; total: number }
  | { type: "done"; maxRssMb: number }
  | { type: "fatal"; error: string };

// Die with the parent: a worker whose CLI was killed must not keep a model
// loaded unsupervised (no RSS guard, no watchdog).
const parentPid = process.ppid;
setInterval(() => {
  if (process.ppid !== parentPid) process.exit(3);
}, 2000).unref();

const emit = (event: LabEvent) => process.stdout.write(`@@${JSON.stringify(event)}\n`);

class Stop extends StoppingCriteria {
  constructor(private readonly promptLength: number, private readonly check: (generated: number[]) => boolean) {
    super();
  }
  override _call(input_ids: number[][]): boolean[] {
    return input_ids.map((seq) => this.check((seq as (number | bigint)[]).slice(this.promptLength).map(Number)));
  }
}

/** Records the probability mass of the given token ids at the first generation step; logits pass through unchanged. */
class FirstStepProbe extends LogitsProcessor {
  p: number | undefined;
  constructor(private readonly ids: number[]) {
    super();
  }
  override _call(_inputIds: unknown, logits: Tensor): Tensor {
    if (this.p === undefined) {
      const row = logits.data as Float32Array;
      const vocab = logits.dims.at(-1)!;
      const scores = row.subarray(row.length - vocab);
      let max = -Infinity;
      for (const v of scores) if (v > max) max = v;
      let z = 0;
      for (const v of scores) z += Math.exp(v - max);
      this.p = this.ids.reduce((a, id) => a + Math.exp(scores[id]! - max), 0) / z;
    }
    return logits;
  }
}

/** CTRL-style repetition penalty restricted to the generated part of the sequence. */
class AnswerRepetitionPenalty extends LogitsProcessor {
  constructor(private readonly promptLength: number, private readonly penalty: number) {
    super();
  }
  override _call(inputIds: (number | bigint)[][], logits: Tensor): Tensor {
    const data = logits.data as Float32Array;
    const vocab = logits.dims.at(-1)!;
    inputIds.forEach((seq, b) => {
      const row = data.subarray(b * vocab, (b + 1) * vocab);
      for (const id of new Set(seq.slice(this.promptLength).map(Number))) {
        const v = row[id]!;
        row[id] = v > 0 ? v / this.penalty : v * this.penalty;
      }
    });
    return logits;
  }
}

async function main() {
  const spec = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as LabWorkerSpec;
  const mod = (await import(pathToFileURL(spec.bundle).href)) as { generation?: { LineOutputTracker?: new () => { feed(t: string): boolean } } };
  const Tracker = mod.generation?.LineOutputTracker;
  if (!Tracker) throw new Error("the extension ref does not export LineOutputTracker");
  const t0 = performance.now();
  const { tokenizer, model } = await loadPretrained(spec.model, spec.dtype as "q8");
  // Exports made for Transformers.js v4 (LFM2.5, Gemma 3, Granite 4) take a
  // `num_logits_to_keep` input that 3.8.1 never feeds. Only the last position's
  // logits are used by greedy decoding (and none by the prefix prefill).
  const session = (model as unknown as { sessions: Record<string, { inputNames: string[] }> }).sessions.model;
  if (session?.inputNames.includes("num_logits_to_keep")) {
    const forward = model.forward.bind(model);
    (model as unknown as { forward: (inputs: Record<string, unknown>) => unknown }).forward = (inputs) =>
      forward({ ...inputs, num_logits_to_keep: new TensorClass("int64", BigInt64Array.from([1n]), []) });
  }
  const contextLength = Number((model.config as { max_position_embeddings?: number }).max_position_embeddings ?? 2048);
  const eos = eosIds(model);
  const common = (await import("onnxruntime-common" as string)) as { env: { versions?: { web?: string } } };
  const ort = String(common.env.versions?.web ?? "?");
  emit({ type: "loaded", loadMs: Math.round(performance.now() - t0), threads: WASM_THREADS, transformers: transformersVersion, ort, contextLength });
  const encode = (text: string) => tokenizer.encode(text, { add_special_tokens: false });
  const noneIds = [...new Set([" NONE", "NONE", " None", "None"].map((w) => encode(w)[0]).filter((id): id is number => id !== undefined))];
  const decode = (ids: readonly number[]) => tokenizer.decode([...ids], { skip_special_tokens: true });
  const total = spec.groups.reduce((a, g) => a + g.jobs.length, 0);
  let done = 0;
  for (const group of spec.groups) {
    const p0 = performance.now();
    const prefixIds = encode(group.prefix);
    let pkv: unknown;
    if (!spec.noPrefixCache) {
      const outputs = await model.forward({ input_ids: idsTensor(prefixIds), attention_mask: ones([1, prefixIds.length]) });
      pkv = (model as unknown as { getPastKeyValues(o: unknown, p: null): unknown }).getPastKeyValues(outputs, null);
    }
    emit({ type: "prefix", tokens: prefixIds.length, ms: Math.round(performance.now() - p0) });
    for (const job of group.jobs) {
      const ids = [...prefixIds, ...encode(job.suffix)];
      const started = performance.now();
      const tracker = new Tracker();
      let checked = 0;
      let lineDone = false;
      let deadline = false;
      let text = "";
      const criteria = new StoppingCriteriaList();
      criteria.push(
        new Stop(ids.length, (generated) => {
          if (performance.now() - started >= job.gen.deadlineMs) return (deadline = true);
          if (generated.length > checked) {
            const fresh = generated.slice(checked);
            checked = generated.length;
            if (job.gen.stopAtNewline) {
              text += decode(fresh);
              if (/\S[^\n]*\n/u.test(text)) return (lineDone = true);
            }
            if (job.gen.lineStop && tracker.feed(decode(fresh))) return (lineDone = true);
          }
          return false;
        }),
      );
      const probe = job.gen.scoreNone ? new FirstStepProbe(noneIds) : undefined;
      const processors = probe || job.gen.answerRepetitionPenalty ? new LogitsProcessorList() : undefined;
      if (job.gen.answerRepetitionPenalty) processors!.push(new AnswerRepetitionPenalty(ids.length, job.gen.answerRepetitionPenalty));
      if (probe) processors!.push(probe);
      const room = contextLength - ids.length;
      const cap = job.gen.maxNewTokens > 0 ? Math.min(job.gen.maxNewTokens, room) : room;
      const output = (await model.generate({
        input_ids: idsTensor(ids),
        attention_mask: ones([1, ids.length]),
        ...(pkv === undefined ? {} : { past_key_values: pkv }),
        max_new_tokens: Math.max(1, cap),
        do_sample: false,
        ...(job.gen.repetitionPenalty === null ? {} : { repetition_penalty: job.gen.repetitionPenalty }),
        ...(job.gen.noRepeatNgram === null ? {} : { no_repeat_ngram_size: job.gen.noRepeatNgram }),
        stopping_criteria: criteria,
        ...(processors ? { logits_processor: processors } : {}),
        ...(job.gen.minNewTokens ? { min_new_tokens: job.gen.minNewTokens } : {}),
      } as unknown as Parameters<PreTrainedModel["generate"]>[0])) as Tensor;
      const generated = ((output.tolist() as (number | bigint)[][])[0] ?? []).slice(ids.length).map(Number);
      const last = generated.at(-1);
      const finishReason: LabFinish =
        last !== undefined && eos.includes(last) ? "eos" : lineDone ? "line" : deadline ? "deadline" : generated.length >= room ? "context" : "length";
      const record: LabRecord = {
        key: job.key,
        model: spec.model,
        dtype: spec.dtype,
        caseId: job.caseId,
        output: decode(generated),
        promptTokens: ids.length,
        generatedTokens: generated.length,
        finishReason,
        ...(probe?.p === undefined ? {} : { pNone: probe.p }),
        ms: Math.round(performance.now() - started),
        at: new Date().toISOString(),
      };
      appendFileSync(spec.resultFile, JSON.stringify(record) + "\n");
      done++;
      emit({ type: "result", caseId: job.caseId, ms: record.ms, tokens: record.generatedTokens, finish: finishReason, done, total });
    }
  }
  await model.dispose();
  emit({ type: "done", maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) });
}

main().catch((error: unknown) => {
  emit({ type: "fatal", error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  process.exitCode = 1;
});
