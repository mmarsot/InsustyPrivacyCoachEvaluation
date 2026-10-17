/**
 * Scores one result against its case.
 *
 * Predictions are the findings the ref's own parser accepted (so the bench
 * scores what the extension would redact). They are collapsed to passages:
 * one prediction per (label, lower-cased value), matched if any of its spans
 * satisfies the criterion.
 *   - exact:   same label and the accepted value equals an expected passage.
 *   - overlap: same label and a predicted span overlaps an occurrence of an
 *              expected passage.
 *   - any-label overlap: overlap regardless of label (label confusion aside).
 * Only the profile's custom labels count; findings with built-in labels
 * (EMAIL, PHONE...) are counted separately since the dataset avoids those.
 *
 * Format and failure analysis reads the raw model text with the line
 * protocol (`LABEL: passage` lines or `NONE`) and is independent of the ref.
 */
import type { CompiledCase, Profile } from "../dataset/schema.ts";
import type { ResultRecord } from "../run/jobs.ts";

/**
 * What went wrong with a raw answer, if anything (`ok` otherwise); one per
 * scored case.
 */
export const FAILURE_MODES = [
  "ok", // compliant output (findings or NONE), no dropped line
  "timeout", // hit the ref's generation budget
  "error", // any other runtime error
  "empty", // no text at all
  "echo", // copied the prompt back
  "echo_instructions", // copied the label list / instructions back instead of scanning
  "answered", // answered/continued the prompt instead of scanning it (prose)
  "unknown_label", // label-shaped lines with labels that are not configured
  "hallucinated", // configured label but passage not in the text: dropped by anchoring
] as const;
export type FailureMode = (typeof FAILURE_MODES)[number];

/**
 * How an answer follows the line protocol: `NONE`, valid lines only, some valid
 * lines, none valid, or no text.
 */
export type FormatClass = "none" | "lines" | "partial" | "invalid" | "empty";

/**
 * An expected passage and how the predictions matched it (see the file header).
 */
export interface ScoredExpected {
  label: string;
  passage: string;
  exact: boolean;
  overlap: boolean;
  anyLabel: boolean;
}
/**
 * A prediction collapsed to (label, value) and whether it matched an expected
 * passage.
 */
export interface ScoredPrediction {
  label: string;
  value: string;
  exact: boolean;
  overlap: boolean;
}

/**
 * One result scored against its case: a line of `runs/<name>/results.jsonl`.
 */
export interface Scored {
  caseId: string;
  model: string;
  instruction: string;
  labelVariant: string;
  config: string;
  profile: string;
  lang: string;
  mixed: boolean;
  type: string;
  difficulty: string;
  lengthBucket: string;
  register: string;
  errors: string;
  split: string;
  positive: boolean;
  expected: ScoredExpected[];
  predicted: ScoredPrediction[];
  builtinPredicted: number;
  detected: boolean;
  falsePositiveCase: boolean;
  format: FormatClass;
  compliant: boolean;
  failure: FailureMode;
  droppedLines: number;
  unknownLabelLines: number;
  echo: boolean;
  timeout: boolean;
  reviewMs: number;
  generatedTokens: number;
  finishReasons: string[];
  raw: string;
  error?: string;
}

/**
 * A configuration's display key, `<model> | <instruction> | <label variant>`;
 * also its grouping key.
 */
export const configKey = (
  model: string,
  instruction: string,
  labelVariant: string,
) => `${model.replace(/^.*\//, "")} | ${instruction} | ${labelVariant}`;

const isWordChar = (c: string | undefined) =>
  c !== undefined && /[\p{L}\p{N}_]/u.test(c);
const normalizeLabel = (label: string) =>
  label.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");

/** Case-insensitive, word-bounded occurrence test, like the ref's anchoring. */
const anchors = (text: string, passage: string): boolean => {
  const variants = new Set<string>();
  const trimmed = passage.trim();
  const noPunct = trimmed.replace(/[.,;:!?]+$/u, "").trim();
  for (const v of [trimmed, noPunct]) {
    variants.add(v);
    variants.add(v.replace(/^["'`“‘](.*)["'`”’]$/u, "$1").trim());
  }
  const hay = text.toLocaleLowerCase();
  for (const v of variants) {
    if (!v) continue;
    const needle = v.toLocaleLowerCase();
    for (let i = hay.indexOf(needle); i >= 0; i = hay.indexOf(needle, i + 1))
      if (
        !(isWordChar(needle[0]) && isWordChar(hay[i - 1])) &&
        !(isWordChar(needle.at(-1)) && isWordChar(hay[i + needle.length]))
      )
        return true;
  }
  return false;
};

const words = (s: string) =>
  s
    .toLocaleLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
const grams = (w: string[]) =>
  new Set(w.slice(0, -3).map((_, i) => w.slice(i, i + 4).join(" ")));

/**
 * Echo test: most of the output's word 4-grams come from the text (partial
 * copies count), or the whole of a short text is copied back.
 */
const isEcho = (text: string, output: string): boolean => {
  const ow = words(output);
  if (ow.length < 8)
    return (
      ow.length > 0 &&
      words(text).length > 0 &&
      output.toLocaleLowerCase().includes(text.trim().toLocaleLowerCase())
    );
  const tg = grams(words(text));
  const og = grams(ow);
  let hit = 0;
  for (const g of og) if (tg.has(g)) hit++;
  return og.size > 0 && hit / og.size >= 0.6;
};

interface LineAnalysis {
  format: FormatClass;
  validLines: number;
  invalidLines: number;
  unknownLabelLines: number;
  droppedLines: number;
  proseChars: number;
  meaningfulLines: number;
  /** Lines that copy text from the instructions (label descriptions...). */
  instructionEchoLines: number;
}

/** Reads raw output with the line protocol. `categories` are every label the model was given. */
export function analyzeLines(
  output: string,
  text: string,
  categories: readonly string[],
  instructions = "",
): LineAnalysis {
  const instructionsLower = instructions.toLocaleLowerCase();
  const known = new Set(categories.map(normalizeLabel));
  const meaningful = output
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith("```"));
  const result: LineAnalysis = {
    format: "empty",
    validLines: 0,
    invalidLines: 0,
    unknownLabelLines: 0,
    droppedLines: 0,
    proseChars: 0,
    meaningfulLines: meaningful.length,
    instructionEchoLines: 0,
  };
  if (!meaningful.length) return result;
  const bare = (l: string) => l.replace(/^(?:(?:[-*•]+|\d+[.)])\s*)+/u, "");
  if (meaningful.every((l) => /^NONE\.?$/iu.test(bare(l))))
    return { ...result, format: "none" };
  for (const raw of meaningful) {
    const line = raw.replace(/^(?:(?:[-*•]+|\d+[.)])\s*)+/u, "");
    const match = /^(?<label>[^:\n]+?)\s*:\s*(?<passage>.+)$/u.exec(line);
    const label = match?.groups?.label ?? "";
    const passage = match?.groups?.passage ?? "";
    const content = (passage || line)
      .replace(/[.\s]+$/u, "")
      .toLocaleLowerCase();
    if (
      instructionsLower &&
      content.length >= 12 &&
      instructionsLower.includes(content) &&
      !text.toLocaleLowerCase().includes(content)
    )
      result.instructionEchoLines++;
    if (match && label.length <= 40 && known.has(normalizeLabel(label))) {
      result.validLines++;
      if (!anchors(text, passage)) result.droppedLines++;
    } else if (match && /^[A-Z][A-Z0-9_ ]{1,39}$/.test(label.trim())) {
      result.invalidLines++;
      result.unknownLabelLines++;
    } else if (/^NONE\.?$/iu.test(line)) {
      // A stray NONE next to findings is tolerated by the parser.
    } else {
      result.invalidLines++;
      result.proseChars += line.length;
    }
  }
  result.format =
    result.invalidLines === 0
      ? "lines"
      : result.validLines > 0
        ? "partial"
        : "invalid";
  return result;
}

/**
 * Scores one cached result. Findings with `builtinLabels` are counted apart;
 * `instructions` lets the failure analysis spot echoed instructions;
 * `completionRef` reads older records, which lack the answer cue, as one
 * answer per label in profile order.
 */
export function scoreResult(
  c: CompiledCase,
  profile: Profile,
  record: ResultRecord,
  builtinLabels: readonly string[],
  instructions = "",
  completionRef = false,
): Scored {
  const custom = new Set(profile.labels.map((l) => l.label));
  const customFindings = record.findings.filter((f) => custom.has(f.category));
  const builtinPredicted = record.findings.length - customFindings.length;

  // Collapse accepted findings into passage-level predictions.
  const byPassage = new Map<
    string,
    { label: string; value: string; spans: { start: number; end: number }[] }
  >();
  for (const f of customFindings) {
    const value = f.value ?? c.text.slice(f.start, f.end);
    const key = `${f.category}\u0000${value.toLocaleLowerCase()}`;
    const entry = byPassage.get(key) ?? { label: f.category, value, spans: [] };
    entry.spans.push({ start: f.start, end: f.end });
    byPassage.set(key, entry);
  }
  const overlaps = (
    a: { start: number; end: number },
    b: { start: number; end: number },
  ) => a.start < b.end && b.start < a.end;

  const predicted: ScoredPrediction[] = [...byPassage.values()].map((p) => ({
    label: p.label,
    value: p.value,
    exact: c.expected.some((e) => e.label === p.label && e.passage === p.value),
    overlap: c.spans.some(
      (s) => s.label === p.label && p.spans.some((ps) => overlaps(ps, s)),
    ),
  }));
  const expected: ScoredExpected[] = c.expected.map((e) => {
    const spans = c.spans.filter(
      (s) => s.label === e.label && s.passage === e.passage,
    );
    return {
      label: e.label,
      passage: e.passage,
      exact: [...byPassage.values()].some(
        (p) => p.label === e.label && p.value === e.passage,
      ),
      overlap: customFindings.some(
        (f) => f.category === e.label && spans.some((s) => overlaps(f, s)),
      ),
      anyLabel: record.findings.some((f) => spans.some((s) => overlaps(f, s))),
    };
  });

  const raw = record.chunks.map((ch) => ch.output).join("\n— next chunk —\n");
  const categories = [...custom, ...builtinLabels];
  // Completion refs answer one line after a `LABEL:` cue: analyze `LABEL: answer`.
  // Older records lack the cue; their chunks follow the profile's label order.
  const cueFor = (i: number, ch: ResultRecord["chunks"][number]) =>
    ch.prefill ??
    (completionRef && record.chunks.length === profile.labels.length
      ? `${profile.labels[i]!.label}:`
      : undefined);
  const analyzed = record.chunks.map((ch, i) => {
    const cue = cueFor(i, ch);
    if (!cue || cue.includes("\n")) return ch.output;
    const answer = ch.output.trimStart().split(/\r?\n/u)[0] ?? "";
    const parts = answer
      .split(" | ")
      .map((part) => part.trim())
      .filter((part) => part && !/^NONE\.?$/iu.test(part));
    return parts.length
      ? parts.map((part) => `${cue} ${part}`).join("\n")
      : "NONE";
  });
  const analyses = analyzed.map((out) =>
    analyzeLines(out, c.text, categories, instructions),
  );
  const sum = (k: Exclude<keyof LineAnalysis, "format">) =>
    analyses.reduce((a, x) => a + x[k], 0);
  const formats = analyses.map((a) => a.format);
  const format: FormatClass = !formats.length
    ? "empty"
    : formats.includes("invalid")
      ? "invalid"
      : formats.includes("partial")
        ? "partial"
        : formats.every((f) => f === "empty")
          ? "empty"
          : formats.includes("lines")
            ? "lines"
            : formats.includes("none")
              ? "none"
              : "empty";
  const timeout = record.errorKind === "deadline";
  const echo =
    format !== "lines" &&
    format !== "none" &&
    record.chunks.some((ch) => isEcho(c.text, ch.output));
  const instructionEcho =
    sum("instructionEchoLines") * 2 >= Math.max(1, sum("meaningfulLines"));
  const dropped = sum("droppedLines");
  const unknown = sum("unknownLabelLines");

  let failure: FailureMode = "ok";
  if (timeout) failure = "timeout";
  else if (record.error) failure = "error";
  else if (format === "empty") failure = "empty";
  else if (echo) failure = "echo";
  else if (instructionEcho) failure = "echo_instructions";
  else if (format === "invalid" && unknown === 0) failure = "answered";
  else if (unknown > 0) failure = "unknown_label";
  else if (format === "partial") failure = "answered";
  else if (dropped > 0) failure = "hallucinated";

  return {
    caseId: c.id,
    model: record.model,
    instruction: record.instruction,
    labelVariant: record.labelVariant,
    config: configKey(record.model, record.instruction, record.labelVariant),
    profile: c.profile,
    lang: c.lang,
    mixed: Boolean(c.mixed),
    type: c.type,
    difficulty: c.difficulty,
    lengthBucket: c.lengthBucket,
    register: c.style.register,
    errors: c.style.errors,
    split: c.split,
    positive: c.positive,
    expected,
    predicted,
    builtinPredicted,
    detected: c.positive && expected.some((e) => e.overlap),
    falsePositiveCase: !c.positive && predicted.length > 0,
    format,
    compliant:
      !timeout && !record.error && (format === "lines" || format === "none"),
    failure,
    droppedLines: dropped,
    unknownLabelLines: unknown,
    echo,
    timeout,
    reviewMs: record.reviewMs,
    generatedTokens: record.chunks.reduce(
      (a, ch) => a + (ch.runtime?.generatedTokens ?? 0),
      0,
    ),
    finishReasons: record.chunks.map(
      (ch) => ch.runtime?.finishReason ?? "error",
    ),
    raw,
    ...(record.error ? { error: record.error } : {}),
  };
}
