import { test } from "node:test";
import assert from "node:assert/strict";
import type { CompiledCase, Profile } from "../src/dataset/schema.ts";
import { containsWord, occurrences } from "../src/dataset/load.ts";
import type { ResultRecord } from "../src/run/jobs.ts";
import { analyzeLines, scoreResult } from "../src/score/score.ts";
import { metrics } from "../src/score/aggregate.ts";
import { composeLabelDescription } from "../src/variants.ts";

const profile: Profile = {
  id: "sales",
  name: "t",
  persona: "t",
  labels: [
    {
      label: "PRODUCT",
      description: "Unreleased products.",
      examples: ["Alpha", "Beta", "Gamma"],
      counterExamples: ["Zoom", "Teams"],
    },
  ],
};
const text = "Draft an update: Orwell slips two weeks, orwell beta later.";
const baseCase: CompiledCase = {
  id: "sales-en-001",
  profile: "sales",
  lang: "en",
  type: "clear_positive",
  difficulty: "easy",
  style: { register: "request", errors: "none" },
  text,
  expected: [{ label: "PRODUCT", passage: "Orwell" }],
  split: "dev",
  positive: true,
  lengthBucket: "short",
  spans: [{ label: "PRODUCT", passage: "Orwell", start: 17, end: 23 }],
};
const record = (
  output: string,
  findings: ResultRecord["findings"] = [],
): ResultRecord => ({
  key: "k",
  extSha: "s",
  model: "org/M",
  instruction: "current",
  labelVariant: "desc",
  caseId: baseCase.id,
  findings,
  chunks: [
    {
      output,
      ms: 10,
      runtime: {
        backend: "wasm",
        quantization: "q8",
        promptTokens: 1,
        generatedTokens: 3,
        finishReason: "line",
      },
    },
  ],
  reviewMs: 10,
  at: "",
});
const builtin = ["EMAIL", "PHONE"];

test("occurrences and whole-word search", () => {
  assert.deepEqual(occurrences("a Orwell b Orwell", "Orwell"), [2, 11]);
  assert.equal(containsWord("the annihilation", "NIH"), false);
  assert.equal(containsWord("funded by NIH.", "nih"), true);
});

test("label description variants", () => {
  const spec = profile.labels[0]!;
  assert.equal(composeLabelDescription(spec, "desc"), "Unreleased products.");
  assert.equal(
    composeLabelDescription(spec, "desc_ex1"),
    'Unreleased products. Example: "Alpha".',
  );
  assert.equal(
    composeLabelDescription(spec, "ex_counter"),
    'Examples: "Alpha", "Beta", "Gamma". Not this label: "Zoom", "Teams".',
  );
});

test("line analysis classifies formats", () => {
  assert.equal(analyzeLines("NONE", text, ["PRODUCT"]).format, "none");
  assert.equal(analyzeLines("- None\n\n", text, ["PRODUCT"]).format, "none");
  assert.equal(
    analyzeLines("PRODUCT: Orwell\n\n", text, ["PRODUCT"]).format,
    "lines",
  );
  assert.equal(
    analyzeLines("PRODUCT: Nautilus", text, ["PRODUCT"]).droppedLines,
    1,
  );
  assert.equal(
    analyzeLines("Sure! Here is your update.", text, ["PRODUCT"]).format,
    "invalid",
  );
  assert.equal(
    analyzeLines("PROJECT: Orwell", text, ["PRODUCT"]).unknownLabelLines,
    1,
  );
});

test("a correct finding scores exact and overlap", () => {
  const scored = scoreResult(
    baseCase,
    profile,
    record("PRODUCT: Orwell", [
      { category: "PRODUCT", start: 17, end: 23, value: "Orwell" },
      { category: "PRODUCT", start: 41, end: 47, value: "orwell" },
    ]),
    builtin,
  );
  assert.equal(scored.failure, "ok");
  assert.equal(scored.detected, true);
  assert.equal(scored.expected[0]!.exact, true);
  // Case variants of one value collapse into a single passage-level prediction.
  assert.equal(scored.predicted.length, 1);
  const m = metrics([scored]);
  assert.equal(m.overlap.recall, 1);
  assert.equal(m.overlap.precision, 1);
});

test("failure modes", () => {
  assert.equal(
    scoreResult(baseCase, profile, record(`Prompt: ${text}`), builtin).failure,
    "echo",
  );
  assert.equal(
    scoreResult(
      baseCase,
      profile,
      record(
        "Here are three friendlier names for your launch: Nova, Pulse, Arc",
      ),
      builtin,
    ).failure,
    "answered",
  );
  assert.equal(
    scoreResult(baseCase, profile, record("PRODUCT: Nautilus"), builtin)
      .failure,
    "hallucinated",
  );
  assert.equal(
    scoreResult(
      baseCase,
      profile,
      record("- PRODUCT: Unreleased products.\n- EMAIL: Email addresses."),
      builtin,
      "Labels:\n- PRODUCT: Unreleased products.\n- EMAIL: Email addresses.",
    ).failure,
    "echo_instructions",
  );
  const timeout = {
    ...record("PRODUCT PRODUCT PRODUCT"),
    error: "budget",
    errorKind: "deadline" as const,
  };
  assert.equal(
    scoreResult(baseCase, profile, timeout, builtin).failure,
    "timeout",
  );
  const negative = {
    ...baseCase,
    type: "lookalike_negative" as const,
    expected: [],
    spans: [],
    positive: false,
  };
  const fp = scoreResult(
    negative,
    profile,
    record("PRODUCT: Orwell", [
      { category: "PRODUCT", start: 17, end: 23, value: "Orwell" },
    ]),
    builtin,
  );
  assert.equal(fp.falsePositiveCase, true);
  assert.equal(metrics([fp]).falsePositiveRate, 1);
});
