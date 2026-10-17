/**
 * Node counterpart of the extension's `src/model-worker.ts` loader: it adapts
 * Transformers.js to the `SlmRuntimeLoader` interface that the ref's
 * `SlmEngine` expects. The adapters below mirror model-worker.ts (chat
 * template rendering, token encode/decode without special tokens, greedy
 * decoding with a per-token stop callback and, when the ref asks, per-token
 * answer probabilities, prefix KV prefill) because that file is a browser
 * worker entry point and cannot be imported.
 *
 * Runtime: `onnxruntime-node` is aliased to `onnxruntime-web` in package.json
 * (the extension does the same), so inference runs on ONNX Runtime's WASM
 * build in Node, the same kernels the extension runs in the browser. Native
 * onnxruntime-node was measured to produce different greedy output on the q8
 * weights, so it is deliberately not used.
 */
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";
import { dirname, join } from "node:path";
import { createWriteStream, existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import {
  AutoConfig,
  AutoModelForCausalLM,
  AutoTokenizer,
  env,
  LogitsProcessor,
  LogitsProcessorList,
  ones,
  StoppingCriteria,
  StoppingCriteriaList,
  Tensor,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";
import { MODEL_CACHE_DIR, ROOT } from "../paths.ts";

export const WASM_THREADS = Math.min(4, Math.max(1, availableParallelism()));

env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = false;
if (env.backends.onnx.wasm) {
  env.backends.onnx.wasm.wasmPaths = pathToFileURL(join(ROOT, "node_modules", "onnxruntime-web", "dist") + "/").href;
  env.backends.onnx.wasm.numThreads = WASM_THREADS;
}

export const transformersVersion: string = env.version;

interface GenerateOptions {
  ids: readonly number[];
  pastKeyValues?: unknown;
  prefixLength: number;
  maxLength: number;
  maxNewTokens?: number;
  /** Decoding settings the engine pins (completion refs: greedy, no repetition penalty). */
  settings?: Record<string, unknown>;
  shouldStop(generated: readonly number[]): boolean;
  /** Receives the probability of each generated token's greedy choice (refs with the answer-confidence filter). */
  onTokenProbability?(probability: number): void;
}

export const idsTensor = (ids: readonly number[]): Tensor =>
  new Tensor("int64", BigInt64Array.from(ids, (id) => BigInt(id)), [1, ids.length]);

class CallbackStoppingCriteria extends StoppingCriteria {
  constructor(
    private readonly promptLength: number,
    private readonly shouldStop: GenerateOptions["shouldStop"],
  ) {
    super();
  }
  override _call(input_ids: number[][]): boolean[] {
    return input_ids.map((sequence) =>
      this.shouldStop((sequence as (number | bigint)[]).slice(this.promptLength).map(Number)),
    );
  }
}

/** Softmax probability of the largest logit (the ref's `greedyTokenProbability`). */
function greedyTokenProbability(logits: ArrayLike<number>): number {
  let max = Number.NEGATIVE_INFINITY;
  for (let index = 0; index < logits.length; index++) max = Math.max(max, logits[index] ?? Number.NEGATIVE_INFINITY);
  let total = 0;
  for (let index = 0; index < logits.length; index++) total += Math.exp((logits[index] ?? Number.NEGATIVE_INFINITY) - max);
  return 1 / total;
}

/**
 * Like model-worker.ts's TokenProbabilityRecorder: a pass-through logits
 * processor reporting each step's greedy-token probability. It never changes
 * the logits, so decoding is unaffected; non-float32 logits record nothing.
 */
class TokenProbabilityRecorder extends LogitsProcessor {
  constructor(private readonly record: (probability: number) => void) {
    super();
  }
  override _call(_input_ids: bigint[][], logits: Tensor): Tensor {
    if (logits.type === "float32") {
      const data = logits.data as Float32Array;
      const vocabulary = logits.dims.at(-1) ?? data.length;
      this.record(greedyTokenProbability(data.subarray(data.length - vocabulary)));
    }
    return logits;
  }
}

export const eosIds = (model: PreTrainedModel): number[] => {
  const config = model.config as { eos_token_id?: unknown };
  const raw = (model as unknown as { generation_config?: { eos_token_id?: unknown } }).generation_config?.eos_token_id ?? config.eos_token_id;
  const list = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  return list.filter((id): id is number => typeof id === "number");
};

export function adaptTokenizer(tokenizer: PreTrainedTokenizer) {
  return {
    hasChatTemplate: Boolean(tokenizer.chat_template),
    applyChatTemplate: (messages: ReadonlyArray<{ role: string; content: string }>) =>
      String(tokenizer.apply_chat_template([...messages] as never, { tokenize: false, add_generation_prompt: true })),
    encode: (text: string) => tokenizer.encode(text, { add_special_tokens: false }),
    decode: (ids: readonly number[]) => tokenizer.decode([...ids], { skip_special_tokens: true }),
  };
}

export function adaptModel(model: PreTrainedModel) {
  const contextLength = (model.config as { max_position_embeddings?: unknown }).max_position_embeddings;
  if (typeof contextLength !== "number" || !(contextLength > 0))
    throw new Error("The selected model does not declare a context length.");
  return {
    contextLength,
    eosTokenIds: eosIds(model),
    async prefill(ids: readonly number[]) {
      const outputs = await model.forward({ input_ids: idsTensor(ids), attention_mask: ones([1, ids.length]) });
      return (model as unknown as { getPastKeyValues(o: unknown, p: null): unknown }).getPastKeyValues(outputs, null);
    },
    async generate(options: GenerateOptions) {
      const criteria = new StoppingCriteriaList();
      criteria.push(new CallbackStoppingCriteria(options.ids.length, options.shouldStop));
      let processors: LogitsProcessorList | undefined;
      if (options.onTokenProbability) {
        processors = new LogitsProcessorList();
        processors.push(new TokenProbabilityRecorder(options.onTokenProbability));
      }
      const parameters = {
        input_ids: idsTensor(options.ids),
        attention_mask: ones([1, options.ids.length]),
        ...(options.pastKeyValues === undefined ? {} : { past_key_values: options.pastKeyValues }),
        max_length: options.maxLength,
        max_new_tokens:
          options.maxNewTokens === undefined
            ? null
            : Math.max(1, Math.min(options.maxNewTokens, options.maxLength - options.ids.length)),
        do_sample: false,
        // Like model-worker.ts: the engine's pinned settings override the model's generation_config.
        ...(options.settings ?? {}),
        stopping_criteria: criteria,
        ...(processors ? { logits_processor: processors } : {}),
      };
      const output = (await model.generate(parameters as unknown as Parameters<PreTrainedModel["generate"]>[0])) as Tensor;
      const sequence = (output.tolist() as (number | bigint)[][])[0] ?? [];
      return sequence.slice(options.ids.length).map(Number);
    },
  };
}

/** Loaded models, so the worker can dispose them explicitly. */
const loaded: PreTrainedModel[] = [];

const DTYPE_SUFFIX: Record<string, string> = { q8: "_quantized", q4: "_q4", q4f16: "_q4f16", fp16: "_fp16", fp32: "" };

/**
 * Weights stored as an external `.onnx_data` file (newer onnx-community
 * exports). In Node, Transformers.js 3.8.1 leaves external data to
 * onnxruntime-node, which the bench aliases to onnxruntime-web, so the file
 * would never reach the session. Read it here and pass it the way the
 * browser build does (`session_options.externalData`). This is not a graph
 * optimization option: inference stays on the default session options.
 */
async function externalDataOptions(model: string, dtype: string) {
  const config = (await AutoConfig.from_pretrained(model)) as unknown as { "transformers.js_config"?: { use_external_data_format?: unknown } };
  const flag = config["transformers.js_config"]?.use_external_data_format;
  const base = `model${DTYPE_SUFFIX[dtype] ?? ""}.onnx`;
  const chunks = typeof flag === "object" && flag !== null ? Number((flag as Record<string, unknown>)[base] ?? 0) : Number(Boolean(flag));
  if (!chunks) return {};
  const externalData = [];
  for (let i = 0; i < chunks; i++) {
    const path = `${base}_data${i === 0 ? "" : `_${i}`}`;
    const file = join(MODEL_CACHE_DIR, model, "onnx", path);
    if (!existsSync(file)) await download(`${env.remoteHost}${model}/resolve/main/onnx/${path}`, file);
    externalData.push({ path, data: new Uint8Array(readFileSync(file)) });
  }
  return { use_external_data_format: false, session_options: { externalData } };
}

/** Streams a file to disk (weights can be several hundred MB; never buffered whole). */
async function download(url: string, file: string) {
  const response = await fetch(url);
  if (!response.ok || !response.body) throw new Error(`download failed (${response.status}): ${url}`);
  mkdirSync(dirname(file), { recursive: true });
  await pipeline(Readable.fromWeb(response.body as never), createWriteStream(`${file}.part`));
  renameSync(`${file}.part`, file);
}

/** Loads a tokenizer and q8/q4 model on the WASM backend. */
export async function loadPretrained(model: string, dtype: "q8" | "q4" = "q8") {
  const external = await externalDataOptions(model, dtype);
  const [tokenizer, instance] = await Promise.all([
    AutoTokenizer.from_pretrained(model),
    // "cpu" is how Transformers.js names the (aliased) onnxruntime-web WASM backend in Node.
    AutoModelForCausalLM.from_pretrained(model, { device: "cpu", dtype, ...external } as never),
  ]);
  loaded.push(instance);
  // The weights were read into JS buffers and copied into the WASM heap; those
  // buffers are garbage now but V8 keeps them for a while (about 1 GB of RSS
  // for Qwen2.5-0.5B). Workers run with --expose-gc so it is released at once.
  (globalThis as { gc?: () => void }).gc?.();
  return { tokenizer, model: instance };
}

export interface FreeGenerationOptions {
  maxNewTokens: number;
  sample: boolean;
  temperature: number;
  topP: number;
  deadlineMs: number;
}

/**
 * Free-form generation for the chat playground: optional sampling, a token
 * cap and a wall-clock deadline. Returns the new token ids and timing.
 */
export async function generateFree(model: PreTrainedModel, ids: readonly number[], options: FreeGenerationOptions) {
  const started = performance.now();
  let firstTokenMs: number | undefined;
  let deadlineHit = false;
  const criteria = new StoppingCriteriaList();
  criteria.push(
    new CallbackStoppingCriteria(ids.length, (generated) => {
      if (generated.length && firstTokenMs === undefined) firstTokenMs = performance.now() - started;
      if (performance.now() - started >= options.deadlineMs) {
        deadlineHit = true;
        return true;
      }
      return false;
    }),
  );
  const parameters = {
    input_ids: idsTensor(ids),
    attention_mask: ones([1, ids.length]),
    max_new_tokens: options.maxNewTokens,
    do_sample: options.sample,
    ...(options.sample ? { temperature: options.temperature, top_p: options.topP } : {}),
    stopping_criteria: criteria,
  };
  const output = (await model.generate(parameters as unknown as Parameters<PreTrainedModel["generate"]>[0])) as Tensor;
  const sequence = (output.tolist() as (number | bigint)[][])[0] ?? [];
  return {
    generated: sequence.slice(ids.length).map(Number),
    ms: Math.round(performance.now() - started),
    firstTokenMs: firstTokenMs === undefined ? undefined : Math.round(firstTokenMs),
    deadlineHit,
  };
}

/** `SlmRuntimeLoader` for the ref's `SlmEngine`: WASM only, no WebGPU. */
export const nodeWasmLoader = {
  async load(model: string, device: string, dtype: string) {
    if (device !== "wasm") throw new Error(`The bench only runs on WASM (asked for ${device}).`);
    const { tokenizer, model: instance } = await loadPretrained(model, dtype as "q8" | "q4");
    return { tokenizer: adaptTokenizer(tokenizer), model: adaptModel(instance) };
  },
  async probeWebGpu() {
    return { available: false, reason: "The bench runs on WASM only, for comparable CPU results." };
  },
  now: () => performance.now(),
};

export async function disposeModels(): Promise<void> {
  for (const model of loaded.splice(0)) await model.dispose();
}
