/**
 * Node counterpart of the extension's `src/model-worker.ts` loader: it adapts
 * Transformers.js to the `SlmRuntimeLoader` interface that the ref's
 * `SlmEngine` expects. The adapters below mirror model-worker.ts (chat
 * template rendering, token encode/decode without special tokens, greedy
 * decoding with a per-token stop callback, prefix KV prefill) because that
 * file is a browser worker entry point and cannot be imported.
 *
 * Runtime: `onnxruntime-node` is aliased to `onnxruntime-web` in package.json
 * (the extension does the same), so inference runs on ONNX Runtime's WASM
 * build in Node, the same kernels the extension runs in the browser. Native
 * onnxruntime-node was measured to produce different greedy output on the q8
 * weights, so it is deliberately not used.
 */
import { availableParallelism } from "node:os";
import { pathToFileURL } from "node:url";
import { join } from "node:path";
import {
  AutoModelForCausalLM,
  AutoTokenizer,
  env,
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
  shouldStop(generated: readonly number[]): boolean;
}

const idsTensor = (ids: readonly number[]): Tensor =>
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

const eosIds = (model: PreTrainedModel): number[] => {
  const config = model.config as { eos_token_id?: unknown };
  const raw = (model as unknown as { generation_config?: { eos_token_id?: unknown } }).generation_config?.eos_token_id ?? config.eos_token_id;
  const list = Array.isArray(raw) ? raw : raw === null || raw === undefined ? [] : [raw];
  return list.filter((id): id is number => typeof id === "number");
};

function adaptTokenizer(tokenizer: PreTrainedTokenizer) {
  return {
    hasChatTemplate: Boolean(tokenizer.chat_template),
    applyChatTemplate: (messages: ReadonlyArray<{ role: string; content: string }>) =>
      String(tokenizer.apply_chat_template([...messages] as never, { tokenize: false, add_generation_prompt: true })),
    encode: (text: string) => tokenizer.encode(text, { add_special_tokens: false }),
    decode: (ids: readonly number[]) => tokenizer.decode([...ids], { skip_special_tokens: true }),
  };
}

function adaptModel(model: PreTrainedModel) {
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
        stopping_criteria: criteria,
      };
      const output = (await model.generate(parameters as unknown as Parameters<PreTrainedModel["generate"]>[0])) as Tensor;
      const sequence = (output.tolist() as (number | bigint)[][])[0] ?? [];
      return sequence.slice(options.ids.length).map(Number);
    },
  };
}

/** Loaded models, so the worker can dispose them explicitly. */
const loaded: PreTrainedModel[] = [];

/** `SlmRuntimeLoader` for the ref's `SlmEngine`: WASM only, no WebGPU. */
export const nodeWasmLoader = {
  async load(model: string, device: string, dtype: string) {
    if (device !== "wasm") throw new Error(`The bench only runs on WASM (asked for ${device}).`);
    const [tokenizer, instance] = await Promise.all([
      AutoTokenizer.from_pretrained(model),
      // "cpu" is how Transformers.js names the (aliased) onnxruntime-web WASM backend in Node.
      AutoModelForCausalLM.from_pretrained(model, { device: "cpu", dtype: dtype as "q8" | "q4" }),
    ]);
    loaded.push(instance);
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
