import { test } from "node:test";
import assert from "node:assert/strict";
import { CONTRACT_VERSION, type RedactionOutput, type Span } from "../contract/types.ts";
import { sampleIds } from "../src/adapters/download.ts";
import { scoreAdapter } from "../src/adapters/score.ts";
import type { GoldCase } from "../src/adapters/types.ts";
import { tab } from "../src/adapters/tab.ts";
import { presidioLabel } from "../src/systems/presidio.ts";
import { planSuite, selectTracks } from "../src/tracks/select.ts";

test("deterministic-rule changes select only the deterministic track; documents and OCR both; Private AI its own", () => {
  assert.deepEqual(selectTracks(["src/detection/detector.ts", "tests/detector.test.ts"]).tracks, ["deterministic"]);
  assert.deepEqual(selectTracks(["src/files/readers/pdf-document.ts"]).tracks, ["deterministic", "private-ai"]);
  assert.deepEqual(selectTracks(["src/files/ocr/ocr-service.ts"]).tracks, ["deterministic", "private-ai"]);
  assert.deepEqual(selectTracks(["src/private-ai/slm-review.ts"]).tracks, ["private-ai"]);
  assert.deepEqual(selectTracks(["src/private-ai/connected-model/hosted-framing.ts"]).tracks, ["private-ai"]);
  assert.deepEqual(selectTracks(["src/files/file-attach.ts", "src/popup/popup.ts", "docs/x.md"]).tracks, []);
  assert.deepEqual(selectTracks(["package-lock.json"]).tracks, ["deterministic", "private-ai"]);
});

test("CI plans gate deterministic regressions, documents, conformance and parity, never Private AI scores", () => {
  const steps = planSuite({ ref: "head", base: "base", tracks: ["deterministic", "private-ai"], ci: true, full: false, connected: false });
  assert.deepEqual(steps.filter((s) => s.gate).map((s) => s.name), ["conformance", "detbench", "docbench", "parity"]);
  assert.ok(steps.find((s) => s.name === "detbench")!.args.includes("--gate"));
  assert.ok(steps.find((s) => s.name === "review (on device)")!.args.includes("smoke"));
  assert.ok(!steps.some((s) => s.args.includes("glm47-flash-connected")), "the paid connected model only with --connected");
  const full = planSuite({ ref: "main", tracks: ["deterministic", "private-ai"], ci: false, full: true, connected: true });
  assert.ok(full.find((s) => s.name === "literature")!.args.includes("insusty,presidio"));
  assert.ok(full.some((s) => s.args.includes("glm47-flash-connected")));
});

const out = (text: string, spans: Array<Partial<Span> & Pick<Span, "start" | "end" | "label">>): RedactionOutput => ({
  contract: CONTRACT_VERSION,
  module: { name: "t", version: "1" },
  text,
  spans: spans.map((s) => ({ kind: "builtin", source: "rules", redacted: true, ...s })),
  redaction: { mode: "none", leakChecked: false },
  coverage: { checked: "full", gaps: [], ocrPages: 0 },
  runtime: { stages: [], totalMs: 0 },
});

test("adapter scores keep out-of-scope and custom-label gold out of the headline", () => {
  const text = "Mail jo@example.org, call Ana Lopez at 06 12 34 56 78 on Monday.";
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
  const map = { email: { builtin: ["EMAIL" as const] }, phone: { builtin: ["PHONE" as const] }, name: { custom: "Person names" }, date: "out_of_scope" as const };
  const s = scoreAdapter(cases, new Map([["a", out(text, [{ start: 5, end: 19, label: "EMAIL" }, { start: 39, end: 47, label: "NATIONAL_ID" }, { start: 0, end: 4, label: "SECRET" }])]]), map);
  assert.equal(s.headline.gold, 2);
  assert.equal(s.headline.recall, 1);
  assert.equal(s.headline.recallTyped, 0.5, "the phone was masked under the wrong label");
  assert.equal(s.headline.recallExact, 0.5);
  assert.equal(s.headline.partialCredit, 0.75);
  assert.equal(s.headline.precision, 2 / 3, "\"Mail\" is a false positive");
  assert.deepEqual([s.custom.gold, s.outOfScope.gold, s.nativeTotal.gold, s.nativeTotal.masked], [1, 1, 4, 2]);
  assert.equal(s.byBuiltin.PHONE!.recallTyped, 0);
});

test("TAB: only DIRECT and QUASI mentions count, and an entity is masked only when all its mentions are", () => {
  const text = "Mr X, applicant no. 123/97, and Mr X again; no. 123/97.";
  const c: GoldCase = {
    id: "d",
    text,
    language: "en",
    gold: [
      { start: 20, end: 26, label: "CODE", entity: "e1", annotator: "a1", identifier: "DIRECT" },
      { start: 48, end: 54, label: "CODE", entity: "e1", annotator: "a1", identifier: "DIRECT" },
      { start: 0, end: 4, label: "PERSON", entity: "e2", annotator: "a1", identifier: "QUASI" },
    ],
  };
  const half = tab.native!([c], new Map([["d", [{ start: 20, end: 26 }]]]), tab.labelMap);
  assert.equal(half.ER_di_in_scope, 0, "one of two mentions masked");
  const all = tab.native!([c], new Map([["d", [{ start: 20, end: 26 }, { start: 48, end: 54 }]]]), tab.labelMap);
  assert.equal(all.ER_di_in_scope, 1);
  assert.equal(all.ER_qi, 0);
});

test("seeded samples are stable and independent of input order", () => {
  const ids = Array.from({ length: 50 }, (_, i) => `id-${i}`);
  const a = sampleIds(ids, 10, "seed");
  assert.equal(a.size, 10);
  assert.deepEqual([...sampleIds([...ids].reverse(), 10, "seed")].sort(), [...a].sort());
  assert.equal(sampleIds(ids, 0, "seed").size, 50);
});

test("Presidio types map to built-in labels; dates only after birth words", () => {
  assert.equal(presidioLabel("IBAN_CODE", "", 0), "FINANCIAL");
  assert.equal(presidioLabel("US_SSN", "", 0), "NATIONAL_ID");
  assert.equal(presidioLabel("UK_NHS", "", 0), "NATIONAL_ID");
  assert.equal(presidioLabel("PERSON", "", 0), null);
  const text = "Born on 12/03/1980, joined on 01/02/2020.";
  assert.equal(presidioLabel("DATE_TIME", text, 8), "DATE_OF_BIRTH");
  assert.equal(presidioLabel("DATE_TIME", text, 30), null);
});
