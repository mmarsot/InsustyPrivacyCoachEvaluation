import { test } from "node:test";
import assert from "node:assert/strict";
import {
  CONTRACT_VERSION,
  type RedactionOutput,
  type Span,
} from "../../../contract/types.ts";
import tab from "../../../datasets/tab/loader.ts";
import { labelTargets } from "../../adapter.ts";
import type { GoldCase } from "../../dataset.ts";
import { sampleIds } from "../../download.ts";
import { readAdapter } from "../../registry.ts";
import { scoreAdapter, sharedComparisons } from "./score.ts";

const out = (
  text: string,
  spans: Array<Partial<Span> & Pick<Span, "start" | "end" | "label">>,
): RedactionOutput => ({
  contract: CONTRACT_VERSION,
  module: { name: "t", version: "1" },
  text,
  spans: spans.map((s) => ({
    kind: "builtin",
    source: "rules",
    redacted: true,
    ...s,
  })),
  redaction: { mode: "none", leakChecked: false },
  coverage: { checked: "full", gaps: [], ocrPages: 0 },
  runtime: { stages: [], totalMs: 0 },
});

test("adapter scores keep out-of-scope and custom-label gold out of the headline", () => {
  const text =
    "Mail jo@example.org, call Ana Lopez at 06 12 34 56 78 on Monday.";
  const cases: GoldCase[] = [
    {
      id: "a",
      text,
      language: "en",
      gold: [
        { start: 5, end: 19, label: "email" },
        { start: 26, end: 35, label: "name" },
        { start: 39, end: 53, label: "phone" },
        { start: 57, end: 63, label: "date" },
      ],
    },
  ];
  const map = {
    email: { builtin: ["EMAIL" as const] },
    phone: { builtin: ["PHONE" as const] },
    name: { custom: "Person names" },
    date: "out_of_scope" as const,
  };
  const s = scoreAdapter(
    cases,
    new Map([
      [
        "a",
        out(text, [
          { start: 5, end: 19, label: "EMAIL" },
          { start: 39, end: 47, label: "NATIONAL_ID" },
          { start: 0, end: 4, label: "SECRET" },
        ]),
      ],
    ]),
    map,
  );
  assert.equal(s.headline.gold, 2);
  assert.equal(s.headline.recall, 1);
  assert.equal(
    s.headline.recallTyped,
    0.5,
    "the phone was masked under the wrong label",
  );
  assert.equal(s.headline.recallExact, 0.5);
  assert.equal(s.headline.partialCredit, 0.75);
  assert.equal(s.headline.precision, 2 / 3, '"Mail" is a false positive');
  assert.deepEqual(
    [
      s.custom.gold,
      s.outOfScope.gold,
      s.nativeTotal.gold,
      s.nativeTotal.masked,
    ],
    [1, 1, 4, 2],
  );
  assert.equal(s.byBuiltin.PHONE!.recallTyped, 0);
});

test("TAB: only DIRECT and QUASI mentions count, and an entity is masked only when all its mentions are", () => {
  const text = "Mr X, applicant no. 123/97, and Mr X again; no. 123/97.";
  const c: GoldCase = {
    id: "d",
    text,
    language: "en",
    gold: [
      {
        start: 20,
        end: 26,
        label: "CODE",
        entity: "e1",
        annotator: "a1",
        identifier: "DIRECT",
      },
      {
        start: 48,
        end: 54,
        label: "CODE",
        entity: "e1",
        annotator: "a1",
        identifier: "DIRECT",
      },
      {
        start: 0,
        end: 4,
        label: "PERSON",
        entity: "e2",
        annotator: "a1",
        identifier: "QUASI",
      },
    ],
  };
  const half = tab.native(
    [c],
    new Map([["d", [{ start: 20, end: 26 }]]]),
    labelTargets(readAdapter("insusty-privacy", "tab")!),
  );
  assert.equal(half.ER_di_in_scope, 0, "one of two mentions masked");
  const all = tab.native(
    [c],
    new Map([
      [
        "d",
        [
          { start: 20, end: 26 },
          { start: 48, end: 54 },
        ],
      ],
    ]),
    labelTargets(readAdapter("insusty-privacy", "tab")!),
  );
  assert.equal(all.ER_di_in_scope, 1);
  assert.equal(all.ER_qi, 0);
});

test("seeded samples are stable and independent of input order", () => {
  const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
  const a = sampleIds(ids, 10, "seed");
  assert.equal(a.size, 10);
  assert.deepEqual(
    [...sampleIds([...ids].reverse(), 10, "seed")].sort(),
    [...a].sort(),
  );
  assert.equal(sampleIds(ids, 0, "seed").size, 50);
});

test("modules are compared on the labels every one of them maps", () => {
  const c: GoldCase = {
    id: "c",
    text: "key sk-1 mail a@b.c",
    language: "en",
    gold: [
      { start: 4, end: 8, label: "api_key" },
      { start: 14, end: 19, label: "email" },
    ],
  };
  const masked = (spans: Array<[number, number, string]>) =>
    new Map([
      [
        "c",
        out(
          c.text,
          spans.map(([start, end, label]) => ({ start, end, label })),
        ),
      ],
    ]);
  const [shared] = sharedComparisons([
    {
      dataset: "d",
      config: "default",
      system: "a",
      cases: [c],
      outputs: masked([
        [4, 8, "SECRET"],
        [14, 19, "EMAIL"],
      ]),
      labelMap: {
        api_key: { builtin: ["SECRET"] },
        email: { builtin: ["EMAIL"] },
      },
    },
    {
      dataset: "d",
      config: "default",
      system: "b",
      cases: [c],
      outputs: masked([[14, 19, "EMAIL"]]),
      labelMap: { api_key: "out_of_scope", email: { builtin: ["EMAIL"] } },
    },
  ]);
  assert.deepEqual(shared!.labels, ["email"]);
  assert.deepEqual(
    shared!.rows.map((r) => [r.system, r.gold, r.recall]),
    [
      ["a", 1, 1],
      ["b", 1, 1],
    ],
  );
});
