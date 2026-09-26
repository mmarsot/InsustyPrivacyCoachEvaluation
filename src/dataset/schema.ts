/**
 * Dataset types. Source files live under `dataset/`:
 *   - `dataset/profiles/<profile>.json`   one `Profile` (client persona + custom labels)
 *   - `dataset/cases/<profile>.<lang>.jsonl`   one `Case` per line
 * Ground truth is stored as {label, passage} pairs (exact substrings of the
 * text), never as offsets; `compileDataset` locates them and rejects any
 * passage that is not found verbatim.
 */

export const PROFILE_IDS = [
  "sales",
  "dev",
  "hr",
  "legal",
  "finance",
  "support",
  "agency",
  "research",
] as const;
export type ProfileId = (typeof PROFILE_IDS)[number];

export const LANGS = ["en", "fr"] as const;
export type Lang = (typeof LANGS)[number];

/**
 * clear_positive      obvious sensitive passage, normal casing, short text
 * subtle_positive     abbreviation, lowercase, possessive, buried mid-paragraph...
 * lookalike_negative  looks sensitive but is not (public codename, public context...)
 * clean_negative      nothing sensitive at all
 * hard                multi-label, long text, code, lists, injection, prompt-as-request...
 */
export const CASE_TYPES = [
  "clear_positive",
  "subtle_positive",
  "lookalike_negative",
  "clean_negative",
  "hard",
] as const;
export type CaseType = (typeof CASE_TYPES)[number];

/** Target share of each type per profile and language (see README). */
export const TYPE_TARGET_SHARE: Record<CaseType, number> = {
  clear_positive: 0.35,
  subtle_positive: 0.15,
  lookalike_negative: 0.25,
  clean_negative: 0.1,
  hard: 0.15,
};

export const DIFFICULTIES = ["easy", "medium", "hard"] as const;
export type Difficulty = (typeof DIFFICULTIES)[number];

/** How the text is written: the channel / document shape it imitates. */
export const REGISTERS = [
  "email", // formal or semi-formal email
  "chat", // terse Slack/Teams/WhatsApp style message
  "notes", // rushed personal or meeting notes
  "log", // pasted log output / stack trace
  "code", // pasted source code, config, SQL
  "list", // bullet list, table, checklist
  "doc", // polished document excerpt (memo, report, brief)
  "ticket", // support or issue-tracker ticket
  "request", // a direct request to the assistant
  "social", // forum / LinkedIn-style post
] as const;
export type Register = (typeof REGISTERS)[number];

/** Spelling and grammar error level, in either language. */
export const ERROR_LEVELS = ["none", "light", "heavy"] as const;
export type ErrorLevel = (typeof ERROR_LEVELS)[number];

export const SPLITS = ["dev", "test"] as const;
export type Split = (typeof SPLITS)[number];

/** Well-known tags; free-form extra tags are allowed. */
export const KNOWN_TAGS = [
  // subtle positives
  "abbreviation",
  "lowercase",
  "possessive",
  "buried",
  "typo_in_passage",
  "partial_mention",
  // look-alike negatives
  "public_codename",
  "public_context",
  "generic_word",
  "competitor_public",
  // hard cases
  "multi_label",
  "long",
  "code_block",
  "list",
  "injection",
  "request",
  "repeated",
  // other
  "mixed_language",
] as const;

export interface LabelSpec {
  /** Custom label as the user types it; must match /^[A-Z][A-Z0-9_]{0,31}$/. */
  label: string;
  /** Plain-language description ("what it should detect"). */
  description: string;
  /** At least 3 positive examples, never reused verbatim in case texts. */
  examples: string[];
  /** At least 2 counter-examples (things that must NOT get this label). */
  counterExamples: string[];
}

export interface Profile {
  id: ProfileId;
  name: string;
  /** Who this fictional client is and what they paste into chatbots. */
  persona: string;
  labels: LabelSpec[];
}

export interface ExpectedFinding {
  label: string;
  /** Exact substring of `text` (case-sensitive). All occurrences count. */
  passage: string;
}

export interface CaseStyle {
  register: Register;
  errors: ErrorLevel;
}

export interface Case {
  /** `<profile>-<lang>-<nnn>`, stable forever (the split and the cache key rely on it). */
  id: string;
  profile: ProfileId;
  lang: Lang;
  /** True when the text mixes languages (French text with English codenames or code...). */
  mixed?: boolean;
  type: CaseType;
  difficulty: Difficulty;
  style: CaseStyle;
  tags?: string[];
  text: string;
  /** Empty for negatives. */
  expected: ExpectedFinding[];
  /** Assigned once by `npm run split`, then never changed. */
  split?: Split;
  /** Why this case exists / what makes it tricky. Not sent to the model. */
  note?: string;
}

export const LENGTH_BUCKETS = ["short", "medium", "long"] as const;
export type LengthBucket = (typeof LENGTH_BUCKETS)[number];
export const lengthBucket = (text: string): LengthBucket =>
  text.length < 300 ? "short" : text.length < 1000 ? "medium" : "long";

export interface CompiledSpan extends ExpectedFinding {
  start: number;
  end: number;
}

/** A validated case with computed offsets and derived tags. */
export interface CompiledCase extends Case {
  split: Split;
  positive: boolean;
  lengthBucket: LengthBucket;
  /** Every occurrence of every expected passage. */
  spans: CompiledSpan[];
}

export interface CompiledDataset {
  profiles: Profile[];
  cases: CompiledCase[];
  /** sha256 over profiles and cases, recorded in every run. */
  hash: string;
}
