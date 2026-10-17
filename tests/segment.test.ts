import assert from "node:assert/strict";
import test from "node:test";
import type { Profile } from "../src/dataset/schema.ts";
import {
  checkInput,
  decide,
  demoBlocks,
  inputBlock,
  mergeRanges,
  parseYesNo,
  policyBlock,
  redact,
  segmentText,
} from "../src/lab/segment.ts";

const pieces = (text: string) =>
  segmentText(text).map((s) => text.slice(s.start, s.end));

test("sentences split at end punctuation, not at abbreviations, initials, decimals or URLs", () => {
  assert.deepEqual(
    pieces(
      "Mr. Smith met K. Anand at 3 p.m. today. Margin was 8.1% vs. 9% e.g. in Europe. ok cool!! next?",
    ),
    [
      "Mr. Smith met K. Anand at 3 p.m. today.",
      "Margin was 8.1% vs. 9% e.g. in Europe.",
      "ok cool!!",
      "next?",
    ],
  );
  assert.deepEqual(
    pieces("Voir https://x.y/a.b?c=1. M. Lhomme a appelé... qqun a vu ?? oui"),
    [
      "Voir https://x.y/a.b?c=1.",
      "M. Lhomme a appelé...",
      "qqun a vu ??",
      "oui",
    ],
  );
});

test("lines are boundaries, semicolons split clauses outside quotes, list numbers stay", () => {
  assert.deepEqual(
    pieces("Objet : point\n\n1. Il veut un remboursement ; merci.\n« a ; b »"),
    ["Objet : point", "1. Il veut un remboursement ;", "merci.", "« a ; b »"],
  );
});

test("segments cover every non-whitespace character and keep exact offsets", () => {
  const text =
    "  Hello there.  How are you?\n\n- item one\n- item two; item three  ";
  const segs = segmentText(text);
  const covered = new Set(
    segs.flatMap((s) =>
      Array.from({ length: s.end - s.start }, (_, i) => s.start + i),
    ),
  );
  for (let i = 0; i < text.length; i++)
    if (/\S/u.test(text[i]!)) assert.ok(covered.has(i), `char ${i} uncovered`);
  for (const s of segs)
    assert.equal(text.slice(s.start, s.end).trim(), text.slice(s.start, s.end));
});

test("over-long segments split near the middle at a comma", () => {
  const text = `${"a".repeat(30)}, ${"b".repeat(30)}`;
  assert.deepEqual(
    segmentText(text, 40).map((s) => text.slice(s.start, s.end)),
    [`${"a".repeat(30)},`, "b".repeat(30)],
  );
});

test("the spec's expected behavior: No, Yes, No redacts the middle line only", () => {
  const text =
    "Please rewrite this.\nAtlas's clients are Acme and Globex.\nKeep the answer short.";
  const segs = segmentText(text);
  assert.equal(segs.length, 3);
  assert.equal(
    redact(text, [segs[1]!]),
    "Please rewrite this.\n[REDACTED]\nKeep the answer short.",
  );
});

test("adjacent flagged ranges merge across whitespace only", () => {
  const text = "One. Two. Three.";
  const [a, b, c] = segmentText(text);
  assert.deepEqual(mergeRanges(text, [a!, b!]), [{ start: 0, end: 9 }]);
  assert.equal(redact(text, [a!, c!]), "[REDACTED] Two. [REDACTED]");
  assert.equal(redact(text, [a!, b!, b!]), "[REDACTED] Three.");
});

test("answers: only Yes or No (case, one period, end markers); anything else is unresolved", () => {
  for (const ok of ["Yes", " yes\n", "YES.", "No", "no.<|im_end|>"])
    assert.ok(parseYesNo(ok), ok);
  for (const bad of [
    "",
    "Yes, because it names a client",
    "The answer is Yes",
    "Yes!",
    "Y",
    "No no",
  ])
    assert.equal(parseYesNo(bad), null, bad);
  assert.equal(decide("text", "Maybe", 0.9, 0.1), null);
  assert.equal(decide("logit", "Maybe", 0.3, 0.2), "yes");
  assert.equal(decide(0.7, "Yes", 0.6, 0.4), "no");
  assert.equal(decide("logit", undefined, 0.9, 0.1), null);
});

const profile: Profile = {
  id: "agency" as Profile["id"],
  name: "t",
  persona: "",
  labels: [
    {
      label: "CLIENT",
      description: "Names of our clients.",
      examples: ["Acme Corp", "Norvik", "Halvard"],
      counterExamples: ["Google", "a public brand"],
    },
    {
      label: "CODENAME",
      description: "Campaign codenames.",
      examples: ["Project Tide", "FALCON-26", "Mistral"],
      counterExamples: ["Just Do It"],
    },
  ],
};

test("policy, demonstrations and input follow the spec's pattern", () => {
  assert.equal(
    policyBlock(profile.labels[0]!),
    'POLICY:\nCLIENT: Names of our clients.\nCovered, for example: "Acme Corp", "Norvik", "Halvard".\nNot covered: "Google", "a public brand".',
  );
  const demos = demoBlocks(profile, profile.labels[0]!, "en", 4);
  assert.equal(demos.length, 4);
  assert.match(demos[0]!, /^Target: ".*Acme Corp.*"\nAnswer: Yes$/u);
  assert.match(demos[1]!, /^Target: ".*Project Tide.*"\nAnswer: No$/u);
  assert.match(
    demos[3]!,
    /^Before: ".*Halvard.*"\nTarget: "Please make this shorter and friendlier."\nAnswer: No$/u,
  );
  assert.deepEqual(
    demoBlocks(profile, profile.labels[0]!, "fr", 2).map((d) => d.slice(-3)),
    ["Yes", " No"],
  );
  const text = 'We discuss Atlas.\nIts clients are "Acme".\nShorter please.';
  const segs = segmentText(text);
  assert.equal(
    inputBlock(checkInput(text, segs, 1, "whole")),
    'Before: "We discuss Atlas."\nTarget: "Its clients are \\"Acme\\"."\nAfter: "Shorter please."\nAnswer:',
  );
  assert.equal(
    inputBlock(checkInput(text, segs, 0, "neighbors")),
    'Target: "We discuss Atlas."\nAfter: "Its clients are \\"Acme\\"."\nAnswer:',
  );
});
