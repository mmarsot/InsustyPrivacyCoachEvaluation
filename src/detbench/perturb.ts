/**
 * Seeded, deterministic perturbations of base cases.
 *
 * Each perturbation rewrites a case's parts (literal text, item values, decoy
 * values) and re-renders it, so ground-truth spans stay exact. The random
 * choices come from a PRNG seeded by (seed, case id, perturbation, variant),
 * so a variant does not change when other cases are added or reordered.
 * A perturbation that does not apply to a case (nothing to change) yields no
 * variant.
 */
import { buildCase } from "./dataset.ts";
import type { DetCase, DetItem, Part } from "./schema.ts";

export const PERTURBATIONS = [
  "spacing",
  "separators",
  "alt_format",
  "case",
  "linebreak",
  "punctuation",
  "code_block",
  "env",
  "accents",
  "typo",
] as const;
export type Perturbation = (typeof PERTURBATIONS)[number];

/** What each perturbation does, for the report. */
export const PERTURBATION_INFO: Record<Perturbation, string> = {
  spacing: "Whitespace inside grouped values: compact, regrouped, no-break spaces or double spaces (IBAN, card, phone, NIR, SIRET, SSN...).",
  separators: "Group separators swapped: dots or dashes instead of spaces (06.12.34.56.78, 4925-9130-..., 14.03.1979).",
  alt_format: "Another common way to write the same value: +33 / +44 / +1 phone prefixes, textual or ISO dates of birth, abbreviated street types.",
  case: "The prose and case-insensitive values (email, IBAN, BIC, VAT, address, hex hashes) lower- or upper-cased; secrets keep their case.",
  linebreak: "A line break inside the value (IBAN or card split over two lines, address on two lines).",
  punctuation: "Values wrapped in quotes, brackets, guillemets or backticks, or followed by punctuation.",
  code_block: "The whole prompt pasted inside a fenced code block (a longer fence when the prompt already holds one).",
  env: "The values rewritten as a .env / YAML / TOML settings snippet (KEY=value).",
  accents: "Accents stripped from the prose and values (French typed without accents).",
  typo: "A typo in the context word before each value (swap, dropped or doubled letter), or in prose words for negatives.",
};

// ------------------------------------------------------------------ PRNG

const fnv1a = (s: string): number => {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h;
};

export type Rng = () => number;

/** mulberry32 seeded from a string key. */
export function rngFor(key: string): Rng {
  let a = fnv1a(key);
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const pick = <T>(rng: Rng, values: readonly T[]): T => values[Math.floor(rng() * values.length)]!;

// ------------------------------------------------------------ value forms

const GROUPINGS: Record<string, number[]> = {
  phone_fr: [2, 2, 2, 2, 2],
  phone_us: [3, 3, 4],
  nir: [1, 2, 2, 2, 3, 3, 2],
  siren: [3, 3, 3],
  siret: [3, 3, 3, 5],
  ssn: [3, 2, 4],
  nhs: [3, 3, 4],
  nino: [2, 2, 2, 2, 1],
};
const group = (s: string, sizes: number[]): string[] => {
  const out: string[] = [];
  let i = 0;
  for (const size of sizes) {
    if (i >= s.length) break;
    out.push(s.slice(i, i + size));
    i += size;
  }
  if (i < s.length) out.push(s.slice(i));
  return out;
};
const by4 = (s: string) => s.match(/.{1,4}/g) ?? [s];

/** The value's groups: its own separators if it has any, else the kind's usual grouping. */
export function valueTokens(item: Pick<DetItem, "kind">, value: string): string[] | null {
  const plain = value.replace(/[()]/g, "");
  const tokens = plain.split(/[\s.\-/]+/u).filter(Boolean);
  if (tokens.length > 1) return tokens;
  const compact = tokens[0] ?? "";
  // A compact international number (+14155550139) has no national grouping to restore.
  if (compact.startsWith("+")) return null;
  if (item.kind === "iban") return by4(compact);
  if (item.kind === "card") return compact.length === 15 ? group(compact, [4, 6, 5]) : by4(compact);
  if (item.kind === "tva") return [compact.slice(0, 2), compact.slice(2, 4), ...group(compact.slice(4), [3, 3, 3])];
  const sizes = GROUPINGS[item.kind];
  return sizes ? group(compact, sizes) : null;
}

const SPACED_KINDS = new Set(["iban", "card", "phone_fr", "phone_us", "phone_uk", "phone_de", "nir", "siren", "siret", "tva", "ssn", "nhs", "nino"]);
const SEPARATORS: Record<string, string[]> = {
  phone_fr: [".", "-"],
  phone_us: [".", "-"],
  phone_uk: ["-"],
  phone_de: ["-", "/"],
  card: ["-"],
  ssn: ["-"],
  nhs: ["-"],
  siren: ["."],
  siret: ["."],
  dob: ["/", ".", "-"],
};

const MONTHS: Record<"en" | "fr", string[]> = {
  en: ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"],
  fr: ["janvier", "février", "mars", "avril", "mai", "juin", "juillet", "août", "septembre", "octobre", "novembre", "décembre"],
};

function dobForms(iso: string, lang: "en" | "fr"): string[] {
  const [y, m, d] = iso.split("-") as [string, string, string];
  const month = MONTHS[lang][Number(m) - 1]!;
  const day = String(Number(d));
  return lang === "fr"
    ? [`${day} ${month} ${y}`, `${d}/${m}/${y}`, `${d}.${m}.${y}`, `${y}-${m}-${d}`]
    : [`${month} ${day}, ${y}`, `${day} ${month} ${y}`, `${m}/${d}/${y}`, `${d}/${m}/${y}`, `${y}-${m}-${d}`];
}

function phoneForms(kind: string, value: string): string[] {
  const digits = value.replace(/\D/g, "");
  const intl: Record<string, [string, number]> = { phone_fr: ["33", 9], phone_uk: ["44", 10], phone_de: ["49", 0], phone_us: ["1", 10] };
  const [cc, nsnLength] = intl[kind] ?? ["", 0];
  if (!cc) return [];
  // National significant number, without trunk prefix or country code.
  let nsn = value.trim().startsWith("+") ? digits.slice(cc.length) : kind === "phone_us" ? digits.slice(-10) : digits.replace(/^0/, "");
  if (nsnLength && nsn.length !== nsnLength) return [];
  if (kind === "phone_fr") {
    const pairs = group(nsn.slice(1), [2, 2, 2, 2]).join(" ");
    return [`+33 ${nsn[0]} ${pairs}`, `+33 (0)${nsn[0]} ${pairs}`, `+33${nsn}`, `0033 ${nsn[0]} ${pairs}`, `0${nsn[0]} ${pairs}`];
  }
  if (kind === "phone_us") {
    const [a, b, c] = group(nsn, [3, 3, 4]) as [string, string, string];
    return [`+1 ${a} ${b} ${c}`, `+1 (${a}) ${b}-${c}`, `1-${a}-${b}-${c}`, `(${a}) ${b}-${c}`, `${a}-${b}-${c}`];
  }
  if (kind === "phone_uk") {
    const london = nsn.startsWith("20");
    const g = london ? group(nsn, [2, 4, 4]) : group(nsn, [4, 6]);
    return [`+44 ${g.join(" ")}`, `+44 (0)${g.join(" ")}`, `0${g.join(" ")}`, `+44${nsn}`];
  }
  nsn = value.trim().startsWith("+") ? digits.slice(2) : digits.replace(/^0/, "");
  return [`+49 ${nsn.slice(0, 2)} ${nsn.slice(2)}`, `0${nsn.slice(0, 2)} ${nsn.slice(2)}`, `+49${nsn}`];
}

const STREET_ABBREVIATIONS: Array<[RegExp, string]> = [
  [/\bavenue\b/i, "av."],
  [/\bboulevard\b/i, "bd"],
  [/\brue\b/i, "r."],
  [/\bplace\b/i, "pl."],
  [/\bStreet\b/, "St."],
  [/\bAvenue\b/, "Ave"],
  [/\bRoad\b/, "Rd"],
  [/\bDrive\b/, "Dr."],
];

/** Candidate rewrites of one value for a value-level perturbation (the current form excluded). */
export function valueForms(type: Perturbation, item: DetItem, value: string, lang: "en" | "fr"): string[] {
  const out: string[] = [];
  if (type === "spacing" && SPACED_KINDS.has(item.kind)) {
    const tokens = valueTokens(item, value);
    if (tokens) out.push(tokens.join(""), tokens.join(" "), tokens.join(" "), tokens.join("  "));
  } else if (type === "separators" && SEPARATORS[item.kind]) {
    const tokens = item.kind === "dob" ? (/^\d{1,4}[/.-]\d{1,2}[/.-]\d{2,4}$/.test(value) ? value.split(/[/.-]/) : null) : valueTokens(item, value);
    if (tokens && tokens.length > 1) for (const sep of SEPARATORS[item.kind]!) out.push(tokens.join(sep));
  } else if (type === "alt_format") {
    if (item.kind.startsWith("phone_")) out.push(...phoneForms(item.kind, value));
    else if (item.kind === "dob" && item.iso) out.push(...dobForms(item.iso, lang));
    else if (item.kind.startsWith("address_")) {
      out.push(value.replace(/,(?=\s)/g, ""));
      for (const [pattern, short] of STREET_ABBREVIATIONS) if (pattern.test(value)) out.push(value.replace(pattern, short));
    }
  } else if (type === "linebreak") {
    if (item.kind.startsWith("address_")) {
      const commas = [...value.matchAll(/, /g)].map((m) => m.index ?? 0);
      for (const at of commas) out.push(`${value.slice(0, at)}\n${value.slice(at + 2)}`);
    } else if (["iban", "card", "nir", "siret"].includes(item.kind)) {
      const tokens = valueTokens(item, value);
      const sep = /\s/.test(value) ? " " : "";
      if (tokens && tokens.length > 2)
        for (let i = 1; i < tokens.length - 1; i++) out.push(`${tokens.slice(0, i).join(sep)}\n${tokens.slice(i).join(sep)}`);
    }
  }
  return [...new Set(out)].filter((v) => v !== value);
}

// ------------------------------------------------------------ helpers

const CASE_INSENSITIVE_ITEMS = new Set(["email", "iban", "bic", "tva", "address_fr", "address_us", "address_uk", "ipv6", "mac", "passport", "nino", "dob"]);
const CASE_INSENSITIVE_DECOYS = new Set(["git_sha", "hash", "trace_id", "uuid"]);

const stripAccents = (s: string) => s.normalize("NFD").replace(/\p{Mn}/gu, "").normalize("NFC");

/** Applies a per-key value rewrite to every occurrence of each changed item. */
function rewriteItems(c: DetCase, rng: Rng, type: Perturbation): { parts: Part[]; note: string } | null {
  const chosen = new Map<string, string>();
  for (const [key, item] of Object.entries(c.items)) {
    const forms = valueForms(type, item, item.value, c.lang);
    if (forms.length) chosen.set(key, pick(rng, forms));
  }
  if (!chosen.size) return null;
  const parts = c.parts.map((p) => (p.t === "item" && chosen.has(p.key) ? { ...p, s: chosen.get(p.key)! } : p));
  return { parts, note: [...chosen].map(([k, v]) => `${k} → ${JSON.stringify(v)}`).join("; ") };
}

/** Merges adjacent text parts (after insertions). */
const tidy = (parts: Part[]): Part[] => {
  const out: Part[] = [];
  for (const p of parts) {
    const last = out[out.length - 1];
    if (p.t === "text" && last?.t === "text") out[out.length - 1] = { t: "text", s: last.s + p.s };
    else if (p.t !== "text" || p.s) out.push(p);
  }
  return out;
};

const WRAPS: Record<"en" | "fr", Array<[string, string]>> = {
  en: [['"', '"'], ["'", "'"], ["(", ")"], ["[", "]"], ["<", ">"], ["`", "`"], ["", "."], ["", ","], ["", ";"], ["", ":"], ["", "!"], ["", ")."]],
  fr: [["« ", " »"], ["«", "»"], ['"', '"'], ["(", ")"], ["[", "]"], ["`", "`"], ["", "."], ["", ","], ["", " ;"], ["", " !"], ["", " :"]],
};

const ENV_NAMES: Record<string, string> = {
  email: "CONTACT_EMAIL",
  phone_fr: "SUPPORT_PHONE",
  phone_us: "SUPPORT_PHONE",
  phone_uk: "SUPPORT_PHONE",
  phone_de: "SUPPORT_PHONE",
  address_fr: "BILLING_ADDRESS",
  address_us: "BILLING_ADDRESS",
  address_uk: "BILLING_ADDRESS",
  iban: "PAYOUT_IBAN",
  bic: "PAYOUT_BIC",
  card: "TEST_CARD_NUMBER",
  cvv: "TEST_CARD_CVV",
  card_expiry: "TEST_CARD_EXPIRY",
  nir: "EMPLOYEE_NIR",
  siren: "COMPANY_SIREN",
  siret: "COMPANY_SIRET",
  tva: "VAT_NUMBER",
  ssn: "EMPLOYEE_SSN",
  nhs: "PATIENT_NHS_NUMBER",
  nino: "EMPLOYEE_NINO",
  passport: "PASSPORT_NUMBER",
  dob: "DATE_OF_BIRTH",
  ipv4: "PUBLIC_IP",
  ipv4_private: "DB_HOST",
  ipv6: "DB_HOST_V6",
  mac: "DEVICE_MAC",
  openai_key: "OPENAI_API_KEY",
  anthropic_key: "ANTHROPIC_API_KEY",
  google_api_key: "GOOGLE_MAPS_API_KEY",
  github_token: "GITHUB_TOKEN",
  gitlab_token: "GITLAB_TOKEN",
  aws_access_key: "AWS_ACCESS_KEY_ID",
  aws_secret_key: "AWS_SECRET_ACCESS_KEY",
  stripe_key: "STRIPE_SECRET_KEY",
  slack_token: "SLACK_BOT_TOKEN",
  slack_webhook: "SLACK_WEBHOOK_URL",
  hf_token: "HF_TOKEN",
  jwt: "SESSION_TOKEN",
  private_key: "SIGNING_PRIVATE_KEY",
  password: "DB_PASSWORD",
  generic_token: "API_TOKEN",
  timestamp: "LAST_DEPLOY_AT",
  date: "RELEASE_DATE",
  git_sha: "GIT_COMMIT",
  hash: "ARTIFACT_SHA256",
  trace_id: "TRACE_ID",
  uuid: "TENANT_ID",
  version: "APP_VERSION",
  price: "PLAN_PRICE",
  order_number: "ORDER_REF",
  number: "MAX_RETRIES",
  identifier: "SERVICE_NAME",
  url: "API_BASE_URL",
  invalid_checksum: "LEGACY_REF",
  loopback: "BIND_HOST",
  port: "PORT",
  masked_secret: "API_KEY_HINT",
  base64: "LOGO_DATA",
  public_key: "JWT_PUBLIC_KEY",
  placeholder: "EXAMPLE_PASSWORD",
  term: "KEY_ALGORITHM",
};

const LEADS = {
  code_block: {
    en: ["Can you check this?", "Here's what I have:", "Why does this fail?", "Quick sanity check please:"],
    fr: ["Tu peux vérifier ça ?", "Voilà ce que j'ai :", "Pourquoi ça plante ?", "Petite relecture stp :"],
  },
  env: {
    en: ["My app doesn't pick up these settings, what's wrong?", "Here is my .env, can you turn it into a docker-compose file?", "Config below, can you spot the typo?"],
    fr: ["Mon appli ne lit pas ces variables, tu vois pourquoi ?", "Voici mon .env, tu peux en faire un docker-compose ?", "Config ci-dessous, tu vois l'erreur ?"],
  },
};

function typoWord(word: string, rng: Rng): string {
  const op = Math.floor(rng() * 3);
  const i = 1 + Math.floor(rng() * Math.max(1, word.length - 2));
  if (op === 0 && i < word.length - 1) return word.slice(0, i) + word[i + 1] + word[i] + word.slice(i + 2);
  if (op === 1) return word.slice(0, i) + word.slice(i + 1);
  return word.slice(0, i) + word[i] + word.slice(i);
}

// ------------------------------------------------------------ perturbations

type Perturber = (c: DetCase, rng: Rng) => { parts: Part[]; note: string } | null;

const PERTURBERS: Record<Perturbation, Perturber> = {
  spacing: (c, rng) => rewriteItems(c, rng, "spacing"),
  separators: (c, rng) => rewriteItems(c, rng, "separators"),
  alt_format: (c, rng) => rewriteItems(c, rng, "alt_format"),
  linebreak: (c, rng) => rewriteItems(c, rng, "linebreak"),

  case: (c, rng) => {
    const upper = rng() < 0.5;
    const f = (s: string) => (upper ? s.toLocaleUpperCase(c.lang) : s.toLocaleLowerCase(c.lang));
    const parts = c.parts.map((p): Part => {
      if (p.t === "text") return { ...p, s: f(p.s) };
      if (p.t === "item" && CASE_INSENSITIVE_ITEMS.has(c.items[p.key]!.kind)) return { ...p, s: f(p.s) };
      if (p.t === "decoy" && CASE_INSENSITIVE_DECOYS.has(c.decoys[p.key]!.kind)) return { ...p, s: f(p.s) };
      return p;
    });
    return { parts, note: upper ? "upper case" : "lower case" };
  },

  punctuation: (c, rng) => {
    if (!Object.keys(c.items).length) return null;
    // A value already followed by punctuation only gets enclosing wraps ("x", (x)...), never "x.,".
    const followedByPunctuation = new Set(
      c.parts.flatMap((p, i) => (p.t === "item" && /^[.,;:!?)»]/.test(c.parts[i + 1]?.s ?? "") ? [p.key] : [])),
    );
    const wraps = new Map(
      Object.keys(c.items).map((key) => [key, pick(rng, WRAPS[c.lang].filter(([open]) => open || !followedByPunctuation.has(key)))] as const),
    );
    const parts: Part[] = [];
    for (const p of c.parts) {
      const wrap = p.t === "item" ? wraps.get(p.key) : undefined;
      if (!wrap) {
        parts.push(p);
        continue;
      }
      parts.push({ t: "text", s: wrap[0] }, p, { t: "text", s: wrap[1] });
    }
    return { parts: tidy(parts), note: [...wraps].map(([k, [a, b]]) => `${k}: ${a}…${b}`).join("; ") };
  },

  code_block: (c, rng) => {
    let fence = pick(rng, ["```", "```", "```text", "```bash", "~~~"]);
    // A prompt that already holds a fence gets a longer one around it, so its own fence does not close the new one.
    const inner = Math.max(0, ...[...c.text.matchAll(/^ {0,3}(`{3,}|~{3,})/gm)].filter((m) => m[1]![0] === fence[0]).map((m) => m[1]!.length));
    if (inner) fence = fence[0]!.repeat(inner + 1) + fence.replace(/^[`~]+/, "");
    const close = fence.match(/^[`~]+/)![0];
    const lead = pick(rng, LEADS.code_block[c.lang]);
    return { parts: tidy([{ t: "text", s: `${lead}\n${fence}\n` }, ...c.parts, { t: "text", s: `\n${close}` }]), note: `fence ${fence}` };
  },

  env: (c, rng) => {
    const seen = new Set<string>();
    const order = c.parts.filter((p): p is Exclude<Part, { t: "text" }> => p.t !== "text" && !seen.has(p.key) && !!seen.add(p.key));
    if (!order.some((p) => p.t === "item")) return null;
    const style = pick(rng, ["dotenv", "export", "yaml", "toml"] as const);
    const names = new Map<string, number>();
    const parts: Part[] = [{ t: "text", s: `${pick(rng, LEADS.env[c.lang])}\n\n` }];
    for (const p of order) {
      const kind = p.t === "item" ? c.items[p.key]!.kind : c.decoys[p.key]!.kind;
      let name = ENV_NAMES[kind] ?? p.key.toUpperCase();
      const n = (names.get(name) ?? 0) + 1;
      names.set(name, n);
      if (n > 1) name = `${name}_${n}`;
      const quote = style === "toml" || /[\s#"']/.test(p.s) ? '"' : "";
      const key = style === "yaml" ? name.toLowerCase() : name;
      const lead = style === "export" ? `export ${key}=` : style === "yaml" ? `${key}: ` : style === "toml" ? `${key} = ` : `${key}=`;
      parts.push({ t: "text", s: `${lead}${quote}` }, p, { t: "text", s: `${quote}\n` });
    }
    return { parts: tidy(parts), note: style };
  },

  accents: (c) => {
    let changed = false;
    const parts = c.parts.map((p): Part => {
      const s = stripAccents(p.s);
      if (s !== p.s) changed = true;
      return { ...p, s };
    });
    return changed ? { parts, note: "accents stripped" } : null;
  },

  typo: (c, rng) => {
    const parts = c.parts.map((p) => ({ ...p }));
    const changed: string[] = [];
    const typoIn = (index: number, fromEnd: boolean) => {
      const p = parts[index];
      if (!p || p.t !== "text") return;
      const words = [...p.s.matchAll(/\p{L}{3,}/gu)];
      if (!words.length) return;
      const w = fromEnd ? words[words.length - 1]! : pick(rng, words);
      if (fromEnd && (w.index ?? 0) < p.s.length - 40) return;
      const typo = typoWord(w[0], rng);
      if (typo === w[0]) return;
      p.s = p.s.slice(0, w.index) + typo + p.s.slice((w.index ?? 0) + w[0].length);
      changed.push(`${w[0]} → ${typo}`);
    };
    const itemIndexes = parts.map((p, i) => (p.t === "item" ? i : -1)).filter((i) => i > 0);
    if (itemIndexes.length) for (const i of itemIndexes) typoIn(i - 1, true);
    else {
      const texts = parts.map((p, i) => (p.t === "text" ? i : -1)).filter((i) => i >= 0);
      for (let n = 0; n < 3 && texts.length; n++) typoIn(pick(rng, texts), false);
    }
    return changed.length ? { parts: parts as Part[], note: changed.join("; ") } : null;
  },
};

/**
 * Generates up to `variants` distinct variants per (base case, perturbation).
 * Ids are `<base id>~<perturbation>~<n>`. Large generated cases are not
 * perturbed: they measure false-positive floods and runtime, not formats.
 */
export function perturbCases(
  bases: DetCase[],
  options: { seed: number; variants: number; types?: readonly Perturbation[] },
): DetCase[] {
  const out: DetCase[] = [];
  for (const base of bases) {
    if (base.large) continue;
    for (const type of options.types ?? PERTURBATIONS) {
      const texts = new Set([base.text]);
      for (let n = 0; n < options.variants; n++) {
        // Try a few draws for a variant that differs from the base and earlier variants.
        for (let attempt = 0; attempt < 4; attempt++) {
          const rng = rngFor(`${options.seed}|${base.id}|${type}|${n}|${attempt}`);
          const result = PERTURBERS[type](base, rng);
          if (!result) break;
          const variant = buildCase(
            { ...base, id: `${base.id}~${type}~${n + 1}`, perturbation: type, perturbationNote: result.note },
            result.parts,
          );
          if (texts.has(variant.text)) continue;
          texts.add(variant.text);
          out.push(variant);
          break;
        }
      }
    }
  }
  return out;
}
