/**
 * Example-derived patterns: a deterministic complement to the model for
 * identifier-like labels (hosts, account/ticket/customer ids, codes, figures),
 * which the small models mostly miss. Each label example that contains an
 * identifier-like token becomes a regular expression:
 *
 *   - words that are not identifier-like stay literal (case-insensitive);
 *   - an identifier token keeps its leading letters and its separators
 *     literal, and generalizes digit runs (\d with ±length) and later letter or
 *     mixed runs; short letter units right after digits (k, m, bn) stay literal;
 *   - a dotted host keeps its domain suffix literal (`[\w-]+\.int\.corp\.net`);
 *   - an identifier token with a literal prefix also matches on its own.
 *
 * Examples with no identifier-like token (plain names) produce no pattern.
 */

const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\/]/g, "\\$&");

const isIdToken = (token: string) =>
  /\p{N}/u.test(token) ||
  /[_=#@:/]/u.test(token) ||
  (token.match(/\./g) ?? []).length >= 2;

function segmentPattern(seg: string, first: boolean): string {
  const n = (k: number) => `\\p{N}{${Math.max(1, k - 2)},${k + 3}}`;
  if (/^\p{N}+$/u.test(seg)) return n(seg.length);
  if (/^\p{L}+$/u.test(seg)) {
    // A leading word or a lower-case key part (`id`, `int`) stays literal; codes are generalized.
    if (first || seg === seg.toLowerCase()) return escape(seg);
    return `[\\p{L}\\p{N}]{1,${seg.length + 4}}`;
  }
  let m = /^(\p{L}{1,4})(\p{N}+)$/u.exec(seg);
  if (m)
    return first
      ? `${escape(m[1]!)}${n(m[2]!.length)}`
      : `\\p{L}{1,4}${n(m[2]!.length)}`;
  m = /^(\p{N}+)(\p{L}{1,2})$/u.exec(seg);
  if (m) return `${n(m[1]!.length)}${escape(m[2]!)}`;
  return `[\\p{L}\\p{N}]{${Math.max(3, Math.ceil(seg.length / 2))},${seg.length * 2 + 2}}`;
}

function tokenPattern(token: string): { source: string; standalone: boolean } {
  const dots = (token.match(/\./g) ?? []).length;
  if (dots >= 2 && !/^\p{N}/u.test(token) && !/:\/\//u.test(token)) {
    const at = token.indexOf(".");
    return {
      source: `[\\p{L}\\p{N}_-]+${escape(token.slice(at))}`,
      standalone: true,
    };
  }
  const parts = token.match(/[\p{L}\p{N}]+|[^\p{L}\p{N}]+/gu) ?? [];
  const firstAlnum = parts.findIndex((x) => /[\p{L}\p{N}]/u.test(x));
  const source = parts
    .map((x, i) =>
      /[\p{L}\p{N}]/u.test(x)
        ? segmentPattern(x, i === firstAlnum && i === 0)
        : escape(x),
    )
    .join("");
  // Stands alone when it starts with a literal code prefix (`cus_`, `ORD-`, `TR-`) or `#`/`@`.
  const standalone =
    /^[#@]/u.test(token) ||
    (/^\p{L}{2,}/u.test(parts[0] ?? "") && parts.length > 1);
  return { source, standalone };
}

/** A pattern derived from one label example (`from`). */
export interface LabelPattern {
  label: string;
  regex: RegExp;
  from: string;
}

/** A money or percentage token: `£1.284bn`, `41.7%`, `€87k`, `$412`. */
const isFigureToken = (token: string) =>
  /^[£€$]?\p{N}[\p{N}.,]*(?:%|k|m|bn|M|K)?$/u.test(token) &&
  /[£€$%]|\p{N}(?:k|m|bn|M|K)$/u.test(token);

/**
 * The patterns of a profile's labels. With `figures`, a money or percentage
 * token of an example also matches on its own, as an identifier with a
 * literal prefix does.
 */
export function labelPatterns(
  labels: ReadonlyArray<{ label: string; examples: readonly string[] }>,
  options: { figures?: boolean } = {},
): LabelPattern[] {
  const out: LabelPattern[] = [];
  const add = (label: string, source: string, from: string) => {
    const regex = new RegExp(
      `(?<![\\p{L}\\p{N}_])${source}(?![\\p{L}\\p{N}_])`,
      "giu",
    );
    if (!out.some((p) => p.label === label && p.regex.source === regex.source))
      out.push({ label, regex, from });
  };
  for (const { label, examples } of labels)
    for (const example of examples) {
      const tokens = example.trim().split(/\s+/u);
      if (!tokens.some(isIdToken)) continue;
      const parts = tokens.map((t) =>
        isIdToken(t)
          ? tokenPattern(t)
          : { source: escape(t), standalone: false },
      );
      add(label, parts.map((p) => p.source).join("\\s+"), example);
      tokens.forEach((t, i) => {
        if (
          isIdToken(t) &&
          (parts[i]!.standalone || (options.figures && isFigureToken(t)))
        )
          add(label, parts[i]!.source, example);
      });
    }
  return out;
}

/** Every match of every pattern in `text`, once per label and span. */
export function patternFindings(
  text: string,
  patterns: readonly LabelPattern[],
) {
  const found: Array<{
    category: string;
    start: number;
    end: number;
    value: string;
  }> = [];
  for (const p of patterns)
    for (const m of text.matchAll(p.regex))
      if (
        !found.some(
          (f) =>
            f.category === p.label &&
            f.start === m.index &&
            f.end === m.index + m[0].length,
        )
      )
        found.push({
          category: p.label,
          start: m.index,
          end: m.index + m[0].length,
          value: m[0],
        });
  return found;
}
