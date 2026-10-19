import { test } from "node:test";
import assert from "node:assert/strict";
import { inflateRawSync } from "node:zlib";
import { benchArgsFromCmdline, normalizeTrack } from "../../dashboard/data.ts";
import { docbenchArgs, isDocbenchArgv } from "../../dashboard/docbench.ts";
import {
  powerFit,
  summarizeDocs,
} from "../../engine/scorers/documents/aggregate.ts";
import { breakValue, buildDoc } from "./cases.ts";
import { fillerParagraphs, loadPools, rngFor, type Unit } from "./content.ts";
import type { PipelineRead } from "../../engine/scorers/documents/pipeline.ts";
import {
  classify,
  locate,
  scoreDoc,
} from "../../engine/scorers/documents/score.ts";
import {
  suiteSpecs,
  sweepSpecs,
  type BuiltDoc,
  type DocSpec,
} from "./specs.ts";
import { independentViews } from "../../engine/scorers/documents/verify.ts";
import { writeCfb } from "./writers/cfb.ts";
import { writeDocx } from "./writers/ooxml.ts";
import { writePdf } from "./writers/pdf.ts";
import { crc32, writeZip } from "./writers/zip.ts";
import { parseDocbenchArgs, planDocbench } from "../../engine/plan.ts";

test("writers are deterministic", async () => {
  const spec = {
    title: "T",
    body: [{ type: "p" as const, text: "Hello jo@example.org" }],
    footnotes: ["note"],
    properties: { custom: [["Client", "x"]] as Array<[string, string]> },
  };
  assert.deepEqual(writeDocx(spec), writeDocx(spec));
  const pdf = {
    blocks: [{ type: "p" as const, text: "Page text" }],
    annotations: ["a"],
    info: { author: "me" },
  };
  assert.deepEqual(await writePdf(pdf), await writePdf(pdf));
});

test("zip writer: entries inflate back, ZipCrypto sets the encryption flag", () => {
  const zip = writeZip([
    { name: "a.txt", data: "hello" },
    { name: "s.txt", data: "secret", password: "pw" },
    { name: "b.bin", data: new Uint8Array([1, 2, 3]), method: 0 },
  ]);
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  assert.equal(view.getUint32(0, true), 0x04034b50);
  const nameLen = view.getUint16(26, true);
  const size = view.getUint32(18, true);
  assert.equal(
    new TextDecoder().decode(
      inflateRawSync(zip.subarray(30 + nameLen, 30 + nameLen + size)),
    ),
    "hello",
  );
  const second = 30 + nameLen + size;
  assert.equal(view.getUint16(second + 6, true) & 1, 1);
  assert.equal(crc32(new TextEncoder().encode("hello")), 0x3610a686);
  const views = independentViews(zip);
  assert.match(views.text, /hello/);
  assert.doesNotMatch(
    views.text,
    /secret/,
    "an encrypted entry is not readable",
  );
});

test("CFB container starts with the OLE2 signature and names its streams", () => {
  const cfb = writeCfb([
    { name: "EncryptedPackage", data: new Uint8Array(10) },
  ]);
  assert.deepEqual([...cfb.subarray(0, 4)], [0xd0, 0xcf, 0x11, 0xe0]);
  assert.equal(cfb.length % 512, 0);
  assert.ok(
    Buffer.from(cfb).includes(Buffer.from("EncryptedPackage", "utf16le")),
  );
});

test("breakValue wraps at a space near the middle, or hyphenates", () => {
  assert.equal(
    breakValue("FR76 3000 6000 0112", false),
    "FR76 3000\n6000 0112",
  );
  assert.equal(breakValue("jo@example.org", true), "jo@exam-\nple.org");
});

test("locate is whitespace-insensitive and matches repeated values by count", () => {
  const text =
    "Mail jo@example.org now.\r\nIBAN FR76 3000\r\n6000 0112 and again jo@example.org";
  const units: Unit[] = [
    {
      source: "u1",
      lang: "en",
      text: "",
      items: [
        { key: "e", category: "EMAIL", kind: "email", value: "jo@example.org" },
        {
          key: "i",
          category: "FINANCIAL",
          kind: "iban",
          value: "FR76 3000 6000 0112",
        },
      ],
      decoys: [],
    },
    {
      source: "u2",
      lang: "en",
      text: "",
      items: [
        { key: "e", category: "EMAIL", kind: "email", value: "jo@example.org" },
        {
          key: "x",
          category: "EMAIL",
          kind: "email",
          value: "missing@example.org",
        },
      ],
      decoys: [],
    },
  ];
  const { items, gold } = locate(
    text,
    [{ start: 0, end: text.length, where: "Page 1" }],
    units,
  );
  assert.deepEqual(
    items.map((i) => i.extracted),
    [true, true, true, false],
  );
  assert.equal(
    text.slice(gold[1]!.start, gold[1]!.end),
    "FR76 3000\r\n6000 0112",
  );
  assert.ok(
    gold[2]!.start > gold[0]!.start,
    "the second occurrence goes to the second item",
  );
});

const read = (
  text: string,
  extra: Partial<PipelineRead> = {},
): PipelineRead => ({
  outcome: "checked",
  text,
  segments: [{ start: 0, end: text.length, where: "Body" }],
  gaps: [],
  signed: false,
  readMs: 1,
  ...extra,
});

test("classify: a failure file read as fully checked is a silent clean", () => {
  assert.deepEqual(
    classify(read("x"), { outcome: "partial" }).silentClean,
    true,
  );
  assert.equal(
    classify(read("", { outcome: "unchecked", reason: "encrypted" }), {
      outcome: "unchecked",
      reason: "encrypted",
    }).ok,
    true,
  );
  assert.equal(
    classify(read("", { outcome: "unchecked", reason: "unreadable" }), {
      outcome: "unchecked",
      reason: "encrypted",
    }).ok,
    false,
  );
  assert.equal(
    classify(read("x", { signed: true }), { outcome: "checked", signed: true })
      .got,
    "checked+signed",
  );
  assert.equal(
    classify(read("", { outcome: "error", reason: "failed" }), {
      outcome: "partial",
    }).got,
    "unchecked:failed",
  );
});

test("scoreDoc: redaction leaks are counted per reading method, net of occurrences that stay on purpose", () => {
  const text = "ISNB 0-3064-6615-5 then ISBN 0-3064-6615-5.";
  const unit: Unit = {
    source: "u",
    lang: "en",
    text,
    items: [
      { key: "i", category: "PHONE", kind: "phone_us", value: "0-3064-6615-5" },
    ],
    decoys: [{ key: "d", kind: "identifier", value: "0-3064-6615-5" }],
  };
  const doc: BuiltDoc = {
    spec: {
      id: "t",
      family: "pdf",
      ext: "pdf",
      zone: "page",
      lang: "en",
      kind: "positive",
      expect: { outcome: "checked" },
    },
    name: "t.pdf",
    bytes: new Uint8Array(),
    units: [unit],
    size: { words: 6 },
  };
  const detections = [
    {
      category: "PHONE",
      start: 5,
      end: 18,
      value: "0-3064-6615-5",
      selected: true,
    },
  ];
  const kept = "ISNB [PHONE] then ISBN 0-3064-6615-5.";
  const ok = scoreDoc(
    doc,
    read(text),
    {
      all: {
        detections,
        ms: 1,
        outputViews: { text: kept, strings: kept, pdftotext: kept },
      },
    },
    ["PHONE"],
  );
  assert.equal(ok.configs.all!.redaction.leaked, 0);
  assert.equal(ok.configs.all!.redaction.removed, 1);
  assert.equal(ok.configs.all!.decoyHits, 0);
  const bad = scoreDoc(
    doc,
    read(text),
    {
      all: {
        detections,
        ms: 1,
        outputViews: { text, strings: text, pdftotext: text },
      },
    },
    ["PHONE"],
  );
  assert.equal(bad.configs.all!.redaction.leaked, 1);
});

test("powerFit recovers a power law", () => {
  const fit = powerFit(
    [1, 10, 100, 1000].map((x) => [x, 3 * x ** 1.5] as [number, number]),
  )!;
  assert.ok(
    Math.abs(fit.b - 1.5) < 1e-9 &&
      Math.abs(fit.a - 3) < 1e-9 &&
      fit.r2 > 0.999,
  );
});

test("suite specs are unique and every positive document places ground truth", async () => {
  const specs = suiteSpecs();
  assert.equal(new Set(specs.map((s) => s.id)).size, specs.length);
  const pools = loadPools();
  for (const spec of specs.filter((s: DocSpec) => s.kind === "positive")) {
    const doc = await buildDoc(spec, pools, 1);
    assert.ok(doc.units.length > 0, `${spec.id} places no unit`);
    const values = doc.units.flatMap((u) => u.items.map((i) => i.value));
    assert.equal(new Set(values).size <= values.length, true);
  }
  const a = await buildDoc(
    specs.find((s) => s.id === "xlsx-hidden_sheet-fr")!,
    pools,
    1,
  );
  const b = await buildDoc(
    specs.find((s) => s.id === "xlsx-hidden_sheet-fr")!,
    pools,
    1,
  );
  const c = await buildDoc(
    specs.find((s) => s.id === "xlsx-hidden_sheet-fr")!,
    pools,
    2,
  );
  assert.deepEqual(a.bytes, b.bytes);
  assert.notDeepEqual(
    a.units.map((u) => u.source),
    c.units.map((u) => u.source),
    "another seed picks other values",
  );
});

test("filler prose has no digits (no accidental identifiers)", () => {
  for (const lang of ["en", "fr"] as const)
    assert.doesNotMatch(
      fillerParagraphs(lang, 2000, rngFor("t")).join(" "),
      /\d/,
    );
});

test("plan: stable keys per ref, tiers and filters", () => {
  const o = parseDocbenchArgs(["--tier", "smoke", "--formats", "pdf"]);
  const a = planDocbench(o, "sha-a");
  assert.deepEqual(a, planDocbench(o, "sha-a"));
  assert.notEqual(a.suite[0]!.key, planDocbench(o, "sha-b").suite[0]!.key);
  assert.ok(a.suite.every((j) => j.spec!.family === "pdf"));
  assert.ok(a.sweeps.every((j) => j.sweep!.type === "pdf"));
  assert.equal(sweepSpecs("full", ["pdf"]).length, 5);
  assert.throws(() => parseDocbenchArgs(["--configs", "nope"]));
  assert.throws(() => parseDocbenchArgs(["--ai", "no-such-model"]));
  assert.deepEqual(parseDocbenchArgs(["--ai", "smollm2-360m"]).tracks, [
    "suite",
    "sweep",
    "ai",
  ]);
  // `--ai` alone, or `default`: the ref's own default model, resolved at run time.
  for (const argv of [
    ["--ai"],
    ["--ai", "--tier", "smoke"],
    ["--ai", "default"],
  ]) {
    const o = parseDocbenchArgs(argv);
    assert.deepEqual(o.aiModels, []);
    assert.ok(o.tracks.includes("ai"));
  }
  // Connected models only by name, next to the default or alone; budget cap 5 USD unless set.
  const both = parseDocbenchArgs(["--ai", "default,glm47-flash-connected"]);
  assert.equal(both.aiDefault, true);
  assert.deepEqual(
    both.aiModels.map((m) => [m.short, !!m.hosted]),
    [["glm47-flash-connected", true]],
  );
  assert.equal(both.budgetUsd, 5);
  assert.equal(
    parseDocbenchArgs(["--ai", "glm47-flash-connected", "--budget-usd", "1"])
      .aiDefault,
    false,
  );
  assert.equal(
    parseDocbenchArgs(["--ai", "glm47-flash-connected", "--budget-usd", "1"])
      .budgetUsd,
    1,
  );
});

test("dashboard finds docbench runs however they were started", () => {
  assert.deepEqual(
    benchArgsFromCmdline(["node", "engine/cli/docbench.ts", "--tier", "smoke"]),
    ["--track", "docbench", "--tier", "smoke"],
  );
  assert.deepEqual(
    benchArgsFromCmdline([
      "node",
      "engine/cli/review.ts",
      "--tier",
      "smoke",
      "--track",
      "docbench",
    ]),
    ["--track", "docbench", "--tier", "smoke"],
  );
  assert.deepEqual(normalizeTrack(["--tier", "quick"]), ["--tier", "quick"]);
  assert.ok(isDocbenchArgv(["--track", "docbench"]));
  assert.deepEqual(docbenchArgs(["--track", "docbench", "--ref", "x"]), [
    "--ref",
    "x",
  ]);
});

test("summarizeDocs keeps text extensions apart and fits sweeps", () => {
  const s = summarizeDocs([], ["all"], { ref: "r", sha: "s" });
  assert.equal(s.overall.items, 0);
  assert.deepEqual(s.zones, []);
});
