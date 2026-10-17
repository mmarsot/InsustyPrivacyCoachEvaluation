import assert from "node:assert/strict";
import test from "node:test";
import { labelPatterns, patternFindings } from "../src/lab/patterns.ts";

const find = (examples: string[], text: string) =>
  patternFindings(text, labelPatterns([{ label: "X", examples }])).map(
    (f) => f.value,
  );

test("identifier examples generalize their digit and code runs but keep literal prefixes", () => {
  assert.deepEqual(find(["acct-00918-BZ"], "see acct-55120-QX and acct-1-A"), [
    "acct-55120-QX",
  ]);
  assert.deepEqual(find(["cus_8Hq2LmX0"], "customer cus_Q7pXw3Ne failed"), [
    "cus_Q7pXw3Ne",
  ]);
  assert.deepEqual(
    find(["tenant_id=55120"], "where tenant_id=90871 and user_id=3"),
    ["tenant_id=90871"],
  );
  assert.deepEqual(find(["ORD-2291-7734"], "order ORD-8812-0931 shipped"), [
    "ORD-8812-0931",
  ]);
});

test("dotted hosts keep their domain suffix", () => {
  assert.deepEqual(
    find(
      ["db-replica-07.int.quillmark.net"],
      "ssh to pg-primary-02.int.quillmark.net now",
    ),
    ["pg-primary-02.int.quillmark.net"],
  );
  assert.deepEqual(
    find(["db-replica-07.int.quillmark.net"], "fetch registry.npmjs.org"),
    [],
  );
});

test("a code token with a literal prefix also matches without its context words", () => {
  assert.deepEqual(find(["account PX-004417"], "PX-118830 is locked"), [
    "PX-118830",
  ]);
  assert.deepEqual(find(["ticket #558120"], "re #771204 please"), ["#771204"]);
});

test("plain names produce no pattern", () => {
  assert.equal(
    labelPatterns([
      { label: "X", examples: ["Maëlle Dufrasne", "Kestrin Automation"] },
    ]).length,
    0,
  );
});
