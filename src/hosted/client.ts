/**
 * Provider-independent hosted client: frames one review request
 * (src/hosted/framing.ts), sends it through the model's adapter
 * (src/hosted/bedrock.ts, src/hosted/openai.ts) with pacing and retries, cuts
 * the answer at its first line like the extension's first-line stop, and
 * turns token log probabilities (when the provider returns them) into the
 * extension's answer confidence.
 */
import { bedrockProvider } from "./bedrock.ts";
import { answerConfidence, firstLine, frameRequest, type NeutralRequest, type ReviewRequest } from "./framing.ts";
import { costOf, type HostedModel } from "./models.ts";
import { openAiProvider } from "./openai.ts";
import { HostedError, type ProviderAnswer } from "./provider.ts";

export interface HostedResult {
  /** First answer line (what the parser sees), or the whole text without `stopAtNewline`. */
  output: string;
  /** Full text returned by the model (before the first-line cut). */
  raw: string;
  /** Normalized stop reason (`stop`, `length`, or the provider's own). */
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  /** Wall-clock of the successful call, network included; excludes backoff waits. */
  ms: number;
  /** The provider's own latency when it reports one (Bedrock), else 0. */
  serverMs: number;
  /** Wall-clock including throttling retries and backoff. */
  totalMs: number;
  attempts: number;
  /** The extension's answer confidence (lowest answer-token probability), when the provider returned log probabilities. */
  answerProbability?: number;
}

/** Sends one neutral request through the model's adapter. */
export function sendNeutral(model: HostedModel, request: NeutralRequest, timeoutMs: number): Promise<ProviderAnswer> {
  return model.provider === "bedrock" ? bedrockProvider.send(model, request, timeoutMs) : openAiProvider.send(model, request, timeoutMs);
}

/**
 * Client-side pacing: request starts at most the model's `rpm` per minute
 * (HOSTED_RPM, or BEDROCK_RPM for Bedrock models, overrides it), within one
 * process; Nova Micro's 18 stays under this test account's hard limit of 20.
 * Backoff on HTTP 429 is only a safety net.
 */
let nextSendAt = 0;
async function pace(rpm: number) {
  const wait = nextSendAt - Date.now();
  if (wait > 0) await new Promise((r) => setTimeout(r, wait));
  nextSendAt = Math.max(Date.now(), nextSendAt) + 60_000 / rpm;
}
const rpmOf = (model: HostedModel) => Number(process.env.HOSTED_RPM ?? (model.provider === "bedrock" ? process.env.BEDROCK_RPM : undefined) ?? model.rpm);

export interface CallOptions {
  maxTokens: number;
  stopAtNewline: boolean;
  maxAttempts?: number;
  timeoutMs?: number;
}

/**
 * Sends one review request with retries (exponential backoff with jitter on
 * throttling, 5xx and network errors). With `stopAtNewline`, the answer is
 * cut at its first line like the local first-line stop.
 */
export async function reviewHosted(model: HostedModel, request: ReviewRequest, options: CallOptions): Promise<HostedResult> {
  const maxAttempts = options.maxAttempts ?? 8;
  const started = performance.now();
  const neutral = frameRequest(request, model, options.maxTokens);
  let attempts = 0;
  let r: ProviderAnswer;
  for (;;) {
    attempts++;
    await pace(rpmOf(model));
    try {
      r = await sendNeutral(model, neutral, options.timeoutMs ?? 60_000);
      break;
    } catch (error) {
      const e = error as HostedError;
      if (!(e instanceof HostedError) || !e.retryable || attempts >= maxAttempts) throw error;
      const wait = Math.min(30_000, 500 * 2 ** (attempts - 1)) * (0.5 + Math.random());
      console.error(`[${model.short}] ${e.message}; retry ${attempts}/${maxAttempts - 1} in ${(wait / 1000).toFixed(1)} s`);
      await new Promise((resolve) => setTimeout(resolve, wait));
    }
  }
  const output = options.stopAtNewline ? firstLine(r.text) : r.text;
  const confidence = answerConfidence(r.tokens, output.length, r.stopReason === "length" && output.length === r.text.length);
  return {
    output,
    raw: r.text,
    stopReason: r.stopReason,
    inputTokens: r.inputTokens,
    outputTokens: r.outputTokens,
    costUsd: costOf(model, r.inputTokens, r.outputTokens),
    ms: Math.round(r.ms),
    serverMs: r.serverMs ?? 0,
    totalMs: Math.round(performance.now() - started),
    attempts,
    ...(confidence === undefined ? {} : { answerProbability: confidence }),
  };
}

/** Unloads a local server's model after its run (Ollama `keep_alive: 0`), so two models never sit in RAM. */
export async function releaseHostedModel(model: HostedModel): Promise<void> {
  if (model.provider !== "openai" || !model.localServer?.unloadAfterRun) return;
  const root = model.baseUrl.replace(/\/v1\/?$/u, "");
  try {
    await fetch(`${root}/api/generate`, { method: "POST", body: JSON.stringify({ model: model.model, keep_alive: 0 }), signal: AbortSignal.timeout(30_000) });
  } catch (error) {
    console.error(`[${model.short}] could not unload the model: ${(error as Error).message}`);
  }
}

export { HostedError };
