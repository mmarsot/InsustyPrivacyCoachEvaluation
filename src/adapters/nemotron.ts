/**
 * Nemotron-PII (NVIDIA, 2025): synthetic, persona-grounded English records
 * (US and international locales) with character spans for 55 PII/PHI types.
 * The test file holds 100,000 records (96 M characters), so a default run
 * scores a pinned, seeded sample of 3,000 (`--limit 0` for all).
 *
 * Mapped to built-ins: e-mail, phone and fax, street address, date of birth,
 * card, bank account, routing and SWIFT/BIC numbers (FINANCIAL), SSN,
 * national and tax ids (NATIONAL_ID), IPv4/IPv6, API keys, passwords and
 * HTTP cookies (SECRET). Names and companies are custom-label territory;
 * the other types (health and vehicle identifiers, URLs, demographics,
 * dates...) have no rule and are reported outside the headline.
 */
import { join } from "node:path";
import { deterministicConfigs } from "./configs.ts";
import { readParquet } from "./parquet.ts";
import type { BenchmarkAdapter, GoldCase, LabelTarget } from "./types.ts";

const REVISION = "b70ffaf5ff39e079776134c5bf4381f00a9fd1ed";
const FILE = {
  name: "test.parquet",
  url: `https://huggingface.co/datasets/nvidia/Nemotron-PII/resolve/${REVISION}/data/test-00000-of-00001.parquet`,
  sha256: "1a4b0512ecb5370f0992d29d0f9c07351e6de13f0d7ea33bb18cecb984780247",
  bytes: 150968398,
};

const b = (
  label:
    | "EMAIL"
    | "PHONE"
    | "ADDRESS"
    | "DATE_OF_BIRTH"
    | "FINANCIAL"
    | "NATIONAL_ID"
    | "IP"
    | "SECRET",
  subtype: string,
): LabelTarget => ({ builtin: [label], subtype });
const OUT = "out_of_scope" as const;
const LABELS: Record<string, LabelTarget> = {
  email: b("EMAIL", "email"),
  phone_number: b("PHONE", "phone"),
  fax_number: b("PHONE", "fax"),
  street_address: b("ADDRESS", "street_address"),
  date_of_birth: b("DATE_OF_BIRTH", "date_of_birth"),
  credit_debit_card: b("FINANCIAL", "card"),
  account_number: b("FINANCIAL", "account_number"),
  bank_routing_number: b("FINANCIAL", "routing_number"),
  swift_bic: b("FINANCIAL", "bic"),
  ssn: b("NATIONAL_ID", "ssn"),
  national_id: b("NATIONAL_ID", "national_id"),
  tax_id: b("NATIONAL_ID", "tax_id"),
  ipv4: b("IP", "ipv4"),
  ipv6: b("IP", "ipv6"),
  api_key: b("SECRET", "api_key"),
  password: b("SECRET", "password"),
  http_cookie: b("SECRET", "http_cookie"),
  first_name: { custom: "Person names" },
  last_name: { custom: "Person names" },
  company_name: { custom: "Organisations" },
  ...Object.fromEntries(
    [
      "date",
      "url",
      "occupation",
      "time",
      "country",
      "customer_id",
      "city",
      "state",
      "user_name",
      "date_time",
      "biometric_identifier",
      "medical_record_number",
      "employment_status",
      "health_plan_beneficiary_number",
      "education_level",
      "race_ethnicity",
      "employee_id",
      "language",
      "county",
      "coordinate",
      "gender",
      "age",
      "pin",
      "political_view",
      "postcode",
      "religious_belief",
      "blood_type",
      "cvv",
      "vehicle_identifier",
      "mac_address",
      "license_plate",
      "sexuality",
      "certificate_license_number",
      "device_identifier",
      "unique_id",
    ].map((l) => [l, OUT]),
  ),
};

/** `[{'start': 0, 'end': 5, 'text': '...', 'label': 'first_name'}, ...]` (a Python literal). */
const SPAN =
  /'start': (\d+), 'end': (\d+), 'text': .*?, 'label': '([a-z_0-9]+)'\}/gs;

/**
 * NVIDIA's Nemotron-PII dataset; its split is large, so a default run scores a
 * pinned, seeded sample (`defaultLimit`).
 */
export const nemotron: BenchmarkAdapter = {
  id: "nemotron-pii",
  title: "Nemotron-PII (NVIDIA, EN, US and international)",
  revision: REVISION,
  license: {
    spdx: "CC-BY-4.0",
    url: "https://huggingface.co/datasets/nvidia/Nemotron-PII",
    note: 'CC BY 4.0 (card metadata and its License/Terms of Use section; "ready for commercial use"). Attribution: NVIDIA Corporation.',
  },
  homepage: "https://huggingface.co/datasets/nvidia/Nemotron-PII",
  citation:
    "NVIDIA (2025). Nemotron-PII: Synthesized Data for Privacy-Preserving AI. Hugging Face dataset nvidia/Nemotron-PII.",
  languages: ["en"],
  splits: ["test"],
  defaultSplit: "test",
  defaultLimit: 3000,
  files: (split) => {
    if (split !== "test")
      throw new Error("nemotron-pii: only the test split is wired (test)");
    return [FILE];
  },
  async load(dir) {
    const rows = await readParquet(join(dir, FILE.name), [
      "uid",
      "locale",
      "text",
      "spans",
    ]);
    return rows.map((r): GoldCase => ({
      id: `${String(r.locale)}-${String(r.uid)}`,
      text: String(r.text),
      language: "en",
      gold: [...String(r.spans).matchAll(SPAN)].map((m) => ({
        start: Number(m[1]),
        end: Number(m[2]),
        label: m[3]!,
      })),
    }));
  },
  labelMap: LABELS,
  configs: deterministicConfigs,
};
