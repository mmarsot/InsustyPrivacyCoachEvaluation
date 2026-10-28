/**
 * A scripted on-device runtime: the package's `DeviceRuntime` with no
 * weights. Its tokenizer gives one id per Unicode code point (so ids decode
 * back to the exact text), and its model answers each request from a
 * script, one token at a time, consulting the ref's stop rule after each
 * token like a real generation. It records what the ref's engine hands the
 * model: every prepared instruction prefix and every full prompt.
 *
 * This is the boundary the bench mocks when it needs the ref's own prompts
 * or wants to replay recorded answers (request parity, the components
 * replay, the instructions a scorer checks echoes against): the ref's
 * review, engine and parsing all run as shipped, only the model is scripted.
 * Completion framing has no chat template, so nothing else is rendered.
 */
import type { DeviceRuntime } from "insusty-prompt-coach/redaction";

/** One generation the ref's engine asked for. */
export interface ScriptedRequest {
  /** The prepared prefix (the label's instructions). */
  prefix: string;
  /** Everything after the prefix: the framed text and the answer cue. */
  suffix: string;
}

/** What the scripted model answers to one request. */
export interface ScriptedAnswer {
  /** The text the model writes after the cue. */
  output: string;
  /** Reported for every token, so the ref's answer confidence equals it; none: no confidence. */
  probability?: number;
}

/** A scripted runtime and what the ref's engine sent it. */
export interface ScriptedRuntime {
  runtime: DeviceRuntime;
  /** Every prefix the engine prepared, in order. */
  prefixes: string[];
  /** Every generation, in order. */
  requests: ScriptedRequest[];
}

type Loaded = Awaited<ReturnType<DeviceRuntime["loader"]["load"]>>;

/** One generation of a traced runtime: what the model read and wrote. */
export interface TracedGeneration {
  /** The prepared prefix the prompt starts with (the label's instructions), decoded. */
  prefix: string;
  /** The whole prompt, decoded: the prepared prefix, the framed text and the cue. */
  prompt: string;
  promptTokens: number;
  output: string;
  generatedTokens: number;
  ms: number;
}

/**
 * `runtime` with every generation reported to `record` (the playground shows
 * what the ref's review sent the model); decoding is unaffected.
 */
export function tracedRuntime(
  runtime: DeviceRuntime,
  record: (generation: TracedGeneration) => void,
): DeviceRuntime {
  const trace = ({ tokenizer, model }: Loaded): Loaded => ({
    tokenizer,
    model: {
      get contextLength() {
        return model.contextLength;
      },
      eosTokenIds: model.eosTokenIds,
      prefill: (ids) => model.prefill(ids),
      async generate(options) {
        const started = performance.now();
        const generated = await model.generate(options);
        record({
          prefix: tokenizer.decode(options.ids.slice(0, options.prefixLength)),
          prompt: tokenizer.decode(options.ids),
          promptTokens: options.ids.length,
          output: tokenizer.decode(generated),
          generatedTokens: generated.length,
          ms: performance.now() - started,
        });
        return generated;
      },
      ...(model.dispose ? { dispose: () => model.dispose!() } : {}),
    },
  });
  return {
    ...runtime,
    loader: {
      load: async (...args) => trace(await runtime.loader.load(...args)),
      probeWebGpu: () => runtime.loader.probeWebGpu(),
      now: () => runtime.loader.now(),
    },
  };
}

/** One past the last code point: never a character, so it can end an answer. */
const EOS = 0x110000;
const encode = (text: string): number[] =>
  Array.from(text, (char) => char.codePointAt(0)!);
const decode = (ids: readonly number[]): string =>
  String.fromCodePoint(...ids.filter((id) => id !== EOS));

/**
 * A runtime whose model answers `answer(request)` (NONE by default). The
 * model's context is unbounded, so the ref's own character budgets alone
 * decide how a text is split.
 */
export function scriptedRuntime(
  answer: (request: ScriptedRequest) => ScriptedAnswer | string = () => " NONE",
): ScriptedRuntime {
  const prefixes: string[] = [];
  const requests: ScriptedRequest[] = [];
  const tokenizer = {
    hasChatTemplate: false,
    applyChatTemplate(): string {
      throw new Error("The scripted runtime has no chat template.");
    },
    encode,
    decode,
  };
  const model = {
    contextLength: Number.MAX_SAFE_INTEGER,
    eosTokenIds: [EOS],
    async prefill(ids: readonly number[]) {
      prefixes.push(decode(ids));
      return { length: ids.length };
    },
    async generate(options: {
      ids: readonly number[];
      prefixLength: number;
      maxNewTokens?: number;
      shouldStop(generated: readonly number[]): boolean;
      onTokenProbability?(probability: number): void;
    }): Promise<number[]> {
      const request: ScriptedRequest = {
        prefix: decode(options.ids.slice(0, options.prefixLength)),
        suffix: decode(options.ids.slice(options.prefixLength)),
      };
      requests.push(request);
      const scripted = answer(request);
      const { output, probability } =
        typeof scripted === "string" ? { output: scripted } : scripted;
      const generated: number[] = [];
      for (const id of [...encode(output), EOS]) {
        if (probability !== undefined)
          options.onTokenProbability?.(probability);
        generated.push(id);
        if (id === EOS || generated.length === options.maxNewTokens) break;
        if (options.shouldStop(generated)) break;
      }
      return generated;
    },
  };
  return {
    runtime: {
      loader: {
        load: async () => ({ tokenizer, model }),
        probeWebGpu: async () => ({
          available: false,
          reason: "The scripted runtime has no GPU.",
        }),
        now: () => performance.now(),
      },
    },
    prefixes,
    requests,
  };
}
