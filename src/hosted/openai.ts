/**
 * OpenAI-compatible adapter for the provider-neutral hosted interface
 * (src/hosted/provider.ts): OpenAI, Ollama, LM Studio, vLLM, llama.cpp
 * server and hosted gateways that speak the same API.
 *
 *   - chat requests go to `{baseUrl}/chat/completions` (`messages`, with the
 *     system prompt as a `system` message; a trailing assistant message is an
 *     answer prefill, which only some servers honour);
 *   - completion requests go to `{baseUrl}/completions` (`prompt`).
 *
 * Decoding is temperature 0. With `logprobs`, chat asks for `logprobs: true`
 * and completions for `logprobs: 1`; both reply shapes are read, and a
 * server that ignores the field simply returns none (Ollama 0.34 returns
 * them for chat only). Ollama's `/v1/completions` also wraps the prompt in
 * the model's chat template: it is not a raw completion (`/api/generate`
 * with `raw` is). Bedrock's OpenAI-compatible endpoint serves chat only (no
 * `/completions`) for its open-weight models, with log probabilities.
 *
 * Auth: optional; the key is read from the environment variable the model
 * entry names (`apiKeyEnv`) and sent as a bearer token, never logged.
 */
import type { NeutralRequest } from "./framing.ts";
import { HostedError, postJson, type HostedProvider } from "./provider.ts";

export interface OpenAiTarget {
  /** API root including the version, e.g. `http://127.0.0.1:11434/v1` or `https://api.openai.com/v1`. */
  baseUrl: string;
  /** The server's model name. */
  model: string;
  /** Environment variable holding the API key; none sends no Authorization header. */
  apiKeyEnv?: string;
  /** Server-specific body fields (e.g. GLM's thinking switch). */
  extraBody?: Record<string, unknown>;
}

export interface OpenAiBody {
  model: string;
  messages?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  prompt?: string;
  max_tokens: number;
  temperature: number;
  stop?: string[];
  logprobs?: boolean | number;
}

/** Endpoint path and body for one neutral request. */
export function openAiRequest(request: NeutralRequest, target: Pick<OpenAiTarget, "model" | "extraBody">): { path: "/chat/completions" | "/completions"; body: OpenAiBody } {
  const common = { max_tokens: request.maxTokens, temperature: 0, ...(request.stop?.length ? { stop: request.stop } : {}), ...target.extraBody };
  if (request.kind === "completion")
    return { path: "/completions", body: { model: target.model, prompt: request.prompt, ...common, ...(request.logprobs ? { logprobs: 1 } : {}) } };
  const messages = [...(request.system !== undefined ? [{ role: "system" as const, content: request.system }] : []), ...request.messages];
  return { path: "/chat/completions", body: { model: target.model, messages, ...common, ...(request.logprobs ? { logprobs: true } : {}) } };
}

interface OpenAiResponse {
  choices?: Array<{
    text?: string;
    message?: { content?: string | null; reasoning_content?: string | null; reasoning?: string | null };
    finish_reason?: string | null;
    logprobs?: { content?: Array<{ token: string; logprob: number }> | null; tokens?: string[]; token_logprobs?: Array<number | null> } | null;
  }>;
  usage?: { prompt_tokens?: number; completion_tokens?: number };
}

/** Tokens with log probabilities from a chat (`content[]`) or completions (`tokens` + `token_logprobs`) reply. */
export function replyTokens(logprobs: NonNullable<NonNullable<OpenAiResponse["choices"]>[number]["logprobs"]> | undefined): Array<{ text: string; logprob: number }> | undefined {
  if (!logprobs) return undefined;
  const tokens = logprobs.content
    ? logprobs.content.map((t) => ({ text: t.token, logprob: t.logprob }))
    : (logprobs.tokens ?? []).map((text, i) => ({ text, logprob: logprobs.token_logprobs?.[i] ?? Number.NaN }));
  const valid = tokens.filter((t) => Number.isFinite(t.logprob));
  return valid.length ? valid : undefined;
}

export const openAiProvider: HostedProvider<OpenAiTarget> = {
  async send(target, request, timeoutMs) {
    let headers: Record<string, string> = {};
    if (target.apiKeyEnv) {
      const key = process.env[target.apiKeyEnv];
      if (!key) throw new HostedError(`${target.apiKeyEnv} is not set`, 0, false);
      headers = { authorization: `Bearer ${key}` };
    }
    const { path, body } = openAiRequest(request, target);
    const { json, ms } = await postJson(`${target.baseUrl.replace(/\/+$/u, "")}${path}`, headers, body, timeoutMs);
    const r = json as OpenAiResponse;
    const choice = r.choices?.[0];
    if (!choice) throw new HostedError(`${target.model}: the reply has no choices`, 200, false);
    // Reasoning must stay off: its tokens are billed and change what is measured.
    if (choice.message?.reasoning_content || choice.message?.reasoning) throw new HostedError(`${target.model}: the reply has reasoning output although the review asks for none`, 200, false);
    const finish = choice.finish_reason ?? "";
    const tokens = replyTokens(choice.logprobs ?? undefined);
    return {
      text: (path === "/completions" ? choice.text : choice.message?.content) ?? "",
      stopReason: finish === "length" ? "length" : finish === "stop" ? "stop" : finish,
      inputTokens: r.usage?.prompt_tokens ?? 0,
      outputTokens: r.usage?.completion_tokens ?? 0,
      ms,
      ...(tokens ? { tokens } : {}),
    };
  },
};
