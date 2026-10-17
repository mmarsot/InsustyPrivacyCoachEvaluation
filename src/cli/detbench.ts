/**
 * Deterministic-redaction bench: scores an extension ref's rule-based
 * detector (`detectSensitiveData`) on `dataset/detbench/` and its seeded
 * perturbations. No model is loaded; a run takes seconds.
 *
 *   npm run detbench -- [--ref main] [--compare <ref B>] [--ext-repo <path>]
 *                       [--seed 1] [--variants 2] [--perturbations all|none|spacing,case,...]
 *                       [--configs default,all] [--name <run name>]
 *   npm run detbench -- --compare-runs runs/detbench/<A> runs/detbench/<B>
 *   npm run detbench -- --validate          # check the dataset only
 *   npm run detbench -- --defang-dataset    # escape secret prefixes in the dataset files
 *
 * Writes runs/detbench/<name>/ (report.html, results.jsonl for base cases,
 * variants.jsonl for perturbed ones, metrics.csv, metrics.json, run.json);
 * with --compare, both runs and
 * runs/detbench/compare-<A>-vs-<B>.html.
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { resolveExtRefName, resolveExtRepo } from "../ext/ref.ts";
import { RUNS_DIR } from "../paths.ts";
import { percentile } from "../score/aggregate.ts";
import { detCsv, summarizeDet, type DetSummary } from "../detbench/aggregate.ts";
import { DETBENCH_DIR, DETBENCH_LANGS, loadDetDataset } from "../detbench/dataset.ts";
import { defangJson, hasRawSecretPrefix } from "../detbench/defang.ts";
import { detectorApi, type DetConfigName } from "../detbench/ext.ts";
import { loadInsustyModule } from "../module/insusty.ts";
import { materializeModule } from "../module/materialize.ts";
import { PERTURBATIONS, perturbCases, type Perturbation } from "../detbench/perturb.ts";
import { renderDetCompare, renderDetReport, textSummary, type DetRunMeta } from "../detbench/report.ts";
import { isFalsePositive, scoreDetCase, type DetScored } from "../detbench/score.ts";

export const DETBENCH_RUNS_DIR = join(RUNS_DIR, "detbench");

function fail(message: string): never {
  console.error(message);
  process.exit(2);
}

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(`--${name}`);
const option = (name: string): string | undefined => {
  const i = argv.indexOf(`--${name}`);
  if (i < 0) return undefined;
  const value = argv[i + 1];
  if (value === undefined || value.startsWith("--")) fail(`--${name} needs a value`);
  return value;
};

// ------------------------------------------------------------ utilities

if (flag("defang-dataset")) {
  for (const lang of DETBENCH_LANGS) {
    const file = join(DETBENCH_DIR, `${lang}.jsonl`);
    const lines = readFileSync(file, "utf8").split("\n").filter((l) => l.trim());
    writeFileSync(file, lines.map((l) => defangJson(JSON.stringify(JSON.parse(l)))).join("\n") + "\n");
    console.log(`rewrote ${file}`);
  }
  process.exit(0);
}

const { dataset, issues } = loadDetDataset();
for (const lang of DETBENCH_LANGS) {
  try {
    if (hasRawSecretPrefix(readFileSync(join(DETBENCH_DIR, `${lang}.jsonl`), "utf8")))
      issues.push(`${lang}.jsonl has a raw secret prefix (it would trip secret scanners): run npm run detbench -- --defang-dataset`);
  } catch {
    /* missing files are already reported */
  }
}
if (!dataset || issues.length) fail(`dataset/detbench is invalid:\n  ${issues.join("\n  ")}`);
if (flag("validate")) {
  const items = dataset.cases.reduce((n, c) => n + c.gold.length, 0);
  console.log(`dataset/detbench OK: ${dataset.cases.length} cases, ${items} items`);
  process.exit(0);
}

interface RunOutput {
  meta: DetRunMeta;
  summaries: DetSummary[];
}

const readRunDir = (dir: string): RunOutput => ({
  meta: JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as DetRunMeta,
  summaries: JSON.parse(readFileSync(join(dir, "metrics.json"), "utf8")) as DetSummary[],
});

function writeCompare(a: RunOutput, b: RunOutput, out?: string): void {
  const file = out ? resolve(out) : join(DETBENCH_RUNS_DIR, `compare-${a.meta.name}-vs-${b.meta.name}.html`);
  mkdirSync(DETBENCH_RUNS_DIR, { recursive: true });
  writeFileSync(file, renderDetCompare(a, b));
  for (const sa of a.summaries) {
    const sb = b.summaries.find((s) => s.config === sa.config);
    if (!sb) continue;
    console.log(
      `[${sa.config}] F1 ${fmt(sa.overall.overlap.f1)} → ${fmt(sb.overall.overlap.f1)} · redacted ${fmt(sa.overall.redactedRecall)} → ${fmt(sb.overall.redactedRecall)} · negatives with FP ${fmt(sa.overall.negativeFpRate)} → ${fmt(sb.overall.negativeFpRate)}`,
    );
    for (const la of sa.large ?? []) {
      const lb = sb.large?.find((l) => l.caseId === la.caseId);
      if (lb) console.log(`  large ${la.caseId}: found ${la.found}/${la.items} → ${lb.found}/${lb.items} · false positives ${la.falsePositives} → ${lb.falsePositives}`);
    }
  }
  console.log(`wrote ${file}`);
}
const fmt = (v: number | null) => (v === null ? "–" : `${(100 * v).toFixed(0)}%`);

const compareRuns = argv.indexOf("--compare-runs");
if (compareRuns >= 0) {
  const [a, b] = argv.slice(compareRuns + 1, compareRuns + 3);
  if (!a || !b) fail("usage: npm run detbench -- --compare-runs runs/detbench/<A> runs/detbench/<B> [--out file.html]");
  writeCompare(readRunDir(resolve(a)), readRunDir(resolve(b)), option("out"));
  process.exit(0);
}

// ------------------------------------------------------------ run

const seed = Number(option("seed") ?? 1);
const variants = Number(option("variants") ?? 2);
if (!Number.isInteger(seed) || !Number.isInteger(variants) || variants < 0) fail("--seed and --variants take integers");
const perturbationArg = option("perturbations") ?? "all";
const perturbations: Perturbation[] =
  perturbationArg === "all" ? [...PERTURBATIONS] : perturbationArg === "none" ? [] : (perturbationArg.split(",") as Perturbation[]);
for (const p of perturbations) if (!(PERTURBATIONS as readonly string[]).includes(p)) fail(`unknown perturbation ${p} (known: ${PERTURBATIONS.join(", ")})`);
const configs = (option("configs") ?? "default,all").split(",") as DetConfigName[];
for (const c of configs) if (c !== "default" && c !== "all") fail(`unknown config ${c} (default, all)`);

const repo = resolveExtRepo(option("ext-repo"));
const cases = [...dataset.cases, ...perturbCases(dataset.cases, { seed, variants: perturbations.length ? variants : 0, types: perturbations })];

async function runRef(ref: string, name?: string): Promise<RunOutput> {
  const ext = await materializeModule(repo, ref);
  const module = await loadInsustyModule(ext);
  const api = detectorApi(module);
  const startedAt = new Date().toISOString();
  const rows: DetScored[] = [];
  const timings: number[] = [];
  const perCase: Array<{ config: string; caseId: string; chars: number; ms: number; large: boolean }> = [];
  for (const config of configs) {
    await api.detect("warm up 06 12 34 56 78", config);
    for (const c of cases) {
      const { detections, ms } = await api.detect(c.text, config);
      if (c.perturbation === "none") {
        timings.push(ms);
        perCase.push({ config, caseId: c.id, chars: c.text.length, ms: Math.round(ms * 10) / 10, large: !!c.large });
      }
      rows.push(scoreDetCase(c, detections, api.supported, config));
    }
  }
  const summaries = summarizeDet(rows);
  const runName = name ?? `${ref.replace(/[^\w.-]+/g, "-")}-${ext.sha.slice(0, 7)}`;
  const meta: DetRunMeta = {
    name: runName,
    ext: { ref, sha: ext.sha, subject: ext.subject, committedAt: ext.committedAt },
    packages: ext.packages,
    refCategories: api.refCategories,
    supported: api.supported,
    configs: Object.fromEntries(
      configs.map((c) => [c, { categories: api.configs[c].builtins, addressCountries: api.configs[c].addressCountries }]),
    ),
    allConfigNote: api.allConfigNote,
    datasetHash: dataset!.hash,
    seed,
    variantsPerType: perturbations.length ? variants : 0,
    perturbations,
    baseCases: dataset!.cases.length,
    variants: cases.length - dataset!.cases.length,
    timing: {
      calls: timings.length,
      p50Ms: percentile(timings, 50),
      p95Ms: percentile(timings, 95),
      maxMs: timings.length ? Math.max(...timings) : null,
      totalMs: timings.reduce((a, b) => a + b, 0),
      slowest: [...perCase].sort((x, y) => y.ms - x.ms).slice(0, 10).map(({ large: _, ...t }) => t),
      large: perCase.filter((t) => t.large).map(({ large: _, ...t }) => t),
    },
    node: process.versions.node,
    machine: `${cpus().length} vCPU, ${Math.round(totalmem() / 2 ** 30)} GB`,
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  const dir = join(DETBENCH_RUNS_DIR, runName);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "run.json"), JSON.stringify(meta, null, 2) + "\n");
  // Large generated cases keep their detections on items and the first 50 others (counts are in metrics.json), and no text
  // (regenerated from the dataset).
  const compact = (r: DetScored) => {
    if (!r.large) return r;
    const kept = [...r.detections.filter((d) => !isFalsePositive(d)), ...r.detections.filter(isFalsePositive).slice(0, 50)];
    return { ...r, text: undefined, textOmitted: true, detections: kept, detectionsOmitted: r.detections.length - kept.length };
  };
  const jsonl = (list: DetScored[]) => list.map((r) => defangJson(JSON.stringify(compact(r)))).join("\n") + "\n";
  writeFileSync(join(dir, "results.jsonl"), jsonl(rows.filter((r) => r.perturbation === "none")));
  // Perturbed variants are regenerated identically from the dataset and seed, so they are not committed (.gitignore).
  writeFileSync(join(dir, "variants.jsonl"), jsonl(rows.filter((r) => r.perturbation !== "none")));
  writeFileSync(join(dir, "metrics.json"), JSON.stringify(summaries, null, 1) + "\n");
  writeFileSync(join(dir, "metrics.csv"), detCsv(summaries));
  writeFileSync(join(dir, "report.html"), renderDetReport(meta, rows, summaries));
  console.log(textSummary(meta, summaries));
  console.log(`wrote ${join(dir, "report.html")}\n`);
  return { meta, summaries };
}

const refA = resolveExtRefName(option("ref"));
const refB = option("compare");
if (refB && option("name")) fail("--name names a single run; leave it out with --compare");
const a = await runRef(refA, option("name"));
if (refB) {
  const b = await runRef(refB);
  writeCompare(a, b, option("out"));
}
