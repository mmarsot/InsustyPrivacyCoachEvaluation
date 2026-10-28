/**
 * The detector half of a redaction module, as detbench scores it: built-in
 * spans from `RedactionModule.redact` on text, with Private AI off, in two
 * configurations. `default` is the module's own default configuration;
 * `all` turns every built-in label on and adds every address country the
 * module declares (`allLabelsConfig`). The extension's package reports the
 * contract's labels itself; any other contract implementation scores the
 * same way.
 */
import {
  BUILTIN_LABELS,
  type BuiltinLabel,
  type ModuleConfig,
  type RedactionModule,
} from "../../../contract/types.ts";
import { allLabelsConfig } from "../../module.ts";
import type { DetCategory } from "../../../datasets/insusty-builtin/schema.ts";

/** A module's label as a dataset category (the contract's built-in labels), or null for one the dataset does not know. */
export const mapCategory = (category: string): DetCategory | null =>
  (BUILTIN_LABELS as readonly string[]).includes(category)
    ? (category as DetCategory)
    : null;

/** One built-in span of the module, in the dataset's vocabulary. */
export interface RefDetection {
  /** The module's label. */
  category: string;
  /** The dataset category it maps to, or null for a category the dataset does not know. */
  mapped: DetCategory | null;
  start: number;
  end: number;
  value: string;
  /** The rule that fired (the span's `subtype`). */
  source: string;
  selected: boolean;
}

/**
 * The two configurations detbench scores: the module's default, and every
 * built-in label on.
 */
export type DetConfigName = "default" | "all";

/**
 * What detbench needs of a module: its categories, its two configurations and
 * one call per text.
 */
export interface DetectorApi {
  /** The module's built-in labels, as the report lists them. */
  refCategories: string[];
  /** Dataset categories this module can report. */
  supported: DetCategory[];
  configs: Record<DetConfigName, ModuleConfig>;
  /** What the "all" configuration changes from the default, for the report. */
  allConfigNote: string;
  /** Detections and the module's own rules time. */
  detect(
    text: string,
    config: DetConfigName,
  ): Promise<{ detections: RefDetection[]; ms: number }>;
}

/**
 * Wraps a contract module as a `DetectorApi`; both configurations keep Private
 * AI off, so no model is ever loaded.
 */
export function detectorApi(module: RedactionModule): DetectorApi {
  const base = module.defaultConfig();
  const off = { runsOn: "off" as const };
  const configs: Record<DetConfigName, ModuleConfig> = {
    default: { ...base, privateAi: off },
    all: { ...allLabelsConfig(module), privateAi: off },
  };
  const notes: string[] = [];
  const switchedOn = module.capabilities.builtins.filter(
    (b) => base.builtins[b] === false,
  );
  if (switchedOn.length) notes.push(`turns on ${switchedOn.join(", ")}`);
  const added = configs.all.addressCountries.filter(
    (c) => !base.addressCountries.includes(c),
  );
  if (added.length) notes.push(`adds address countries ${added.join(", ")}`);
  return {
    refCategories: [...module.capabilities.builtins],
    supported: [...module.capabilities.builtins] as BuiltinLabel[],
    configs,
    allConfigNote: notes.length ? notes.join("; ") : "same as default",
    async detect(text, name) {
      const out = await module.redact({ kind: "text", text }, configs[name]);
      return {
        detections: out.spans
          .filter((s) => s.kind === "builtin")
          .map((s) => ({
            category: s.label,
            mapped: mapCategory(s.label),
            start: s.start,
            end: s.end,
            value: out.text.slice(s.start, s.end),
            source: s.subtype ?? "",
            selected: s.redacted,
          })),
        ms:
          out.runtime.stages.find((s) => s.stage === "rules")?.ms ??
          out.runtime.totalMs,
      };
    },
  };
}
