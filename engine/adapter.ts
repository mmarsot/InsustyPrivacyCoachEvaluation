/**
 * Dataset adapters: one file per (module, dataset),
 * `modules/<module>/dataset-adapters/<dataset>.json`. It belongs to the module
 * and says how the module's output answers the dataset's expected labels
 * (`datasets/<dataset>/contract.json`), and which of them it cannot produce.
 *
 * A target is written as:
 * - `"EMAIL"`: a built-in span with that label answers the dataset label;
 * - `"FINANCIAL/iban"`: the same, noting the finer type (the span's `subtype`);
 * - `["SECRET", "FINANCIAL", ...]`: any of those labels (a coarse dataset
 *   label such as TAB's `CODE`);
 * - `{ "custom": "Person names" }`: a custom label (Private AI);
 * - a label listed under `missing`: the module cannot produce it, so a run
 *   leaves it out of the headline (it is reported apart).
 *
 * Validation requires every label of the dataset's contract to be mapped or
 * listed missing, so a forgotten label is caught.
 */
import { BUILTIN_LABELS, type BuiltinLabel } from "../contract/types.ts";
import type { DatasetContract, LabelTarget } from "./dataset.ts";
import type { ModuleManifest } from "./module.ts";

/** One target as written in an adapter file. */
export type TargetSpec =
  string | string[] | { custom: string; description?: string };

/** `modules/<module>/dataset-adapters/<dataset>.json`. */
export interface DatasetAdapterFile {
  dataset: string;
  /** The version of the dataset's contract this adapter was written for. */
  datasetContract: string;
  /** The module configurations it serves: all, or a list of ids. */
  configurations: "all" | string[];
  /** Dataset label → what in the module's output answers it; `per-case`: custom labels passed through from each case. */
  labels: Record<string, TargetSpec> | "per-case";
  /** Dataset labels the module cannot produce. */
  missing?: string[];
  /** Custom labels some cases carry, passed through when the configuration runs Private AI. */
  customLabels?: "per-case";
  /** Runner options this adapter allows (insusty-custom: label-description variants). */
  options?: Record<string, string[]>;
}

const isBuiltin = (label: string): label is BuiltinLabel =>
  (BUILTIN_LABELS as readonly string[]).includes(label);

/** The scorer's form of one target; throws on a label the contract does not know. */
export function parseTarget(spec: TargetSpec): LabelTarget {
  if (typeof spec === "object" && !Array.isArray(spec))
    return { custom: spec.custom };
  const list = Array.isArray(spec) ? spec : [spec];
  const labels = list.map((s) => s.split("/")[0]!);
  for (const l of labels)
    if (!isBuiltin(l)) throw new Error(`unknown built-in label ${l}`);
  const subtype =
    !Array.isArray(spec) && spec.includes("/") ? spec.split("/")[1] : undefined;
  return {
    builtin: labels as BuiltinLabel[],
    ...(subtype ? { subtype } : {}),
  };
}

/**
 * The adapter as the literature scorer reads it: every mapped label's target,
 * and `out_of_scope` for every missing one.
 */
export function labelTargets(
  adapter: DatasetAdapterFile,
): Record<string, LabelTarget> {
  if (adapter.labels === "per-case") return {};
  const out: Record<string, LabelTarget> = {};
  for (const [label, spec] of Object.entries(adapter.labels))
    out[label] = parseTarget(spec);
  for (const label of adapter.missing ?? []) out[label] = "out_of_scope";
  return out;
}

/** The dataset labels a module answers with built-in spans (the headline's labels). */
export function builtinMapped(adapter: DatasetAdapterFile): string[] {
  return Object.entries(labelTargets(adapter))
    .filter(([, t]) => typeof t === "object" && "builtin" in t)
    .map(([label]) => label);
}

const major = (v: string) => /^(\d+)\./.exec(v)?.[1];

/**
 * What is wrong with an adapter against the dataset's contract and the
 * module's manifest; empty when it is valid.
 */
export function adapterIssues(
  adapter: DatasetAdapterFile,
  contract: DatasetContract,
  manifest: ModuleManifest,
): string[] {
  const issues: string[] = [];
  if (adapter.dataset !== contract.dataset)
    issues.push(
      `written for dataset ${adapter.dataset}, not ${contract.dataset}`,
    );
  if (major(adapter.datasetContract) !== major(contract.version))
    issues.push(
      `written for contract ${adapter.datasetContract}; the dataset is at ${contract.version}`,
    );
  const ids = manifest.configurations.map((c) => c.id);
  if (adapter.configurations !== "all")
    for (const c of adapter.configurations)
      if (!ids.includes(c)) issues.push(`unknown configuration ${c}`);
  if (contract.labels === "per-case" || adapter.labels === "per-case") {
    if (contract.labels !== adapter.labels)
      issues.push(
        `labels are ${JSON.stringify(adapter.labels === "per-case" ? "per-case" : "mapped")} but the contract's are ${JSON.stringify(contract.labels === "per-case" ? "per-case" : "named")}`,
      );
    else if (!manifest.labels.custom)
      issues.push("per-case custom labels, but the module takes none");
    return issues;
  }
  const expected = Object.keys(contract.labels);
  const mapped = Object.keys(adapter.labels);
  const missing = adapter.missing ?? [];
  for (const l of [...mapped, ...missing])
    if (!expected.includes(l))
      issues.push(`label ${l} is not in the dataset's contract`);
  for (const l of mapped.filter((x) => missing.includes(x)))
    issues.push(`label ${l} is both mapped and missing`);
  for (const l of expected)
    if (!mapped.includes(l) && !missing.includes(l))
      issues.push(`label ${l} is neither mapped nor listed missing`);
  for (const [label, spec] of Object.entries(adapter.labels)) {
    let target: LabelTarget;
    try {
      target = parseTarget(spec);
    } catch (error) {
      issues.push(`${label}: ${(error as Error).message}`);
      continue;
    }
    if (typeof target === "object" && "builtin" in target) {
      const absent = target.builtin.filter(
        (b) => !manifest.labels.builtin.includes(b),
      );
      if (absent.length === target.builtin.length)
        issues.push(
          `${label} maps to ${absent.join(", ")}, which the module does not produce`,
        );
    } else if (typeof target === "object" && !manifest.labels.custom)
      issues.push(`${label} maps to a custom label, but the module takes none`);
  }
  if (adapter.customLabels && !contract.customLabels)
    issues.push("per-case custom labels, but the contract has none");
  return issues;
}

/** One copied target, narrowed to what `manifest` produces, or undefined (missing). */
function narrow(
  spec: TargetSpec,
  manifest: ModuleManifest,
): TargetSpec | undefined {
  if (typeof spec === "object" && !Array.isArray(spec))
    return manifest.labels.custom ? spec : undefined;
  const has = (s: string) =>
    (manifest.labels.builtin as string[]).includes(s.split("/")[0]!);
  if (!Array.isArray(spec)) return has(spec) ? spec : undefined;
  const kept = spec.filter(has);
  return kept.length > 1 ? kept : kept[0];
}

/**
 * A first draft of a module's adapter for a dataset (`npm run adapter`):
 * every expected label copied from `source` (another module's adapter for the
 * same dataset) narrowed to what this module produces, or, without a source,
 * mapped to itself when it is a built-in label the module produces; anything
 * else listed missing.
 */
export function draftAdapter(
  manifest: ModuleManifest,
  contract: DatasetContract,
  source: DatasetAdapterFile | undefined,
): DatasetAdapterFile {
  const base = {
    dataset: contract.dataset,
    datasetContract: contract.version,
    configurations: "all" as const,
  };
  if (contract.labels === "per-case") return { ...base, labels: "per-case" };
  const labels: Record<string, TargetSpec> = {};
  const missing: string[] = [];
  for (const label of Object.keys(contract.labels)) {
    const from =
      source && source.labels !== "per-case" ? source.labels[label] : label;
    const target = from === undefined ? undefined : narrow(from, manifest);
    if (target === undefined) missing.push(label);
    else labels[label] = target;
  }
  return {
    ...base,
    labels,
    missing,
    ...(contract.customLabels && manifest.labels.custom
      ? { customLabels: "per-case" as const }
      : {}),
  };
}
