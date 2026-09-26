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
import { ones, StoppingCriteria, StoppingCriteriaList, type PreTrainedModel, type Tensor } from "@huggingface/transformers";
import { eosIds, idsTensor, loadPretrained, WASM_THREADS, transformersVersion } from "../run/transformers-loader.ts";

export interface LabGen {
  maxNewTokens: number;
  deadlineMs: number;
  /** null = the model's generation_config default (what the extension gets). */
  repetitionPenalty: number | null;
  noRepeatNgram: number | null;
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
  ms: number;
  at: string;
}
export type LabEvent =
  | { type: "loaded"; loadMs: number; threads: number; transformers: string; contextLength: number }
  | { type: "prefix"; tokens: number; ms: number }
  | { type: "result"; caseId: string; ms: number; tokens: number; finish: LabFinish; done: number; total: number }
  | { type: "done"; maxRssMb: number }
  | { type: "fatal"; error: string };

const emit = (event: LabEvent) => process.stdout.write(`@@${JSON.stringify(event)}\n`);

class Stop extends StoppingCriteria {
  constructor(private readonly promptLength: number, private readonly check: (generated: number[]) => boolean) {
    super();
  }
  override _call(input_ids: number[][]): boolean[] {
    return input_ids.map((seq) => this.check((seq as (number | bigint)[]).slice(this.promptLength).map(Number)));
  }
}

async function main() {
  const spec = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as LabWorkerSpec;
  const mod = (await import(pathToFileURL(spec.bundle).href)) as { generation?: { LineOutputTracker?: new () => { feed(t: string): boolean } } };
  const Tracker = mod.generation?.LineOutputTracker;
  if (!Tracker) throw new Error("the extension ref does not export LineOutputTracker");
  const t0 = performance.now();
  const { tokenizer, model } = await loadPretrained(spec.model, spec.dtype as "q8");
  const contextLength = Number((model.config as { max_position_embeddings?: number }).max_position_embeddings ?? 2048);
  const eos = eosIds(model);
  emit({ type: "loaded", loadMs: Math.round(performance.now() - t0), threads: WASM_THREADS, transformers: transformersVersion, contextLength });
  const encode = (text: string) => tokenizer.encode(text, { add_special_tokens: false });
  const decode = (ids: readonly number[]) => tokenizer.decode([...ids], { skip_special_tokens: true });
  const total = spec.groups.reduce((a, g) => a + g.jobs.length, 0);
  let done = 0;
  for (const group of spec.groups) {
    const p0 = performance.now();
    const prefixIds = encode(group.prefix);
    const outputs = await model.forward({ input_ids: idsTensor(prefixIds), attention_mask: ones([1, prefixIds.length]) });
    const pkv = (model as unknown as { getPastKeyValues(o: unknown, p: null): unknown }).getPastKeyValues(outputs, null);
    emit({ type: "prefix", tokens: prefixIds.length, ms: Math.round(performance.now() - p0) });
    for (const job of group.jobs) {
      const ids = [...prefixIds, ...encode(job.suffix)];
      const started = performance.now();
      const tracker = new Tracker();
      let checked = 0;
      let lineDone = false;
      let deadline = false;
      const criteria = new StoppingCriteriaList();
      criteria.push(
        new Stop(ids.length, (generated) => {
          if (performance.now() - started >= job.gen.deadlineMs) return (deadline = true);
          if (generated.length > checked) {
            const fresh = generated.slice(checked);
            checked = generated.length;
            if (tracker.feed(decode(fresh))) return (lineDone = true);
          }
          return false;
        }),
      );
      const room = contextLength - ids.length;
      const cap = job.gen.maxNewTokens > 0 ? Math.min(job.gen.maxNewTokens, room) : room;
      const output = (await model.generate({
        input_ids: idsTensor(ids),
        attention_mask: ones([1, ids.length]),
        past_key_values: pkv,
        max_new_tokens: Math.max(1, cap),
        do_sample: false,
        ...(job.gen.repetitionPenalty === null ? {} : { repetition_penalty: job.gen.repetitionPenalty }),
        ...(job.gen.noRepeatNgram === null ? {} : { no_repeat_ngram_size: job.gen.noRepeatNgram }),
        stopping_criteria: criteria,
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
