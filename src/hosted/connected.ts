/**
 * Connected models of the Private AI track: Trusted AI connections as a user
 * sets them up in the extension, run through the ref's own connected-model
 * client (`createHostedModelClient`, `src/module/insusty.ts`). The ref
 * builds every request, paces it, retries it and parses the answer; the
 * bench supplies only the transport, which adds what a measurement needs:
 *
 * - a disk cache of replies keyed by the exact request (`cache/hosted/`),
 *   so a rerun sends nothing new and costs nothing;
 * - cost per reply from the provider's token usage and the model's on-demand
 *   prices, and the `--budget-usd` cap over every cached hosted spend
 *   (`hostedSpentUsd`);
 * - the key, read from the environment only (never printed, logged or
 *   stored).
 *
 * A connection field (format, time limit, pace) is part of the model id:
 * change one and add a new entry, never edit one (results are cached by id).
 * These are paid paths that leave the device: every report marks them
 * "connected" with their cost.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { ConnectedTarget } from "../module/insusty.ts";
import { CACHE_DIR } from "../paths.ts";

export interface ConnectedModel {
  /** Model id (part of every cache key). */
  id: string;
  short: string;
  /** The extension's `TrustedConnection`. */
  connection: {
    provider: "bedrock" | "openai-compatible";
    region?: string;
    baseUrl?: string;
    model: string;
    displayName: string;
    format: "auto" | "answer-cue" | "system";
    timeLimitMs: number;
    maxRequestsPerMinute: number | null;
  };
  apiKeyEnv: string;
  /** On-demand USD per 1M tokens. */
  usdPerMInput: number;
  usdPerMOutput: number;
  /** Bench estimate (s per case). */
  priorSecondsPerCase: number;
  languages: { advertised: string[]; fr: string; summary: string; source: string };
}

/**
 * GLM-4.7 Flash on Bedrock in eu-north-1 (in-region; this test account allows
 * it 100 requests per minute), with the extension's defaults: `auto` format
 * (the native task prompt for GLM) and the default 15 s time limit. Prices:
 * AWS price list, EU (Stockholm), standard tier, 2026-09-29.
 */
export const CONNECTED_MODELS: ConnectedModel[] = [
  {
    id: "connected/bedrock/zai.glm-4.7-flash#auto-15s",
    short: "glm47-flash-connected",
    connection: { provider: "bedrock", region: "eu-north-1", model: "zai.glm-4.7-flash", displayName: "GLM-4.7 Flash", format: "auto", timeLimitMs: 15_000, maxRequestsPerMinute: 90 },
    apiKeyEnv: "AWS_BEARER_TOKEN_BEDROCK",
    usdPerMInput: 0.08,
    usdPerMOutput: 0.48,
    priorSecondsPerCase: 2.5,
    languages: {
      advertised: ["en", "zh"],
      fr: "not advertised",
      summary: "Z.ai GLM-4.7 Flash, a lightweight general model; its card highlights English and Chinese.",
      source: "https://docs.aws.amazon.com/bedrock/latest/userguide/model-card-zai-glm-4-7-flash.html",
    },
  },
];

export const findConnectedModel = (name: string) => CONNECTED_MODELS.find((m) => m.id === name || m.short === name);

export const CONNECTED_CACHE_DIR = join(CACHE_DIR, "hosted");
/** Set on replies served from the cache (they cost nothing now). */
const CACHE_HEADER = "x-bench-cache";
const slug = (id: string) => id.replace(/[^\w.-]+/g, "_");
export const connectedCacheFile = (m: Pick<ConnectedModel, "id">) => join(CONNECTED_CACHE_DIR, `${slug(m.id)}.jsonl`);

interface CachedReply {
  key: string;
  status: number;
  body: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  at: string;
}

const readCache = (file: string): Map<string, CachedReply> => {
  const out = new Map<string, CachedReply>();
  if (!existsSync(file)) return out;
  for (const line of readFileSync(file, "utf8").split("\n"))
    if (line.trim())
      try {
        const r = JSON.parse(line) as CachedReply;
        out.set(r.key, r);
      } catch {
        // torn line
      }
  return out;
};

/** USD of every reply cached for the connected models (each paid request counts once). */
export function connectedSpentUsd(): number {
  let usd = 0;
  for (const m of CONNECTED_MODELS) for (const r of readCache(connectedCacheFile(m)).values()) usd += r.costUsd;
  return usd;
}

/** Token usage of a provider reply (Bedrock Converse `usage`, OpenAI `usage`). */
function tokensOf(json: unknown): { inputTokens: number; outputTokens: number } | undefined {
  const u = (json as { usage?: Record<string, number> } | undefined)?.usage;
  if (!u) return undefined;
  return { inputTokens: u.inputTokens ?? u.prompt_tokens ?? 0, outputTokens: u.outputTokens ?? u.completion_tokens ?? 0 };
}

/**
 * The transport for one connected model. `spentUsd` returns the hosted spend
 * so far (cached included); an uncached request is refused once it reaches
 * `budgetUsd`.
 */
export function connectedTarget(m: ConnectedModel, budget: { budgetUsd: number; spentUsd: () => number }): ConnectedTarget {
  const file = connectedCacheFile(m);
  const cache = readCache(file);
  const costOf = (t: { inputTokens: number; outputTokens: number }) => (t.inputTokens * m.usdPerMInput + t.outputTokens * m.usdPerMOutput) / 1e6;
  const transport: typeof fetch = async (input, init) => {
    const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url;
    const key = createHash("sha256").update(JSON.stringify([m.id, url, init?.body ?? ""])).digest("hex");
    const hit = cache.get(key);
    if (hit) return new Response(hit.body, { status: hit.status, headers: { "content-type": "application/json", [CACHE_HEADER]: "hit" } });
    if (budget.spentUsd() >= budget.budgetUsd) throw new Error(`hosted budget of ${budget.budgetUsd} USD reached; nothing was sent`);
    const response = await fetch(input, init);
    const body = await response.text();
    if (response.ok) {
      const tokens = tokensOf(JSON.parse(body) as unknown) ?? { inputTokens: 0, outputTokens: 0 };
      const record: CachedReply = { key, status: response.status, body, ...tokens, costUsd: costOf(tokens), at: new Date().toISOString() };
      cache.set(key, record);
      mkdirSync(CONNECTED_CACHE_DIR, { recursive: true });
      appendFileSync(file, JSON.stringify(record) + "\n");
    }
    return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
  };
  const apiKey = process.env[m.apiKeyEnv];
  return {
    id: m.id,
    connection: m.connection,
    ...(apiKey ? { apiKey } : {}),
    fetch: transport,
    usage(json, response) {
      const tokens = tokensOf(json);
      if (!tokens) return undefined;
      const cached = response.headers.get(CACHE_HEADER) === "hit";
      return { ...tokens, usd: cached ? 0 : costOf(tokens), ...(cached ? { cached: true } : {}) };
    },
  };
}
