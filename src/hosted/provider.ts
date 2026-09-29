/**
 * The provider-neutral hosted-model interface: send one framed review
 * request (src/hosted/framing.ts), get the answer text, token usage, latency
 * and, where the provider returns them, the answer tokens' log probabilities.
 * Adapters: Amazon Bedrock Converse (src/hosted/bedrock.ts) and any
 * OpenAI-compatible server, `/v1/chat/completions` or `/v1/completions`
 * (src/hosted/openai.ts). Pacing, retries, the first-line cut and the answer
 * confidence are provider-independent (src/hosted/client.ts).
 */
import type { NeutralRequest } from "./framing.ts";

export interface ProviderAnswer {
  /** Everything the model returned (the client cuts it at its first line). */
  text: string;
  /** Normalized stop reason: `stop` (end of sequence or a stop sequence), `length` (the token cap), else the provider's own value. */
  stopReason: string;
  inputTokens: number;
  outputTokens: number;
  /** Wall-clock of this call, network included. */
  ms: number;
  /** The provider's own latency, when it reports one (Bedrock `metrics.latencyMs`). */
  serverMs?: number;
  /** Returned tokens with their log probabilities, when the provider gives them. */
  tokens?: Array<{ text: string; logprob: number }>;
}

/** One adapter: a stateless sender for one provider type. */
export interface HostedProvider<Target> {
  /** Sends one request to `target` (model, endpoint, credentials); throws HostedError. */
  send(target: Target, request: NeutralRequest, timeoutMs: number): Promise<ProviderAnswer>;
}

export class HostedError extends Error {
  constructor(message: string, readonly status: number, readonly retryable: boolean) {
    super(message);
  }
}

/** POSTs JSON and parses the JSON reply; HTTP errors become HostedError (retryable for 429, 5xx and network errors). */
export async function postJson(url: string, headers: Record<string, string>, body: unknown, timeoutMs: number, errorType?: (res: Response) => string): Promise<{ json: unknown; ms: number }> {
  const t0 = performance.now();
  let res: Response;
  try {
    res = await fetch(url, { method: "POST", headers: { "content-type": "application/json", accept: "application/json", ...headers }, body: JSON.stringify(body), signal: AbortSignal.timeout(timeoutMs) });
  } catch (error) {
    throw new HostedError(`network: ${(error as Error).message}`, 0, true);
  }
  const text = await res.text();
  const ms = performance.now() - t0;
  if (!res.ok) {
    let message = text.slice(0, 300);
    try {
      const j = JSON.parse(text) as { message?: string; Message?: string; error?: { message?: string } | string };
      message = j.message ?? j.Message ?? (typeof j.error === "string" ? j.error : j.error?.message) ?? message;
    } catch {
      // not JSON
    }
    const type = errorType?.(res) ?? "";
    throw new HostedError(`HTTP ${res.status}${type ? ` ${type}` : ""}: ${message}`, res.status, res.status === 429 || res.status >= 500 || /Throttl/i.test(type));
  }
  try {
    return { json: JSON.parse(text) as unknown, ms };
  } catch {
    throw new HostedError(`not JSON: ${text.slice(0, 200)}`, res.status, false);
  }
}
