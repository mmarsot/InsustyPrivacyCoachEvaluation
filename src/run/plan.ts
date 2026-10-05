/**
 * Bench planning shared by the runner and the dashboard: argument parsing,
 * job expansion (tier x models x instructions x label variants x cases) and
 * runtime estimates. Given the same arguments, both compute the same job keys.
 */
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import type { CompiledCase, CompiledDataset, Split } from "../dataset/schema.ts";
import { join } from "node:path";
import { HOSTED_MODELS } from "../hosted/models.ts";
import { MODELS_FILE, ROOT } from "../paths.ts";
import { INSTRUCTION_VARIANTS, isLabelVariant, LABEL_VARIANTS, type InstructionVariant, type LabelVariantId } from "../variants.ts";
import { detDatasetHash, GEN_VERSION, SWEEP_TYPES, SWEEP_UNITS, suiteSpecs, sweepSpecs, type DocSpec, type SweepType } from "../docbench/specs.ts";
import type { DocJob } from "../docbench/types.ts";
import { cachedTimings, DEFAULT_QUICK_CASES_PER_PROFILE, jobKey, rulesFor, selectCases, TIERS, type Job, type Tier } from "./jobs.ts";

export interface ModelInfo {
  id: string;
  short: string;
  priorSecondsPerCase: number;
  priorLoadSeconds: number;
  /** Hosted chat model (src/hosted/models.ts): its requests go to an API, not a local worker model. */
  hosted?: boolean;
}
export const MODELS: ModelInfo[] = (JSON.parse(readFileSync(MODELS_FILE, "utf8")) as { models: ModelInfo[] }).models;
/**
 * Hosted models the bench can run by name (`--models nova-micro-prefill`).
 * Never part of `--models all`: they send the dataset to an API and cost money.
 */
export const HOSTED_BENCH_MODELS: ModelInfo[] = HOSTED_MODELS.map((h) => ({ id: h.id, short: h.short, priorSecondsPerCase: h.priorSecondsPerCase, priorLoadSeconds: 0, hosted: true }));
/** A bundled or hosted model by id or short name. */
export const findBenchModel = (name: string) => [...MODELS, ...HOSTED_BENCH_MODELS].find((x) => x.short === name || x.id === name);

export interface BenchOptions {
  tier: Tier;
  /** Quick tier only: cases per profile and language. */
  casesPerProfile: number;
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
  /** Score and report what is already cached; compute nothing. */
  cachedOnly: boolean;
  allowMissingSplit: boolean;
  /** `--set <name>`: the dev cases of experiments/sets/<name>.json instead of a tier's selection. */
  set?: string;
  /** Hosted models: USD the whole hosted evaluation may spend (cached lab and bench requests included). */
  budgetUsd: number;
}

/** One label-description variant by default; the others are opt-in (`--label-variants all`). */
export const DEFAULT_LABEL_VARIANTS = "desc";

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
  const labelArg = opt("label-variants") ?? opt("labels") ?? DEFAULT_LABEL_VARIANTS;
  const casesPerProfile = Number(opt("cases-per-profile", String(DEFAULT_QUICK_CASES_PER_PROFILE)));
  if (!Number.isInteger(casesPerProfile) || casesPerProfile < 1) bad("--cases-per-profile must be a positive integer");
  const split = opt("split") as Split | "all" | undefined;
  if (split && !["dev", "test", "all"].includes(split)) bad("--split must be dev, test or all");
  return {
    tier,
    casesPerProfile,
    models: modelArg === "all" ? MODELS : list(modelArg).map((m) => findBenchModel(m) ?? bad(`unknown model ${m}`)),
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
    cachedOnly: flag("cached-only"),
    allowMissingSplit: flag("allow-missing-split"),
    set: opt("set"),
    budgetUsd: Number(opt("budget-usd", "5")),
  };
}

export const splitLabel = (o: Pick<BenchOptions, "split" | "tier">) => o.split ?? (o.tier === "full" ? "all" : "dev");

export interface Plan {
  cases: CompiledCase[];
  jobsByModel: Map<string, Job[]>;
}

/** Expands options into jobs for one extension commit. */
export function planJobs(
  dataset: CompiledDataset,
  o: Omit<BenchOptions, "models"> & { models: Pick<ModelInfo, "id">[] },
  extSha: string,
  defaultPrompt: string,
  /** Completion refs take label examples (`examples` field); chat refs never do. */
  withExamples = false,
): Plan {
  let cases = o.set ? casesOfSet(dataset, o.set) : selectCases(dataset, o.tier, o.split, o.casesPerProfile);
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
          const rules = rulesFor(profiles.get(c.profile)!, labelVariant, withExamples);
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

/** Cases of a lab set (experiments/sets/<name>.json); held-out test cases are refused. */
export function casesOfSet(dataset: CompiledDataset, name: string): CompiledCase[] {
  const ids = (JSON.parse(readFileSync(join(ROOT, "experiments", "sets", `${name}.json`), "utf8")) as { cases: string[] }).cases;
  const cases = ids.map((id) => dataset.cases.find((c) => c.id === id) ?? (() => {
    throw new Error(`set ${name}: unknown case ${id}`);
  })());
  if (cases.some((c) => c.split === "test")) throw new Error(`set ${name} contains held-out test cases`);
  return cases;
}

/** Mean cached review time on this machine (timeouts included), else the prior from models.json; hosted models: their pacing-bound prior. */
export function secondsPerCase(m: ModelInfo, timings: number[] = cachedTimings(m.id)): number {
  // Hosted runs are paced (requests per minute): cached latencies would underestimate them.
  if (m.hosted) return m.priorSecondsPerCase;
  return timings.length >= 10 ? timings.reduce((a, b) => a + b, 0) / timings.length / 1000 : m.priorSecondsPerCase;
}
export const estimateSeconds = (m: ModelInfo, pending: number, perCase = secondsPerCase(m)) =>
  pending ? m.priorLoadSeconds + pending * perCase * 1.1 : 0;
export const formatDuration = (s: number) =>
  s < 90 ? `${Math.round(s)} s` : s < 5400 ? `${Math.round(s / 60)} min` : `${(s / 3600).toFixed(1)} h`;

// ------------------------------------------------------------------ document bench (npm run docbench / npm run bench -- --track docbench)

export type DocTier = "smoke" | "quick" | "full";
export interface DocbenchOptions {
  tier: DocTier;
  seed: number;
  configs: DocConfig[];
  /** Report families to keep (docx, xlsx, pdf, text, zip...); empty for all. */
  families: string[];
  kinds: Array<DocSpec["kind"]>;
  tracks: Array<"suite" | "sweep" | "ai">;
  sweepTypes: SweepType[];
  /** Timing repetitions of each sweep point (the median is kept). */
  reps: number;
  ref?: string;
  compare?: string;
  extRepo?: string;
  name?: string;
  dryRun: boolean;
  cachedOnly: boolean;
  maxRssMb: number;
  /** Private AI review of documents: bundled models (by short name), none by default. */
  aiModels: ModelInfo[];
  /** Document sizes (characters of extracted text) for the Private AI track. */
  aiSizes: number[];
  /** Cases of the Private AI track (`--ai-tier`, default smoke: 2 cases; quick: 16; full: 32). */
  aiTier: DocTier;
}
type DocConfig = "default" | "all";

/** Parses `npm run docbench` arguments. Throws on an unknown value. */
export function parseDocbenchArgs(argv: readonly string[]): DocbenchOptions {
  const flag = (name: string) => argv.includes(`--${name}`);
  const opt = (name: string, fallback?: string) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : fallback;
  };
  const list = (value: string | undefined) => (value ? value.split(",").map((s) => s.trim()).filter(Boolean) : []);
  const bad = (message: string): never => {
    throw new Error(message);
  };
  const tier = (opt("tier", "quick") ?? "quick") as DocTier;
  if (!["smoke", "quick", "full"].includes(tier)) bad("--tier must be smoke, quick or full");
  const configs = list(opt("configs", "default,all")) as DocConfig[];
  for (const c of configs) if (c !== "default" && c !== "all") bad(`unknown config ${c} (default, all)`);
  const kinds = list(opt("kinds", "positive,negative,failure")) as DocbenchOptions["kinds"];
  for (const k of kinds) if (!["positive", "negative", "failure"].includes(k)) bad(`unknown kind ${k}`);
  const aiArg = opt("ai");
  const tracks = list(opt("tracks", aiArg ? "suite,sweep,ai" : "suite,sweep")) as DocbenchOptions["tracks"];
  for (const t of tracks) if (!["suite", "sweep", "ai"].includes(t)) bad(`unknown track ${t} (suite, sweep, ai)`);
  const sweepArg = opt("sweep-types", "all")!;
  const sweepTypes = (sweepArg === "all" ? [...SWEEP_TYPES] : list(sweepArg)) as SweepType[];
  for (const s of sweepTypes) if (!(SWEEP_TYPES as readonly string[]).includes(s)) bad(`unknown sweep type ${s} (${SWEEP_TYPES.join(", ")})`);
  const seed = Number(opt("seed", "1"));
  const reps = Number(opt("reps", "3"));
  if (!Number.isInteger(seed) || !Number.isInteger(reps) || reps < 1) bad("--seed and --reps take integers (reps >= 1)");
  return {
    tier,
    seed,
    configs,
    families: list(opt("formats")),
    kinds,
    tracks,
    sweepTypes,
    reps,
    ref: opt("ref"),
    compare: opt("compare"),
    extRepo: opt("ext-repo"),
    name: opt("name"),
    dryRun: flag("dry-run"),
    cachedOnly: flag("cached-only"),
    maxRssMb: Number(opt("max-rss-mb", "3000")),
    aiModels: list(aiArg).map((m) => MODELS.find((x) => x.short === m || x.id === m) ?? bad(`unknown model ${m} (Private AI track: bundled models only)`)),
    aiSizes: list(opt("ai-sizes", "1000,5000,20000,50000")).map(Number),
    aiTier: ((): DocTier => {
      const t = opt("ai-tier", "smoke")!;
      return ["smoke", "quick", "full"].includes(t) ? (t as DocTier) : bad("--ai-tier must be smoke, quick or full");
    })(),
  };
}

/** Bump when scoring changes what a cached result holds (results are recomputed). */
export const DOC_SCORE_VERSION = 2;

export const docJobKey = (extSha: string, o: Pick<DocbenchOptions, "seed" | "configs">, id: string, spec: unknown) =>
  createHash("sha256").update(JSON.stringify([extSha, GEN_VERSION, detDatasetHash(), DOC_SCORE_VERSION, o.seed, [...o.configs].sort(), id, spec])).digest("hex");

export interface DocPlan {
  suite: DocJob[];
  sweeps: DocJob[];
}

/** Expands docbench options into jobs for one extension commit. The dashboard rebuilds the same plan from a run's arguments. */
export function planDocbench(o: DocbenchOptions, extSha: string): DocPlan {
  let specs = o.tracks.includes("suite") ? suiteSpecs() : [];
  if (o.tier === "smoke") specs = specs.filter((s) => s.lang === "en" || s.kind !== "positive");
  if (o.families.length) specs = specs.filter((s) => o.families.includes(s.family) || o.families.includes(s.ext));
  specs = specs.filter((s) => o.kinds.includes(s.kind));
  const sweeps = o.tracks.includes("sweep") ? sweepSpecs(o.tier, o.sweepTypes).filter((s) => !o.families.length || o.families.includes(s.type) || o.families.includes(SWEEP_UNITS[s.type].family)) : [];
  return {
    suite: specs.map((spec) => ({ key: docJobKey(extSha, o, spec.id, spec), id: spec.id, track: "suite" as const, spec })),
    sweeps: sweeps.map((sweep) => ({ key: docJobKey(extSha, o, sweep.id, sweep), id: sweep.id, track: "sweep" as const, sweep })),
  };
}
