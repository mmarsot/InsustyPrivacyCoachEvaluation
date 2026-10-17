/**
 * Pure logic of the chat playground: request validation, what the model
 * receives (rendered chat-template text), finish reasons, and the exact
 * extension review flow. No model or I/O here, so it is unit-tested with fakes.
 */
import type {
  ExtApi,
  FindingLike,
  ReviewRequestLike,
  Rule,
  RuntimeReportLike,
} from "../ext/ref.ts";

export type ChatRole = "system" | "user" | "assistant";
export interface ChatMessage {
  role: ChatRole;
  content: string;
}

export interface GenerationSettings {
  maxNewTokens: number;
  sample: boolean;
  temperature: number;
  topP: number;
  /** Wall-clock stop, so a runaway sample cannot hold the model forever. */
  deadlineMs: number;
}
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

export interface TemplateTokenizer {
  hasChatTemplate: boolean;
  applyChatTemplate(
    messages: ReadonlyArray<{ role: string; content: string }>,
  ): string;
}
export interface EncodingTokenizer extends TemplateTokenizer {
  encode(text: string): number[];
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

const CONTENT_MARKER = "\u0000PLAYGROUND_CONTENT\u0000";

/**
 * The text the extension's engine feeds the model for one review request,
 * framed like `SlmEngine` (slm-generation.ts): the chat template split around
 * the user turn (system = instructions, user = framed chunk), or the plain
 * framing without a template, then the reply prefill. The engine tokenizes
 * the instruction prefix and the rest separately, so the count does too.
 */
export function renderReviewPrompt(
  tokenizer: EncodingTokenizer,
  request: ReviewRequestLike,
  framing: "chat" | "completion" = "chat",
): { rendered: string; promptTokens: number } {
  let prefix = `${request.instructions}\n\nInput:\n`;
  let suffix = "\n\n";
  // Completion refs send the instructions as the whole prefix, no template.
  if (framing === "completion") {
    prefix = request.instructions;
    suffix = "";
  } else if (tokenizer.hasChatTemplate) {
    const templated = tokenizer.applyChatTemplate([
      { role: "system", content: request.instructions },
      { role: "user", content: CONTENT_MARKER },
    ]);
    const at = templated.indexOf(CONTENT_MARKER);
    if (at < 0)
      throw new Error("The chat template did not place the request content.");
    prefix = templated.slice(0, at);
    suffix = templated.slice(at + CONTENT_MARKER.length);
  }
  const rest = `${request.input}${suffix}${request.responsePrefill ?? ""}`;
  return {
    rendered: prefix + rest,
    promptTokens:
      tokenizer.encode(prefix).length + tokenizer.encode(rest).length,
  };
}

export type ChatFinishReason =
  "eos" | "max_new_tokens" | "deadline" | "context";

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

const RULE_LABEL_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;

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

export interface ReviewChunkTrace {
  input: string;
  rendered: string;
  promptTokens: number;
  output: string;
  runtime?: RuntimeReportLike;
  ms: number;
  error?: string;
}
export interface ReviewTrace {
  instructions: string;
  categories: string[];
  chunks: ReviewChunkTrace[];
  findings: FindingLike[];
  /** Set when the extension skips the model (no custom label and nothing deterministic). */
  skipped?: string;
  error?: string;
}

type ReviewApi = Pick<
  ExtApi,
  "composeReviewInstructions" | "reviewCategories" | "runReview"
>;

/**
 * Runs the extension's own `reviewPrompt` (chunking, framing, prefill,
 * parsing, anchoring) against a model, recording what each request sends and
 * returns. `review` performs one engine request; `render` shows its input.
 */
export async function runExtensionReview(
  api: ReviewApi,
  review: (
    request: ReviewRequestLike,
  ) => Promise<{ output: string; runtime?: RuntimeReportLike }>,
  render: (request: ReviewRequestLike) => {
    rendered: string;
    promptTokens: number;
  },
  request: ReviewPlaygroundRequest,
  model: string,
): Promise<ReviewTrace> {
  const trace: ReviewTrace = {
    instructions: api.composeReviewInstructions(
      request.systemInstruction,
      request.rules,
    ),
    categories: api.reviewCategories(request.rules),
    chunks: [],
    findings: [],
  };
  const client = {
    async review(req: ReviewRequestLike) {
      const shown = render(req);
      const started = performance.now();
      try {
        const result = await review(req);
        trace.chunks.push({
          input: req.input,
          ...shown,
          output: result.output,
          ...(result.runtime ? { runtime: result.runtime } : {}),
          ms: Math.round(performance.now() - started),
        });
        return {
          output: result.output,
          ...(result.runtime ? { runtime: result.runtime } : {}),
        };
      } catch (error) {
        trace.chunks.push({
          input: req.input,
          ...shown,
          output: "",
          ms: Math.round(performance.now() - started),
          error: (error as Error).message,
        });
        throw error;
      }
    },
  };
  try {
    const result = await api.runReview(
      request.text,
      request.systemInstruction,
      client,
      request.rules,
      model,
      { backend: "wasm", quantization: "auto" },
    );
    trace.findings = result.findings.map(({ category, start, end, value }) => ({
      category,
      start,
      end,
      value,
    }));
    if (!trace.chunks.length)
      trace.skipped =
        "No custom label is configured and deterministic review found nothing, so the extension does not call the model.";
  } catch (error) {
    trace.error = (error as Error).message;
  }
  return trace;
}
