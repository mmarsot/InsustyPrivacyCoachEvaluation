/**
 * Deterministic-redaction dataset types (`dataset/detbench/<lang>.jsonl`).
 *
 * A case is a template with `{{key}}` placeholders. Each key names either a
 * sensitive item (ground truth, with a category and a value kind) or a decoy
 * (a hard negative that must not be flagged: timestamp, git SHA, version...).
 * Rendering the template gives the prompt text and exact spans, and
 * perturbations (`perturb.ts`) rewrite the parts separately, so spans stay
 * exact after any change.
 */

/**
 * Ground-truth categories, named as in the detector upgrade (API_KEY is
 * SECRET there; SIREN, SIRET and VAT numbers are COMPANY_ID, apart from
 * personal NATIONAL_ID). A ref that lacks one reports it as "not supported by
 * this ref" instead of scoring its items as misses.
 */
export const DET_CATEGORIES = [
  "SECRET",
  "EMAIL",
  "PHONE",
  "ADDRESS",
  "FINANCIAL",
  "NATIONAL_ID",
  "DATE_OF_BIRTH",
  "IP",
  "COMPANY_ID",
] as const;
export type DetCategory = (typeof DET_CATEGORIES)[number];

/** Value kinds per category; they drive checksum validation and format perturbations. */
export const ITEM_KINDS: Record<DetCategory, readonly string[]> = {
  SECRET: [
    "openai_key",
    "anthropic_key",
    "google_api_key",
    "github_token",
    "gitlab_token",
    "aws_access_key",
    "aws_secret_key",
    "stripe_key",
    "slack_token",
    "slack_webhook",
    "hf_token",
    "jwt",
    "private_key",
    "password",
    "generic_token",
  ],
  EMAIL: ["email"],
  PHONE: ["phone_fr", "phone_us", "phone_uk", "phone_de"],
  ADDRESS: ["address_fr", "address_us", "address_uk"],
  FINANCIAL: ["iban", "bic", "card", "cvv", "card_expiry"],
  NATIONAL_ID: ["nir", "ssn", "nhs", "nino", "passport"],
  DATE_OF_BIRTH: ["dob"],
  IP: ["ipv4", "ipv4_private", "ipv6", "mac"],
  COMPANY_ID: ["siren", "siret", "tva"],
};

/** Hard-negative kinds: look like identifiers but are not sensitive. */
export const DECOY_KINDS = [
  "timestamp",
  "date",
  "git_sha",
  "hash",
  "trace_id",
  "uuid",
  "version",
  "price",
  "order_number",
  "number",
  "identifier",
  "url",
  /** Fails the checksum of the item kind named in `of` (an IBAN or card look-alike). */
  "invalid_checksum",
  /** 127.0.0.1, localhost, ::1, 0.0.0.0. */
  "loopback",
  "port",
  /** A key shown masked or truncated (sk-...a1B2), no longer usable. */
  "masked_secret",
  /** High-entropy data that is not a secret: a base64 image, a font. */
  "base64",
  "public_key",
  /** Placeholder syntax standing for a value, not a value: `<password>`, `<mot_de_passe>`. */
  "placeholder",
  /** A technical term or acronym in prose, e.g. in parentheses after a secret keyword: RSA-2048, v2, 2FA, OAuth2. */
  "term",
] as const;
export type DecoyKind = (typeof DECOY_KINDS)[number];

export interface DetItem {
  category: DetCategory;
  kind: string;
  value: string;
  /** DATE_OF_BIRTH only: the date as YYYY-MM-DD, for format perturbations. */
  iso?: string;
}
export interface DetDecoy {
  kind: DecoyKind;
  value: string;
  /** invalid_checksum only: the item kind it imitates (iban, card, nir...); the value must fail that kind's checksum. */
  of?: string;
}

export const REGISTERS = ["email", "chat", "notes", "doc", "form", "ticket", "code", "log", "config"] as const;

/** One line of `dataset/detbench/<lang>.jsonl`. */
export interface DetCaseSource {
  id: string;
  lang: "en" | "fr";
  register: (typeof REGISTERS)[number];
  template: string;
  items?: Record<string, DetItem>;
  decoys?: Record<string, DetDecoy>;
  tags?: string[];
  note?: string;
}

/** Case type, derived: no item, one category, or several categories. */
export type DetCaseType = "negative" | "single" | "multi";

/**
 * Where a value sits in the prompt: inside a fenced (``` or ~~~) or indented
 * code block, or in the surrounding prose. Derived from the rendered text.
 */
export type Zone = "prose" | "code";

/** A piece of a case: literal text, or one placeholder occurrence. */
export type Part = { t: "text"; s: string } | { t: "item"; key: string; s: string } | { t: "decoy"; key: string; s: string };

export interface GoldSpan {
  key: string;
  category: DetCategory;
  kind: string;
  start: number;
  end: number;
  value: string;
  zone: Zone;
}
export interface DecoySpan {
  key: string;
  kind: DecoyKind;
  start: number;
  end: number;
  value: string;
  zone: Zone;
}

/** A rendered case (a base case or one of its perturbed variants). */
export interface DetCase {
  id: string;
  baseId: string;
  lang: "en" | "fr";
  register: string;
  type: DetCaseType;
  tags: string[];
  /** `none` for base cases, else the perturbation type. */
  perturbation: string;
  /** What the perturbation changed, for the report. */
  perturbationNote?: string;
  items: Record<string, DetItem>;
  decoys: Record<string, DetDecoy>;
  parts: Part[];
  text: string;
  gold: GoldSpan[];
  decoySpans: DecoySpan[];
}
