/**
 * Jobs, tiers and the result cache. One job = one (extension ref, model,
 * instruction variant, label-description variant, case). Its cache key also
 * hashes the exact instruction text, rule texts and case text, so editing a
 * case or a label description re-runs only what changed.
 */
import { createHash } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readdirSync, readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { CompiledCase, CompiledDataset, Profile, Split } from "../dataset/schema.ts";
import type { FindingLike, Rule, RuntimeReportLike } from "../ext/ref.ts";
import { RESULT_CACHE_DIR } from "../paths.ts";
import { composeLabelDescription, type LabelVariantId } from "../variants.ts";

export const DEVICE = "wasm";
export const DTYPE = "q8";

export interface Job {
  key: string;
  caseId: string;
  model: string;
  instruction: string;
  labelVariant: LabelVariantId;
  systemInstruction: string;
  rules: Rule[];
  text: string;
}

export interface ChunkRecord {
  output: string;
  runtime?: RuntimeReportLike;
  /** Wall-clock time of this model request (generation, prefix already prepared). */
  ms: number;
  error?: string;
}

export interface ResultRecord {
  key: string;
  extSha: string;
  model: string;
  instruction: string;
  labelVariant: LabelVariantId;
  caseId: string;
  /** Findings accepted by the ref's own parser/anchoring (`reviewPrompt`). */
  findings: FindingLike[];
  chunks: ChunkRecord[];
  error?: string;
  errorKind?: "deadline" | "error";
  /** Total review time for the case (all chunks). */
  reviewMs: number;
  at: string;
}

export const rulesFor = (profile: Profile, variant: LabelVariantId): Rule[] =>
  profile.labels.map((spec) => ({ label: spec.label, prompt: composeLabelDescription(spec, variant) }));

export function jobKey(parts: {
  extSha: string;
  model: string;
  systemInstruction: string;
  rules: Rule[];
  caseId: string;
  text: string;
}): string {
  return createHash("sha256")
    .update(JSON.stringify([parts.extSha, parts.model, DEVICE, DTYPE, parts.systemInstruction, parts.rules, parts.caseId, parts.text]))
    .digest("hex");
}

export const modelSlug = (model: string) => model.replace(/^.*\//, "").replace(/[^A-Za-z0-9.-]+/g, "_");
export const cacheFile = (extSha: string, model: string) => join(RESULT_CACHE_DIR, extSha, `${modelSlug(model)}.jsonl`);

export function loadCache(extSha: string, model: string): Map<string, ResultRecord> {
  const file = cacheFile(extSha, model);
  const map = new Map<string, ResultRecord>();
  if (!existsSync(file)) return map;
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      const record = JSON.parse(line) as ResultRecord;
      map.set(record.key, record);
    } catch {
      // A torn last line from an interrupted run is simply recomputed.
    }
  }
  return map;
}

export function appendResult(file: string, record: ResultRecord): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, JSON.stringify(record) + "\n");
}

/** Every cached review time for a model on this machine, whatever the ref, for runtime estimates. */
export function cachedTimings(model: string): number[] {
  if (!existsSync(RESULT_CACHE_DIR)) return [];
  const out: number[] = [];
  for (const sha of readdirSafe(RESULT_CACHE_DIR)) {
    const file = join(RESULT_CACHE_DIR, sha, `${modelSlug(model)}.jsonl`);
    if (!existsSync(file)) continue;
    for (const line of readFileSync(file, "utf8").split("\n"))
      if (line.trim())
        try {
          out.push((JSON.parse(line) as ResultRecord).reviewMs);
        } catch {
          /* ignore torn line */
        }
  }
  return out;
}

const readdirSafe = (dir: string) => {
  try {
    return readdirSync(dir);
  } catch {
    return [];
  }
};

// ---------------------------------------------------------------- tiers

export const TIERS = ["smoke", "quick", "full"] as const;
export type Tier = (typeof TIERS)[number];

const stableHash = (text: string) => createHash("sha256").update(text).digest("hex");

/** Per (profile, lang) quota for the quick tier: 10 cases covering every type. */
const QUICK_QUOTA: Record<CompiledCase["type"], number> = {
  clear_positive: 3,
  subtle_positive: 2,
  lookalike_negative: 2,
  clean_negative: 1,
  hard: 2,
};

/**
 * smoke: 1 clear positive + 1 look-alike negative per profile, alternating languages (dev split).
 * quick: ~10 dev cases per profile and language, stratified by type.
 * full:  every case, both splits (unless --split narrows it).
 */
export function selectCases(dataset: CompiledDataset, tier: Tier, split?: Split | "all"): CompiledCase[] {
  const effectiveSplit = split ?? (tier === "full" ? "all" : "dev");
  const pool = dataset.cases.filter((c) => effectiveSplit === "all" || c.split === effectiveSplit);
  const ordered = (cases: CompiledCase[]) => [...cases].sort((a, b) => stableHash(a.id).localeCompare(stableHash(b.id)));
  if (tier === "full") return pool;
  const picked: CompiledCase[] = [];
  dataset.profiles.forEach((profile, index) => {
    for (const lang of ["en", "fr"] as const) {
      const group = pool.filter((c) => c.profile === profile.id && c.lang === lang);
      if (tier === "smoke") {
        if (lang !== (index % 2 ? "fr" : "en")) continue;
        for (const type of ["clear_positive", "lookalike_negative"] as const) {
          const first = ordered(group.filter((c) => c.type === type))[0];
          if (first) picked.push(first);
        }
        continue;
      }
      const chosen: CompiledCase[] = [];
      for (const [type, quota] of Object.entries(QUICK_QUOTA))
        chosen.push(...ordered(group.filter((c) => c.type === type)).slice(0, quota));
      const target = Object.values(QUICK_QUOTA).reduce((a, b) => a + b, 0);
      for (const c of ordered(group)) if (chosen.length < target && !chosen.includes(c)) chosen.push(c);
      picked.push(...chosen);
    }
  });
  return picked.sort((a, b) => a.id.localeCompare(b.id));
}
