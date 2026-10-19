import { test } from "node:test";
import assert from "node:assert/strict";
import { planSuite, selectTracks } from "./suite.ts";

test("deterministic-rule changes select only the deterministic track; documents and OCR both; Private AI its own", () => {
  assert.deepEqual(
    selectTracks(["src/detection/detector.ts", "tests/detector.test.ts"])
      .tracks,
    ["deterministic"],
  );
  assert.deepEqual(selectTracks(["src/files/readers/pdf-document.ts"]).tracks, [
    "deterministic",
    "private-ai",
  ]);
  assert.deepEqual(selectTracks(["src/files/ocr/ocr-service.ts"]).tracks, [
    "deterministic",
    "private-ai",
  ]);
  assert.deepEqual(selectTracks(["src/private-ai/slm-review.ts"]).tracks, [
    "private-ai",
  ]);
  assert.deepEqual(
    selectTracks(["src/private-ai/connected-model/hosted-framing.ts"]).tracks,
    ["private-ai"],
  );
  assert.deepEqual(
    selectTracks([
      "src/files/file-attach.ts",
      "src/popup/popup.ts",
      "docs/x.md",
    ]).tracks,
    [],
  );
  assert.deepEqual(selectTracks(["package-lock.json"]).tracks, [
    "deterministic",
    "private-ai",
  ]);
});

test("CI plans gate deterministic regressions, documents, conformance and parity, never Private AI scores", () => {
  const steps = planSuite({
    ref: "head",
    base: "base",
    tracks: ["deterministic", "private-ai"],
    ci: true,
    full: false,
    connected: false,
  });
  assert.deepEqual(
    steps.filter((s) => s.gate).map((s) => s.name),
    ["conformance", "detbench", "docbench", "parity"],
  );
  assert.ok(steps.find((s) => s.name === "detbench")!.args.includes("--gate"));
  assert.ok(
    steps.find((s) => s.name === "review (on device)")!.args.includes("smoke"),
  );
  assert.ok(
    !steps.some((s) => s.args.includes("glm47-flash-connected")),
    "the paid connected model only with --connected",
  );
  const full = planSuite({
    ref: "main",
    tracks: ["deterministic", "private-ai"],
    ci: false,
    full: true,
    connected: true,
  });
  assert.ok(
    full
      .find((s) => s.name === "literature")!
      .args.includes("insusty,presidio"),
  );
  assert.ok(full.some((s) => s.args.includes("glm47-flash-connected")));
});
