/**
 * Leave-one-out ablation of the shipped design (modules/insusty-privacy/lab/shipped.ts): runs the
 * `shipped` baseline and every `shipped-no-<switch>` configuration through the
 * lab (same cache, memory guards, one model process at a time), plus any
 * proposals given with `--with`, then writes a table of deltas vs the baseline
 * to experiments/ablations/<name>.md.
 *
 *   npm run ablate -- [--set tune96] [--model smollm2-360m] [--with id,id]
 *                     [--name ablate-tune96-smollm2-360m] [--dry-run] [--allow-test]
 *
 * Retired switches (their "off" state can no longer run) are listed with
 * their reason. Rerunning with nothing new only rescores.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { EXPERIMENTS_DIR, ROOT } from "../../../engine/paths.ts";
import { LAB_CONFIGS } from "./configs.ts";
import { findLabModel } from "./models.ts";
import {
  SHIPPED_COMPONENTS,
  SHIPPED_CONFIG,
  SHIPPED_MODEL,
  shippedOffId,
} from "./shipped.ts";

const args = process.argv.slice(2);
const opt = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args[i + 1] : undefined;
};
const flag = (name: string) => args.includes(`--${name}`);
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

const set = opt("set") ?? "tune96";
const modelName = opt("model") ?? SHIPPED_MODEL;
const model = findLabModel(modelName) ?? fail(`unknown model ${modelName}`);
const proposals = (opt("with") ?? "")
  .split(",")
  .map((s) => s.trim())
  .filter(Boolean);
for (const id of proposals) if (!LAB_CONFIGS[id]) fail(`unknown config ${id}`);
const name =
  opt("name") ??
  `ablate-${set}-${model.short}${proposals.length ? "-with" : ""}`;
const passThrough = [
  ...(flag("dry-run") ? ["--dry-run"] : []),
  ...(flag("allow-test") ? ["--allow-test"] : []),
];

const configRows = SHIPPED_COMPONENTS.filter((c) => c.off && !c.retired);
const retiredRows = SHIPPED_COMPONENTS.filter((c) => c.retired);

function lab(configs: string[], modelShort: string, runName: string) {
  const labArgs = [
    "--import",
    "tsx",
    join(ROOT, "modules/insusty-privacy/lab/cli.ts"),
    "--configs",
    configs.join(","),
    "--models",
    modelShort,
    "--set",
    set,
    "--name",
    runName,
    ...passThrough,
  ];
  console.log(`\n$ npm run lab -- ${labArgs.slice(3).join(" ")}`);
  const result = spawnSync(process.execPath, labArgs, {
    cwd: ROOT,
    stdio: "inherit",
  });
  if (result.status) fail(`lab run ${runName} failed (exit ${result.status})`);
}

lab(
  [SHIPPED_CONFIG.id, ...configRows.map(shippedOffId), ...proposals],
  model.short,
  name,
);
if (flag("dry-run")) process.exit(0);

// ------------------------------------------------------------------ table
interface Stats {
  cases: number;
  f1: number | null;
  precision: number | null;
  recall: number | null;
  exactF1: number | null;
  detection: number | null;
  fpr: number | null;
  compliance: number | null;
  p50ms: number | null;
}
interface RunSummary {
  model: string;
  config: string;
  incomplete?: string;
  overall: Stats;
  en: Stats;
  fr: Stats;
}
interface RunFile {
  ext: { ref: string; sha: string };
  set: string;
  summary: RunSummary[];
}

const runFile = (runName: string): RunFile => {
  const file = join(EXPERIMENTS_DIR, "runs", `${runName}.json`);
  if (!existsSync(file))
    fail(`no results in ${file} (was the model skipped for memory?)`);
  return JSON.parse(readFileSync(file, "utf8")) as RunFile;
};
const main = runFile(name);
const find = (run: RunFile, config: string, short: string) =>
  run.summary.find((s) => s.config === config && s.model === short);
const baseline =
  find(main, SHIPPED_CONFIG.id, model.short) ??
  fail(`baseline missing from ${name}`);

const pct = (v: number | null) => (v === null ? "–" : (v * 100).toFixed(1));
const delta = (v: number | null, b: number | null, scale = 100, digits = 1) => {
  if (v === null || b === null) return "–";
  const d = (v - b) * scale;
  return `${d > 0 ? "+" : d < 0 ? "−" : "±"}${Math.abs(d).toFixed(digits)}`;
};
const sec = (ms: number | null) => (ms === null ? "–" : (ms / 1000).toFixed(2));

const header =
  "| switched off | off means | F1 | ΔF1 | precision | ΔP | recall | ΔR | FP rate | ΔFP | detection | EN F1 | FR F1 | p50 s | Δp50 s |\n" +
  "|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|";
const row = (
  label: string,
  note: string,
  s: RunSummary | undefined,
  isBaseline = false,
) => {
  if (!s) return `| ${label} | ${note} | not run | | | | | | | | | | | | |`;
  const o = s.overall;
  const b = baseline.overall;
  const d = (v: number | null, bv: number | null) =>
    isBaseline ? "" : delta(v, bv);
  const flagged = s.incomplete ? ` (INCOMPLETE ${s.incomplete})` : "";
  return `| ${label}${flagged} | ${note} | ${pct(o.f1)} | ${d(o.f1, b.f1)} | ${pct(o.precision)} | ${d(o.precision, b.precision)} | ${pct(o.recall)} | ${d(o.recall, b.recall)} | ${pct(o.fpr)} | ${d(o.fpr, b.fpr)} | ${pct(o.detection)} | ${pct(s.en.f1)} | ${pct(s.fr.f1)} | ${sec(o.p50ms)} | ${isBaseline ? "" : delta(o.p50ms, b.p50ms, 1 / 1000, 2)} |`;
};

const rows = [
  row(
    "**nothing (shipped baseline)**",
    SHIPPED_CONFIG.note ?? "",
    baseline,
    true,
  ),
  ...configRows.map((c) =>
    row(c.title, c.offNote, find(main, shippedOffId(c), model.short)),
  ),
  ...retiredRows.map(
    (c) => `| ${c.title} | retired: ${c.retired} | | | | | | | | | | | | | |`,
  ),
  ...proposals.map((id) =>
    row(
      `(proposal, added) ${id}`,
      LAB_CONFIGS[id]!.note ?? "",
      find(main, id, model.short),
    ),
  ),
];

const cases = baseline.overall.cases;
const doc = `# Ablation ${name}

Leave-one-out grid of the shipped design (\`npm run ablate -- --set ${set} --model ${model.short}${proposals.length ? ` --with ${proposals.join(",")}` : ""}\`),
${new Date().toISOString().slice(0, 10)}, set \`${set}\` (${cases} cases), model ${model.short} (${model.dtype}), extension ${main.ext.ref}@${main.ext.sha.slice(0, 7)}.
Each row turns one shipped improvement off (modules/insusty-privacy/shipped-improvements.md); deltas are vs the baseline row, in points
(latency in seconds). Overlap F1 / precision / recall at passage level, FP rate = negatives with a false finding,
p50 = median review time per prompt. Lab run: \`experiments/runs/${name}.json\`.

${header}
${rows.join("\n")}
`;
mkdirSync(join(EXPERIMENTS_DIR, "ablations"), { recursive: true });
const out = join(EXPERIMENTS_DIR, "ablations", `${name}.md`);
writeFileSync(out, doc);
console.log(
  `\n${header}\n${rows.join("\n")}\n\nwrote ${out.replace(ROOT, "")}`,
);
