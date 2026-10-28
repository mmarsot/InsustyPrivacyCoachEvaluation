/**
 * Pure logic of the chat playground: request validation, what the model
 * receives (rendered chat-template text), finish reasons, and the extension
 * review flow through the ref's package. No model or I/O here, so it is
 * tested with a scripted runtime.
 */
import type { ModuleConfig, RedactionModule } from "../../contract/types.ts";
import type {
  FindingLike,
  Rule,
  RuntimeReportLike,
} from "../../engine/jobs.ts";
import type { TracedGeneration } from "../../modules/insusty-privacy/runtime/scripted.ts";

/** A chat turn's role. */
export type ChatRole = "system" | "user" | "assistant";
/** One chat turn. */
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

/** Free-form generation settings; `deadlineMs` is in milliseconds. */
export interface GenerationSettings {
  maxNewTokens: number;
  sample: boolean;
  temperature: number;
  topP: number;
  /** Wall-clock stop, so a runaway sample cannot hold the model forever. */
  deadlineMs: number;
}
/**
 * Greedy, 256 new tokens, one minute: what a playground request gets unless it
 * says otherwise.
 */
export const DEFAULT_SETTINGS: GenerationSettings = {
  maxNewTokens: 256,
  sample: false,
  temperature: 0.7,
  topP: 0.95,
  deadlineMs: 60_000,
};

const clamp = (value: unknown, min: number, max: number, fallback: number) => {
  const n = typeof value === "number" ? value : Number(value);
  return Number.isFinite(n) ? Math.min(max, Math.max(min, n)) : fallback;
};

/**
 * Settings from an untrusted request body: each field clamped to its range, a
 * missing or non-numeric one replaced by its default.
 */
export function normalizeSettings(input: unknown): GenerationSettings {
  const s = (input ?? {}) as Partial<Record<keyof GenerationSettings, unknown>>;
  return {
    maxNewTokens: Math.round(
      clamp(s.maxNewTokens, 1, 2048, DEFAULT_SETTINGS.maxNewTokens),
    ),
    sample: s.sample === true,
    temperature: clamp(s.temperature, 0.05, 2, DEFAULT_SETTINGS.temperature),
    topP: clamp(s.topP, 0.05, 1, DEFAULT_SETTINGS.topP),
    deadlineMs: Math.round(
      clamp(s.deadlineMs, 1_000, 300_000, DEFAULT_SETTINGS.deadlineMs),
    ),
  };
}

/**
 * Validates a conversation: an optional non-empty system message first, then
 * alternating user/assistant turns ending with a user turn.
 */
export function normalizeMessages(input: unknown): ChatMessage[] {
  if (!Array.isArray(input)) throw new Error("messages must be an array");
  const messages = input.map((m) => {
    const { role, content } = (m ?? {}) as Partial<ChatMessage>;
    if (role !== "system" && role !== "user" && role !== "assistant")
      throw new Error(`invalid role ${String(role)}`);
    if (typeof content !== "string")
      throw new Error("message content must be a string");
    return { role, content };
  });
  const turns = messages[0]?.role === "system" ? messages.slice(1) : messages;
  if (turns.some((m) => m.role === "system"))
    throw new Error("only the first message may be a system message");
  if (!turns.length || turns.at(-1)!.role !== "user")
    throw new Error("the conversation must end with a user message");
  turns.forEach((m, i) => {
    if (m.role !== (i % 2 === 0 ? "user" : "assistant"))
      throw new Error("user and assistant turns must alternate");
  });
  return messages[0]?.role === "system" && !messages[0].content.trim()
    ? turns
    : messages;
}

/** The part of a tokenizer prompt rendering needs. */
export interface TemplateTokenizer {
  hasChatTemplate: boolean;
  applyChatTemplate(
    messages: ReadonlyArray<{ role: string; content: string }>,
  ): string;
}

/** Exactly the text the model continues: chat template with the generation prompt, then the prefill. */
export function renderPrompt(
  tokenizer: TemplateTokenizer,
  messages: readonly ChatMessage[],
  prefill = "",
): string {
  if (tokenizer.hasChatTemplate)
    return tokenizer.applyChatTemplate(messages) + prefill;
  return `${messages.map((m) => `${m.role}: ${m.content}`).join("\n")}\nassistant: ${prefill}`;
}

/**
 * Why a generation stopped; `context` is what remains when no other reason
 * applies (the model's context filled).
 */
export type ChatFinishReason =
  "eos" | "max_new_tokens" | "deadline" | "context";

/**
 * Why a generation stopped: an end-of-sequence token wins over the deadline,
 * which wins over the token cap.
 */
export function chatFinishReason(o: {
  generated: readonly number[];
  eosIds: readonly number[];
  maxNewTokens: number;
  deadlineHit: boolean;
}): ChatFinishReason {
  const last = o.generated.at(-1);
  if (last !== undefined && o.eosIds.includes(last)) return "eos";
  if (o.deadlineHit) return "deadline";
  if (o.generated.length >= o.maxNewTokens) return "max_new_tokens";
  return "context";
}

// ---------------------------------------------------------------- extension review

/** The extension's custom-label name constraint (config-gateway). */
const RULE_LABEL_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

/**
 * A playground review: the custom labels and text, reviewed the way the
 * extension would review them.
 */
export interface ReviewPlaygroundRequest {
  systemInstruction: string;
  rules: Rule[];
  text: string;
}

/** Applies the extension's own rule constraints (config-gateway): uppercase label, pattern, 1000-char description, 20 rules. */
export function normalizeReviewRequest(
  input: unknown,
  defaultPrompt: string,
): ReviewPlaygroundRequest {
  const r = (input ?? {}) as Partial<ReviewPlaygroundRequest>;
  if (typeof r.text !== "string" || !r.text.trim())
    throw new Error("text to review is required");
  const seen = new Set<string>();
  const rules: Rule[] = [];
  for (const rule of Array.isArray(r.rules) ? r.rules : []) {
    const label = String(rule?.label ?? "")
      .trim()
      .toUpperCase();
    const prompt = String(rule?.prompt ?? "").trim();
    if (!label && !prompt) continue;
    if (!RULE_LABEL_PATTERN.test(label))
      throw new Error(`label "${label}" must match ${RULE_LABEL_PATTERN}`);
    if (!prompt || prompt.length > 1000)
      throw new Error(`${label}: description must be 1 to 1000 characters`);
    if (seen.has(label)) continue;
    seen.add(label);
    // Completion refs: up to three example passages (one per line in the UI).
    const rawExamples = (rule as { examples?: unknown }).examples;
    const examples = (
      Array.isArray(rawExamples)
        ? rawExamples
        : typeof rawExamples === "string"
          ? rawExamples.split("\n")
          : []
    )
      .map((e) => String(e).trim())
      .filter(Boolean)
      .slice(0, 3);
    if (examples.some((e) => e.length > 200))
      throw new Error(`${label}: each example must be at most 200 characters`);
    rules.push({ label, prompt, ...(examples.length ? { examples } : {}) });
    if (rules.length === 20) break;
  }
  const systemInstruction =
    typeof r.systemInstruction === "string" && r.systemInstruction.trim()
      ? r.systemInstruction
      : defaultPrompt;
  return { systemInstruction, rules, text: r.text };
}

/**
 * One model request of a playground review: the rendered prompt as the model
 * saw it, its token count, and the raw answer.
 */
export interface ReviewChunkTrace {
  input: string;
  rendered: string;
  promptTokens: number;
  output: string;
  runtime?: RuntimeReportLike;
  ms: number;
  error?: string;
}
/** A playground review traced through the ref's package. */
export interface ReviewTrace {
  /** The prefixes the ref's review prepared (one per label and language), joined. */
  instructions: string;
  categories: string[];
  chunks: ReviewChunkTrace[];
  findings: FindingLike[];
  /** Set when the extension skips the model (no custom label). */
  skipped?: string;
  error?: string;
}

/**
 * Runs the extension's review (the ref's package: chunking, framing, cue,
 * engine, parsing, anchoring, patterns) on `module`, whose on-device runtime
 * reports each generation to `generations` (`tracedRuntime`).
 */
export async function runPackageReview(
  module: Pick<RedactionModule, "defaultConfig" | "redact">,
  generations: TracedGeneration[],
  request: ReviewPlaygroundRequest,
  model: string,
): Promise<ReviewTrace> {
  generations.length = 0;
  const trace: ReviewTrace = {
    instructions: "",
    categories: request.rules.map((r) => r.label),
    chunks: [],
    findings: [],
  };
  const config: ModuleConfig = {
    ...module.defaultConfig(),
    customLabels: request.rules.map((r) => ({
      label: r.label,
      description: r.prompt,
      examples: [...(r.examples ?? [])],
    })),
    privateAi: { runsOn: "device", model },
  };
  try {
    const out = await module.redact(
      { kind: "text", text: request.text },
      config,
    );
    const requests = out.runtime.requests ?? [];
    const backend = out.runtime.backend;
    trace.findings = out.spans
      .filter((s) => s.kind === "custom")
      .map(({ label, start, end }) => ({
        category: label,
        start,
        end,
        value: request.text.slice(start, end),
      }));
    if (out.coverage.reason === "private_ai_unavailable")
      trace.error = out.coverage.detail ?? "Private AI review failed";
    trace.chunks = generations.map((g, i) => {
      const r = requests[i];
      return {
        input: g.prompt.slice(g.prefix.length),
        rendered: g.prompt,
        promptTokens: g.promptTokens,
        output: g.output,
        runtime: {
          backend: backend?.name ?? "",
          quantization: backend?.dtype ?? "",
          promptTokens: g.promptTokens,
          generatedTokens: g.generatedTokens,
          finishReason: r?.finishReason ?? "",
          ...(r?.confidence !== undefined
            ? { answerProbability: r.confidence }
            : {}),
        },
        ms: Math.round(g.ms),
      };
    });
    if (!trace.chunks.length && !trace.error)
      trace.skipped =
        "No custom label is configured, so the extension does not call the model.";
  } catch (error) {
    trace.error = (error as Error).message;
  }
  trace.instructions = [...new Set(generations.map((g) => g.prefix))].join(
    "\n\n",
  );
  return trace;
}
