/**
 * `npm run bench -- --module <id> --config <id> --dataset <id>`: which runner
 * a grid cell needs, and the runner arguments that give exactly the plan
 * (and cache keys) the runner's own command gives. Without those three flags
 * the arguments go to the review runner unchanged, as before.
 *
 * Runners, by the dataset contract's scorer:
 * - `custom-passages` → review (`engine/cli/review.ts`): insusty-privacy's
 *   Private AI configurations (`--models`);
 * - `builtin-spans` → detbench: any module with an adapter (`--module`),
 *   `--configs default|all` from the configuration;
 * - `documents` → docbench: insusty-privacy; rules configurations run the
 *   suite and sweeps, Private AI ones its `ai` suite;
 * - `literature` → literature: any module with an adapter (`--systems`),
 *   `--datasets`, `--configs`, `--tier` → the contract's `--limit`.
 */
import type { DatasetAdapterFile } from "./adapter.ts";
import type { DatasetContract, DatasetManifest } from "./dataset.ts";
import type { ModuleManifest } from "./module.ts";
import {
  cellState,
  readAdapter,
  readDatasetContract,
  readDatasetManifest,
  readModuleManifest,
  resolveModuleId,
} from "./registry.ts";

export type Runner = "review" | "detbench" | "docbench" | "literature";

/** A runner and its arguments. */
export interface Route {
  runner: Runner;
  argv: string[];
}

/** What the router reads from disk (replaced in tests). */
export interface RouteLookup {
  resolveModuleId(name: string): string;
  module(id: string): ModuleManifest;
  dataset(id: string): {
    manifest: DatasetManifest;
    contract?: DatasetContract;
  };
  adapter(moduleId: string, datasetId: string): DatasetAdapterFile | undefined;
}

const fromDisk: RouteLookup = {
  resolveModuleId,
  module: readModuleManifest,
  dataset: (id) => ({
    manifest: readDatasetManifest(id),
    contract: readDatasetContract(id),
  }),
  adapter: readAdapter,
};

const RUNNER: Record<DatasetContract["scorer"], Runner> = {
  "custom-passages": "review",
  "builtin-spans": "detbench",
  documents: "docbench",
  literature: "literature",
};

/** The module whose Private AI the review and document runners drive. */
const EXTENSION = "insusty-privacy";

/** Routes bench arguments; throws with a plain reason when the cell cannot run. */
export function routeBench(
  argv: readonly string[],
  lookup: RouteLookup = fromDisk,
): Route {
  const rest = [...argv];
  const take = (name: string) => {
    const i = rest.indexOf(`--${name}`);
    if (i < 0) return undefined;
    const value = rest[i + 1];
    if (value === undefined || value.startsWith("--"))
      throw new Error(`--${name} needs a value`);
    rest.splice(i, 2);
    return value;
  };
  const datasetArg = take("dataset");
  const moduleArg = take("module");
  const configArg = take("config");
  if (!datasetArg && !moduleArg && !configArg)
    return { runner: "review", argv: rest };
  const datasetId = datasetArg ?? "insusty-custom";
  const moduleId = lookup.resolveModuleId(moduleArg ?? EXTENSION);
  const manifest = lookup.module(moduleId);
  const dataset = lookup.dataset(datasetId);
  if (!dataset.contract)
    throw new Error(
      `${datasetId} is not wired: ${dataset.manifest.blocked ?? "it has no contract.json"}`,
    );
  const contract = dataset.contract;
  const adapter = lookup.adapter(moduleId, datasetId);
  const configuration = configArg
    ? manifest.configurations.find((c) => c.id === configArg)
    : undefined;
  if (configArg && !configuration)
    throw new Error(
      `${moduleId} has no configuration ${configArg} (${manifest.configurations.map((c) => c.id).join(", ")})`,
    );
  const facts = { id: datasetId, manifest: dataset.manifest, contract };
  for (const c of configuration ? [configuration] : manifest.configurations) {
    const cell = cellState(manifest, c, facts, adapter);
    if (cell.state === "runnable" || cell.state === "partial") continue;
    if (
      !configuration &&
      (cell.state === "n/a" || cell.state === "same-as-rules")
    )
      continue;
    throw new Error(
      `${moduleId} / ${c.id} × ${datasetId} cannot run: ${cell.state}${cell.reason ? ` (${cell.reason})` : ""}${cell.issues ? `: ${cell.issues.join("; ")}` : ""}`,
    );
  }
  const runner = RUNNER[contract.scorer];
  const needsExtension = () => {
    if (moduleId !== EXTENSION)
      throw new Error(
        `${datasetId} runs on ${EXTENSION} only: its runner drives that module's Private AI and document reader`,
      );
  };
  switch (runner) {
    case "review":
      needsExtension();
      if (configuration) rest.push("--models", configuration.model!);
      break;
    case "detbench":
      take("tier");
      rest.push("--module", moduleId);
      if (configuration) rest.push("--configs", configuration.builtins);
      break;
    case "docbench":
      needsExtension();
      if (configuration?.privateAi === "off")
        rest.push("--configs", configuration.builtins);
      else if (configuration)
        rest.push("--tracks", "ai", "--ai", configuration.model!);
      break;
    case "literature": {
      const tier = take("tier");
      rest.push("--systems", moduleId, "--datasets", datasetId);
      if (configuration) rest.push("--configs", configuration.builtins);
      if (tier !== undefined) {
        const limit = contract.tiers?.[tier];
        if (limit === undefined)
          throw new Error(
            `${datasetId} has no tier ${tier} (${Object.keys(contract.tiers ?? {}).join(", ") || "none"})`,
          );
        rest.push("--limit", String(limit));
      }
      break;
    }
  }
  return { runner, argv: rest };
}
