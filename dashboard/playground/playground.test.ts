import { test } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Rule } from "../../engine/jobs.ts";
import { ROOT } from "../../engine/paths.ts";
import { loadInsustyModule } from "../../modules/insusty-privacy/insusty.ts";
import {
  scriptedRuntime,
  tracedRuntime,
  type TracedGeneration,
} from "../../modules/insusty-privacy/runtime/scripted.ts";
import {
  chatFinishReason,
  DEFAULT_SETTINGS,
  normalizeMessages,
  normalizeReviewRequest,
  normalizeSettings,
  renderPrompt,
  runPackageReview,
} from "./logic.ts";
import { BusyError, PlaygroundHost } from "./manager.ts";

// ChatML-like fake template, with the generation prompt appended.
const chatml = {
  hasChatTemplate: true,
  applyChatTemplate: (
    messages: ReadonlyArray<{ role: string; content: string }>,
  ) =>
    messages
      .map((m) => `<|im_start|>${m.role}\n${m.content}<|im_end|>\n`)
      .join("") + "<|im_start|>assistant\n",
  // One token per whitespace-separated word, enough to check the split count.
  encode: (text: string) =>
    text
      .split(/\s+/)
      .filter(Boolean)
      .map((_, i) => i),
};
const plain = { ...chatml, hasChatTemplate: false };

test("normalizeSettings clamps and falls back to defaults", () => {
  assert.deepEqual(normalizeSettings(undefined), DEFAULT_SETTINGS);
  const s = normalizeSettings({
    maxNewTokens: 99999,
    sample: true,
    temperature: -1,
    topP: "0.5",
    deadlineMs: 10,
  });
  assert.deepEqual(s, {
    maxNewTokens: 2048,
    sample: true,
    temperature: 0.05,
    topP: 0.5,
    deadlineMs: 1000,
  });
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
  assert.deepEqual(
    normalizeMessages([
      { role: "system", content: "  " },
      { role: "user", content: "a" },
    ]),
    [{ role: "user", content: "a" }],
  );
  assert.throws(() => normalizeMessages("x"), /array/);
  assert.throws(
    () =>
      normalizeMessages([
        { role: "user", content: "a" },
        { role: "system", content: "S" },
      ]),
    /first message/,
  );
  assert.throws(
    () =>
      normalizeMessages([
        { role: "user", content: "a" },
        { role: "user", content: "b" },
      ]),
    /alternate/,
  );
  assert.throws(
    () =>
      normalizeMessages([
        { role: "user", content: "a" },
        { role: "assistant", content: "b" },
      ]),
    /end with a user/,
  );
  assert.throws(
    () => normalizeMessages([{ role: "tool", content: "a" }]),
    /invalid role/,
  );
});

test("renderPrompt appends the prefill after the generation prompt", () => {
  const text = renderPrompt(
    chatml,
    [{ role: "user", content: "hi" }],
    "Findings:\n",
  );
  assert.equal(
    text,
    "<|im_start|>user\nhi<|im_end|>\n<|im_start|>assistant\nFindings:\n",
  );
  assert.equal(
    renderPrompt(
      plain,
      [
        { role: "system", content: "S" },
        { role: "user", content: "hi" },
      ],
      "ok",
    ),
    "system: S\nuser: hi\nassistant: ok",
  );
});

test("chatFinishReason distinguishes eos, deadline, token cap and context", () => {
  const base = { eosIds: [2], maxNewTokens: 3, deadlineHit: false };
  assert.equal(chatFinishReason({ ...base, generated: [5, 2] }), "eos");
  assert.equal(
    chatFinishReason({ ...base, generated: [5], deadlineHit: true }),
    "deadline",
  );
  assert.equal(
    chatFinishReason({ ...base, generated: [5, 6, 7] }),
    "max_new_tokens",
  );
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
  assert.deepEqual(r.rules, [
    { label: "CODENAME", prompt: "Internal codenames." },
  ]);
  assert.throws(() => normalizeReviewRequest({ text: " " }, "D"), /required/);
  assert.throws(
    () =>
      normalizeReviewRequest(
        { text: "x", rules: [{ label: "1BAD", prompt: "p" }] },
        "D",
      ),
    /must match/,
  );
  assert.throws(
    () =>
      normalizeReviewRequest(
        { text: "x", rules: [{ label: "OK", prompt: "p".repeat(1001) }] },
        "D",
      ),
    /1 to 1000/,
  );
  const many = Array.from({ length: 25 }, (_, i) => ({
    label: `L${i}`,
    prompt: "p",
  }));
  assert.equal(
    normalizeReviewRequest({ text: "x", rules: many }, "D").rules.length,
    20,
  );
});

test("runPackageReview runs the ref's review on the loaded runtime and shows each request", async () => {
  const generations: TracedGeneration[] = [];
  const scripted = scriptedRuntime(() => ({
    output: " Orion\n",
    probability: 0.9,
  }));
  const module = await loadInsustyModule(
    {
      ref: "pinned",
      sha: "0".repeat(40),
      subject: "",
      committedAt: "",
      dir: ROOT,
      entry: fileURLToPath(
        import.meta.resolve("insusty-prompt-coach/redaction"),
      ),
      packages: {},
      runtime: {},
    },
    {
      device: () =>
        Promise.resolve(
          tracedRuntime(scripted.runtime, (g) => void generations.push(g)),
        ),
    },
  );
  const rules: Rule[] = [
    { label: "CODENAME", prompt: "Codenames.", examples: ["Vega", "Lyra"] },
  ];
  const model = module.capabilities.models!.find((m) => m.default)!.id;
  const trace = await runPackageReview(
    module,
    generations,
    { systemInstruction: "", rules, text: "Hello Orion" },
    model,
  );
  assert.equal(trace.error, undefined);
  assert.deepEqual(trace.categories, ["CODENAME"]);
  assert.equal(trace.chunks.length, 1);
  const [chunk] = trace.chunks;
  assert.ok(chunk!.rendered.startsWith(trace.instructions));
  assert.ok(chunk!.input.includes("Hello Orion"));
  assert.ok(chunk!.input.endsWith("CODENAME:"));
  assert.equal(chunk!.output, " Orion\n");
  assert.equal(chunk!.runtime?.answerProbability, 0.9);
  assert.ok(trace.instructions.includes("Codenames."));
  assert.deepEqual(trace.findings, [
    { category: "CODENAME", start: 6, end: 11, value: "Orion" },
  ]);
  assert.equal(trace.skipped, undefined);

  const skipped = await runPackageReview(
    module,
    generations,
    { systemInstruction: "", rules: [], text: "x" },
    model,
  );
  assert.match(skipped.skipped ?? "", /does not call the model/);
});

test("PlaygroundHost keeps one process, rejects overlapping requests and frees it on unload", async () => {
  const host = new PlaygroundHost(
    join(import.meta.dirname, "fake-host.fixture.mjs"),
  );
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
