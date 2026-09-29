/**
 * Hosted models the bench and the lab can run by name, on any provider
 * adapter (src/hosted/provider.ts), plus their cost and the budget of the
 * whole hosted evaluation. A model id is a cache key: a new framing, prompt
 * wording, endpoint or decoding setting is a new entry, never an edit.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR, RESULT_CACHE_DIR } from "../paths.ts";
import { modelSlug } from "../run/jobs.ts";
import type { BedrockTarget } from "./bedrock.ts";
import { NATIVE_SYSTEM, type Framing } from "./framing.ts";
import type { OpenAiTarget } from "./openai.ts";

interface HostedModelCommon {
  /** Model id (unique per framing; part of the cache key). */
  id: string;
  short: string;
  framing: Framing;
  /** On-demand USD per 1M tokens (0 for a local server). */
  usdPerMInput: number;
  usdPerMOutput: number;
  /** `native` framing: its system prompt, and whether the label's examples are sent. */
  nativeSystem?: string;
  nativeExamples?: boolean;
  /** Request pace (starts per minute); HOSTED_RPM (or BEDROCK_RPM for Bedrock) overrides it. */
  rpm: number;
  /** Answer cap; default the extension's 48 tokens. */
  maxTokens?: number;
  /** Stop sequences sent to the provider (the first-line cut happens in code either way). */
  stop?: string[];
  /** Ask for token log probabilities; when the reply has them, the answer confidence feeds the ref's confidence filter. */
  logprobs?: boolean;
  /** Bench: the ref's context budget in tokens (chunk size); default the ref's own. */
  contextBudget?: number;
  /** Bench estimate (s per case). */
  priorSecondsPerCase: number;
  /** A local server that loads the model in its own process (Ollama): its RSS, for the memory guard, and whether to unload it after the run. */
  localServer?: { peakRssMb: number; unloadAfterRun: boolean };
  /** Advertised French support, for the report's language table. */
  languages: { advertised: string[]; fr: string; summary: string; source: string };
}
export type BedrockModel = HostedModelCommon & BedrockTarget & { provider: "bedrock" };
export type OpenAiModel = HostedModelCommon & OpenAiTarget & { provider: "openai" };
export type HostedModel = BedrockModel | OpenAiModel;

/** Nova Micro in eu-north-1 through the EU cross-region inference profile; prices: AWS price list, EU (Stockholm), 2026-09-29. */
const NOVA_MICRO = {
  provider: "bedrock" as const,
  modelId: "eu.amazon.nova-micro-v1:0",
  region: "eu-north-1",
  usdPerMInput: 0.038,
  usdPerMOutput: 0.152,
  // This test account's hard limit is 20 requests per minute for Nova Micro.
  rpm: 18,
  // ~2.5 per-label requests per prompt at the paced 18 requests per minute.
  priorSecondsPerCase: 8.5,
  languages: {
    advertised: ["en", "fr"],
    fr: "advertised",
    summary: "Text-only Amazon Nova model; AWS lists French among the languages Nova understanding models are optimized for.",
    source: "https://docs.aws.amazon.com/nova/latest/userguide/what-is-nova.html",
  },
};

/**
 * Z.ai GLM-4.7 Flash, in-region in eu-north-1 (no geo or global profile).
 * Thinking is explicitly disabled (`thinking`, accepted by Converse; no
 * reasoning appeared even when enabled, but a reasoningContent block in a
 * response stops the run). Prices: AWS price list, EU (Stockholm), standard
 * tier, 2026-09-29. This test account allows it 100 requests per minute.
 */
const GLM_47_FLASH = {
  provider: "bedrock" as const,
  modelId: "zai.glm-4.7-flash",
  region: "eu-north-1",
  usdPerMInput: 0.08,
  usdPerMOutput: 0.48,
  additionalFields: { thinking: { type: "disabled" } },
  rpm: 90,
  // ~2.5 per-label requests per prompt at 90 requests per minute, plus latency.
  priorSecondsPerCase: 2.5,
  languages: {
    advertised: ["en", "zh"],
    fr: "not advertised",
    summary: "Z.ai GLM-4.7 Flash, a lightweight general model; its card highlights English and Chinese.",
    source: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-4-7-flash.html",
  },
};

/**
 * Local Ollama models through its OpenAI-compatible API (`OLLAMA_BASE_URL`,
 * default http://127.0.0.1:11434/v1; no key). SmolLM (v1) 360M is Q4_0 in
 * Ollama's library and SmolLM2 360M is F16 (the extension runs SmolLM2-360M
 * q8 in the browser). Both have a 2,048-token context, so the ref's default
 * budget (chunking) applies. One model at a time: each is unloaded after its
 * run (`keep_alive: 0`), and the bench waits for its RSS plus the margin.
 */
const OLLAMA_BASE_URL = process.env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434/v1";
const ollama = (model: string, family: string, peakRssMb: number) =>
  (["completion", "native-v2"] as const).map((framing): OpenAiModel => ({
    provider: "openai",
    id: `ollama/${model}#${framing}`,
    short: `ollama-${model.replace(/[:.]/g, "-")}-${framing}`,
    baseUrl: OLLAMA_BASE_URL,
    model,
    framing: framing === "completion" ? "completion" : "native",
    ...(framing === "native-v2" ? { nativeSystem: NATIVE_SYSTEM.v2, nativeExamples: true, maxTokens: 128 } : {}),
    // The design's OpenAI-compatible request: first-line stop on the server, token log probabilities.
    stop: ["\n"],
    logprobs: true,
    usdPerMInput: 0,
    usdPerMOutput: 0,
    rpm: 600,
    priorSecondsPerCase: 2,
    localServer: { peakRssMb, unloadAfterRun: true },
    languages: { advertised: ["en"], fr: "not advertised", summary: `${family}, English-only small model (Hugging Face), served by a local Ollama.`, source: "https://ollama.com/library" },
  }));

export const HOSTED_MODELS: HostedModel[] = [
  { id: "bedrock/eu.amazon.nova-micro-v1:0#prefill", short: "nova-micro-prefill", framing: "prefill", ...NOVA_MICRO },
  { id: "bedrock/eu.amazon.nova-micro-v1:0#system", short: "nova-micro-system", framing: "system", ...NOVA_MICRO },
  // Prefill with a "\nText:" stop sequence (Converse rejects a bare "\n"): Nova's answers otherwise run on into a new demonstration up to the cap.
  { id: "bedrock/eu.amazon.nova-micro-v1:0#prefill-stop", short: "nova-micro-prefill-stop", framing: "prefill", stop: ["\nText:"], ...NOVA_MICRO },
  // Several passages fit on one line; 100k tokens of 128k context: no chunking, a guard against absurd input.
  ...(["v1", "v2"] as const).flatMap((v) =>
    [true, false].map((examples): HostedModel => {
      const name = `native${v === "v1" ? "" : `-${v}`}${examples ? "" : "-noex"}`;
      return { id: `bedrock/eu.amazon.nova-micro-v1:0#${name}`, short: `nova-micro-${name}`, framing: "native", nativeSystem: NATIVE_SYSTEM[v], nativeExamples: examples, maxTokens: 128, contextBudget: 100_000, ...NOVA_MICRO };
    }),
  ),
  { id: "bedrock/zai.glm-4.7-flash#prefill", short: "glm47-flash-prefill", framing: "prefill", ...GLM_47_FLASH },
  { id: "bedrock/zai.glm-4.7-flash#system", short: "glm47-flash-system", framing: "system", ...GLM_47_FLASH },
  ...[true, false].map((examples): HostedModel => ({
    id: `bedrock/zai.glm-4.7-flash#native-v2${examples ? "" : "-noex"}`,
    short: `glm47-flash-native-v2${examples ? "" : "-noex"}`,
    framing: "native",
    nativeSystem: NATIVE_SYSTEM.v2,
    nativeExamples: examples,
    maxTokens: 128,
    contextBudget: 100_000,
    ...GLM_47_FLASH,
  })),
  // GLM-4.7 Flash through Bedrock's OpenAI-compatible endpoint (chat only; the same Bedrock API key): it returns token log probabilities, so the ref's confidence filter applies.
  {
    ...GLM_47_FLASH,
    provider: "openai",
    id: "bedrock/zai.glm-4.7-flash#oai-native-v2",
    short: "glm47-flash-oai-native-v2",
    baseUrl: `https://bedrock-runtime.${GLM_47_FLASH.region}.amazonaws.com/openai/v1`,
    model: GLM_47_FLASH.modelId,
    apiKeyEnv: "AWS_BEARER_TOKEN_BEDROCK",
    extraBody: GLM_47_FLASH.additionalFields,
    framing: "native",
    nativeSystem: NATIVE_SYSTEM.v2,
    nativeExamples: true,
    maxTokens: 128,
    contextBudget: 100_000,
    stop: ["\n"],
    logprobs: true,
  },
  ...ollama("smollm:360m", "SmolLM 360M Instruct (v1)", 700),
  ...ollama("smollm2:360m", "SmolLM2 360M Instruct", 1300),
];

export const findHostedModel = (name: string) => HOSTED_MODELS.find((m) => m.id === name || m.short === name);

/** Where the model runs, for logs and run metadata. */
export const describeTarget = (m: HostedModel) =>
  m.provider === "bedrock" ? `bedrock ${m.modelId} in ${m.region}` : `openai-compatible ${m.baseUrl} model ${m.model}`;

export const costOf = (model: Pick<HostedModel, "usdPerMInput" | "usdPerMOutput">, inputTokens: number, outputTokens: number) =>
  (inputTokens * model.usdPerMInput + outputTokens * model.usdPerMOutput) / 1e6;

/**
 * Pre-run estimate: input tokens from characters (chars / 3, conservative for
 * English and French on a ~100k-vocabulary tokenizer) plus the system/role
 * overhead, and every answer at the cap.
 */
export function estimateCost(model: HostedModel, requests: ReadonlyArray<{ chars: number }>, maxTokens: number) {
  const inputTokens = requests.reduce((a, r) => a + Math.ceil(r.chars / 3) + 20, 0);
  const outputTokens = requests.length * maxTokens;
  return { inputTokens, outputTokens, usd: costOf(model, inputTokens, outputTokens) };
}

/** Every cached hosted result's cost: lab caches (`cache/lab/*-api.jsonl`) and bench result caches of hosted models. */
export function hostedSpentUsd(): number {
  let usd = 0;
  const add = (file: string, cost: (record: Record<string, unknown>) => number) => {
    if (!existsSync(file)) return;
    for (const line of readFileSync(file, "utf8").split("\n"))
      if (line.trim())
        try {
          usd += cost(JSON.parse(line) as Record<string, unknown>);
        } catch {
          // torn line
        }
  };
  const labDir = join(CACHE_DIR, "lab");
  if (existsSync(labDir)) for (const f of readdirSync(labDir)) if (f.endsWith("-api.jsonl")) add(join(labDir, f), (r) => Number(r.costUsd ?? 0));
  const slugs = new Set(HOSTED_MODELS.map((m) => `${modelSlug(m.id)}.jsonl`));
  if (existsSync(RESULT_CACHE_DIR))
    for (const sha of readdirSync(RESULT_CACHE_DIR))
      for (const f of slugs)
        add(join(RESULT_CACHE_DIR, sha, f), (r) => ((r.chunks as Array<{ usage?: { costUsd?: number } }> | undefined) ?? []).reduce((a, c) => a + (c.usage?.costUsd ?? 0), 0));
  return usd;
}
