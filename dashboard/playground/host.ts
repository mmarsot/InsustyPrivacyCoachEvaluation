/**
 * Child process that holds ONE playground model. The dashboard forks it on
 * "load" and kills it on unload or model switch, so the operating system
 * reclaims the whole WASM heap (it cannot shrink inside a process).
 * Reviews run the ref's package on the loaded weights, through a traced
 * runtime that reports what each request sent the model.
 * Protocol: IPC messages {id, type, ...} -> {id, ok, result | error}.
 */
import type { RedactionModule } from "../../contract/types.ts";
import { importPackage } from "../../modules/insusty-privacy/insusty.ts";
import {
  tracedRuntime,
  type TracedGeneration,
} from "../../modules/insusty-privacy/runtime/scripted.ts";
import {
  adaptModel,
  adaptTokenizer,
  eosIds,
  generateFree,
  loadPretrained,
  transformersVersion,
  WASM_THREADS,
} from "../../modules/insusty-privacy/runtime/transformers-loader.ts";
import {
  chatFinishReason,
  normalizeMessages,
  normalizeReviewRequest,
  normalizeSettings,
  renderPrompt,
  runPackageReview,
} from "./logic.ts";

type Loaded = Awaited<ReturnType<typeof loadPretrained>> & {
  modelId: string;
  /** The ref's module, its on-device runtime on these weights. */
  module: RedactionModule;
  /** What the traced runtime recorded during the current review. */
  generations: TracedGeneration[];
  adapted: ReturnType<typeof adaptTokenizer>;
  contextLength: number;
  eos: number[];
};
let loaded: Loaded | undefined;

const reply = (
  id: number,
  body: { ok: true; result: unknown } | { ok: false; error: string },
) => process.send?.({ id, ...body });

/**
 * Runs one message from the parent: load a model (the ref's engine reuses its
 * weights), chat, or review.
 */
async function handle(msg: Record<string, unknown>): Promise<unknown> {
  if (msg.type === "load") {
    const started = performance.now();
    const modelId = String(msg.model);
    const { createContractModule } = await importPackage({
      entry: String(msg.entry),
    });
    const { tokenizer, model } = await loadPretrained(modelId, "q8");
    const adapted = adaptTokenizer(tokenizer);
    const adaptedModel = adaptModel(model);
    const generations: TracedGeneration[] = [];
    // The ref's engine reuses these weights: no second copy is loaded.
    const runtime = {
      loader: {
        load: async (_model: string, device: string, dtype: string) => {
          if (device !== "wasm" || dtype !== "q8")
            throw new Error(
              `The playground holds only WASM q8 weights (asked for ${device} ${dtype}).`,
            );
          return { tokenizer: adapted, model: adaptedModel };
        },
        probeWebGpu: async () => ({ available: false, reason: "WASM only" }),
        now: () => performance.now(),
      },
      threads: WASM_THREADS,
    };
    const module: RedactionModule = createContractModule({
      device: async () =>
        tracedRuntime(runtime, (g) => void generations.push(g)),
    });
    loaded = {
      tokenizer,
      model,
      modelId,
      module,
      generations,
      adapted,
      contextLength: adaptedModel.contextLength,
      eos: eosIds(model),
    };
    return {
      model: modelId,
      loadMs: Math.round(performance.now() - started),
      contextLength: loaded.contextLength,
      eosTokenIds: loaded.eos,
      hasChatTemplate: adapted.hasChatTemplate,
      transformers: transformersVersion,
      threads: WASM_THREADS,
    };
  }
  if (!loaded) throw new Error("no model loaded");
  const { adapted, contextLength } = loaded;
  if (msg.type === "chat") {
    const messages = normalizeMessages(msg.messages);
    const settings = normalizeSettings(msg.settings);
    const prefill = typeof msg.prefill === "string" ? msg.prefill : "";
    const rendered = renderPrompt(adapted, messages, prefill);
    const ids = adapted.encode(rendered);
    if (ids.length >= contextLength)
      throw new Error(
        `The prompt uses ${ids.length} tokens; the model context is ${contextLength}.`,
      );
    const maxNewTokens = Math.min(
      settings.maxNewTokens,
      contextLength - ids.length,
    );
    const result = await generateFree(loaded.model, ids, {
      ...settings,
      maxNewTokens,
    });
    return {
      rendered,
      promptTokens: ids.length,
      output: adapted.decode(result.generated),
      outputWithSpecialTokens: loaded.tokenizer.decode(result.generated, {
        skip_special_tokens: false,
      }),
      generatedTokens: result.generated.length,
      finishReason: chatFinishReason({
        generated: result.generated,
        eosIds: loaded.eos,
        maxNewTokens,
        deadlineHit: result.deadlineHit,
      }),
      ms: result.ms,
      firstTokenMs: result.firstTokenMs,
      settings: { ...settings, maxNewTokens },
    };
  }
  if (msg.type === "review") {
    const request = normalizeReviewRequest(msg.request, "");
    return runPackageReview(
      loaded.module,
      loaded.generations,
      request,
      loaded.modelId,
    );
  }
  throw new Error(`unknown request ${String(msg.type)}`);
}

// One request at a time: the manager enforces it, this queue is a safety net.
let queue: Promise<void> = Promise.resolve();
process.on("message", (msg: Record<string, unknown>) => {
  const id = Number(msg.id);
  queue = queue.then(() =>
    handle(msg).then(
      (result) => void reply(id, { ok: true, result }),
      (error: unknown) =>
        void reply(id, {
          ok: false,
          error: error instanceof Error ? error.message : String(error),
        }),
    ),
  );
});
process.on("disconnect", () => process.exit(0));
