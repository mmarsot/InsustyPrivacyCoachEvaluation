/**
 * What a module folder declares (`modules/<id>/manifest.json`) and what its
 * entry (`modules/<id>/module.ts`) exports. The manifest is plain JSON so the
 * dashboard and the planner read it without loading the module; conformance
 * holds the loaded module's `capabilities` to it.
 *
 * A configuration is a named `ModuleConfig` recipe: which built-in labels are
 * on, and where Private AI runs. Local and connected models are
 * configurations of one module, not modules of their own.
 */
import type {
  BuiltinLabel,
  ModuleConfig,
  RedactionModule,
} from "../contract/types.ts";

/** One named configuration of a module. */
export interface ModuleConfiguration {
  id: string;
  title: string;
  /** `default`: the module's own defaults; `all`: every built-in label it declares on (`allLabelsConfig`). */
  builtins: "default" | "all";
  privateAi: "off" | "device" | "connected";
  /** The model Private AI runs (device or connected), as the module names it. */
  model?: string;
  /** A connected model billed per request: the dashboard asks before it runs one. */
  paid?: boolean;
  /** Environment variables the configuration needs (names only, never values). */
  env?: string[];
  /** Default spending cap of a paid configuration, USD. */
  budgetUsd?: number;
  /** Peak resident memory while the model loads, MB (memory waits use it). */
  peakRssMb?: number;
}

/** `modules/<id>/manifest.json`. */
export interface ModuleManifest {
  /** The folder name. */
  id: string;
  title: string;
  role: "system-under-test" | "baseline";
  /** The redaction contract version the module implements (`contract/types.ts`). */
  contract: string;
  /** Other names commands accept for this module (`--system insusty`). */
  aliases?: string[];
  source: Record<string, string>;
  inputs: Array<"text" | "document">;
  /** The labels the module can produce: built-in ones, and whether it takes custom labels. */
  labels: { builtin: BuiltinLabel[]; custom: boolean };
  configurations: ModuleConfiguration[];
  notes?: string[];
}

/** Options every module's `load` accepts; a module ignores what it has no use for. */
export interface LoadOptions {
  /** A git ref of the module's source (insusty-privacy: the extension clone). */
  ref?: string;
  /** Path to the extension clone (insusty-privacy). */
  extRepo?: string;
  log?: (line: string) => void;
}

/** What `modules/<id>/module.ts` exports as default. */
export interface ModuleAdapter {
  manifest: ModuleManifest;
  load(o: LoadOptions): Promise<RedactionModule>;
}

/**
 * Every built-in label on, and every address country the module declares (the
 * extension's `SUPPORTED_ADDRESS_COUNTRIES`; until a ref exports it, its
 * default ones).
 */
export function allLabelsConfig(
  module: Pick<RedactionModule, "defaultConfig" | "capabilities">,
): ModuleConfig {
  const d = module.defaultConfig();
  return {
    ...d,
    builtins: Object.fromEntries(
      module.capabilities.builtins.map((b) => [b, true]),
    ),
    addressCountries: module.capabilities.addressCountries
      ? [...module.capabilities.addressCountries]
      : d.addressCountries,
  };
}

/**
 * The `ModuleConfig` of a configuration, with Private AI where it says;
 * callers add custom labels (from the dataset) themselves.
 */
export function configFor(
  module: Pick<RedactionModule, "defaultConfig" | "capabilities">,
  configuration: Pick<ModuleConfiguration, "builtins" | "privateAi" | "model">,
): ModuleConfig {
  const base =
    configuration.builtins === "all"
      ? allLabelsConfig(module)
      : module.defaultConfig();
  return {
    ...base,
    privateAi:
      configuration.privateAi === "off"
        ? { runsOn: "off" }
        : {
            runsOn: configuration.privateAi,
            ...(configuration.model ? { model: configuration.model } : {}),
          },
  };
}

/**
 * Where a loaded module and its manifest disagree. `errors`: the module
 * offers something its manifest does not declare (the grid would hide it);
 * `warnings`: it offers less (an older ref of the extension, before a label
 * or the document reader existed).
 */
export function manifestIssues(
  module: Pick<RedactionModule, "capabilities">,
  manifest: ModuleManifest,
): { errors: string[]; warnings: string[] } {
  const errors: string[] = [];
  const warnings: string[] = [];
  const c = module.capabilities;
  for (const b of c.builtins)
    if (!manifest.labels.builtin.includes(b))
      errors.push(`produces ${b}, which the manifest does not declare`);
  for (const b of manifest.labels.builtin)
    if (!c.builtins.includes(b))
      warnings.push(`the manifest declares ${b}, which this build lacks`);
  const documents = manifest.inputs.includes("document");
  if (c.documents && !documents)
    errors.push("reads documents, but the manifest declares text only");
  if (!c.documents && documents)
    warnings.push(
      "the manifest declares documents, which this build cannot read",
    );
  if (c.customLabels && !manifest.labels.custom)
    errors.push("takes custom labels, but the manifest declares none");
  if (!c.customLabels && manifest.labels.custom)
    warnings.push(
      "the manifest declares custom labels, which this build cannot take",
    );
  return { errors, warnings };
}
