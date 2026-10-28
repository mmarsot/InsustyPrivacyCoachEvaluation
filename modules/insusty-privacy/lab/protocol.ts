/**
 * The lab's line protocol: how it stops a generation and reads an answer.
 * These are copies of the extension's own, at 748f772 (PR #132): the line
 * stop (`LineOutputTracker`, `src/private-ai/on-device/slm-generation.ts`),
 * the parser and anchoring (`validateModelOutput`) and the plausibility
 * filter (`isPlausiblePassage`, `src/private-ai/slm-review.ts`).
 *
 * The extension's package exports none of them (only the module and the
 * contract), and the lab never imports extension internals, so the lab
 * keeps these copies instead of the ref's. They no longer follow a newer
 * ref by themselves: `npm run parity` replays answers through the ref's
 * package and fails when the lab's shipped reading of an answer and the
 * ref's disagree, which is when to copy the ref's change here.
 */

/** A passage the parser anchored in the text (UTF-16 offsets). */
export interface LabFinding {
  category: string;
  start: number;
  end: number;
  value: string;
}

/** The ref's cap on findings per answer. */
const MAX_FINDINGS = 20;
/** A passage this share of the scanned text or more is an echo of it. */
const MAX_PASSAGE_FRACTION = 0.8;

/** A label name compared without case, spaces or punctuation. */
export const normalizeLabel = (label: string): string =>
  label.toLocaleLowerCase().replace(/[^\p{L}\p{N}]/gu, "");
const isWordCharacter = (character: string | undefined): boolean =>
  character !== undefined && /[\p{L}\p{N}_]/u.test(character);

const hasWordBoundaries = (
  text: string,
  start: number,
  value: string,
): boolean => {
  const first = value.at(0);
  const last = value.at(-1);
  return (
    (!isWordCharacter(first) || !isWordCharacter(text.at(start - 1))) &&
    (!isWordCharacter(last) || !isWordCharacter(text.at(start + value.length)))
  );
};

/** Every whole-word occurrence of `value`: exact ones first, then case-insensitive ones. */
const findOccurrences = (text: string, value: string): number[] => {
  if (!value) return [];
  const exact: number[] = [];
  for (
    let start = text.indexOf(value);
    start >= 0;
    start = text.indexOf(value, start + value.length)
  )
    if (hasWordBoundaries(text, start, value)) exact.push(start);
  const insensitive: number[] = [];
  const lowerText = text.toLocaleLowerCase();
  const lowerValue = value.toLocaleLowerCase();
  for (
    let start = lowerText.indexOf(lowerValue);
    start >= 0;
    start = lowerText.indexOf(lowerValue, start + lowerValue.length)
  )
    if (
      !exact.includes(start) &&
      text.slice(start, start + value.length).toLocaleLowerCase() ===
        lowerValue &&
      hasWordBoundaries(text, start, value)
    )
      insensitive.push(start);
  return [...exact, ...insensitive];
};

const stripSurroundingQuotes = (value: string): string => {
  const pairs: ReadonlyArray<readonly [string, string]> = [
    ['"', '"'],
    ["'", "'"],
    ["`", "`"],
    ["“", "”"],
    ["‘", "’"],
  ];
  let stripped = value;
  let changed = true;
  while (changed) {
    changed = false;
    for (const [open, close] of pairs)
      if (stripped.startsWith(open) && stripped.endsWith(close)) {
        stripped = stripped.slice(open.length, -close.length).trim();
        changed = true;
        break;
      }
  }
  return stripped;
};

const passageVariants = (passage: string): string[] => {
  const trimmed = passage.trim();
  const withoutTrailingPunctuation = trimmed.replace(/[.,;:!?]+$/u, "").trim();
  return [
    ...new Set([
      trimmed,
      stripSurroundingQuotes(trimmed),
      withoutTrailingPunctuation,
      stripSurroundingQuotes(withoutTrailingPunctuation),
    ]),
  ].filter(Boolean);
};

const isEcho = (passage: string, chunk: string): boolean => {
  const chunkLength = chunk.trim().length;
  return (
    chunkLength > 0 &&
    passage.trim().length / chunkLength >= MAX_PASSAGE_FRACTION
  );
};

/**
 * Parses `LABEL: passage` lines and anchors each passage in `chunk.text`:
 * unmatched passages and echoes of the chunk are dropped, every whole-word
 * occurrence is kept (offsets shifted by `globalOffset`).
 */
export function validateModelOutput(
  raw: unknown,
  chunk: { text: string; offset: number },
  globalOffset: number,
  categories: readonly string[],
): LabFinding[] {
  if (typeof raw !== "string") return [];
  const categoryMap = new Map(
    categories.map((category) => [normalizeLabel(category), category]),
  );
  const lines = raw.split(/\r?\n/u);
  const meaningful = lines
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("```"));
  if (meaningful.length === 1 && /^NONE$/iu.test(meaningful[0] ?? ""))
    return [];
  const findings: LabFinding[] = [];
  for (const originalLine of lines) {
    const line = originalLine
      .trim()
      .replace(/^(?:(?:[-*•]+|\d+[.)])\s*)+/u, "");
    if (!line || line.startsWith("```")) continue;
    const match = /^(?<label>[^:\n]+?)\s*:\s*(?<passage>.+)$/u.exec(line);
    const label = match?.groups?.label;
    const rawPassage = match?.groups?.passage;
    if (!label || !rawPassage) continue;
    const category = categoryMap.get(normalizeLabel(label));
    if (!category) continue;
    for (const passage of passageVariants(rawPassage)) {
      if (isEcho(passage, chunk.text)) continue;
      const occurrences = findOccurrences(chunk.text, passage);
      if (!occurrences.length) continue;
      for (const start of occurrences)
        findings.push({
          category,
          start: globalOffset + start,
          end: globalOffset + start + passage.length,
          value: chunk.text.slice(start, start + passage.length),
        });
      break;
    }
  }
  return findings.slice(0, MAX_FINDINGS);
}

const PASSAGE_STOP_WORDS = new Set(
  "a an the and or of to in on at for with by is are be it this that ok yes no none le la les un une des du de et ou à au en pour par sur avec est ce ça oui non".split(
    " ",
  ),
);

/**
 * Whether one answered passage can be a sensitive item on its own: at least
 * 3 characters, not a bare one- or two-digit number (or range), not only
 * stop words, at most 8 words.
 */
export function isPlausiblePassage(passage: string): boolean {
  const value = passage.trim().replace(/^["'`“‘«]+|["'`”’».,;:!?]+$/gu, "");
  if (value.length < 3) return false;
  if (/^[+-]?\d{1,2}([-–]\d{1,2})?$/u.test(value)) return false;
  const words = value.split(/\s+/u);
  if (words.length > 8) return false;
  return !words.every((word) => PASSAGE_STOP_WORDS.has(word.toLowerCase()));
}

/**
 * The line-protocol stop: `NONE` alone is complete, a findings list is
 * complete at the blank line after it (or an `END` line), and any reply is
 * complete once a non-blank line repeats an earlier one.
 */
export class LineOutputTracker {
  private done = false;
  private contentSeen = false;
  private contentBeforeLine = false;
  private lineBlank = true;
  private lineWord: string | null = "";
  private lineWordClosed = false;
  private line = "";
  private readonly seenLines = new Set<string>();

  /** Consumes more generated text and reports whether the line reply is complete. */
  feed(text: string): boolean {
    if (this.done) return true;
    for (const char of text) {
      if (char === "\n") {
        if ((this.lineBlank && this.contentBeforeLine) || this.isMarkerLine())
          return this.finish();
        if (!this.lineBlank) {
          const line = this.line.trim();
          if (this.seenLines.has(line)) return this.finish();
          this.seenLines.add(line);
        }
        this.line = "";
        this.contentBeforeLine = this.contentSeen;
        this.lineBlank = true;
        this.lineWord = "";
        this.lineWordClosed = false;
        continue;
      }
      this.line += char;
      if (/\s/u.test(char)) {
        if (char !== " " && char !== "\t" && char !== "\r")
          this.lineBlank = false;
        if (this.lineWord) this.lineWordClosed = true;
      } else {
        this.contentSeen = true;
        this.lineBlank = false;
        if (this.lineWord !== null)
          this.lineWord =
            this.lineWordClosed || this.lineWord.length >= 4
              ? null
              : this.lineWord + char;
      }
    }
    return this.isMarkerLine() ? this.finish() : false;
  }

  private isMarkerLine(): boolean {
    const word = this.lineWord?.toUpperCase();
    return word === "END" || (word === "NONE" && !this.contentBeforeLine);
  }

  private finish(): true {
    this.done = true;
    return true;
  }
}
