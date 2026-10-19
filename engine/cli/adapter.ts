/**
 * Drafts a module's dataset adapter
 * (`modules/<module>/dataset-adapters/<dataset>.json`) for a person to
 * review: every label of the dataset's contract is either mapped or listed
 * missing.
 *
 *   npm run adapter -- --module <id> --dataset <id> [--from <module>] [--force]
 *
 * With another module's adapter for the same dataset (`--from`, else the
 * first module that has one), each target is copied, keeping only the
 * built-in labels this module produces (a custom target only when it takes
 * custom labels); without one, a dataset label that is a built-in label this
 * module produces maps to itself. Everything else goes under `missing`.
 * Refuses to overwrite an existing adapter without `--force`.
 */
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, join, relative } from "node:path";
import { adapterIssues, draftAdapter } from "../adapter.ts";
import { MODULES_DIR, ROOT } from "../paths.ts";
import {
  moduleIds,
  readAdapter,
  readDatasetContract,
  readModuleManifest,
  resolveModuleId,
} from "../registry.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

const moduleId = resolveModuleId(
  opt("module") ?? fail("--module <id> is required"),
);
const datasetId = opt("dataset") ?? fail("--dataset <id> is required");
const manifest = readModuleManifest(moduleId);
const fromId = opt("from")
  ? resolveModuleId(opt("from")!)
  : moduleIds().find((m) => m !== moduleId && readAdapter(m, datasetId));
const source = fromId ? readAdapter(fromId, datasetId) : undefined;
if (opt("from") && !source) fail(`${fromId} has no adapter for ${datasetId}`);
const file = join(
  MODULES_DIR,
  moduleId,
  "dataset-adapters",
  `${datasetId}.json`,
);
if (existsSync(file) && !argv.includes("--force"))
  fail(`${relative(ROOT, file)} exists; pass --force to overwrite it`);
const contract =
  readDatasetContract(datasetId) ?? fail(`${datasetId} has no contract.json`);
const draft = draftAdapter(manifest, contract, source);
mkdirSync(dirname(file), { recursive: true });
writeFileSync(file, JSON.stringify(draft, null, 2) + "\n");
console.log(
  `wrote ${relative(ROOT, file)}${fromId ? ` (from ${fromId}'s adapter)` : ""}`,
);
if (draft.labels !== "per-case")
  console.log(
    `mapped ${Object.keys(draft.labels).length}, missing ${draft.missing?.length ?? 0}: ${draft.missing?.join(", ") || "none"}`,
  );
const issues = adapterIssues(draft, contract, manifest);
for (const i of issues) console.log(`check: ${i}`);
console.log(
  "Review it, then run npm run validate -- --module " +
    moduleId +
    " and open the dashboard's grid.",
);
