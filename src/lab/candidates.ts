/**
 * Candidate spans for the classification approach: code proposes the
 * passages that could be sensitive, and the model only answers yes/no per
 * (candidate, label). Candidates are deterministic and language-agnostic:
 *
 *   - identifier-like tokens: letters and digits mixed, or joined by _ - . / : @ #
 *     (hostnames, service names, customer/ticket/order ids, codes);
 *   - capitalized word sequences (names, companies, products, codenames),
 *     allowing lowercase particles inside (de, du, van, &...);
 *   - money, percentages and figures with a unit, bare decimals and 3+ digit numbers;
 *   - quoted strings;
 *   - words written in ALL CAPS (codenames).
 *
 * Overlapping candidates are all kept (e.g. "Project Falcon" and "Falcon");
 * the classifier decides.
 */

export interface Candidate {
  start: number;
  end: number;
  text: string;
  kind: "id" | "caps" | "name" | "figure" | "quoted";
}

/** Capitalized words that open sentences or messages and are never sensitive on their own. */
const STOP = new Set(
  (
    "i a an the hi hello hey dear thanks thank best regards cheers ok okay yes no please can could would should will is are was were this that these those it its we our you your he she they my me " +
    "monday tuesday wednesday thursday friday saturday sunday january february march april may june july august september october november december " +
    "bonjour salut merci cordialement bonne journee journée le la les un une des du de et ou mais donc je tu il elle nous vous ils elles mon ma mes ton ta ses notre votre leur ce cet cette ces " +
    "lundi mardi mercredi jeudi vendredi samedi dimanche janvier fevrier février mars avril mai juin juillet aout août septembre octobre novembre decembre décembre " +
    "q1 q2 q3 q4 h1 h2 fy ok re fw fwd tl dr asap fyi eod eta cc pm am"
  ).split(" "),
);
const PARTICLES = new Set(
  "de du des la le van von der den di da & and et of".split(" "),
);

const add = (
  out: Candidate[],
  text: string,
  start: number,
  end: number,
  kind: Candidate["kind"],
) => {
  const raw = text.slice(start, end);
  const trimmed = raw.replace(/[.,;:!?)\]}'"’”]+$/u, "");
  const lead = trimmed.length - trimmed.replace(/^[(["'“‘]+/u, "").length;
  const s = start + lead;
  const e = start + trimmed.length;
  if (e - s < 2) return;
  if (!out.some((c) => c.start === s && c.end === e))
    out.push({ start: s, end: e, text: text.slice(s, e), kind });
};

/**
 * The candidate passages of `text` (see the file header): the first `max` in
 * text order, trimmed of surrounding quotes and punctuation, never shorter
 * than two characters.
 */
export function generateCandidates(text: string, max = 60): Candidate[] {
  const out: Candidate[] = [];
  let m: RegExpExecArray | null;

  // Identifier-like tokens.
  const idRe = /[\p{L}\p{N}][\p{L}\p{N}_\-./:@#]*[\p{L}\p{N}]/gu;
  while ((m = idRe.exec(text))) {
    const t = m[0];
    const hasDigit = /\p{N}/u.test(t);
    const hasLetter = /\p{L}/u.test(t);
    const joined = /[_\-./:@#]/u.test(t);
    if (
      (hasDigit && hasLetter) ||
      (joined && hasLetter && t.length >= 4) ||
      (hasDigit && joined && t.replace(/\D/gu, "").length >= 4)
    )
      add(out, text, m.index, m.index + t.length, "id");
    else if (/^\p{Lu}{2,}\p{N}*$/u.test(t) && !STOP.has(t.toLowerCase()))
      add(out, text, m.index, m.index + t.length, "caps");
  }

  // Capitalized sequences, with particles inside.
  const wordRe = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  const words: Array<{ w: string; s: number; e: number }> = [];
  while ((m = wordRe.exec(text)))
    words.push({ w: m[0], s: m.index, e: m.index + m[0].length });
  const isCap = (w: string) =>
    /^\p{Lu}/u.test(w) && !STOP.has(w.toLowerCase().replace(/['’]s$/u, ""));
  for (let i = 0; i < words.length; i++) {
    if (!isCap(words[i]!.w)) continue;
    let j = i;
    while (j + 1 < words.length && j - i < 4) {
      const next = words[j + 1]!;
      const gap = text.slice(words[j]!.e, next.s);
      if (!/^[ \t]+$|^ & $/u.test(gap)) break;
      if (isCap(next.w)) j++;
      else if (
        PARTICLES.has(next.w.toLowerCase()) &&
        j + 2 < words.length &&
        isCap(words[j + 2]!.w) &&
        /^[ \t]+$/u.test(text.slice(next.e, words[j + 2]!.s))
      )
        j += 2;
      else break;
    }
    // The whole run, and each single capitalized word inside a multi-word run.
    add(out, text, words[i]!.s, words[j]!.e, "name");
    if (j > i)
      for (let k = i; k <= j; k++)
        if (isCap(words[k]!.w))
          add(out, text, words[k]!.s, words[k]!.e, "name");
    i = j;
  }

  // Money, percentages and figures with a unit.
  const figRe =
    /(?:[$€£]\s?)?\d[\d\s.,]*\d?(?:\s?(?:%|pts?|bps|k€|K€|M€|Md€|€|\$|£|k|K|M|m|bn|Bn|millions?|milliards?|million|billion))(?![\p{L}])|[$€£]\s?\d[\d.,]*(?:\s?(?:k|K|M|m|bn))?/gu;
  while ((m = figRe.exec(text)))
    add(out, text, m.index, m.index + m[0].trimEnd().length, "figure");
  // Bare figures: decimals, multiples and numbers of 3+ digits (amounts, ids, counts).
  const numRe =
    /(?<![\p{L}\p{N}.,])[+-]?\d+(?:[.,]\d+)+x?(?![\p{L}\p{N}])|(?<![\p{L}\p{N}.,])\d{3,}(?:[ \u00a0]\d{3})*(?:[.,]\d+)?(?![\p{L}\p{N}])/gu;
  while ((m = numRe.exec(text)))
    add(out, text, m.index, m.index + m[0].length, "figure");

  // Quoted strings (short).
  const qRe = /["“«]([^"”»\n]{2,60})["”»]/gu;
  while ((m = qRe.exec(text))) {
    const inner = m[1]!.trim();
    const s = text.indexOf(inner, m.index);
    add(out, text, s, s + inner.length, "quoted");
  }

  return out.sort((a, b) => a.start - b.start || b.end - a.end).slice(0, max);
}
