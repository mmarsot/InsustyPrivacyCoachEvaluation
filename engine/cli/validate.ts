/**
 * Checks datasets and modules without running any module.
 *
 *   npm run validate [-- --allow-missing-split] [--quiet] [--profile <id>]   # the review dataset (insusty-custom)
 *   npm run validate -- --dataset <id>       # one dataset: insusty-custom, insusty-builtin, insusty-documents,
 *                                            # or a published one (downloads once, checks every gold label is in its contract)
 *   npm run validate -- --module <id>        # a module's manifest and every dataset adapter against the dataset contracts
 *   npm run validate -- --adapters           # every module's adapters (seconds, no download)
 *
 * Exits 1 on any error.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { validateCustomDataset } from "../../datasets/insusty-custom/validate.ts";
import { adapterIssues } from "../adapter.ts";
import { ensureDataset } from "../download.ts";
import { ROOT } from "../paths.ts";
import {
  datasetIds,
  literatureDataset,
  moduleIds,
  readAdapter,
  readDatasetContract,
  readDatasetManifest,
  readModuleManifest,
  resolveModuleId,
} from "../registry.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};

/** Every adapter of a module against the dataset contracts; returns the error count. */
function checkModule(id: string): number {
  const manifest = readModuleManifest(id);
  let errors = 0;
  if (manifest.id !== id) {
    console.log(`ERROR ${id}: manifest id is ${manifest.id}`);
    errors++;
  }
  for (const d of datasetIds()) {
    const adapter = readAdapter(id, d);
    if (!adapter) continue;
    const contract = readDatasetContract(d);
    const issues = contract
      ? adapterIssues(adapter, contract, manifest)
      : [`dataset ${d} has no contract`];
    for (const i of issues) console.log(`ERROR ${id} × ${d}: ${i}`);
    if (!issues.length) console.log(`ok    ${id} × ${d}`);
    errors += issues.length;
  }
  return errors;
}

/** Published dataset: download once, check every gold label is in the contract. */
async function checkPublished(id: string): Promise<number> {
  const d = await literatureDataset(id);
  const contract = readDatasetContract(id)!;
  const labels =
    contract.labels === "per-case" ? [] : Object.keys(contract.labels);
  let errors = 0;
  for (const split of d.splits) {
    const dir = await ensureDataset(d, split);
    const cases = await d.load(dir, split);
    const unknown = new Set(
      cases
        .flatMap((c) => c.gold.map((g) => g.label))
        .filter((l) => !labels.includes(l)),
    );
    for (const l of unknown)
      console.log(
        `ERROR ${id} ${split}: gold label ${l} is not in contract.json`,
      );
    console.log(
      `${unknown.size ? "ERROR" : "ok   "} ${id} ${split}: ${cases.length} cases`,
    );
    errors += unknown.size;
  }
  return errors;
}

/** Runs another command and returns its exit code. */
const run = (script: string, ...args: string[]) =>
  spawnSync(
    process.execPath,
    ["--import", "tsx", join(ROOT, script), ...args],
    {
      stdio: "inherit",
      cwd: ROOT,
    },
  ).status ?? 1;

const dataset = opt("dataset");
const moduleArg = opt("module");
let code = 0;
if (argv.includes("--adapters")) {
  code = moduleIds().reduce((n, id) => n + checkModule(id), 0) ? 1 : 0;
} else if (moduleArg) {
  code = checkModule(resolveModuleId(moduleArg)) ? 1 : 0;
} else if (dataset) {
  if (!datasetIds().includes(dataset)) {
    console.error(`unknown dataset ${dataset} (${datasetIds().join(", ")})`);
    process.exit(2);
  }
  const blocked = readDatasetManifest(dataset).blocked;
  if (blocked) {
    console.log(`${dataset} is listed but not wired: ${blocked}`);
  } else if (dataset === "insusty-custom") {
    code = validateCustomDataset(
      argv.filter((a, i) => a !== "--dataset" && argv[i - 1] !== "--dataset"),
    );
  } else if (dataset === "insusty-builtin") {
    code = run("engine/cli/detbench.ts", "--validate");
  } else if (dataset === "insusty-documents") {
    code = run("engine/cli/docbench.ts", "--validate");
  } else code = (await checkPublished(dataset)) ? 1 : 0;
} else code = validateCustomDataset(argv);
process.exit(code);
