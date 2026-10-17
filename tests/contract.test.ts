import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { checkConformance, outputProblems, schemaErrors, SCHEMA_FILE } from "../contract/conformance.ts";
import { outputToJson } from "../contract/json.ts";
import { referenceModule } from "../contract/reference-module.ts";
import { CONTRACT_VERSION, isCompatibleContract, type ModuleConfig, type RedactionOutput } from "../contract/types.ts";

/** Every field of every output type set: the TypeScript type checks that it still exists, the schema test that the schema knows it. */
const FULL: RedactionOutput = {
  contract: CONTRACT_VERSION,
  module: { name: "full", version: "1.0.0", sha: "abc" },
  text: "Mail jo@example.org now",
  parts: [{ start: 0, end: 23, where: "Page 1", page: 1 }],
  spans: [{ start: 5, end: 19, label: "EMAIL", kind: "builtin", subtype: "email", source: "rules", redacted: true, confidence: 0.9, page: 1, box: [1, 2, 3, 4] }],
  redaction: {
    text: "Mail [EMAIL] now",
    file: { name: "a.pdf", type: "application/pdf", bytes: new Uint8Array([1, 2, 3]) },
    mode: "in_place",
    leakChecked: true,
    unredactable: [{ start: 5, end: 19 }],
    error: "none",
  },
  coverage: { checked: "full", reason: "ok", gaps: [], format: "pdf", pages: 1, ocrPages: 0, signed: false },
  runtime: {
    stages: [{ stage: "rules", ms: 1, pages: 1, requests: 0 }],
    totalMs: 2,
    peakRssMb: 100,
    charsPerSecond: 1000,
    pagesPerMinute: 30,
    backend: { name: "wasm", threads: 4, dtype: "q8" },
    model: { id: "m", bytes: 10, cold: true, loadMs: 5 },
    cost: { usd: 0.001, provider: "bedrock", connected: true },
    requests: [{ label: "X", ms: 1, promptTokens: 1, outputTokens: 1, finishReason: "stop", output: "NONE", confidence: 0.5, cached: false }],
    machine: { id: "adhoc", cpu: "cpu", cores: 8, ramMb: 7000, os: "linux", node: "24", python: "3.14", chrome: "140", powerMode: "balanced" },
  },
};
const CONFIG: ModuleConfig = {
  builtins: { EMAIL: true },
  addressCountries: ["FR"],
  customLabels: [{ label: "PROJECT", description: "codenames", examples: ["Bluefin"] }],
  privateAi: { runsOn: "connected", model: "m", backend: "wasm" },
  ocr: { enabled: false, languages: ["eng"] },
  limits: { characters: 10 },
};
const caps = { capabilities: { builtins: ["EMAIL" as const], customLabels: true, documents: true, ocr: false, privateAi: ["connected" as const] } };

test("the schema and the types carry the same version", () => {
  const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as { version: string; $id: string };
  assert.equal(schema.version, CONTRACT_VERSION);
  assert.ok(schema.$id.endsWith(`${CONTRACT_VERSION}.json`));
});

test("a fully populated output and configuration match the schema, which has no field the types lack", () => {
  assert.deepEqual(schemaErrors("RedactionOutput", outputToJson(FULL)), []);
  assert.deepEqual(schemaErrors("ModuleConfig", CONFIG), []);
  // Every schema property is used by FULL or CONFIG: a property only the schema has would fail here.
  const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as { $defs: Record<string, { properties?: Record<string, unknown> }> };
  const used = new Set<string>();
  const walk = (v: unknown) => {
    if (Array.isArray(v)) v.forEach(walk);
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) (used.add(k), walk(x));
  };
  walk(outputToJson(FULL, true));
  walk(CONFIG);
  walk({ kind: "text", text: "", language: "en", name: "x", bytes: 0 });
  walk(caps.capabilities);
  for (const [def, s] of Object.entries(schema.$defs)) for (const key of Object.keys(s.properties ?? {})) assert.ok(used.has(key), `${def}.${key} is in the schema but not in the types' example`);
});

test("the schema rejects unknown fields and bad values", () => {
  assert.notDeepEqual(schemaErrors("RedactionOutput", { ...(outputToJson(FULL) as object), extra: 1 }), []);
  assert.notDeepEqual(schemaErrors("RedactionOutput", { ...(outputToJson(FULL) as object), contract: "1.0" }), []);
  assert.notDeepEqual(schemaErrors("ModuleConfig", { ...CONFIG, builtins: { NAME: true } }), []);
  assert.notDeepEqual(schemaErrors("ModuleConfig", { ...CONFIG, addressCountries: ["fra"] }), []);
});

test("conformance rules catch what the schema cannot", () => {
  const input = { kind: "text" as const, text: FULL.text };
  assert.deepEqual(outputProblems(caps, input, CONFIG, FULL), []);
  const bad = (patch: Partial<RedactionOutput>) => outputProblems(caps, input, CONFIG, { ...FULL, ...patch });
  assert.match(bad({ spans: [{ ...FULL.spans[0]!, end: 99 }] }).join(), /outside the text/);
  assert.match(bad({ spans: [{ ...FULL.spans[0]!, label: "PHONE" }] }).join(), /does not declare/);
  assert.match(bad({ spans: [{ ...FULL.spans[0]!, kind: "custom", label: "OTHER" }] }).join(), /custom label not in the configuration/);
  assert.match(bad({ redaction: { ...FULL.redaction, text: FULL.text } }).join(), /still in redaction.text/);
  assert.match(bad({ text: "other" }).join(), /differs from the input/);
  assert.match(outputProblems(caps, input, { ...CONFIG, builtins: { EMAIL: false } }, FULL).join(), /switched off/);
  assert.match(outputProblems(caps, input, { ...CONFIG, privateAi: { runsOn: "off" } }, FULL).join(), /cost without a connected model/);
  assert.match(bad({ runtime: { ...FULL.runtime, totalMs: 0, stages: [{ stage: "model", ms: 50 }] } }).join(), /below its longest stage/);
});

test("a value also present unredacted elsewhere is not a leak", () => {
  const text = "jo@example.org wrote jo@example.org";
  const out: RedactionOutput = { ...FULL, text, parts: [], spans: [{ ...FULL.spans[0]!, start: 0, end: 14 }, { ...FULL.spans[0]!, start: 21, end: 35, redacted: false }], redaction: { mode: "in_place", leakChecked: false, text: "[EMAIL] wrote jo@example.org" } };
  assert.deepEqual(outputProblems(caps, { kind: "text", text }, CONFIG, out), []);
});

test("major versions decide compatibility", () => {
  assert.ok(isCompatibleContract("1.4.2"));
  assert.ok(!isCompatibleContract("2.0.0"));
  assert.ok(!isCompatibleContract("1.0"));
});

test("the reference module conforms", async () => {
  const results = await checkConformance(referenceModule());
  assert.deepEqual(results.filter((r) => r.problems.length), []);
});

test("a module that leaks a redacted value fails conformance", async () => {
  const ref = referenceModule();
  const leaky = { ...ref, redact: async (...args: Parameters<typeof ref.redact>) => {
    const out = await ref.redact(...args);
    return out.redaction.text === undefined ? out : { ...out, redaction: { ...out.redaction, text: out.text } };
  } };
  const failed = (await checkConformance(leaky)).filter((r) => r.problems.length);
  assert.ok(failed.some((r) => r.problems.some((p) => /still in redaction.text/.test(p))));
});
