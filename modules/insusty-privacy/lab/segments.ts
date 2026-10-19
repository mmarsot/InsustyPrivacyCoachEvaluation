/**
 * Sentence and clause segmentation for the lab's segment view (every lab run
 * prints segment precision/recall and over-redaction): code cuts a prompt
 * into sentences or clear clauses with exact offsets. This is what remains of
 * the rejected segment Yes/No classification (experiments/LOG.md S1-S4; its
 * request texts, answer parser and `seg-*` configurations were deleted with
 * the restructure, see LOG.md for the last commit that has them).
 */

/** A sentence or clause of the prompt: UTF-16 offsets, `start < end`. */
export interface Segment {
  start: number;
  end: number;
}

// ------------------------------------------------------------------ segmentation

/** Tokens that end with a period without ending a sentence (lower-case, trailing dot removed). */
const ABBREVIATIONS = new Set(
  "mr mrs ms dr prof st jr sr mme mlle mm vs etc approx cf fig figs vol art env inc ltd corp co llc dept est min max no nos tel ref réf av bd ch resp ex".split(
    " ",
  ),
);

const OPEN_QUOTES = new Set(['"', "“", "«"]);
const CLOSE_QUOTES = new Set(['"', "”", "»"]);

/** Whether the period at `dot` (the last char of `token`) ends a sentence. */
function periodEnds(token: string, lineStart: boolean): boolean {
  const word = token
    .replace(/^[("'“‘«[]+/u, "")
    .replace(/\.+$/u, "")
    .toLowerCase();
  if (!word) return true;
  if (ABBREVIATIONS.has(word)) return false;
  // Initials (K. Anand, M. Lhomme) and dotted abbreviations (e.g., p.m., U.S.).
  if (/^\p{L}$/u.test(word) || /^(?:\p{L}\.)+\p{L}$/u.test(word)) return false;
  // A list number at the start of a line ("1. First item").
  if (lineStart && /^\d{1,3}$/u.test(word)) return false;
  return true;
}

/**
 * Cuts one line (no line breaks) into sentence / clause ranges: after `.`,
 * `!`, `?` or `…` runs followed by whitespace (not after abbreviations,
 * initials or a leading list number; decimals and URLs have no whitespace
 * after their dots), and after `;` followed by whitespace outside quotes.
 */
function splitLine(text: string, from: number, to: number): Segment[] {
  const cuts: number[] = [];
  let quoted = false;
  for (let i = from; i < to; i++) {
    const ch = text[i]!;
    if (ch === '"') quoted = !quoted;
    else if (OPEN_QUOTES.has(ch)) quoted = true;
    else if (CLOSE_QUOTES.has(ch)) quoted = false;
    if (ch === ";" && !quoted && /\s/u.test(text[i + 1] ?? "")) {
      cuts.push(i + 1);
      continue;
    }
    if (!/[.!?…]/u.test(ch)) continue;
    let j = i;
    while (j + 1 < to && /[.!?…]/u.test(text[j + 1]!)) j++;
    // Closing quotes or brackets right after the punctuation stay in the sentence.
    let k = j;
    while (k + 1 < to && /["'”’»)\]]/u.test(text[k + 1]!)) k++;
    const next = text[k + 1];
    if (next !== undefined && k + 1 < to && /\s/u.test(next)) {
      const run = text.slice(i, j + 1);
      let ends = true;
      if (run === ".") {
        let s = i;
        while (s > from && !/\s/u.test(text[s - 1]!)) s--;
        ends = periodEnds(
          text.slice(s, i + 1),
          s === from || /^\s*$/u.test(text.slice(from, s)),
        );
      }
      if (ends) cuts.push(k + 1);
    }
    i = k;
  }
  const out: Segment[] = [];
  let start = from;
  for (const cut of [...cuts, to]) {
    const seg = trimRange(text, start, cut);
    if (seg) out.push(seg);
    start = cut;
  }
  return out;
}

function trimRange(text: string, start: number, end: number): Segment | null {
  while (start < end && /\s/u.test(text[start]!)) start++;
  while (end > start && /\s/u.test(text[end - 1]!)) end--;
  return end > start ? { start, end } : null;
}

/** Splits a range longer than `maxChars` at the comma (else space) nearest its middle, recursively. */
function splitLong(text: string, seg: Segment, maxChars: number): Segment[] {
  if (seg.end - seg.start <= maxChars) return [seg];
  const mid = (seg.start + seg.end) >> 1;
  let best = -1;
  for (const re of [/,\s/gu, /\s/gu]) {
    re.lastIndex = 0;
    const slice = text.slice(seg.start, seg.end);
    for (let m = re.exec(slice); m; m = re.exec(slice)) {
      const at = seg.start + m.index + 1;
      if (
        at > seg.start &&
        at < seg.end &&
        (best < 0 || Math.abs(at - mid) < Math.abs(best - mid))
      )
        best = at;
    }
    if (best > 0) break;
  }
  if (best < 0) return [seg];
  return [trimRange(text, seg.start, best), trimRange(text, best, seg.end)]
    .filter((s): s is Segment => s !== null)
    .flatMap((s) => splitLong(text, s, maxChars));
}

/**
 * Segments a prompt: every line (paragraphs, list items, table rows) is a
 * boundary, then sentences and `;` clauses within a line. Segments are
 * trimmed of surrounding whitespace, never overlap, and together cover every
 * non-whitespace character of the text.
 */
export function segmentText(text: string, maxChars = 1000): Segment[] {
  const out: Segment[] = [];
  const lineBreak = /\r?\n/gu;
  let start = 0;
  for (let m = lineBreak.exec(text); ; m = lineBreak.exec(text)) {
    const end = m ? m.index : text.length;
    for (const seg of splitLine(text, start, end))
      out.push(...splitLong(text, seg, maxChars));
    if (!m) break;
    start = m.index + m[0].length;
  }
  return out;
}
