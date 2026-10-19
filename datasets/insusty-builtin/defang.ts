/**
 * Keeps the fictional secrets of the dataset and of run outputs from
 * tripping secret scanners (GitHub push protection, gitleaks...) without
 * changing what the bench reads or shows.
 *
 * In JSON, one character of each provider prefix is written as a `\uXXXX`
 * escape: `JSON.parse` restores the exact value, but the raw file no longer
 * contains `sk_live_`, `xoxb-`, `AKIA`, a MongoDB Atlas or Azure SQL
 * connection string... In HTML the same character becomes a numeric entity,
 * which the browser displays unchanged.
 */
const PREFIXES =
  /(?:sk|rk|pk)_(?:live|test)_|xox[baprs]-|gh[pousr]_|github_pat_|glpat-|AKIA|ASIA|AIza|sk-ant-|sk-proj-|hooks\.slack\.com\/services|\bhf_|-----BEGIN|eyJhbGci|[Aa][Ww][Ss]_[Ss][Ee][Cc][Rr][Ee][Tt]|mongodb\+srv:\/\/|database\.windows\.net/g;

const escapeSecond = (match: string, encode: (c: string) => string) =>
  match[0] + encode(match[1]!) + match.slice(2);

/** Escapes secret prefixes inside serialized JSON (string contents only are affected). */
export const defangJson = (json: string): string =>
  json.replace(PREFIXES, (m) =>
    escapeSecond(
      m,
      (c) => `\\u${c.charCodeAt(0).toString(16).padStart(4, "0")}`,
    ),
  );

/** Escapes secret prefixes in already-escaped HTML text. */
export const defangHtml = (html: string): string =>
  html.replace(PREFIXES, (m) =>
    escapeSecond(m, (c) => `&#${c.charCodeAt(0)};`),
  );

/** True when raw text still contains a secret prefix (the dataset files must not). */
export const hasRawSecretPrefix = (text: string): boolean =>
  new RegExp(PREFIXES.source).test(text);
