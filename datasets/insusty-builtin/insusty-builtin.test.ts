import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CACHE_DIR } from "../../engine/paths.ts";
import {
  detMetrics,
  summarizeConfig,
} from "../../engine/scorers/builtin-spans/aggregate.ts";
import {
  frenchIban,
  isValidCard,
  isValidFrenchVat,
  isValidIban,
  isValidNhs,
  isValidNino,
  isValidNir,
  isValidSiren,
  isValidSiret,
  isValidSsn,
  nirKey,
} from "./checksums.ts";
import {
  caseFromSource,
  codeRanges,
  loadDetDataset,
  validateSource,
} from "./dataset.ts";
import { generateText } from "./generate.ts";
import { defangHtml, defangJson, hasRawSecretPrefix } from "./defang.ts";
import {
  detectorApi,
  mapCategory,
  type RefDetection,
} from "../../engine/scorers/builtin-spans/detector.ts";
import { loadInsustyModule } from "../../modules/insusty-privacy/insusty.ts";
import { lockSubset } from "../../modules/insusty-privacy/materialize.ts";
import { PERTURBATIONS, perturbCases, valueForms } from "./perturb.ts";
import type { DetCase, DetCaseSource } from "./schema.ts";
import { scoreDetCase } from "../../engine/scorers/builtin-spans/score.ts";

const toCase = (source: DetCaseSource): DetCase => caseFromSource(source);

const sample: DetCaseSource = {
  id: "fr-900",
  lang: "fr",
  register: "email",
  template:
    "Réglez sur l'IBAN {{iban}}, ou appelez le {{phone}} ; écrivez à {{email}}. Build {{sha}} du {{ts}}. Rappel : {{phone}}",
  items: {
    iban: {
      category: "FINANCIAL",
      kind: "iban",
      value: "FR76 6078 0229 8901 2384 8588 948",
    },
    phone: { category: "PHONE", kind: "phone_fr", value: "06 12 48 77 30" },
    email: {
      category: "EMAIL",
      kind: "email",
      value: "contrats@brisemont-conseil.fr",
    },
  },
  decoys: {
    sha: { kind: "git_sha", value: "e29de3427b2f15e19079e69b3512b08b5c9ac355" },
    ts: { kind: "timestamp", value: "2026-09-24 18:02:11" },
  },
};

// ------------------------------------------------------------ checksums

test("checksums accept known-valid identifiers and reject one-digit changes", () => {
  assert.ok(isValidIban("GB82 WEST 1234 5698 7654 32"));
  assert.ok(isValidIban("FR14 2004 1010 0505 0001 3M02 606"));
  assert.ok(!isValidIban("GB82 WEST 1234 5698 7654 33"));
  assert.ok(isValidIban(frenchIban("12345", "67890", "0000123456A")));
  assert.ok(isValidCard("4539 1488 0343 6467"));
  assert.ok(!isValidCard("4539 1488 0343 6468"));
  assert.ok(isValidSiren("732 829 320"));
  assert.ok(isValidSiret("732 829 320 00074"));
  assert.ok(!isValidSiret("732 829 320 00075"));
  assert.ok(isValidFrenchVat("FR44732829320"));
  assert.ok(!isValidFrenchVat("FR45732829320"));
  assert.ok(isValidNir("2 84 05 75 116 023 36"));
  assert.equal(nirKey("177032A198642"), "91");
  assert.ok(isValidNir("1 77 03 2A 198 642 91"));
  assert.ok(!isValidNir("2 84 05 75 116 023 37"));
  assert.ok(isValidNhs("943 476 5919"));
  assert.ok(!isValidNhs("943 476 5918"));
  assert.ok(isValidSsn("536-22-8714"));
  assert.ok(
    !isValidSsn("666-22-8714") &&
      !isValidSsn("936-22-8714") &&
      !isValidSsn("536-00-8714"),
  );
  assert.ok(isValidNino("JT 48 29 61 B") && isValidNino("pe482917a"));
  assert.ok(
    !isValidNino("QQ 12 34 56 C") &&
      !isValidNino("GB 12 34 56 A") &&
      !isValidNino("JO 12 34 56 A") &&
      !isValidNino("JT 48 29 61 E"),
  );
});

// ------------------------------------------------------------ dataset

test("templates render to exact spans, including repeated placeholders", () => {
  const c = toCase(sample);
  assert.equal(c.type, "multi");
  assert.equal(c.gold.length, 4);
  for (const g of c.gold) assert.equal(c.text.slice(g.start, g.end), g.value);
  for (const d of c.decoySpans)
    assert.equal(c.text.slice(d.start, d.end), d.value);
  assert.deepEqual(
    c.gold.filter((g) => g.key === "phone").map((g) => g.value),
    ["06 12 48 77 30", "06 12 48 77 30"],
  );
});

test("the validator rejects bad checksums, undefined or unused keys and wrong kinds", () => {
  assert.deepEqual(validateSource(sample, "fr"), []);
  const bad: DetCaseSource = {
    ...sample,
    template: sample.template + " {{nope}}",
    items: {
      ...sample.items,
      iban: {
        category: "FINANCIAL",
        kind: "iban",
        value: "FR76 6078 0229 8901 2384 8588 949",
      },
      extra: { category: "PHONE", kind: "iban", value: "x" },
    },
  };
  const issues = validateSource(bad, "fr").join("\n");
  assert.match(issues, /\{\{nope\}\} is not defined/);
  assert.match(issues, /fails its checksum/);
  assert.match(issues, /extra is defined but unused/);
  assert.match(issues, /kind iban is not a PHONE kind/);
  assert.match(validateSource(sample, "en").join(), /lang fr in the en file/);
});

test("an invalid_checksum decoy must name a checksummed kind and fail it", () => {
  const base: DetCaseSource = {
    id: "en-902",
    lang: "en",
    register: "chat",
    template: "is {{bad}} a valid IBAN?",
  };
  const ok = {
    ...base,
    decoys: {
      bad: {
        kind: "invalid_checksum" as const,
        value: "GB82 WEST 1234 5698 7654 33",
        of: "iban",
      },
    },
  };
  assert.deepEqual(validateSource(ok, "en"), []);
  const passes = {
    ...base,
    decoys: {
      bad: {
        kind: "invalid_checksum" as const,
        value: "GB82 WEST 1234 5698 7654 32",
        of: "iban",
      },
    },
  };
  assert.match(validateSource(passes, "en").join(), /passes the iban checksum/);
  const noKind = {
    ...base,
    decoys: {
      bad: {
        kind: "invalid_checksum" as const,
        value: "GB82 WEST 1234 5698 7654 33",
      },
    },
  };
  assert.match(validateSource(noKind, "en").join(), /needs "of"/);
  const stray = {
    ...base,
    decoys: { bad: { kind: "number" as const, value: "42", of: "iban" } },
  };
  assert.match(validateSource(stray, "en").join(), /only for invalid_checksum/);
});

test("code ranges follow Markdown fences and indented blocks; spans carry their zone", () => {
  const text = [
    "prose `inline` a",
    "```sh",
    "code b",
    "```",
    "prose c",
    "",
    "    indented d",
    "prose e",
    "    not code f",
    "~~~~",
    "code g",
    "~~~",
    "~~~",
    "open h",
  ].join("\n");
  const ranges = codeRanges(text);
  const inCode = (word: string) =>
    ranges.some(([s, e]) => s <= text.indexOf(word) && text.indexOf(word) < e);
  assert.deepEqual(
    ["a", "b", "c", "d", "e", "f", "g", "h"].map(
      (w) => inCode(` ${w}`) || inCode(`${w}\n`),
    ),
    [false, true, false, true, false, false, true, true],
  );
  const c = toCase({
    id: "en-903",
    lang: "en",
    register: "code",
    template: "mail {{email}}:\n\n```\nSMTP_USER={{email}}\nPORT={{port}}\n```",
    items: {
      email: { category: "EMAIL", kind: "email", value: "ops@lanternbay.io" },
    },
    decoys: { port: { kind: "port", value: "587" } },
  });
  assert.deepEqual(
    c.gold.map((g) => g.zone),
    ["prose", "code"],
  );
  assert.equal(c.decoySpans[0]!.zone, "code");
  // Only the second occurrence is found: recall 1/2 overall, 0 in prose, 1 in code.
  const s = scoreDetCase(
    c,
    [det(c, "EMAIL", "ops@lanternbay.io", 1), det(c, "PHONE", "587")],
    ["EMAIL", "PHONE"],
    "all",
  );
  assert.equal(detMetrics([s]).overlap.recall, 1 / 2);
  const prose = detMetrics([s], { zone: "prose" });
  const code = detMetrics([s], { zone: "code" });
  assert.equal(prose.overlap.recall, 0);
  assert.equal(prose.detections, 0);
  assert.equal(code.overlap.recall, 1);
  assert.equal(code.overlap.precision, 1 / 2);
  assert.equal(code.decoysFlagged, 1);
  assert.equal(prose.decoys, 0);
  assert.deepEqual(Object.keys(summarizeConfig("all", [s]).byZone), [
    "prose",
    "code",
  ]);
});

test("a case counts under each of its tags", () => {
  const tagged = (id: string, tags: string[]) =>
    scoreDetCase(
      toCase({
        id,
        lang: "fr",
        register: "doc",
        template: "à {{a}}",
        items: {
          a: {
            category: "ADDRESS",
            kind: "address_fr",
            value: "7 rue des Glycines\n00100 Nulleville",
          },
        },
        tags,
      }),
      [],
      ["ADDRESS"],
      "all",
    );
  const byTag = summarizeConfig("all", [
    tagged("fr-901", ["fr_multiline_address", "ocr_scan"]),
    tagged("fr-902", ["fr_multiline_address"]),
  ]).byTag!;
  assert.deepEqual(Object.keys(byTag), ["fr_multiline_address", "ocr_scan"]);
  assert.equal(byTag.fr_multiline_address!.cases, 2);
  assert.equal(byTag.ocr_scan!.cases, 1);
  assert.equal(byTag.ocr_scan!.overlap.recall, 0);
});

test("the code_block perturbation fences around a prompt that already has a fence", () => {
  const c = toCase({
    id: "en-904",
    lang: "en",
    register: "code",
    template: "why?\n```\nKEY={{k}}\n```",
    items: {
      k: {
        category: "SECRET",
        kind: "generic_token",
        value: "nG5SwHznJ9JtvEVhx5AT1FRoNMiKsAME",
      },
    },
  });
  for (const v of perturbCases([c], {
    seed: 1,
    variants: 4,
    types: ["code_block"],
  })) {
    const outer = /^[`~]+/m.exec(v.text.split("\n")[1]!)![0];
    assert.ok(outer[0] === "~" || outer.length > 3, v.text);
    assert.ok(v.text.endsWith(`\n${outer}`));
    assert.equal(v.gold[0]!.zone, "code");
  }
});

test("the committed dataset is valid, bilingual and defanged", () => {
  const { dataset, issues } = loadDetDataset();
  assert.deepEqual(issues, []);
  assert.ok(dataset);
  const langs = new Set(dataset.cases.map((c) => c.lang));
  assert.deepEqual([...langs].sort(), ["en", "fr"]);
  for (const type of ["negative", "single", "multi"])
    assert.ok(
      dataset.cases.some((c) => c.type === type),
      type,
    );
  for (const zone of ["prose", "code"])
    for (const lang of ["en", "fr"])
      assert.ok(
        dataset.cases.some(
          (c) => c.lang === lang && c.gold.some((g) => g.zone === zone),
        ),
        `${lang} ${zone}`,
      );
});

// ------------------------------------------------------------ perturbations

test("perturbations are deterministic for a seed and keep spans exact", () => {
  const { dataset } = loadDetDataset();
  const bases = dataset!.cases;
  const a = perturbCases(bases, { seed: 7, variants: 2 });
  const b = perturbCases(bases, { seed: 7, variants: 2 });
  const c = perturbCases(bases, { seed: 8, variants: 2 });
  assert.deepEqual(
    a.map((v) => [v.id, v.text]),
    b.map((v) => [v.id, v.text]),
  );
  assert.notDeepEqual(
    a.map((v) => v.text),
    c.map((v) => v.text),
  );
  for (const type of PERTURBATIONS)
    assert.ok(
      a.some((v) => v.perturbation === type),
      `no ${type} variant`,
    );
  const baseText = new Map(bases.map((x) => [x.id, x.text]));
  for (const v of a) {
    assert.notEqual(
      v.text,
      baseText.get(v.baseId),
      `${v.id} did not change the text`,
    );
    for (const g of v.gold)
      assert.equal(v.text.slice(g.start, g.end), g.value, v.id);
    for (const d of v.decoySpans)
      assert.equal(v.text.slice(d.start, d.end), d.value, v.id);
    const base = bases.find((x) => x.id === v.baseId)!;
    // The settings snippet lists each item once; every other type keeps every occurrence.
    if (v.perturbation === "env")
      assert.deepEqual(
        new Set(v.gold.map((g) => g.key)),
        new Set(base.gold.map((g) => g.key)),
        v.id,
      );
    else
      assert.equal(
        v.gold.length,
        base.gold.length,
        `${v.id} lost or gained items`,
      );
  }
  // A variant does not depend on the other cases in the run.
  const alone = perturbCases([bases[0]!], { seed: 7, variants: 2 });
  assert.deepEqual(
    alone.map((v) => v.text),
    a.filter((v) => v.baseId === bases[0]!.id).map((v) => v.text),
  );
});

test("value forms cover the documented formats", () => {
  const phone = {
    category: "PHONE" as const,
    kind: "phone_fr",
    value: "06 12 34 56 78",
  };
  assert.ok(
    valueForms("separators", phone, phone.value, "fr").includes(
      "06.12.34.56.78",
    ),
  );
  assert.ok(
    valueForms("alt_format", phone, phone.value, "fr").includes(
      "+33 6 12 34 56 78",
    ),
  );
  assert.ok(
    valueForms("spacing", phone, phone.value, "fr").includes("0612345678"),
  );
  const iban = {
    category: "FINANCIAL" as const,
    kind: "iban",
    value: "FR7660780229890123848588948",
  };
  assert.ok(
    valueForms("spacing", iban, iban.value, "fr").includes(
      "FR76 6078 0229 8901 2384 8588 948",
    ),
  );
  assert.ok(
    valueForms(
      "linebreak",
      iban,
      "FR76 6078 0229 8901 2384 8588 948",
      "fr",
    ).every((v) => v.includes("\n")),
  );
  const us = {
    category: "PHONE" as const,
    kind: "phone_us",
    value: "(415) 555-0132",
  };
  assert.ok(
    valueForms("alt_format", us, us.value, "en").includes("+1 415 555 0132"),
  );
  const dob = {
    category: "DATE_OF_BIRTH" as const,
    kind: "dob",
    value: "14/03/1991",
    iso: "1991-03-14",
  };
  assert.ok(
    valueForms("alt_format", dob, dob.value, "fr").includes("14 mars 1991"),
  );
  assert.ok(
    valueForms("separators", dob, dob.value, "fr").includes("14.03.1991"),
  );
  const addr = {
    category: "ADDRESS" as const,
    kind: "address_fr",
    value: "12 bis rue des Lilas, 69003 Lyon",
  };
  assert.deepEqual(valueForms("linebreak", addr, addr.value, "fr"), [
    "12 bis rue des Lilas\n69003 Lyon",
  ]);
  const key = {
    category: "SECRET" as const,
    kind: "openai_key",
    value: "sk-abc",
  };
  assert.deepEqual(valueForms("spacing", key, key.value, "en"), []);
});

test("context perturbations wrap, rewrite and strip as documented", () => {
  const base = toCase(sample);
  const [fence] = perturbCases([base], {
    seed: 1,
    variants: 1,
    types: ["code_block"],
  });
  assert.match(fence!.text, /\n(```|~~~)[a-z]*\n[\s\S]*\n(```|~~~)$/);
  const [env] = perturbCases([base], { seed: 1, variants: 1, types: ["env"] });
  assert.match(env!.text, /PAYOUT_IBAN|payout_iban/);
  assert.equal(
    env!.gold.length,
    3,
    "a repeated item appears once in the settings snippet",
  );
  const [accents] = perturbCases([base], {
    seed: 1,
    variants: 1,
    types: ["accents"],
  });
  assert.ok(
    accents!.text.includes("Reglez") && accents!.text.includes("ecrivez"),
  );
  const [upper] = perturbCases([base], {
    seed: 3,
    variants: 2,
    types: ["case"],
  }).filter((v) => v.perturbationNote === "upper case");
  if (upper) {
    assert.ok(upper.text.includes("CONTRATS@BRISEMONT-CONSEIL.FR"));
    assert.ok(
      upper.text.includes(
        "e29de3427b2f15e19079e69b3512b08b5c9ac355".toUpperCase(),
      ),
    );
  }
  const [typo] = perturbCases([base], {
    seed: 1,
    variants: 1,
    types: ["typo"],
  });
  assert.notEqual(typo!.text, base.text);
  assert.deepEqual(
    typo!.gold.map((g) => g.value),
    base.gold.map((g) => g.value),
  );
  const [punct] = perturbCases([base], {
    seed: 1,
    variants: 1,
    types: ["punctuation"],
  });
  assert.doesNotMatch(punct!.text, /[.,;:!]{2}/);
});

// ------------------------------------------------------------ scoring

const det = (
  c: DetCase,
  category: string,
  value: string,
  occurrence = 0,
  extend = 0,
): RefDetection => {
  let start = -1;
  for (let i = 0; i <= occurrence; i++)
    start = c.text.indexOf(value, start + 1);
  assert.ok(start >= 0, value);
  return {
    category,
    mapped: mapCategory(category),
    start: start - extend,
    end: start + value.length,
    value,
    source: "t",
    selected: true,
  };
};

test("detections get one verdict each and items their flags", () => {
  const c = toCase(sample);
  const detections: RefDetection[] = [
    det(c, "PHONE", "06 12 48 77 30"), // exact tp
    det(c, "PHONE", "12 48 77 30", 1), // partial tp on the second occurrence
    det(c, "EMAIL", "contrats@brisemont-conseil.fr", 0, 3), // tp, not exact ("à " included)
    det(c, "API_KEY", "e29de3427b2f15e19079e69b3512b08b"), // decoy
    det(c, "PHONE", "2026-09-24 18"), // decoy
    det(c, "PHONE", "6078 0229 8901"), // on an unsupported FINANCIAL item
    { ...det(c, "EMAIL", "Réglez"), selected: false }, // unselected: ignored
  ];
  const s = scoreDetCase(
    c,
    detections,
    ["SECRET", "PHONE", "EMAIL", "ADDRESS"],
    "default",
  );
  assert.deepEqual(
    s.detections.map((d) => d.verdict),
    ["tp", "tp", "tp", "decoy", "decoy", "unsupported_item"],
  );
  assert.equal(s.unselected, 1);
  const byKey = (key: string, n = 0) =>
    s.items.filter((i) => i.key === key)[n]!;
  assert.ok(byKey("phone").exact && byKey("phone").leakFree);
  assert.ok(
    byKey("phone", 1).overlap &&
      !byKey("phone", 1).exact &&
      !byKey("phone", 1).leakFree,
  );
  assert.ok(
    byKey("email").overlap && !byKey("email").exact && byKey("email").leakFree,
  );
  assert.ok(
    !byKey("iban").supported &&
      byKey("iban").redacted &&
      !byKey("iban").leakFree,
  );
  assert.deepEqual(byKey("iban").detectedAs, ["PHONE"]);
  assert.deepEqual(
    s.decoys.map((d) => [d.kind, d.flagged]),
    [
      ["git_sha", true],
      ["timestamp", true],
    ],
  );

  const m = detMetrics([s]);
  assert.equal(m.supportedItems, 3);
  assert.equal(m.unsupportedItems, 1);
  assert.equal(
    m.detections,
    5,
    "the detection on the unsupported item is left out of precision",
  );
  assert.equal(m.overlap.precision, 3 / 5);
  assert.equal(m.overlap.recall, 1);
  assert.equal(m.exact.recall, 1 / 3);
  assert.equal(m.redactedRecall, 1);
  assert.equal(m.unsupportedRedacted, 1);
  assert.equal(m.decoysFlagged, 2);
  const phone = detMetrics([s], { category: "PHONE" });
  assert.equal(phone.detections, 3);
  assert.equal(phone.overlap.precision, 2 / 3);
});

test("a span swallowing two items marks both merged; a wrong category is a false positive", () => {
  const source: DetCaseSource = {
    id: "en-900",
    lang: "en",
    register: "log",
    template: "DSN postgres://app:{{pw}}@{{ip}}:5432/db",
    items: {
      pw: { category: "SECRET", kind: "password", value: "Kx7vR2mQp9" },
      ip: { category: "IP", kind: "ipv4_private", value: "10.0.4.12" },
    },
  };
  const c = toCase(source);
  const s = scoreDetCase(
    c,
    [det(c, "EMAIL", "Kx7vR2mQp9@10.0.4.12")],
    ["SECRET", "EMAIL", "IP"],
    "all",
  );
  assert.equal(s.detections[0]!.verdict, "wrong_category");
  assert.ok(s.items.every((i) => i.merged && i.redacted && !i.overlap));
  const m = detMetrics([s]);
  assert.equal(m.wrongCategory, 1);
  assert.equal(m.falsePositives, 1);
  assert.equal(m.mergedItems, 2);
  // Only one of the two categories supported: the detection is still wrong (it hit a supported item).
  const partial = scoreDetCase(
    c,
    [det(c, "EMAIL", "Kx7vR2mQp9@10.0.4.12")],
    ["SECRET", "EMAIL"],
    "all",
  );
  assert.equal(partial.detections[0]!.verdict, "wrong_category");
});

test("negatives count cases with a false positive; perturbations compare to the same base cases", () => {
  const neg = toCase({
    id: "en-901",
    lang: "en",
    register: "log",
    template: "at {{ts}} ok",
    decoys: { ts: { kind: "timestamp", value: "2026-09-24 18:02:11" } },
  });
  const pos = toCase(sample);
  const rows = [
    scoreDetCase(
      neg,
      [det(neg, "PHONE", "2026-09-24 18")],
      ["PHONE"],
      "default",
    ),
    scoreDetCase(
      pos,
      [det(pos, "PHONE", "06 12 48 77 30")],
      ["PHONE"],
      "default",
    ),
    scoreDetCase(
      { ...pos, id: "fr-900~spacing~1", perturbation: "spacing" },
      [],
      ["PHONE"],
      "default",
    ),
  ];
  const summary = summarizeConfig("default", rows);
  assert.equal(
    summary.overall.cases,
    2,
    "headline metrics use base cases only",
  );
  assert.equal(summary.overall.negativeFpRate, 1);
  assert.equal(summary.byCategory.FINANCIAL!.supportedItems, 0);
  const spacing = summary.perturbations.spacing!;
  assert.equal(spacing.baseCases, 1);
  assert.equal(spacing.base.overlap.recall, 1 / 2);
  assert.equal(spacing.perturbed.overlap.recall, 0);
});

test("generated placeholders render large deterministic tables, scored apart and never perturbed", () => {
  const source: DetCaseSource = {
    id: "en-903",
    lang: "en",
    register: "table",
    template: "Order\tStatus\n{{rows_a}}\nORD-9\t{{email}}\n{{rows_b}}",
    items: {
      email: { category: "EMAIL", kind: "email", value: "jo@example.com" },
    },
    generated: {
      rows_a: { generator: "orders_tsv", from: 10000, count: 3 },
      rows_b: { generator: "orders_tsv", from: 10003, count: 2 },
    },
  };
  assert.deepEqual(validateSource(source, "en"), []);
  assert.equal(
    generateText({ generator: "orders_tsv", from: 10000, count: 1 }),
    "ORD-0-10000\tCustomer 230\t35000\tnote 10000\tok",
  );
  const report = generateText({
    generator: "gpu_report",
    from: 0,
    count: 12,
  }).split("\n");
  assert.equal(
    report[0],
    "*   emulateRenderbufferStoragePixel (OpenGL workarounds): Disabled",
  );
  assert.equal(report[5], "__GLX_VENDOR_LIBRARY_NAME       : mesa");
  assert.equal(report.length, 12);
  const c = toCase(source);
  assert.ok(c.large);
  assert.equal(c.text.split("\n").length, 7);
  assert.equal(
    c.text.slice(c.gold[0]!.start, c.gold[0]!.end),
    "jo@example.com",
  );
  assert.deepEqual(
    perturbCases([c], { seed: 1, variants: 2 }),
    [],
    "large cases are not perturbed",
  );

  const bad = (
    generated: DetCaseSource["generated"],
    template = source.template,
  ) => validateSource({ ...source, template, generated }, "en").join("\n");
  assert.match(
    bad({
      ...source.generated,
      rows_a: { generator: "nope", from: 0, count: 1 },
    }),
    /unknown generator nope/,
  );
  assert.match(
    bad({
      ...source.generated,
      rows_a: { generator: "orders_tsv", from: 0, count: 0 },
    }),
    /count from 1/,
  );
  assert.match(
    bad({
      ...source.generated,
      extra: { generator: "orders_tsv", from: 0, count: 1 },
    }),
    /extra is defined but unused/,
  );
  assert.match(
    bad(
      {
        ...source.generated,
        email: { generator: "orders_tsv", from: 0, count: 1 },
      },
      source.template,
    ),
    /defined twice/,
  );

  const small = toCase(sample);
  const rows = [
    scoreDetCase(
      small,
      [det(small, "PHONE", "06 12 48 77 30")],
      ["PHONE", "ADDRESS"],
      "default",
    ),
    scoreDetCase(
      c,
      [
        det(c, "EMAIL", "jo@example.com"),
        det(c, "ADDRESS", "35000\tnote 10000\tok"),
        det(c, "ADDRESS", "35003.5\tnote 10001"),
      ],
      ["EMAIL", "ADDRESS"],
      "default",
    ),
  ];
  const summary = summarizeConfig("default", rows);
  assert.equal(
    summary.overall.cases,
    1,
    "the large case stays out of the headline metrics",
  );
  assert.equal(summary.overall.falsePositives, 0);
  assert.deepEqual(summary.large, [
    {
      caseId: "en-903",
      lang: "en",
      chars: c.text.length,
      lines: 7,
      items: 1,
      found: 1,
      redacted: 1,
      falsePositives: 2,
      fpByCategory: { ADDRESS: 2 },
    },
  ]);
});

// ------------------------------------------------------------ helpers

test("category aliases map today's and the upgrade's names", () => {
  assert.equal(mapCategory("API_KEY"), "SECRET");
  assert.equal(mapCategory("SECRET"), "SECRET");
  assert.equal(mapCategory("IP_ADDRESS"), "IP");
  assert.equal(mapCategory("NATIONAL_ID"), "NATIONAL_ID");
  assert.equal(mapCategory("COMPANY_ID"), "COMPANY_ID");
  assert.equal(mapCategory("SOMETHING_NEW"), null);
});

test("lockSubset follows nested and hoisted dependencies", () => {
  const lock = {
    packages: {
      "": { dependencies: { a: "^1" } },
      "node_modules/a": {
        version: "1.0.0",
        dependencies: { b: "^1", c: "^2" },
      },
      "node_modules/a/node_modules/b": {
        version: "1.5.0",
        dependencies: { c: "^2" },
      },
      "node_modules/b": { version: "2.0.0" },
      "node_modules/c": { version: "2.1.0", dev: true },
      "node_modules/unrelated": { version: "9.9.9" },
    },
  };
  const subset = lockSubset(lock, ["a"]);
  assert.deepEqual(Object.keys(subset).sort(), [
    "node_modules/a",
    "node_modules/a/node_modules/b",
    "node_modules/c",
  ]);
  assert.equal(subset["node_modules/c"]!.dev, undefined);
  assert.throws(() => lockSubset(lock, ["missing"]));
});

test("defanging keeps values intact after JSON.parse and hides raw prefixes", () => {
  // Built by concatenation so this file holds no scanner-shaped literal.
  const value = {
    t: `key ${"sk_" + "live_abc"} and ${"xoxb" + "-123"} ${"AKIA" + "ABCDEFGHIJKLMNOP"} -----${"BEGIN"} PRIVATE KEY----- ${"mongodb+"}srv://u:p@c0.x.mongodb.net Server=tcp:x.${"database"}.windows.net`,
    n: 1,
  };
  const json = defangJson(JSON.stringify(value));
  assert.ok(!hasRawSecretPrefix(json));
  assert.deepEqual(JSON.parse(json), value);
  assert.equal(defangJson(json), json, "idempotent");
  const html = defangHtml(`<p>${"sk_" + "live_abc"}</p>`);
  assert.ok(!html.includes("sk_live_") && html.includes("&#"));
});

test("the module adapter reads an upgraded ref's categories, defaults and switched-off categories", async () => {
  const dir = join(CACHE_DIR, "tmp", `detbench-test-${process.pid}`);
  mkdirSync(dir, { recursive: true });
  const bundle = join(dir, "module.mjs");
  // A stand-in for an upgraded ref: SECRET instead of API_KEY, FINANCIAL off by default.
  writeFileSync(
    bundle,
    `const CATEGORIES = ["SECRET", "PHONE", "FINANCIAL"];
const DEFAULT_CONFIG = { categories: { SECRET: true, PHONE: true, FINANCIAL: false }, addressCountries: ["FR"] };
const SUPPORTED_ADDRESS_COUNTRIES = ["FR", "US"];
function detectSensitiveData(text, config) {
  const out = [];
  const iban = text.indexOf("FR76");
  if (iban >= 0) out.push({ category: "FINANCIAL", start: iban, end: iban + 4, value: "FR76", source: "t", selected: config.categories.FINANCIAL });
  return out;
}
export const detector = { detectSensitiveData };
export const config = { CATEGORIES, DEFAULT_CONFIG, SUPPORTED_ADDRESS_COUNTRIES };
`,
  );
  try {
    const module = await loadInsustyModule({
      ref: "test",
      sha: "0".repeat(40),
      subject: "",
      committedAt: "",
      dir,
      bundle,
      modules: {},
      packages: {},
      runtime: {},
    });
    const api = detectorApi(module);
    assert.deepEqual(api.supported, ["SECRET", "PHONE", "FINANCIAL"]);
    assert.match(api.allConfigNote, /turns on FINANCIAL/);
    assert.match(api.allConfigNote, /adds address countries US/);
    const [off] = (await api.detect("IBAN FR76 ...", "default")).detections;
    const [on] = (await api.detect("IBAN FR76 ...", "all")).detections;
    assert.equal(off!.selected, false);
    assert.equal(on!.selected, true);
    assert.equal(on!.mapped, "FINANCIAL");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
