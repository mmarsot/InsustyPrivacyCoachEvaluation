import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type {
  CompiledCase,
  CompiledDataset,
  Profile,
} from "../datasets/insusty-custom/schema.ts";
import {
  benchArgsFromCmdline,
  caseDetail,
  caseVerdict,
  computeProgress,
  filterOptions,
  filterRows,
  groupMetrics,
  listCases,
  RESULT_DIMENSIONS,
  readCacheFile,
} from "./data.ts";
import { compareRows } from "../engine/compare.ts";
import { latestResults, storedResults } from "./grid.ts";
import type { Job, ResultRecord } from "../engine/jobs.ts";
import { parseBenchArgs, planJobs } from "../engine/plan.ts";
import {
  scoreResult,
  type Scored,
} from "../engine/scorers/custom-passages/score.ts";

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
const mk = (
  id: string,
  lang: "en" | "fr",
  type: CompiledCase["type"],
  text: string,
  passage?: string,
): CompiledCase => {
  const start = passage ? text.indexOf(passage) : -1;
  return {
    id,
    profile: "sales",
    lang,
    type,
    difficulty: "easy",
    style: { register: "chat", errors: "none" },
    text,
    expected: passage ? [{ label: "PRODUCT", passage }] : [],
    split: "dev",
    positive: Boolean(passage),
    lengthBucket: "short",
    spans: passage
      ? [{ label: "PRODUCT", passage, start, end: start + passage.length }]
      : [],
  };
};
const cases = [
  mk(
    "sales-en-001",
    "en",
    "clear_positive",
    "Ship Orwell next week.",
    "Orwell",
  ),
  mk("sales-en-002", "en", "lookalike_negative", "Compare Zoom plans for us."),
  mk("sales-fr-001", "fr", "clear_positive", "On lance Nadir en mai.", "Nadir"),
  mk("sales-fr-002", "fr", "clean_negative", "Résume ce mail stp."),
];
const dataset: CompiledDataset = { profiles: [profile], cases, hash: "h" };

const record = (
  job: Pick<Job, "key" | "caseId" | "model" | "instruction" | "labelVariant">,
  output: string,
  findings: ResultRecord["findings"],
  at: string,
  extra: Partial<ResultRecord> = {},
): ResultRecord => ({
  key: job.key,
  extSha: "sha",
  model: job.model,
  instruction: job.instruction,
  labelVariant: job.labelVariant,
  caseId: job.caseId,
  findings,
  chunks: [
    {
      output,
      ms: 1000,
      runtime: {
        backend: "wasm",
        quantization: "q8",
        promptTokens: 10,
        generatedTokens: 4,
        finishReason: "line",
      },
    },
  ],
  reviewMs: 1000,
  at,
  ...extra,
});

test("recognizes bench processes from /proc command lines", () => {
  assert.deepEqual(
    benchArgsFromCmdline([
      "/usr/bin/node",
      "--require",
      "x",
      "engine/cli/review.ts",
      "--tier",
      "quick",
    ]),
    ["--tier", "quick"],
  );
  assert.equal(
    benchArgsFromCmdline(["node", "engine/workers/model.ts", "spec.json"]),
    undefined,
  );
});

test("parses bench arguments and plans the same keys twice", () => {
  const o = parseBenchArgs([
    "--tier",
    "full",
    "--models",
    "smollm2-360m",
    "--labels",
    "desc,ex3",
  ]);
  assert.equal(o.tier, "full");
  assert.deepEqual(o.labelVariants, ["desc", "ex3"]);
  assert.throws(() => parseBenchArgs(["--labels", "nope"]));
  assert.throws(() => parseBenchArgs(["--instructions", "all"]), /removed/);
  const a = planJobs(dataset, o, "sha", "v3: default");
  const b = planJobs(dataset, o, "sha", "v3: default");
  const jobs = a.jobsByModel.get(o.models[0]!.id)!;
  assert.equal(jobs.length, 4 * 2);
  assert.ok(jobs.every((j) => j.instruction === "current"));
  assert.deepEqual(
    jobs.map((j) => j.key),
    b.jobsByModel.get(o.models[0]!.id)!.map((j) => j.key),
  );
  assert.notEqual(
    planJobs(dataset, o, "other-sha", "v3: default").jobsByModel.get(
      o.models[0]!.id,
    )![0]!.key,
    jobs[0]!.key,
  );
});

test("reads a growing cache file and tolerates a torn last line", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-"));
  const file = join(dir, "m.jsonl");
  writeFileSync(
    file,
    JSON.stringify({ key: "a", reviewMs: 1 }) + "\n" + '{"key":"b","revi',
  );
  assert.deepEqual([...readCacheFile(file).keys()], ["a"]);
  writeFileSync(
    file,
    JSON.stringify({ key: "a" }) + "\n" + JSON.stringify({ key: "b" }) + "\n",
  );
  assert.deepEqual([...readCacheFile(file).keys()].sort(), ["a", "b"]);
});

test("computes live progress, statuses and ETA", () => {
  const o = parseBenchArgs([
    "--tier",
    "full",
    "--models",
    "smollm2-360m,glm47-flash-connected",
    "--labels",
    "desc",
  ]);
  const plan = planJobs(dataset, o, "sha", "p");
  const [m1, m2] = o.models.map((m) => m.id) as [string, string];
  const jobs1 = plan.jobsByModel.get(m1)!;
  const now = Date.parse("2026-01-01T00:10:00Z");
  const cache1 = new Map(
    jobs1
      .slice(0, 3)
      .map((j, i) => [
        j.key,
        record(
          j,
          "NONE",
          [],
          new Date(now - (3 - i) * 60_000).toISOString(),
          i === 2 ? { error: "budget", errorKind: "deadline" } : {},
        ),
      ]),
  );
  const progress = computeProgress(
    plan.jobsByModel,
    (m) => (m === m1 ? cache1 : new Map()),
    (_j, r) => (r.errorKind ? "timeout" : "ok"),
    () => 20,
    now,
  );
  assert.equal(progress.total, 8);
  assert.equal(progress.done, 3);
  const [p1, p2] = progress.models;
  assert.equal(p1!.status, "running");
  assert.equal(p2!.status, "pending");
  assert.equal(p1!.throughputPerMin, 1); // 3 results over 2 minutes
  assert.equal(p1!.etaSeconds, 60); // 1 remaining at 1/min
  assert.equal(p2!.etaSeconds, 80); // 4 at the 20 s fallback
  const cell = progress.cells.find((c) => c.model === m1)!;
  assert.deepEqual(
    [
      cell.done,
      cell.total,
      cell.timeouts,
      cell.failures.ok,
      cell.failures.timeout,
    ],
    [3, 4, 1, 2, 1],
  );
  assert.equal(progress.recent[0]!.caseId, jobs1[2]!.caseId);
  assert.ok(m2);
});

const scoredRows = (): Scored[] => {
  const o = parseBenchArgs([
    "--tier",
    "full",
    "--models",
    "smollm2-360m,glm47-flash-connected",
    "--labels",
    "desc",
  ]);
  const plan = planJobs(dataset, o, "sha", "p");
  const rows: Scored[] = [];
  for (const jobs of plan.jobsByModel.values())
    for (const job of jobs) {
      const c = cases.find((x) => x.id === job.caseId)!;
      const glm = job.model.includes("glm");
      // GLM finds Orwell and flags Zoom; SmolLM2 answers NONE everywhere.
      const findings =
        glm && c.id === "sales-en-001"
          ? [{ category: "PRODUCT", start: 5, end: 11, value: "Orwell" }]
          : glm && c.id === "sales-en-002"
            ? [{ category: "PRODUCT", start: 8, end: 12, value: "Zoom" }]
            : [];
      const output =
        findings.map((f) => `PRODUCT: ${f.value}`).join("\n") || "NONE";
      rows.push(
        scoreResult(
          c,
          profile,
          record(job, output, findings, "2026-01-01T00:00:00Z"),
          ["EMAIL"],
        ),
      );
    }
  return rows;
};

test("filters, groups and lists results with verdicts", () => {
  const rows = scoredRows();
  assert.deepEqual(filterOptions(rows).lang, ["en", "fr"]);
  const glmName = RESULT_DIMENSIONS.model!(
    rows.find((r) => r.model.includes("glm"))!,
  );
  const glmEn = filterRows(rows, { model: [glmName], lang: ["en"] });
  assert.equal(glmEn.length, 2);
  const groups = groupMetrics(rows, ["model", "lang"]);
  assert.equal(groups.length, 4);
  const g = groups.find((x) => x.keys.join() === `${glmName},en`)!;
  assert.equal(g.metrics.caseDetection, 1);
  assert.equal(g.metrics.falsePositiveRate, 1);
  assert.equal(g.metrics.overlap.precision, 0.5);
  assert.deepEqual(groupMetrics(rows, [])[0]!.keys, ["all"]);
  assert.deepEqual(glmEn.map(caseVerdict).sort(), ["FP", "TP"]);
  const fns = listCases(rows, "FN");
  assert.equal(fns.total, 3); // SmolLM2 misses both positives, GLM misses the French one
  assert.equal(listCases(rows, undefined, 1).items.length, 1);
});

test("builds the case drill-down with highlights", () => {
  const rows = scoredRows();
  const fp = rows.find((r) => caseVerdict(r) === "FP")!;
  const detail = caseDetail(
    fp,
    cases[1]!,
    [{ label: "PRODUCT", prompt: "Unreleased products." }],
    "v3: default",
  );
  assert.deepEqual(detail.predicted, [
    { label: "PRODUCT", value: "Zoom", verdict: "FP", exact: false },
  ]);
  assert.deepEqual(detail.highlights, [
    { start: 8, end: 12, kind: "predicted-fp", label: "PRODUCT" },
  ]);
  const miss = rows.find((r) => r.caseId === "sales-fr-001")!;
  assert.equal(
    caseDetail(miss, cases[2]!, [], "p").highlights[0]!.kind,
    "expected-miss",
  );
});

test("compares two runs on shared results only", () => {
  const rows = scoredRows();
  const smol = rows.filter((r) => r.model.includes("SmolLM2"));
  const better = smol.map((r) =>
    r.caseId === "sales-en-001"
      ? {
          ...r,
          detected: true,
          expected: r.expected.map((e) => ({ ...e, overlap: true })),
        }
      : r,
  );
  const { shared, rows: cmp } = compareRows(smol, better.slice(1));
  assert.equal(shared, 3);
  const all = cmp.find((r) => r.slice === "all")!;
  assert.equal(all.cases, 3);
  assert.equal(
    compareRows(smol, better).rows.find((r) => r.slice === "en")!.cells[1]!
      .direction,
    1,
  );
});

test("quick tier: N cases per profile and language, stratified across the run", async () => {
  const { selectCases } = await import("../engine/jobs.ts");
  const { compileDataset } = await import("../datasets/insusty-custom/load.ts");
  const { dataset: real } = compileDataset();
  assert.ok(real);
  const two = selectCases(real, "quick", undefined, 2);
  assert.equal(two.length, 32);
  assert.ok(two.every((c) => c.split === "dev"));
  const count = (cs: typeof two, t: string) =>
    cs.filter((c) => c.type === t).length;
  // 32 slots walk the 10-slot type cycle: 11 clear, 7-8 look-alike, 6-7 subtle, 6 hard, 3 clean.
  assert.ok(
    count(two, "clear_positive") >= 10 &&
      count(two, "clean_negative") >= 3 &&
      count(two, "hard") >= 6,
  );
  const ten = selectCases(real, "quick", undefined, 10);
  assert.equal(ten.length, 160);
  const group = ten.filter((c) => c.profile === "sales" && c.lang === "fr");
  assert.deepEqual(
    [
      count(group, "clear_positive"),
      count(group, "lookalike_negative"),
      count(group, "subtle_positive"),
      count(group, "hard"),
      count(group, "clean_negative"),
    ],
    [3, 2, 2, 2, 1],
  );
});

test("grid results: a Private AI-only document run feeds its model's cell, never the rules cells", () => {
  const runs = mkdtempSync(join(tmpdir(), "grid-runs-"));
  const write = (name: string, metrics: unknown, ai?: unknown) => {
    const dir = join(runs, "docbench", name);
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "run.json"),
      JSON.stringify({ finishedAt: name === "suite" ? "1" : "2" }),
    );
    writeFileSync(join(dir, "metrics.json"), JSON.stringify(metrics));
    if (ai) writeFileSync(join(dir, "ai.json"), JSON.stringify(ai));
  };
  write("suite", {
    sha: "s",
    overall: { positives: 3, configs: { default: { f1: 0.8 } } },
  });
  write(
    "ai-only",
    { sha: "s", overall: { positives: 0, configs: { default: { f1: null } } } },
    {
      summary: [
        {
          model: "gliner2-pii-multi-v1",
          bySize: [
            { expected: 3, found: 1 },
            { expected: 3, found: 2 },
          ],
        },
      ],
    },
  );
  const latest = latestResults(storedResults(runs));
  const cell = (configuration: string) =>
    latest.find(
      (r) =>
        r.dataset === "insusty-documents" && r.configuration === configuration,
    );
  assert.equal(cell("rules")?.run, "docbench/suite");
  assert.equal(cell("rules")?.value, 0.8);
  assert.equal(cell("gliner2-pii")?.value, 0.5);
});
