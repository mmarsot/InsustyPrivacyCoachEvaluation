/**
 * Amazon Bedrock adapter (Converse API over `fetch`, no SDK) for the
 * provider-neutral hosted interface (src/hosted/provider.ts).
 *
 * Decoding is greedy (temperature 0, topK 1). Converse rejects "\n" as a
 * stop sequence ("blank"), so blank stop sequences are dropped and the
 * first-line cut happens in the client (src/hosted/client.ts): the model may
 * write past the first line up to the cap, which counts in output tokens and
 * latency. Converse returns no token probabilities.
 *
 * Auth: a Bedrock API key in AWS_BEARER_TOKEN_BEDROCK, sent as a bearer token.
 * It is read from the environment only and never logged or stored.
 */
import type { NeutralRequest } from "./framing.ts";
import { HostedError, postJson, type HostedProvider } from "./provider.ts";

export interface BedrockTarget {
  /** Bedrock model or inference-profile id. */
  modelId: string;
  region: string;
  /** Model-specific Converse fields merged into `additionalModelRequestFields` (e.g. GLM's thinking switch). */
  additionalFields?: Record<string, unknown>;
}

interface Message {
  role: "user" | "assistant";
  content: Array<{ text: string }>;
}
export interface ConverseBody {
  system?: Array<{ text: string }>;
  messages: Message[];
  inferenceConfig: { maxTokens: number; temperature: number; stopSequences?: string[] };
  additionalModelRequestFields: { inferenceConfig: { topK: number } } & Record<string, unknown>;
}

/** Converse request body for one neutral request. Raw completions do not exist on Converse. */
export function converseBody(request: NeutralRequest, target: Pick<BedrockTarget, "additionalFields">): ConverseBody {
  if (request.kind !== "chat") throw new HostedError("Bedrock Converse has no raw completion: use a chat framing (prefill, system, native)", 0, false);
  const stopSequences = (request.stop ?? []).filter((s) => s.trim());
  return {
    ...(request.system !== undefined ? { system: [{ text: request.system }] } : {}),
    messages: request.messages.map((m) => ({ role: m.role, content: [{ text: m.content }] })),
    inferenceConfig: { maxTokens: request.maxTokens, temperature: 0, ...(stopSequences.length ? { stopSequences } : {}) },
    additionalModelRequestFields: { inferenceConfig: { topK: 1 }, ...target.additionalFields },
  };
}

interface ConverseResponse {
  output?: { message?: { content?: Array<{ text?: string; reasoningContent?: unknown }> } };
  stopReason?: string;
  usage?: { inputTokens?: number; outputTokens?: number };
  metrics?: { latencyMs?: number };
}

const token = () => {
  const t = process.env.AWS_BEARER_TOKEN_BEDROCK;
  if (!t) throw new HostedError("AWS_BEARER_TOKEN_BEDROCK is not set", 0, false);
  return t;
};

export const bedrockProvider: HostedProvider<BedrockTarget> = {
  async send(target, request, timeoutMs) {
    const url = `https://bedrock-runtime.${target.region}.amazonaws.com/model/${encodeURIComponent(target.modelId)}/converse`;
    const { json, ms } = await postJson(url, { authorization: `Bearer ${token()}` }, converseBody(request, target), timeoutMs, (res) => (res.headers.get("x-amzn-errortype") ?? "").split(":")[0]!);
    const r = json as ConverseResponse;
    const content = r.output?.message?.content ?? [];
    // Reasoning must stay off: its tokens are billed and change what is measured.
    if (content.some((c) => c.reasoningContent !== undefined)) throw new HostedError(`${target.modelId}: the response has a reasoningContent block although reasoning is disabled`, 200, false);
    const stop = r.stopReason ?? "";
    return {
      text: content.map((c) => c.text ?? "").join(""),
      stopReason: stop === "max_tokens" ? "length" : stop === "end_turn" || stop === "stop_sequence" ? "stop" : stop,
      inputTokens: r.usage?.inputTokens ?? 0,
      outputTokens: r.usage?.outputTokens ?? 0,
      serverMs: r.metrics?.latencyMs ?? 0,
      ms,
    };
  },
};
