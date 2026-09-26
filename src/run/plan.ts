/**
 * Bench planning shared by the runner and the dashboard: argument parsing,
 * job expansion (tier x models x instructions x label variants x cases) and
 * runtime estimates. Given the same arguments, both compute the same job keys.
 */
import { readFileSync } from "node:fs";
import type { CompiledCase, CompiledDataset, Split } from "../dataset/schema.ts";
import { MODELS_FILE } from "../paths.ts";
import { INSTRUCTION_VARIANTS, isLabelVariant, LABEL_VARIANTS, type InstructionVariant, type LabelVariantId } from "../variants.ts";
import { cachedTimings, jobKey, rulesFor, selectCases, TIERS, type Job, type Tier } from "./jobs.ts";

export interface ModelInfo {
  id: string;
  short: string;
  priorSecondsPerCase: number;
  priorLoadSeconds: number;
}
export const MODELS: ModelInfo[] = (JSON.parse(readFileSync(MODELS_FILE, "utf8")) as { models: ModelInfo[] }).models;

export interface BenchOptions {
  tier: Tier;
  models: ModelInfo[];
  instructions: InstructionVariant[];
  labelVariants: LabelVariantId[];
  split?: Split | "all";
  profiles: string[];
  langs: string[];
  ref?: string;
  extRepo?: string;
  name?: string;
  maxRssMb: number;
  dryRun: boolean;
  allowMissingSplit: boolean;
}

/** Parses `npm run bench` arguments. Throws on an unknown value. */
export function parseBenchArgs(argv: readonly string[]): BenchOptions {
  const flag = (name: string) => argv.includes(`--${name}`);
  const opt = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const list = (value: string | undefined) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);
  const bad = (message: string): never => {
    throw new Error(message);
  };
  const tier = (opt("tier", "quick") ?? "quick") as Tier;
  if (!TIERS.includes(tier)) bad(`--tier must be one of ${TIERS.join(", ")}`);
  const modelArg = opt("models", "all")!;
  const instrArg = opt("instructions", "current")!;
  const labelArg = opt("labels", "desc,desc_ex3")!;
  const split = opt("split") as Split | "all" | undefined;
  if (split && !["dev", "test", "all"].includes(split)) bad("--split must be dev, test or all");
  return {
    tier,
    models: modelArg === "all" ? MODELS : list(modelArg).map((m) => MODELS.find((x) => x.short === m || x.id === m) ?? bad(`unknown model ${m}`)),
    instructions:
      instrArg === "all" ? [...INSTRUCTION_VARIANTS] : list(instrArg).map((i) => INSTRUCTION_VARIANTS.find((v) => v.id === i) ?? bad(`unknown instruction variant ${i}`)),
    labelVariants: labelArg === "all" ? LABEL_VARIANTS.map((v) => v.id) : list(labelArg).map((l) => (isLabelVariant(l) ? l : bad(`unknown label variant ${l}`))),
    split,
    profiles: list(opt("profiles")),
    langs: list(opt("langs")),
    ref: opt("ref"),
    extRepo: opt("ext-repo"),
    name: opt("name"),
    maxRssMb: Number(opt("max-rss-mb", "3800")),
    dryRun: flag("dry-run"),
    allowMissingSplit: flag("allow-missing-split"),
  };
}

export const splitLabel = (o: Pick<BenchOptions, "split" | "tier">) => o.split ?? (o.tier === "full" ? "all" : "dev");

export interface Plan {
  cases: CompiledCase[];
  jobsByModel: Map<string, Job[]>;
}

/** Expands options into jobs for one extension commit. */
export function planJobs(dataset: CompiledDataset, o: Omit<BenchOptions, "models"> & { models: Pick<ModelInfo, "id">[] }, extSha: string, defaultPrompt: string): Plan {
  let cases = selectCases(dataset, o.tier, o.split);
  if (o.profiles.length) cases = cases.filter((c) => o.profiles.includes(c.profile));
  if (o.langs.length) cases = cases.filter((c) => o.langs.includes(c.lang));
  const profiles = new Map(dataset.profiles.map((p) => [p.id, p]));
  const jobsByModel = new Map<string, Job[]>();
  for (const model of o.models) {
    const jobs: Job[] = [];
    for (const variant of o.instructions)
      for (const labelVariant of o.labelVariants)
        for (const c of cases) {
          const systemInstruction = variant.text ?? defaultPrompt;
          const rules = rulesFor(profiles.get(c.profile)!, labelVariant);
          jobs.push({
            key: jobKey({ extSha, model: model.id, systemInstruction, rules, caseId: c.id, text: c.text }),
            caseId: c.id,
            model: model.id,
            instruction: variant.id,
            labelVariant,
            systemInstruction,
            rules,
            text: c.text,
          });
        }
    jobsByModel.set(model.id, jobs);
  }
  return { cases, jobsByModel };
}

/** Mean cached review time on this machine (timeouts included), else the prior from models.json. */
export function secondsPerCase(m: ModelInfo, timings: number[] = cachedTimings(m.id)): number {
  return timings.length >= 10 ? timings.reduce((a, b) => a + b, 0) / timings.length / 1000 : m.priorSecondsPerCase;
}
export const estimateSeconds = (m: ModelInfo, pending: number, perCase = secondsPerCase(m)) =>
  pending ? m.priorLoadSeconds + pending * perCase * 1.1 : 0;
export const formatDuration = (s: number) =>
  s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;
