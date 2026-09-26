import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import type { ReviewRequestLike, Rule } from "../src/ext/ref.ts";
import {
  chatFinishReason,
  DEFAULT_SETTINGS,
  normalizeMessages,
  normalizeReviewRequest,
  normalizeSettings,
  renderPrompt,
  renderReviewPrompt,
  runExtensionReview,
} from "../src/playground/logic.ts";
import { BusyError, PlaygroundHost } from "../src/playground/manager.ts";

// ChatML-like fake template, with the generation prompt appended.
const chatml = {
  hasChatTemplate: true,
  applyChatTemplate: (messages: ReadonlyArray<{ role: string; content: string }>) =>
    messages.map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`).join("") + "<|im_start|>assistant\n",
  // One token per whitespace-separated word, enough to check the split count.
  encode: (text: string) => text.split(/\s+/).filter(Boolean).map((_, i) => i),
};
const plain = { ...chatml, hasChatTemplate: false };

test("normalizeSettings clamps and falls back to defaults", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  const s = normalizeSettings({ maxNewTokens: 99999, sample: true, temperature: -1, topP: "0.5", deadlineMs: 10 });
  assert.deepEqual(s, { maxNewTokens: 2048, sample: true, temperature: 0.05, topP: 0.5, deadlineMs: 1000 });
  assert.equal(normalizeSettings({ sample: "yes" }).sample, false);
});

test("normalizeMessages enforces system first, alternation and a final user turn", () => {
  const ok = normalizeMessages([
    { role: "system", content: "S" },
    { role: "user", content: "a" },
    { role: "assistant", content: "b" },
    { role: "user", content: "c" },
  ]);
  assert.equal(ok.length, 4);
  // A blank system message is dropped rather than sent empty.
  assert.deepEqual(normalizeMessages([{ role: "system", content: "  " }, { role: "user", content: "a" }]), [{ role: "user", content: "a" }]);
  assert.throws(() => normalizeMessages("x"), /array/);
  assert.throws(() => normalizeMessages([{ role: "user", content: "a" }, { role: "system", content: "S" }]), /first message/);
  assert.throws(() => normalizeMessages([{ role: "user", content: "a" }, { role: "user", content: "b" }]), /alternate/);
  assert.throws(() => normalizeMessages([{ role: "user", content: "a" }, { role: "assistant", content: "b" }]), /end with a user/);
  assert.throws(() => normalizeMessages([{ role: "tool", content: "a" }]), /invalid role/);
});

test("renderPrompt appends the prefill after the generation prompt", () => {
  const text = renderPrompt(chatml, [{ role: "user", content: "hi" }], "Findings:\n");
  assert.equal(text, "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\nFindings:\n");
  assert.equal(renderPrompt(plain, [{ role: "system", content: "S" }, { role: "user", content: "hi" }], "ok"), "system: S\nuser: hi\nassistant: ok");
});

test("renderReviewPrompt frames like the engine and counts prefix and rest separately", () => {
  const request: ReviewRequestLike = { instructions: "Find labels.", input: "<text_to_scan>\nsecret\n</text_to_scan>", responsePrefill: "Findings:\n" };
  const { rendered, promptTokens } = renderReviewPrompt(chatml, request);
  assert.equal(rendered, "<|im_start|>system\nFind labels.<|im_end|>\n<|im_start|>user\n<text_to_scan>\nsecret\n</text_to_scan><|im_end|>\n<|im_start|>assistant\nFindings:\n");
  const prefix = "<|im_start|>system\nFind labels.<|im_end|>\n<|im_start|>user\n";
  assert.equal(promptTokens, chatml.encode(prefix).length + chatml.encode(rendered.slice(prefix.length)).length);
  // Without a template: the engine's plain completion framing.
  assert.equal(renderReviewPrompt(plain, request).rendered, "Find labels.\n\nInput:\n<text_to_scan>\nsecret\n</text_to_scan>\n\nFindings:\n");
});

test("chatFinishReason distinguishes eos, deadline, token cap and context", () => {
  const base = { eosIds: [2], maxNewTokens: 3, deadlineHit: false };
  assert.equal(chatFinishReason({ ...base, generated: [5, 2] }), "eos");
  assert.equal(chatFinishReason({ ...base, generated: [5], deadlineHit: true }), "deadline");
  assert.equal(chatFinishReason({ ...base, generated: [5, 6, 7] }), "max_new_tokens");
  assert.equal(chatFinishReason({ ...base, generated: [5] }), "context");
});

test("normalizeReviewRequest applies the extension's rule constraints", () => {
  const r = normalizeReviewRequest(
    {
      text: "hello",
      systemInstruction: " ",
      rules: [
        { label: "codename", prompt: "Internal codenames." },
        { label: "CODENAME", prompt: "duplicate" },
        { label: "", prompt: "" },
      ],
    },
    "DEFAULT",
  );
  assert.equal(r.systemInstruction, "DEFAULT");
  assert.deepEqual(r.rules, [{ label: "CODENAME", prompt: "Internal codenames." }]);
  assert.throws(() => normalizeReviewRequest({ text: " " }, "D"), /required/);
  assert.throws(() => normalizeReviewRequest({ text: "x", rules: [{ label: "1BAD", prompt: "p" }] }, "D"), /must match/);
  assert.throws(() => normalizeReviewRequest({ text: "x", rules: [{ label: "OK", prompt: "p".repeat(1001) }] }, "D"), /1 to 1000/);
  const many = Array.from({ length: 25 }, (_, i) => ({ label: `L${i}`, prompt: "p" }));
  assert.equal(normalizeReviewRequest({ text: "x", rules: many }, "D").rules.length, 20);
});

test("runExtensionReview records every engine request and returns anchored findings", async () => {
  const rules: Rule[] = [{ label: "CODENAME", prompt: "Codenames." }];
  const api = {
    composeReviewInstructions: (s: string, r: Rule[]) => `${s}|${r.map((x) => x.label).join(",")}`,
    reviewCategories: (r: Rule[]) => r.map((x) => x.label),
    // Two chunks, like a long prompt paginated by the extension.
    reviewPrompt: async (text: string, _d: unknown[], _s: string, client: { review(req: ReviewRequestLike): Promise<{ output: unknown }> }) => {
      await client.review({ instructions: "I", input: text.slice(0, 5), responsePrefill: "Findings:\n" });
      await client.review({ instructions: "I", input: text.slice(5), responsePrefill: "Findings:\n" });
      return { findings: [{ category: "CODENAME", start: 6, end: 11, value: "Orion", extra: true }] };
    },
  };
  const trace = await runExtensionReview(
    api as never,
    async (req) => ({ output: `CODENAME: ${req.input}`, runtime: { backend: "wasm", quantization: "q8", promptTokens: 3, generatedTokens: 4, finishReason: "line" } }),
    (req) => ({ rendered: `R:${req.input}`, promptTokens: 1 }),
    { systemInstruction: "S", rules, text: "Hello Orion" },
    "m",
  );
  assert.equal(trace.instructions, "S|CODENAME");
  assert.deepEqual(trace.categories, ["CODENAME"]);
  assert.equal(trace.chunks.length, 2);
  assert.equal(trace.chunks[1]!.rendered, "R: Orion");
  assert.equal(trace.chunks[0]!.runtime?.finishReason, "line");
  assert.deepEqual(trace.findings, [{ category: "CODENAME", start: 6, end: 11, value: "Orion" }]);
  assert.equal(trace.skipped, undefined);

  const skipped = await runExtensionReview({ ...api, reviewPrompt: async () => ({ findings: [] }) } as never, async () => ({ output: "" }), () => ({ rendered: "", promptTokens: 0 }), { systemInstruction: "S", rules: [], text: "x" }, "m");
  assert.match(skipped.skipped ?? "", /does not call the model/);

  const failing = await runExtensionReview(api as never, async () => { throw new Error("boom"); }, () => ({ rendered: "", promptTokens: 0 }), { systemInstruction: "S", rules, text: "Hello Orion" }, "m");
  assert.equal(failing.error, "boom");
  assert.equal(failing.chunks[0]!.error, "boom");
});

test("PlaygroundHost keeps one process, rejects overlapping requests and frees it on unload", async () => {
  const host = new PlaygroundHost(join(import.meta.dirname, "fixtures/fake-playground-host.mjs"));
  await assert.rejects(host.request("chat", {}), BusyError);
  const status = await host.load("fake-model", "unused");
  assert.equal(status.state, "ready");
  assert.equal(status.loadMs, 5);
  const slow = host.request("chat", { settings: { delayMs: 200 } });
  assert.equal(host.getStatus().state, "busy");
  await assert.rejects(host.request("chat", {}), BusyError);
  await assert.rejects(host.load("other", "unused"), BusyError);
  const { pid } = (await slow) as { pid: number };
  assert.equal(host.getStatus().state, "ready");
  await host.unload();
  assert.equal(host.getStatus().state, "empty");
  assert.throws(() => process.kill(pid, 0), /ESRCH/);

  const broken = await host.load("broken", "unused");
  assert.equal(broken.state, "error");
  assert.equal(broken.error, "cannot load");
  await host.unload();
});
