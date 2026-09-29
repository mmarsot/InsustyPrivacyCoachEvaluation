import assert from "node:assert/strict";
import test from "node:test";
import { converseBody, costOf, firstLine, HOSTED_MODELS, NATIVE_SYSTEM } from "../src/hosted/bedrock.ts";
import { passagesToLines } from "../src/lab/config.ts";

// The extension's per-label request (composeLabelPrefix + frameReviewInput + reviewAnswerCue).
const request = {
  instructions:
    "Copy the CLIENT passages from each text, exactly as written. CLIENT: Names of our clients. Write NONE when the text has none.\n\n" +
    "Text: Quick update before the call: Acme Corp is still on the list for next week, can you tidy up this paragraph?\nCLIENT: Acme Corp\n\n",
  input: "Text: Please tidy up this note about Norvik.\n",
  responsePrefill: "CLIENT:",
};

test("prefill framing: the completion text as the user turn, the answer cue as assistant prefill", () => {
  const body = converseBody(request, { framing: "prefill" }, 48);
  assert.equal(body.system, undefined);
  assert.deepEqual(body.messages, [
    { role: "user", content: [{ text: request.instructions + request.input }] },
    { role: "assistant", content: [{ text: "CLIENT:" }] },
  ]);
  assert.deepEqual(body.inferenceConfig, { maxTokens: 48, temperature: 0 });
  assert.deepEqual(body.additionalModelRequestFields, { inferenceConfig: { topK: 1 } });
});

test("system framing: the instruction line as system prompt, demonstrations + text + cue as the user turn", () => {
  const body = converseBody(request, { framing: "system" }, 48);
  assert.deepEqual(body.system, [{ text: "Copy the CLIENT passages from each text, exactly as written. CLIENT: Names of our clients. Write NONE when the text has none." }]);
  assert.equal(body.messages.length, 1);
  const user = body.messages[0]!.content[0]!.text;
  assert.ok(user.startsWith("Text: Quick update before the call"));
  assert.ok(user.endsWith("Text: Please tidy up this note about Norvik.\nCLIENT:"));
  // Nothing is lost or added: system + blank line + user is the completion text.
  assert.equal(`${body.system![0]!.text}\n\n${user}`, request.instructions + request.input + request.responsePrefill);
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
  const native = { label: { label: "CLIENT", description: "Names of our clients.", examples: ["Acme Corp", "Norvik"] }, text: "Mail to Norvik about the renewal." };
  const body = converseBody({ ...request, native }, { framing: "native", nativeSystem: NATIVE_SYSTEM.v1 }, 128);
  assert.equal(body.system![0]!.text, NATIVE_SYSTEM.v1);
  assert.equal(
    body.messages[0]!.content[0]!.text,
    "Label: CLIENT\nDescription: Names of our clients.\nExamples of matching passages (from other texts): Acme Corp | Norvik\n\n<prompt>\nMail to Norvik about the renewal.\n</prompt>",
  );
  assert.equal(body.messages.length, 1);
  const noex = converseBody({ ...request, native }, { framing: "native", nativeSystem: NATIVE_SYSTEM.v1, nativeExamples: false }, 128);
  assert.ok(!noex.messages[0]!.content[0]!.text.includes("Examples"));
  assert.throws(() => converseBody(request, { framing: "native", nativeSystem: NATIVE_SYSTEM.v1 }, 128));
  // The four native models keep their ids (cache keys) and settings.
  assert.deepEqual(
    HOSTED_MODELS.filter((m) => m.framing === "native" && m.modelId.includes("nova-micro")).map((m) => [m.short, m.nativeSystem === NATIVE_SYSTEM.v2 ? "v2" : "v1", m.nativeExamples]),
    [["nova-micro-native", "v1", true], ["nova-micro-native-noex", "v1", false], ["nova-micro-native-v2", "v2", true], ["nova-micro-native-v2-noex", "v2", false]],
  );
});

test("GLM-4.7 Flash: thinking explicitly disabled in the model-specific fields", () => {
  const glm = HOSTED_MODELS.find((m) => m.short === "glm47-flash-prefill")!;
  const body = converseBody(request, glm, 48);
  assert.deepEqual(body.additionalModelRequestFields, { inferenceConfig: { topK: 1 }, thinking: { type: "disabled" } });
  // Nova Micro requests are unchanged.
  assert.deepEqual(converseBody(request, HOSTED_MODELS[0]!, 48).additionalModelRequestFields, { inferenceConfig: { topK: 1 } });
});
