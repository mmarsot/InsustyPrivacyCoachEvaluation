/**
 * The extension ref the bench drives, and what the bench reads of the ref's
 * Private AI review (`refReview`), all through the ref's package
 * (`materialize.ts` installs it, `insusty.ts` loads it): the on-device models
 * it ships, and the instructions its review prepares for a set of labels,
 * recovered with a scripted runtime (`runtime/scripted.ts`).
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import type { Rule } from "../../engine/jobs.ts";
import { LOCAL_CONFIG_FILE, ROOT } from "../../engine/paths.ts";
import { loadInsustyModule } from "./insusty.ts";
import type { ModuleRef } from "./materialize.ts";
import { scriptedRuntime } from "./runtime/scripted.ts";

/** Default extension ref: `main`. */
export const DEFAULT_EXT_REF = "main";

interface LocalConfig {
  extRepo?: string;
  extRef?: string;
}

const readLocalConfig = (): LocalConfig => {
  if (!existsSync(LOCAL_CONFIG_FILE)) return {};
  return JSON.parse(readFileSync(LOCAL_CONFIG_FILE, "utf8")) as LocalConfig;
};

/**
 * Where the extension clone lives: `--ext-repo`, then `INSUSTY_EXT_REPO`, then
 * `extRepo` in the untracked `bench.local.json`, then a sibling
 * `../InsustyPromptCoach` checkout. Relative paths resolve from the bench root.
 * The bench reads refs, commits and diffs from it; packages come from GitHub.
 */
export function resolveExtRepo(cli?: string): string {
  const configured =
    cli ??
    process.env.INSUSTY_EXT_REPO ??
    readLocalConfig().extRepo ??
    "../InsustyPromptCoach";
  const path = isAbsolute(configured) ? configured : resolve(ROOT, configured);
  if (!existsSync(join(path, ".git")))
    throw new Error(
      `Extension clone not found at ${path}. Pass --ext-repo <path>, set INSUSTY_EXT_REPO, or add {"extRepo": "<path>"} to bench.local.json.`,
    );
  return path;
}

/**
 * The ref to bench: `--ref`, then `INSUSTY_EXT_REF`, then `extRef` in
 * `bench.local.json`, then `DEFAULT_EXT_REF`.
 */
export function resolveExtRefName(cli?: string): string {
  return (
    cli ??
    process.env.INSUSTY_EXT_REF ??
    readLocalConfig().extRef ??
    DEFAULT_EXT_REF
  );
}

/** What the bench reads of a ref's Private AI review. */
export interface RefReview {
  /** The on-device models the ref ships, and the one a new user gets. */
  modelIds: string[];
  defaultModelId: string;
  /** The span models (GLiNER2) among them: they read no instructions and generate nothing. */
  spanModelIds: string[];
  /**
   * The instruction prefixes the ref's review prepares for these labels on
   * its generation model (SmolLM2; cost estimates measure them); none when
   * the ref ships no generation model.
   */
  prefixes(rules: readonly Rule[]): Promise<string[]>;
  /** The prefixes joined: what a scorer checks echoed answers against. */
  instructions(rules: readonly Rule[]): Promise<string>;
}

/** Span models listed, never loaded: listing them needs only that the kind has a runtime. */
const unloadedSpans = () =>
  Promise.reject(new Error("refReview loads no span model."));

/** A ref's review through its package; no model is loaded. */
export async function refReview(ref: ModuleRef): Promise<RefReview> {
  const deviceModels = async (withSpans: boolean) =>
    (
      (
        await loadInsustyModule(ref, {
          device: () => Promise.resolve(scriptedRuntime().runtime),
          ...(withSpans ? { spans: unloadedSpans } : {}),
        })
      ).capabilities.models ?? []
    ).filter((m) => m.runsOn === "device");
  const models = await deviceModels(true);
  if (!models.length) throw new Error(`${ref.ref} ships no on-device model.`);
  // The package lists span models only when given their runtime.
  const generationIds = new Set((await deviceModels(false)).map((m) => m.id));
  const generation =
    models.find((m) => m.default && generationIds.has(m.id)) ??
    models.find((m) => generationIds.has(m.id));
  const memo = new Map<string, Promise<string[]>>();
  const prepared = async (rules: readonly Rule[]) => {
    if (!generation) return [];
    // A fresh module per label set: the engine prepares each prefix once.
    const scripted = scriptedRuntime();
    const module = await loadInsustyModule(ref, {
      device: () => Promise.resolve(scripted.runtime),
    });
    await module.prepare!({
      ...module.defaultConfig(),
      customLabels: rules.map((r) => ({
        label: r.label,
        description: r.prompt,
        examples: [...(r.examples ?? [])],
      })),
      privateAi: { runsOn: "device", model: generation.id },
    });
    await module.dispose?.();
    return scripted.prefixes;
  };
  const prefixes = (rules: readonly Rule[]) => {
    const key = JSON.stringify(rules);
    if (!memo.has(key)) memo.set(key, prepared(rules));
    return memo.get(key)!;
  };
  return {
    modelIds: models.map((m) => m.id),
    defaultModelId: (models.find((m) => m.default) ?? models[0]!).id,
    spanModelIds: models
      .filter((m) => !generationIds.has(m.id))
      .map((m) => m.id),
    prefixes,
    instructions: async (rules) => (await prefixes(rules)).join("\n\n"),
  };
}
