/**
 * Finds what can be scored and on what, from files only: module manifests
 * (`modules/<id>/manifest.json`), their dataset adapters
 * (`modules/<id>/dataset-adapters/<dataset>.json`), and dataset manifests and
 * contracts (`datasets/<id>/`). A new folder appears here, in the commands and
 * in the dashboard's grid without any other edit.
 *
 * A grid cell is one module configuration × one dataset. Its state comes from
 * the files alone (no module or model is loaded):
 * - `runnable`: the module has a valid adapter for the dataset that maps every
 *   expected label (or passes per-case custom labels with Private AI on);
 * - `partial`: the adapter lists missing labels, which the run leaves out of
 *   the headline;
 * - `no-adapter`: the module has no adapter for the dataset;
 * - `n/a`: the adapter does not serve this configuration (custom labels with
 *   Private AI off);
 * - `same-as-rules`: the configuration only adds Private AI and the dataset
 *   has nothing for it, so a run would repeat the rules row;
 * - `incompatible`, `invalid`, `blocked`: the module's contract major differs,
 *   the adapter fails validation, or the dataset is listed but not wired.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { referenceModule } from "../contract/reference-module.ts";
import {
  CONTRACT_VERSION,
  isCompatibleContract,
  type RedactionModule,
} from "../contract/types.ts";
import {
  adapterIssues,
  builtinMapped,
  type DatasetAdapterFile,
} from "./adapter.ts";
import type {
  DatasetContract,
  DatasetLoader,
  DatasetManifest,
  LiteratureDataset,
} from "./dataset.ts";
import type {
  LoadOptions,
  ModuleAdapter,
  ModuleConfiguration,
  ModuleManifest,
} from "./module.ts";
import { DATASETS_ROOT, MODULES_DIR } from "./paths.ts";

const readJson = <T>(file: string): T =>
  JSON.parse(readFileSync(file, "utf8")) as T;
const folders = (dir: string, file: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory() && existsSync(join(dir, d.name, file)))
        .map((d) => d.name)
        .sort()
    : [];

/** Every module folder with a manifest. */
export const moduleIds = (): string[] => folders(MODULES_DIR, "manifest.json");
/** Every dataset folder with a manifest. */
export const datasetIds = (): string[] =>
  folders(DATASETS_ROOT, "manifest.json");

export const readModuleManifest = (id: string): ModuleManifest =>
  readJson(join(MODULES_DIR, id, "manifest.json"));
export const readDatasetManifest = (id: string): DatasetManifest =>
  readJson(join(DATASETS_ROOT, id, "manifest.json"));
/** A dataset's contract, or undefined for a listed dataset that is not wired. */
export const readDatasetContract = (id: string): DatasetContract | undefined =>
  existsSync(join(DATASETS_ROOT, id, "contract.json"))
    ? readJson(join(DATASETS_ROOT, id, "contract.json"))
    : undefined;
/** A module's adapter for a dataset, or undefined when it has none. */
export function readAdapter(
  moduleId: string,
  datasetId: string,
): DatasetAdapterFile | undefined {
  const file = join(
    MODULES_DIR,
    moduleId,
    "dataset-adapters",
    `${datasetId}.json`,
  );
  return existsSync(file) ? readJson(file) : undefined;
}

/** The contract's reference module: scored only on request, never in the grid. */
export const REFERENCE_MODULE = "reference";

/**
 * A module id from a command-line name: its folder name or one of its
 * aliases (`insusty` → `insusty-privacy`), or `reference`.
 */
export function resolveModuleId(name: string): string {
  if (name === REFERENCE_MODULE) return name;
  for (const id of moduleIds())
    if (id === name || readModuleManifest(id).aliases?.includes(name))
      return id;
  throw new Error(
    `unknown module ${name} (${[...moduleIds(), REFERENCE_MODULE].join(", ")})`,
  );
}

/** Every name `--module` / `--system` accepts. */
export const moduleNames = (): string[] => [
  ...moduleIds().flatMap((id) => [
    id,
    ...(readModuleManifest(id).aliases ?? []),
  ]),
  REFERENCE_MODULE,
];

/** A module's entry (`modules/<id>/module.ts`), imported on demand. */
export async function moduleAdapter(id: string): Promise<ModuleAdapter> {
  const entry = join(MODULES_DIR, id, "module.ts");
  return (
    (await import(pathToFileURL(entry).href)) as { default: ModuleAdapter }
  ).default;
}

/** Loads a module as a contract module, by folder name or alias. */
export async function loadModule(
  name: string,
  o: LoadOptions = {},
): Promise<RedactionModule> {
  const id = resolveModuleId(name);
  if (id === REFERENCE_MODULE) return referenceModule();
  return (await moduleAdapter(id)).load(o);
}

/** A published dataset with its loader (`datasets/<id>/loader.ts`), for the literature runner. */
export async function literatureDataset(
  folder: string,
): Promise<LiteratureDataset> {
  const m = readDatasetManifest(folder);
  const c = readDatasetContract(folder);
  if (!c || c.scorer !== "literature")
    throw new Error(`${folder} is not a published dataset with a contract`);
  const entry = join(DATASETS_ROOT, folder, "loader.ts");
  const loader = (
    (await import(pathToFileURL(entry).href)) as { default: DatasetLoader }
  ).default;
  return {
    ...loader,
    id: m.resultsId ?? m.id,
    folder,
    title: m.title,
    revision: m.source.revision ?? "",
    license: {
      spdx: m.licence.spdx,
      url: m.licence.url ?? "",
      note: m.licence.note,
    },
    homepage: m.source.url ?? "",
    citation: m.citation ?? "",
    languages: m.languages,
    splits: c.splits,
    defaultSplit: c.defaultSplit ?? c.splits[0]!,
  };
}

/** The published datasets the literature runner knows, by folder name. */
export const literatureDatasetIds = (): string[] =>
  datasetIds().filter((d) => readDatasetContract(d)?.scorer === "literature");

/**
 * A literature dataset folder from a name: the folder, its results id, or a
 * prefix of either (`--datasets gretel`).
 */
export function resolveLiteratureDataset(name: string): string | undefined {
  const ids = literatureDatasetIds();
  const resultsId = (d: string) => readDatasetManifest(d).resultsId ?? d;
  return (
    ids.find((d) => d === name || resultsId(d) === name) ??
    ids.find((d) => d.startsWith(name) || resultsId(d).startsWith(name))
  );
}

// ------------------------------------------------------------------ grid

export type CellState =
  | "runnable"
  | "partial"
  | "no-adapter"
  | "n/a"
  | "same-as-rules"
  | "incompatible"
  | "invalid"
  | "blocked";

/** One module configuration × one dataset. */
export interface Cell {
  module: string;
  configuration: string;
  dataset: string;
  state: CellState;
  /** Built-in-labelled datasets: expected labels the adapter maps, of all. */
  mapped?: number;
  total?: number;
  /** Expected labels the module cannot produce (left out of the headline). */
  missing?: string[];
  /** Why the cell is not runnable, or what the run covers. */
  reason?: string;
  issues?: string[];
}

/** What a cell needs to know about its dataset. */
export interface DatasetFacts {
  id: string;
  manifest: Pick<DatasetManifest, "blocked">;
  contract?: DatasetContract;
}

/** The state of one cell, from the manifests, the contract and the adapter alone. */
export function cellState(
  manifest: ModuleManifest,
  configuration: ModuleConfiguration,
  dataset: DatasetFacts,
  adapter: DatasetAdapterFile | undefined,
  harnessContract: string = CONTRACT_VERSION,
): Cell {
  const base = {
    module: manifest.id,
    configuration: configuration.id,
    dataset: dataset.id,
  };
  const contract = dataset.contract;
  if (dataset.manifest.blocked || !contract)
    return {
      ...base,
      state: "blocked",
      reason: dataset.manifest.blocked ?? "no contract",
    };
  if (!isCompatibleContract(manifest.contract, harnessContract))
    return {
      ...base,
      state: "incompatible",
      reason: `module implements contract ${manifest.contract}, the bench ${harnessContract}`,
    };
  if (!adapter) {
    const reason =
      contract.input === "document" && !manifest.inputs.includes("document")
        ? "the module reads text only"
        : contract.labels === "per-case" && !manifest.labels.custom
          ? "the module takes no custom labels"
          : "no dataset adapter in the module yet";
    return { ...base, state: "no-adapter", reason };
  }
  const issues = adapterIssues(adapter, contract, manifest);
  if (issues.length) return { ...base, state: "invalid", issues };
  const privateAi = configuration.privateAi !== "off";
  if (
    adapter.configurations !== "all" &&
    !adapter.configurations.includes(configuration.id)
  )
    return {
      ...base,
      state: "n/a",
      reason:
        contract.labels === "per-case" && !privateAi
          ? "custom labels need Private AI"
          : "the adapter does not serve this configuration",
    };
  if (contract.labels === "per-case")
    return privateAi
      ? { ...base, state: "runnable", reason: "custom labels per case" }
      : { ...base, state: "n/a", reason: "custom labels need Private AI" };
  const expected = Object.keys(contract.labels);
  const mapped = builtinMapped(adapter);
  const missing = expected.filter((l) => !mapped.includes(l));
  const coverage = { mapped: mapped.length, total: expected.length, missing };
  if (privateAi) {
    if (adapter.customLabels && contract.customLabels)
      return {
        ...base,
        state: "runnable",
        reason: "Private AI suite (per-case custom labels)",
        ...coverage,
      };
    return {
      ...base,
      state: "same-as-rules",
      reason: "no custom labels to review",
      ...coverage,
    };
  }
  return {
    ...base,
    state: missing.length ? "partial" : "runnable",
    ...coverage,
  };
}

/** A module and its configurations, for the grid's rows. */
export interface GridModule {
  manifest: ModuleManifest;
  adapters: string[];
}

/** Every module configuration × every dataset. */
export interface Grid {
  modules: GridModule[];
  datasets: Array<DatasetFacts & { manifest: DatasetManifest }>;
  cells: Cell[];
}

/** Builds the grid from the folders on disk. */
export function buildGrid(): Grid {
  const datasets = datasetIds().map((id) => ({
    id,
    manifest: readDatasetManifest(id),
    contract: readDatasetContract(id),
  }));
  const modules = moduleIds().map((id) => ({
    manifest: readModuleManifest(id),
    adapters: datasets.filter((d) => readAdapter(id, d.id)).map((d) => d.id),
  }));
  const cells: Cell[] = [];
  for (const { manifest } of modules)
    for (const configuration of manifest.configurations)
      for (const d of datasets)
        cells.push(
          cellState(manifest, configuration, d, readAdapter(manifest.id, d.id)),
        );
  return { modules, datasets, cells };
}
