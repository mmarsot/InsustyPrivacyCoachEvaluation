import { test } from "node:test";
import assert from "node:assert/strict";
import { referenceModule } from "../contract/reference-module.ts";
import { BUILTIN_LABELS } from "../contract/types.ts";
import { PRESIDIO_BUILTINS } from "../modules/presidio/presidio.ts";
import { adapterIssues, draftAdapter, labelTargets } from "./adapter.ts";
import { allLabelsConfig, configFor, manifestIssues } from "./module.ts";
import {
  buildGrid,
  datasetIds,
  moduleIds,
  readAdapter,
  readDatasetContract,
  readModuleManifest,
  resolveLiteratureDataset,
  resolveModuleId,
} from "./registry.ts";
import { routeBench } from "./route.ts";

test("every module's dataset adapters validate against the dataset contracts", () => {
  for (const m of moduleIds()) {
    const manifest = readModuleManifest(m);
    assert.equal(manifest.id, m);
    for (const d of datasetIds()) {
      const adapter = readAdapter(m, d);
      if (!adapter) continue;
      const contract = readDatasetContract(d);
      assert.ok(contract, `${d} has a contract`);
      assert.deepEqual(
        adapterIssues(adapter, contract, manifest),
        [],
        `${m} × ${d}`,
      );
    }
  }
});

test("the grid shows the approved cells: runnable, partial with N of M labels, no adapter, n/a, same as rules, blocked", () => {
  const cells = buildGrid().cells;
  const at = (m: string, c: string, d: string) =>
    cells.find(
      (x) => x.module === m && x.configuration === c && x.dataset === d,
    )!;
  assert.equal(
    at("insusty-privacy", "rules", "insusty-builtin").state,
    "runnable",
  );
  assert.equal(at("insusty-privacy", "rules", "insusty-custom").state, "n/a");
  assert.equal(
    at("insusty-privacy", "smollm2-360m", "insusty-custom").state,
    "runnable",
  );
  assert.equal(
    at("insusty-privacy", "smollm2-360m", "insusty-builtin").state,
    "same-as-rules",
  );
  assert.equal(
    at("insusty-privacy", "smollm2-360m", "insusty-documents").state,
    "runnable",
  );
  const gretel = at("insusty-privacy", "rules", "gretel");
  assert.equal(gretel.state, "partial");
  assert.deepEqual([gretel.mapped, gretel.total], [16, 29]);
  const presidio = at("presidio", "default", "insusty-builtin");
  assert.equal(presidio.state, "partial");
  assert.deepEqual(presidio.missing, ["SECRET"]);
  assert.deepEqual(
    [
      at("presidio", "default", "gretel").mapped,
      at("presidio", "default", "nemotron").mapped,
    ],
    [14, 14],
  );
  assert.equal(at("presidio", "default", "insusty-custom").state, "no-adapter");
  assert.equal(
    at("presidio", "default", "insusty-documents").state,
    "no-adapter",
  );
  assert.equal(at("presidio", "default", "ai4privacy").state, "blocked");
  assert.ok(
    !cells.some((c) => c.module === "reference"),
    "the reference module is not a grid row",
  );
});

test("insusty-privacy's literature adapters are the label maps it was scored with before the restructure", () => {
  const gretel = labelTargets(readAdapter("insusty-privacy", "gretel")!);
  assert.deepEqual(gretel.iban, { builtin: ["FINANCIAL"], subtype: "iban" });
  assert.deepEqual(gretel.name, { custom: "Person names" });
  assert.equal(gretel.date, "out_of_scope");
  const tab = labelTargets(readAdapter("insusty-privacy", "tab")!);
  assert.deepEqual(tab.CODE, {
    builtin: [
      "SECRET",
      "FINANCIAL",
      "NATIONAL_ID",
      "PHONE",
      "EMAIL",
      "IP",
      "COMPANY_ID",
    ],
  });
  assert.equal(
    Object.keys(labelTargets(readAdapter("insusty-privacy", "nemotron")!))
      .length,
    55,
  );
});

test("the adapter scaffold drafts presidio's adapters from insusty-privacy's", () => {
  const presidio = readModuleManifest("presidio");
  for (const d of ["insusty-builtin", "tab", "gretel", "nemotron"])
    assert.deepEqual(
      draftAdapter(
        presidio,
        readDatasetContract(d)!,
        readAdapter("insusty-privacy", d),
      ),
      readAdapter("presidio", d),
      d,
    );
});

test("manifests declare what the modules produce", () => {
  assert.deepEqual(readModuleManifest("insusty-privacy").labels.builtin, [
    ...BUILTIN_LABELS,
  ]);
  assert.deepEqual(
    readModuleManifest("presidio").labels.builtin,
    PRESIDIO_BUILTINS,
  );
  const reference = referenceModule();
  const less = manifestIssues(reference, readModuleManifest("presidio"));
  assert.deepEqual(less.errors, []);
  assert.ok(
    less.warnings.length > 0,
    "a module offering less than its manifest only warns",
  );
  assert.ok(
    manifestIssues(reference, {
      ...readModuleManifest("presidio"),
      labels: { builtin: [], custom: false },
    }).errors.length > 0,
  );
});

test("configurations build the module configs the runners used (same JSON, so the same cache keys)", () => {
  const m = referenceModule();
  const off = { runsOn: "off" as const };
  assert.equal(
    JSON.stringify(configFor(m, { builtins: "default", privateAi: "off" })),
    JSON.stringify({ ...m.defaultConfig(), privateAi: off }),
  );
  assert.equal(
    JSON.stringify(configFor(m, { builtins: "all", privateAi: "off" })),
    JSON.stringify({ ...allLabelsConfig(m), privateAi: off }),
  );
});

test("names resolve: aliases, results ids and prefixes", () => {
  assert.equal(resolveModuleId("insusty"), "insusty-privacy");
  assert.equal(resolveModuleId("reference"), "reference");
  assert.throws(() => resolveModuleId("nope"), /unknown module/);
  assert.equal(
    resolveLiteratureDataset("gretel-pii-finance-multilingual"),
    "gretel",
  );
  assert.equal(resolveLiteratureDataset("nemo"), "nemotron");
});

test("bench routes a grid cell to its runner with the runner's own arguments", () => {
  assert.deepEqual(routeBench(["--tier", "smoke"]), {
    runner: "review",
    argv: ["--tier", "smoke"],
  });
  assert.deepEqual(
    routeBench([
      "--module",
      "insusty",
      "--config",
      "smollm2-360m",
      "--dataset",
      "insusty-custom",
      "--tier",
      "quick",
    ]),
    {
      runner: "review",
      argv: [
        "--tier",
        "quick",
        "--models",
        "onnx-community/SmolLM2-360M-Instruct-ONNX",
      ],
    },
  );
  assert.deepEqual(
    routeBench(["--config", "rules-all", "--dataset", "insusty-builtin"]),
    {
      runner: "detbench",
      argv: ["--module", "insusty-privacy", "--configs", "all"],
    },
  );
  assert.deepEqual(
    routeBench([
      "--module",
      "presidio",
      "--config",
      "default",
      "--dataset",
      "gretel",
      "--tier",
      "smoke",
    ]),
    {
      runner: "literature",
      argv: [
        "--systems",
        "presidio",
        "--datasets",
        "gretel",
        "--configs",
        "default",
        "--limit",
        "100",
      ],
    },
  );
  assert.deepEqual(
    routeBench([
      "--config",
      "smollm2-360m",
      "--dataset",
      "insusty-documents",
      "--ref",
      "main",
    ]),
    {
      runner: "docbench",
      argv: [
        "--ref",
        "main",
        "--tracks",
        "ai",
        "--ai",
        "onnx-community/SmolLM2-360M-Instruct-ONNX",
      ],
    },
  );
  assert.throws(
    () => routeBench(["--config", "rules", "--dataset", "insusty-custom"]),
    /n\/a/,
  );
  assert.throws(
    () =>
      routeBench(["--module", "presidio", "--dataset", "insusty-documents"]),
    /no-adapter/,
  );
  assert.throws(
    () => routeBench(["--config", "smollm2-360m", "--dataset", "gretel"]),
    /same-as-rules/,
  );
  assert.throws(() => routeBench(["--dataset", "ai4privacy"]), /not wired/);
});
