import assert from "node:assert/strict";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import test from "node:test";
import { converseBody } from "../src/hosted/bedrock.ts";
import { reviewHosted, sendNeutral } from "../src/hosted/client.ts";
import { answerConfidence, firstLine, frameRequest, NATIVE_SYSTEM, type FramingOptions, type ReviewRequest } from "../src/hosted/framing.ts";
import { costOf, findHostedModel, HOSTED_MODELS, type OpenAiModel } from "../src/hosted/models.ts";
import { openAiRequest, replyTokens } from "../src/hosted/openai.ts";
import { HostedError } from "../src/hosted/provider.ts";
import { passagesToLines } from "../src/lab/config.ts";
import { modelSlug } from "../src/run/jobs.ts";

// No pacing in tests.
process.env.HOSTED_RPM = "600000";

// The extension's per-label request (composeLabelPrefix + frameReviewInput + reviewAnswerCue).
const request: ReviewRequest = {
  instructions:
    "Copy the CLIENT passages from each text, exactly as written. CLIENT: Names of our clients. Write NONE when the text has none.\n\n" +
    "Text: Quick update before the call: Acme Corp is still on the list for next week, can you tidy up this paragraph?\nCLIENT: Acme Corp\n\n",
  input: "Text: Please tidy up this note about Norvik.\n",
  responsePrefill: "CLIENT:",
};
const native = { label: { label: "CLIENT", description: "Names of our clients.", examples: ["Acme Corp", "Norvik"] }, text: "Mail to Norvik about the renewal." };

/** The Converse body the Bedrock adapter sends for a review request in a model's framing. */
const bedrockBody = (r: ReviewRequest, model: FramingOptions & { additionalFields?: Record<string, unknown> }, maxTokens: number) => converseBody(frameRequest(r, model, maxTokens), model);

test("prefill framing: the completion text as the user turn, the answer cue as assistant prefill", () => {
  const body = bedrockBody(request, { framing: "prefill" }, 48);
  assert.equal(body.system, undefined);
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ text: request.instructions + request.input }] },
    { role: "assistant", content: [{ text: "CLIENT:" }] },
  ]);
  assert.deepEqual(body.inferenceConfig, { maxTokens: 48, temperature: 0 });
  assert.deepEqual(body.additionalModelRequestFields, { inferenceConfig: { topK: 1 } });
});

test("system framing: the instruction line as system prompt, demonstrations + text + cue as the user turn", () => {
  const body = bedrockBody(request, { framing: "system" }, 48);
  assert.deepEqual(body.system, [{ text: "Copy the CLIENT passages from each text, exactly as written. CLIENT: Names of our clients. Write NONE when the text has none." }]);
  assert.equal(body.messages.length, 1);
  const user = body.messages[0]!.content[0]!.text;
  assert.ok(user.startsWith("Text: Quick update before the call"));
  assert.ok(user.endsWith("Text: Please tidy up this note about Norvik.\nCLIENT:"));
  // Nothing is lost or added: system + blank line + user is the completion text.
  assert.equal(`${body.system![0]!.text}\n\n${user}`, request.instructions + request.input + request.responsePrefill);
});

test("completion framing: exactly the extension's completion text; Converse refuses it", () => {
  const neutral = frameRequest(request, { framing: "completion" }, 48);
  assert.deepEqual(neutral, { kind: "completion", prompt: request.instructions + request.input + request.responsePrefill, maxTokens: 48 });
  assert.throws(() => converseBody(neutral, {}), HostedError);
});

test("first-line cut matches the local first-line stop", () => {
  assert.equal(firstLine("Acme Corp\n\nText: more"), "Acme Corp");
  assert.equal(firstLine("\n NONE\nx"), "\n NONE");
  assert.equal(firstLine("NONE"), "NONE");
  assert.equal(firstLine(""), "");
});

test("cost uses the per-million prices", () => {
  const model = HOSTED_MODELS[0]!;
  assert.equal(costOf(model, 1_000_000, 0), model.usdPerMInput);
  assert.equal(costOf(model, 0, 1_000_000), model.usdPerMOutput);
});

test("a chat model's repeated cue is stripped before the NONE check, like the ref's labelAnswerLines", () => {
  assert.equal(passagesToLines("CLIENT: NONE", "CLIENT"), "NONE");
  assert.equal(passagesToLines("CLIENT: Acme Corp", "CLIENT"), "CLIENT: Acme Corp");
  assert.equal(passagesToLines(" NONE", "CLIENT"), "NONE");
});

test("native framing: task system prompt, one label with its description (and examples), the whole prompt", () => {
  const body = bedrockBody({ ...request, native }, { framing: "native", nativeSystem: NATIVE_SYSTEM.v1 }, 128);
  assert.equal(body.system![0]!.text, NATIVE_SYSTEM.v1);
  assert.equal(
    body.messages[0]!.content[0]!.text,
    "Label: CLIENT\nDescription: Names of our clients.\nExamples of matching passages (from other texts): Acme Corp | Norvik\n\n<prompt>\nMail to Norvik about the renewal.\n</prompt>",
  );
  assert.equal(body.messages.length, 1);
  const noex = bedrockBody({ ...request, native }, { framing: "native", nativeSystem: NATIVE_SYSTEM.v1, nativeExamples: false }, 128);
  assert.ok(!noex.messages[0]!.content[0]!.text.includes("Examples"));
  assert.throws(() => frameRequest(request, { framing: "native", nativeSystem: NATIVE_SYSTEM.v1 }, 128));
  // The four native models keep their ids (cache keys) and settings.
  assert.deepEqual(
    HOSTED_MODELS.filter((m) => m.framing === "native" && m.provider === "bedrock" && m.modelId.includes("nova-micro")).map((m) => [m.short, m.nativeSystem === NATIVE_SYSTEM.v2 ? "v2" : "v1", m.nativeExamples]),
    [["nova-micro-native", "v1", true], ["nova-micro-native-noex", "v1", false], ["nova-micro-native-v2", "v2", true], ["nova-micro-native-v2-noex", "v2", false]],
  );
});

test("GLM-4.7 Flash: thinking explicitly disabled in the model-specific fields", () => {
  const glm = findHostedModel("glm47-flash-prefill")!;
  const body = bedrockBody(request, glm, 48);
  assert.deepEqual(body.additionalModelRequestFields, { inferenceConfig: { topK: 1 }, thinking: { type: "disabled" } });
  // Nova Micro requests are unchanged.
  assert.deepEqual(bedrockBody(request, HOSTED_MODELS[0]!, 48).additionalModelRequestFields, { inferenceConfig: { topK: 1 } });
});

test("Bedrock models keep their ids (result cache keys), provider and settings", () => {
  const bedrock = HOSTED_MODELS.filter((m) => m.provider === "bedrock");
  assert.deepEqual(
    bedrock.map((m) => m.id),
    [
      "bedrock/eu.amazon.nova-micro-v1:0#prefill",
      "bedrock/eu.amazon.nova-micro-v1:0#system",
      "bedrock/eu.amazon.nova-micro-v1:0#prefill-stop",
      "bedrock/eu.amazon.nova-micro-v1:0#native",
      "bedrock/eu.amazon.nova-micro-v1:0#native-noex",
      "bedrock/eu.amazon.nova-micro-v1:0#native-v2",
      "bedrock/eu.amazon.nova-micro-v1:0#native-v2-noex",
      "bedrock/zai.glm-4.7-flash#prefill",
      "bedrock/zai.glm-4.7-flash#system",
      "bedrock/zai.glm-4.7-flash#native-v2",
      "bedrock/zai.glm-4.7-flash#native-v2-noex",
      "bedrock/eu.amazon.nova-micro-v1:0#trusted",
      "bedrock/zai.glm-4.7-flash#trusted",
    ],
  );
  // Before the provider-neutral interface: no stop sequence and no logprobs, so their requests are byte for byte those of the cached results.
  assert.ok(bedrock.every((m) => m.id.endsWith("#prefill-stop") || m.id.endsWith("#trusted") || (m.stop === undefined && m.logprobs === undefined)));
  assert.deepEqual(findHostedModel("nova-micro-prefill-stop")!.stop, ["\nText:"]);
  assert.equal(new Set(HOSTED_MODELS.map((m) => m.id)).size, HOSTED_MODELS.length);
  // Result cache files are named by slug (the id after its last "/"): one file per model.
  assert.equal(new Set(HOSTED_MODELS.map((m) => modelSlug(m.id))).size, HOSTED_MODELS.length);
  assert.equal(new Set(HOSTED_MODELS.map((m) => m.short)).size, HOSTED_MODELS.length);
});

test("Converse keeps non-blank stop sequences and drops the blank ones it rejects", () => {
  const body = converseBody(frameRequest(request, { framing: "prefill", stop: ["\n", "\nText:"] }, 48), {});
  assert.deepEqual(body.inferenceConfig, { maxTokens: 48, temperature: 0, stopSequences: ["\nText:"] });
});

test("OpenAI-compatible bodies: completions take the prompt, chat the system message first", () => {
  const completion = openAiRequest(frameRequest(request, { framing: "completion", stop: ["\n"], logprobs: true }, 48), { model: "smollm2:360m" });
  assert.equal(completion.path, "/completions");
  assert.deepEqual(completion.body, { model: "smollm2:360m", prompt: request.instructions + request.input + "CLIENT:", max_tokens: 48, temperature: 0, stop: ["\n"], logprobs: 1 });
  const chat = openAiRequest(frameRequest({ ...request, native }, { framing: "native", nativeSystem: NATIVE_SYSTEM.v2, logprobs: true }, 128), { model: "m" });
  assert.equal(chat.path, "/chat/completions");
  assert.deepEqual(chat.body.messages!.map((m) => m.role), ["system", "user"]);
  assert.equal(chat.body.messages![0]!.content, NATIVE_SYSTEM.v2);
  assert.equal(chat.body.logprobs, true);
  assert.equal(chat.body.stop, undefined);
  // A prefill framing keeps the trailing assistant message (servers that support it continue it).
  const prefill = openAiRequest(frameRequest(request, { framing: "prefill" }, 48), { model: "m" });
  assert.deepEqual(prefill.body.messages!.at(-1), { role: "assistant", content: "CLIENT:" });
});

test("reply tokens: chat `content[]` and completions `tokens` + `token_logprobs`", () => {
  assert.deepEqual(replyTokens({ content: [{ token: " Acme", logprob: -0.1 }] }), [{ text: " Acme", logprob: -0.1 }]);
  assert.deepEqual(replyTokens({ tokens: [" A", "cme"], token_logprobs: [-0.2, null] }), [{ text: " A", logprob: -0.2 }]);
  assert.equal(replyTokens(undefined), undefined);
  assert.equal(replyTokens({ content: null }), undefined);
});

test("answer confidence: lowest probability of the first line's tokens; the cap token is left out", () => {
  const t = (text: string, p: number) => ({ text, logprob: Math.log(p) });
  // Stopped on the server at the line break: every returned token is the answer.
  assert.ok(Math.abs(answerConfidence([t(" Acme", 0.9), t(" Corp", 0.5)], 10, false)! - 0.5) < 1e-9);
  // Cut in code at the first line: the line break that ended it and what follows are not the answer.
  assert.ok(Math.abs(answerConfidence([t(" Acme", 0.9), t("\n", 0.2), t("Text", 0.1)], 5, false)! - 0.9) < 1e-9);
  // Hit the token cap inside the first line: the last (cap) token is left out, like the ref.
  assert.ok(Math.abs(answerConfidence([t(" Acme", 0.9), t(" Co", 0.1)], 8, true)! - 0.9) < 1e-9);
  assert.equal(answerConfidence(undefined, 5, false), undefined);
});

// ---------------------------------------------------------------- fake servers

async function fakeServer(handler: (path: string, body: Record<string, unknown>, req: IncomingMessage, res: ServerResponse) => void) {
  const server = createServer((req, res) => {
    let data = "";
    req.on("data", (c: Buffer) => (data += c.toString()));
    req.on("end", () => handler(req.url ?? "", JSON.parse(data || "{}") as Record<string, unknown>, req, res));
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, close: () => new Promise<void>((r) => server.close(() => r())) };
}
const json = (res: ServerResponse, status: number, body: unknown) => {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
};
const openAiModel = (baseUrl: string, over: Partial<OpenAiModel> = {}): OpenAiModel => ({
  ...(findHostedModel("ollama-smollm2-360m-native-v2") as OpenAiModel),
  baseUrl,
  ...over,
});

test("OpenAI-compatible chat: answer, usage, logprob confidence, API key from its env var", async () => {
  const seen: Array<{ path: string; body: Record<string, unknown>; auth?: string }> = [];
  const srv = await fakeServer((path, body, req, res) => {
    seen.push({ path, body, auth: req.headers.authorization });
    json(res, 200, {
      choices: [{ message: { content: "Norvik" }, finish_reason: "stop", logprobs: { content: [{ token: "Nor", logprob: Math.log(0.9) }, { token: "vik", logprob: Math.log(0.6) }] } }],
      usage: { prompt_tokens: 120, completion_tokens: 2 },
    });
  });
  try {
    process.env.TEST_OPENAI_KEY = "sk-test";
    const r = await reviewHosted(openAiModel(srv.url, { apiKeyEnv: "TEST_OPENAI_KEY" }), { ...request, native }, { maxTokens: 128, stopAtNewline: true });
    assert.equal(r.output, "Norvik");
    assert.equal(r.stopReason, "stop");
    assert.equal(r.inputTokens, 120);
    assert.equal(r.outputTokens, 2);
    assert.equal(r.costUsd, 0);
    assert.ok(Math.abs(r.answerProbability! - 0.6) < 1e-9);
    assert.equal(seen[0]!.path, "/v1/chat/completions");
    assert.equal(seen[0]!.auth, "Bearer sk-test");
    assert.equal(seen[0]!.body.model, "smollm2:360m");
    assert.deepEqual(seen[0]!.body.stop, ["\n"]);
    // Without apiKeyEnv, no Authorization header at all.
    await reviewHosted(openAiModel(srv.url), { ...request, native }, { maxTokens: 128, stopAtNewline: true });
    assert.equal(seen[1]!.auth, undefined);
    // A missing key is a configuration error, not retried.
    delete process.env.TEST_OPENAI_KEY;
    await assert.rejects(reviewHosted(openAiModel(srv.url, { apiKeyEnv: "TEST_OPENAI_KEY" }), { ...request, native }, { maxTokens: 128, stopAtNewline: true }), (e: unknown) => e instanceof HostedError && !e.retryable);
  } finally {
    await srv.close();
  }
});

test("OpenAI-compatible completions: the prompt, a run-on answer cut at its first line, no logprobs", async () => {
  const srv = await fakeServer((path, body, _req, res) => {
    assert.equal(path, "/v1/completions");
    assert.equal(body.prompt, request.instructions + request.input + request.responsePrefill);
    json(res, 200, { choices: [{ text: " Norvik\n\nText: next", finish_reason: "length" }], usage: { prompt_tokens: 90, completion_tokens: 48 } });
  });
  try {
    const model = openAiModel(srv.url, { ...findHostedModel("ollama-smollm2-360m-completion"), baseUrl: srv.url } as Partial<OpenAiModel>);
    const r = await reviewHosted(model, request, { maxTokens: 48, stopAtNewline: true });
    assert.equal(r.output, " Norvik");
    assert.equal(r.raw, " Norvik\n\nText: next");
    assert.equal(r.stopReason, "length");
    assert.equal(r.answerProbability, undefined);
  } finally {
    await srv.close();
  }
});

test("retries: HTTP 429 and 5xx are retried, 401 is not", async () => {
  let calls = 0;
  const srv = await fakeServer((path, _body, _req, res) => {
    calls++;
    if (path.includes("auth")) return json(res, 401, { error: { message: "bad key" } });
    if (calls === 1) return json(res, 429, { error: { message: "slow down" } });
    if (calls === 2) return json(res, 503, { error: "busy" });
    json(res, 200, { choices: [{ message: { content: "NONE" }, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } });
  });
  try {
    const r = await reviewHosted(openAiModel(srv.url), { ...request, native }, { maxTokens: 128, stopAtNewline: true });
    assert.equal(r.output, "NONE");
    assert.equal(r.attempts, 3);
    await assert.rejects(reviewHosted(openAiModel(`${srv.url}/auth`), { ...request, native }, { maxTokens: 128, stopAtNewline: true }), (e: unknown) => e instanceof HostedError && e.status === 401 && !e.retryable && /bad key/.test(e.message));
  } finally {
    await srv.close();
  }
});

test("Bedrock adapter: Converse URL, bearer key, stop reason, reasoning blocks refused", async () => {
  const original = globalThis.fetch;
  const calls: Array<{ url: string; init: RequestInit }> = [];
  let reply: unknown = { output: { message: { content: [{ text: "Norvik\nText: x" }] } }, stopReason: "max_tokens", usage: { inputTokens: 300, outputTokens: 48 }, metrics: { latencyMs: 250 } };
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    return new Response(JSON.stringify(reply), { status: 200 });
  }) as typeof fetch;
  process.env.AWS_BEARER_TOKEN_BEDROCK = "test-token";
  try {
    const nova = findHostedModel("nova-micro-prefill")!;
    const r = await reviewHosted(nova, request, { maxTokens: 48, stopAtNewline: true });
    assert.equal(calls[0]!.url, "https://bedrock-runtime.eu-north-1.amazonaws.com/model/eu.amazon.nova-micro-v1%3A0/converse");
    assert.equal((calls[0]!.init.headers as Record<string, string>).authorization, "Bearer test-token");
    assert.deepEqual(JSON.parse(String(calls[0]!.init.body)), bedrockBody(request, nova, 48));
    assert.equal(r.output, "Norvik");
    assert.equal(r.stopReason, "length");
    assert.equal(r.serverMs, 250);
    assert.equal(r.answerProbability, undefined);
    assert.ok(Math.abs(r.costUsd - costOf(nova, 300, 48)) < 1e-12);
    reply = { output: { message: { content: [{ reasoningContent: {} }, { text: "x" }] } }, stopReason: "end_turn" };
    await assert.rejects(sendNeutral(nova, frameRequest(request, nova, 48), 1000), (e: unknown) => e instanceof HostedError && !e.retryable);
  } finally {
    globalThis.fetch = original;
    delete process.env.AWS_BEARER_TOKEN_BEDROCK;
  }
});

test("GLM-4.7 Flash over Bedrock's OpenAI-compatible endpoint: same key, chat, logprobs, thinking off", () => {
  const glm = findHostedModel("glm47-flash-oai-native-v2") as OpenAiModel;
  assert.equal(glm.provider, "openai");
  assert.equal(glm.apiKeyEnv, "AWS_BEARER_TOKEN_BEDROCK");
  const { path, body } = openAiRequest(frameRequest({ ...request, native }, glm, 128), glm);
  assert.equal(path, "/chat/completions");
  assert.equal(body.model, "zai.glm-4.7-flash");
  assert.deepEqual((body as unknown as Record<string, unknown>).thinking, { type: "disabled" });
  assert.equal(body.logprobs, true);
});

test("tolerant parser: the extension's connected-model reading (PR #48)", async () => {
  const { tolerantAnswer } = await import("../src/hosted/framing.ts");
  assert.equal(tolerantAnswer("Acme Corp |", "CLIENT"), "Acme Corp");
  assert.equal(tolerantAnswer("Acme Corp | NONE\nmore", "CLIENT"), "Acme Corp");
  assert.equal(tolerantAnswer("client: Acme Corp|Norvik", "CLIENT"), "Acme Corp | Norvik");
  assert.equal(tolerantAnswer("  NONE.", "CLIENT"), "NONE");
  assert.equal(tolerantAnswer("", "CLIENT"), "NONE");
  // Another label's cue is kept: only a repeated cue of this label is stripped.
  assert.equal(tolerantAnswer("Note: Acme Corp", "CLIENT"), "Note: Acme Corp");
});

test("trusted models mirror the extension's connected-model requests", () => {
  const nova = findHostedModel("nova-micro-trusted")!;
  assert.deepEqual([nova.framing, nova.stop, nova.answerParser], ["prefill", ["\nText:"], "tolerant"]);
  assert.deepEqual(bedrockBody(request, nova, 48).inferenceConfig, { maxTokens: 48, temperature: 0, stopSequences: ["\nText:"] });
  const glm = findHostedModel("glm47-flash-trusted")!;
  assert.deepEqual(bedrockBody({ ...request, native }, glm, 128).inferenceConfig, { maxTokens: 128, temperature: 0 });
  const oai = findHostedModel("glm47-flash-oai-trusted") as OpenAiModel;
  const chat = openAiRequest(frameRequest({ ...request, native }, oai, 128), oai);
  assert.equal(chat.body.stop, undefined);
  assert.equal(chat.body.logprobs, true);
  const comp = findHostedModel("ollama-smollm2-360m-completion-trusted") as OpenAiModel;
  assert.deepEqual(openAiRequest(frameRequest(request, comp, 48), comp).body.stop, ["\nText:"]);
  assert.equal((findHostedModel("ollama-smollm2-360m-native-v2-trusted") as OpenAiModel).stop, undefined);
  // Cached ids keep their meaning.
  assert.equal(findHostedModel("nova-micro-prefill")!.answerParser, undefined);
  assert.deepEqual(findHostedModel("glm47-flash-oai-native-v2")!.stop, ["\n"]);
});
