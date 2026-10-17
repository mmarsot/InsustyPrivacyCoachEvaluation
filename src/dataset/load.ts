/**
 * Loads and validates the review dataset (`docs/dataset.md`): profiles, then
 * cases, then the compiled form with offsets. Every problem becomes an `Issue`
 * rather than an exception, so `npm run validate` reports them all at once.
 */
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { CASES_DIR, PROFILES_DIR } from "../paths.ts";
import {
  CASE_TYPES,
  DIFFICULTIES,
  ERROR_LEVELS,
  LANGS,
  lengthBucket,
  PROFILE_IDS,
  REGISTERS,
  SPLITS,
  type Case,
  type CompiledCase,
  type CompiledDataset,
  type CompiledSpan,
  type Profile,
} from "./schema.ts";
import { composeLabelDescription, LABEL_VARIANTS } from "../variants.ts";

/** Same constraints the extension applies to custom rules (src/config-gateway.ts). */
const RULE_LABEL_PATTERN = /^[A-Z][A-Z0-9_]{0,31}$/;
const RULE_PROMPT_MAX_LENGTH = 1_000;
/**
 * `<profile>-<lang>-<nnn>`: the id prefix must repeat the case's profile and
 * language.
 */
const CASE_ID_PATTERN = /^([a-z]+)-(en|fr)-(\d{3})$/;

/**
 * A validation finding. Errors block compilation; warnings flag likely
 * authoring mistakes (overlapping or glued passages, values a deterministic
 * rule would catch first) without blocking.
 */
export interface Issue {
  level: "error" | "warning";
  where: string;
  message: string;
}

/** `dataset` is absent whenever `issues` holds an error. */
export interface LoadResult {
  dataset?: CompiledDataset;
  issues: Issue[];
}

const isWordChar = (c: string | undefined) =>
  c !== undefined && /[\p{L}\p{N}_]/u.test(c);

/** Case-insensitive search for `needle` as a whole word sequence (not inside a longer word). */
export const containsWord = (text: string, needle: string): boolean => {
  const hay = text.toLowerCase();
  const n = needle.trim().toLowerCase();
  if (!n) return false;
  for (let i = hay.indexOf(n); i >= 0; i = hay.indexOf(n, i + 1))
    if (
      !(isWordChar(n[0]) && isWordChar(hay[i - 1])) &&
      !(isWordChar(n.at(-1)) && isWordChar(hay[i + n.length]))
    )
      return true;
  return false;
};

/** Every start offset of `needle` in `text` (case-sensitive, non-overlapping). */
export const occurrences = (text: string, needle: string): number[] => {
  const out: number[] = [];
  if (!needle) return out;
  for (
    let i = text.indexOf(needle);
    i >= 0;
    i = text.indexOf(needle, i + needle.length)
  )
    out.push(i);
  return out;
};

const readJsonl = (file: string, issues: Issue[]): unknown[] => {
  const rows: unknown[] = [];
  readFileSync(file, "utf8")
    .split("\n")
    .forEach((line, index) => {
      if (!line.trim()) return;
      try {
        rows.push(JSON.parse(line));
      } catch (error) {
        issues.push({
          level: "error",
          where: `${file}:${index + 1}`,
          message: `invalid JSON: ${(error as Error).message}`,
        });
      }
    });
  return rows;
};

/**
 * Reads and checks every profile, appending problems to `issues`; profiles with
 * errors are still returned so their cases can be checked too.
 */
export function loadProfiles(issues: Issue[]): Profile[] {
  if (!existsSync(PROFILES_DIR)) return [];
  const profiles: Profile[] = [];
  for (const file of readdirSync(PROFILES_DIR)
    .filter((f) => f.endsWith(".json"))
    .sort()) {
    const where = `profiles/${file}`;
    let profile: Profile;
    try {
      profile = JSON.parse(
        readFileSync(join(PROFILES_DIR, file), "utf8"),
      ) as Profile;
    } catch (error) {
      issues.push({
        level: "error",
        where,
        message: `invalid JSON: ${(error as Error).message}`,
      });
      continue;
    }
    const err = (message: string) =>
      issues.push({ level: "error", where, message });
    if (!PROFILE_IDS.includes(profile.id))
      err(`unknown profile id "${profile.id}"`);
    if (file !== `${profile.id}.json`)
      err(`file name must be ${profile.id}.json`);
    if (!profile.name || !profile.persona) err("name and persona are required");
    if (
      !Array.isArray(profile.labels) ||
      profile.labels.length < 1 ||
      profile.labels.length > 3
    )
      err("each profile needs 1 to 3 labels");
    const seen = new Set<string>();
    for (const spec of profile.labels ?? []) {
      if (!RULE_LABEL_PATTERN.test(spec.label))
        err(`label "${spec.label}" does not match ${RULE_LABEL_PATTERN}`);
      if (seen.has(spec.label)) err(`duplicate label ${spec.label}`);
      seen.add(spec.label);
      if (!spec.description?.trim())
        err(`${spec.label}: description is required`);
      if (!Array.isArray(spec.examples) || spec.examples.length < 3)
        err(`${spec.label}: needs at least 3 examples`);
      if (
        !Array.isArray(spec.counterExamples) ||
        spec.counterExamples.length < 2
      )
        err(`${spec.label}: needs at least 2 counterExamples`);
      for (const variant of LABEL_VARIANTS) {
        const text = composeLabelDescription(spec, variant.id);
        if (text.length > RULE_PROMPT_MAX_LENGTH)
          err(
            `${spec.label}/${variant.id}: composed description is ${text.length} chars (max ${RULE_PROMPT_MAX_LENGTH})`,
          );
      }
    }
    profiles.push(profile);
  }
  return profiles;
}

/**
 * Reads every case line as written, appending JSON and shape problems to
 * `issues`; content checks happen in `compileDataset`.
 */
export function loadRawCases(issues: Issue[]): Case[] {
  if (!existsSync(CASES_DIR)) return [];
  const cases: Case[] = [];
  for (const file of readdirSync(CASES_DIR)
    .filter((f) => f.endsWith(".jsonl"))
    .sort()) {
    const match = /^([a-z]+)\.(en|fr)\.jsonl$/.exec(file);
    if (!match) {
      issues.push({
        level: "error",
        where: `cases/${file}`,
        message: "file must be named <profile>.<lang>.jsonl",
      });
      continue;
    }
    for (const row of readJsonl(join(CASES_DIR, file), issues)) {
      const c = row as Case;
      if (c.profile !== match[1] || c.lang !== match[2])
        issues.push({
          level: "error",
          where: `cases/${file}#${c.id}`,
          message: `profile/lang must be ${match[1]}/${match[2]}`,
        });
      cases.push(c);
    }
  }
  return cases;
}

/** Validates one case against its profile and returns its compiled form, or undefined on error. */
function compileCase(
  c: Case,
  profile: Profile | undefined,
  issues: Issue[],
  requireSplit: boolean,
): CompiledCase | undefined {
  const where = `case ${c.id ?? "<no id>"}`;
  const before = issues.filter((i) => i.level === "error").length;
  const err = (message: string) =>
    issues.push({ level: "error", where, message });
  const warn = (message: string) =>
    issues.push({ level: "warning", where, message });

  const idMatch = CASE_ID_PATTERN.exec(c.id ?? "");
  if (!idMatch) err(`id must look like <profile>-<lang>-<nnn>`);
  else if (idMatch[1] !== c.profile || idMatch[2] !== c.lang)
    err("id prefix must match profile and lang");
  if (!profile) err(`unknown profile "${c.profile}"`);
  if (!LANGS.includes(c.lang)) err(`lang must be one of ${LANGS.join(", ")}`);
  if (!CASE_TYPES.includes(c.type))
    err(`type must be one of ${CASE_TYPES.join(", ")}`);
  if (!DIFFICULTIES.includes(c.difficulty))
    err(`difficulty must be one of ${DIFFICULTIES.join(", ")}`);
  if (!c.style || !REGISTERS.includes(c.style.register))
    err(`style.register must be one of ${REGISTERS.join(", ")}`);
  if (!c.style || !ERROR_LEVELS.includes(c.style.errors))
    err(`style.errors must be one of ${ERROR_LEVELS.join(", ")}`);
  if (c.mixed !== undefined && typeof c.mixed !== "boolean")
    err("mixed must be a boolean");
  if (
    c.tags !== undefined &&
    (!Array.isArray(c.tags) || c.tags.some((t) => typeof t !== "string"))
  )
    err("tags must be strings");
  if (c.split === undefined) {
    if (requireSplit) err("split is missing: run `npm run split`");
  } else if (!SPLITS.includes(c.split))
    err(`split must be one of ${SPLITS.join(", ")}`);
  if (typeof c.text !== "string" || !c.text.trim()) err("text is required");
  if (!Array.isArray(c.expected))
    err("expected must be an array (empty for negatives)");

  const text = c.text ?? "";
  const expected = Array.isArray(c.expected) ? c.expected : [];
  if (
    (c.type === "clear_positive" || c.type === "subtle_positive") &&
    expected.length === 0
  )
    err(`${c.type} needs at least one expected finding`);
  if (
    (c.type === "lookalike_negative" || c.type === "clean_negative") &&
    expected.length > 0
  )
    err(`${c.type} must have no expected findings`);

  const labels = new Set(profile?.labels.map((l) => l.label) ?? []);
  const spans: CompiledSpan[] = [];
  const pairs = new Set<string>();
  for (const finding of expected) {
    if (!labels.has(finding.label)) {
      err(`label ${finding.label} is not defined in profile ${c.profile}`);
      continue;
    }
    if (typeof finding.passage !== "string" || !finding.passage.trim()) {
      err(`${finding.label}: empty passage`);
      continue;
    }
    if (finding.passage !== finding.passage.trim())
      err(
        `${finding.label}: passage "${finding.passage}" has surrounding whitespace`,
      );
    const key = `${finding.label}\u0000${finding.passage}`;
    if (pairs.has(key))
      err(`duplicate expected finding ${finding.label}: ${finding.passage}`);
    pairs.add(key);
    const starts = occurrences(text, finding.passage);
    if (!starts.length) {
      err(
        `${finding.label}: passage "${finding.passage}" is not found verbatim in the text`,
      );
      continue;
    }
    for (const start of starts) {
      const end = start + finding.passage.length;
      if (
        (isWordChar(finding.passage[0]) && isWordChar(text[start - 1])) ||
        (isWordChar(finding.passage.at(-1)) && isWordChar(text[end]))
      )
        warn(
          `${finding.label}: passage "${finding.passage}" at ${start} is glued to a neighbouring word; the extension's anchoring requires word boundaries`,
        );
      spans.push({ ...finding, start, end });
    }
  }
  // Overlapping expectations with different labels are almost always a mistake.
  for (const a of spans)
    for (const b of spans)
      if (a !== b && a.label !== b.label && a.start < b.end && b.start < a.end)
        warn(
          `passages "${a.passage}" (${a.label}) and "${b.passage}" (${b.label}) overlap`,
        );

  // Label examples must never leak into case texts: they would make a case trivially easy.
  for (const spec of profile?.labels ?? [])
    for (const example of [...spec.examples, ...spec.counterExamples])
      if (containsWord(text, example))
        err(
          `text contains "${example}", an example or counter-example of ${spec.label}; label examples must not appear in cases`,
        );

  // Built-in categories are handled by deterministic rules, not by this benchmark.
  if (/[\w.+-]+@[\w-]+\.[\w.]+/.test(text))
    warn("text contains an email address (a deterministic category)");
  if (/(?:sk-|AKIA|ghp_|xox[baprs]-|AIza)[A-Za-z0-9_-]{12,}/.test(text))
    warn("text contains an API-key-like token (a deterministic category)");

  if (issues.filter((i) => i.level === "error").length > before)
    return undefined;
  return {
    ...c,
    split: c.split ?? "dev",
    positive: expected.length > 0,
    lengthBucket: lengthBucket(text),
    spans: spans.sort((a, b) => a.start - b.start),
  };
}

/** Loads, validates and compiles the whole dataset. `dataset` is undefined when any error exists. */
export function compileDataset(
  options: { requireSplit?: boolean; profiles?: string[] } = {},
): LoadResult {
  const issues: Issue[] = [];
  const wanted = (id: string) =>
    !options.profiles?.length || options.profiles.includes(id);
  const profiles = loadProfiles(issues).filter((p) => wanted(p.id));
  const raw = loadRawCases(issues).filter((c) => wanted(c.profile));
  const byId = new Map(profiles.map((p) => [p.id, p]));
  const ids = new Set<string>();
  const texts = new Map<string, string>();
  const cases: CompiledCase[] = [];
  for (const c of raw) {
    if (ids.has(c.id))
      issues.push({
        level: "error",
        where: `case ${c.id}`,
        message: "duplicate id",
      });
    ids.add(c.id);
    const normalized = (c.text ?? "").trim().toLowerCase();
    const twin = texts.get(normalized);
    if (twin)
      issues.push({
        level: "error",
        where: `case ${c.id}`,
        message: `same text as ${twin}`,
      });
    texts.set(normalized, c.id);
    const compiled = compileCase(
      c,
      byId.get(c.profile),
      issues,
      options.requireSplit ?? true,
    );
    if (compiled) cases.push(compiled);
  }
  if (issues.some((i) => i.level === "error")) return { issues };
  cases.sort((a, b) => a.id.localeCompare(b.id));
  const hash = createHash("sha256")
    .update(JSON.stringify({ profiles, cases: raw }))
    .digest("hex");
  return { dataset: { profiles, cases, hash }, issues };
}
