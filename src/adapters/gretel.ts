/**
 * Gretel synthetic PII finance multilingual (Gretel.ai, 2024): synthetic
 * financial documents with character spans for 29 PII types, the bench's
 * French source next to English. Scored on the English and French test
 * files (3,334 documents).
 *
 * Gold is finer than the contract: IBAN, BBAN, card, BIC and routing
 * numbers map down to FINANCIAL (the type kept as subtype), SSN, passport
 * and driver licence to NATIONAL_ID, IPv4 and IPv6 to IP, API keys and
 * passwords to SECRET. Names, companies, dates, times, customer and
 * employee ids, user names, PINs, CVVs and coordinates have no rule and are
 * reported outside the headline.
 */
import { join } from "node:path";
import type { BuiltinLabel } from "../../contract/types.ts";
import { deterministicConfigs } from "./configs.ts";
import { readParquet } from "./parquet.ts";
import type { BenchmarkAdapter, GoldCase, LabelTarget } from "./types.ts";

const REVISION = "7b844d16738527a04264f50214cb426a4cea0897";
const BASE = `https://huggingface.co/datasets/gretelai/synthetic_pii_finance_multilingual/resolve/${REVISION}/data`;
const TEST = [
  {
    lang: "en",
    name: "English_test.parquet",
    remote: "English_test-00000-of-00001.parquet",
    sha256: "c02b06d3c5b7c375525136d6f74acc52ab8fc07fa863d0aa50734910ec0ef2ad",
    bytes: 2720729,
  },
  {
    lang: "fr",
    name: "France_test.parquet",
    remote: "France_test-00000-of-00001.parquet",
    sha256: "39fc2777822bbecab2d89bb23cbed40d9825ff4117897b8b025c02287f4ba845",
    bytes: 397822,
  },
];

const b = (label: BuiltinLabel, subtype: string): LabelTarget => ({
  builtin: [label],
  subtype,
});
const LABELS: Record<string, LabelTarget> = {
  email: b("EMAIL", "email"),
  phone_number: b("PHONE", "phone"),
  street_address: b("ADDRESS", "street_address"),
  date_of_birth: b("DATE_OF_BIRTH", "date_of_birth"),
  iban: b("FINANCIAL", "iban"),
  bban: b("FINANCIAL", "bban"),
  credit_card_number: b("FINANCIAL", "card"),
  swift_bic_code: b("FINANCIAL", "bic"),
  bank_routing_number: b("FINANCIAL", "routing_number"),
  ssn: b("NATIONAL_ID", "ssn"),
  passport_number: b("NATIONAL_ID", "passport"),
  driver_license_number: b("NATIONAL_ID", "driver_license"),
  ipv4: b("IP", "ipv4"),
  ipv6: b("IP", "ipv6"),
  api_key: b("SECRET", "api_key"),
  password: b("SECRET", "password"),
  name: { custom: "Person names" },
  first_name: { custom: "Person names" },
  last_name: { custom: "Person names" },
  company: { custom: "Organisations" },
  date: "out_of_scope",
  time: "out_of_scope",
  date_time: "out_of_scope",
  employee_id: "out_of_scope",
  customer_id: "out_of_scope",
  user_name: "out_of_scope",
  account_pin: "out_of_scope",
  credit_card_security_code: "out_of_scope",
  local_latlng: "out_of_scope",
};

/**
 * Gretel's synthetic finance PII dataset, English and French documents of its
 * test split.
 */
export const gretel: BenchmarkAdapter = {
  id: "gretel-pii-finance-multilingual",
  title: "Gretel synthetic PII finance multilingual (EN, FR test)",
  revision: REVISION,
  license: {
    spdx: "Apache-2.0",
    url: "https://huggingface.co/datasets/gretelai/synthetic_pii_finance_multilingual",
    note: 'Apache-2.0 (card metadata and its License section: "can be used for any purpose that is not harmful").',
  },
  homepage:
    "https://huggingface.co/datasets/gretelai/synthetic_pii_finance_multilingual",
  citation:
    "Watson, Meyer, Van Segbroeck, Grossman, Torbey, Mlocek, Greco (2024). Synthetic PII Financial Documents. Gretel.ai.",
  languages: ["en", "fr"],
  splits: ["test"],
  defaultSplit: "test",
  files: (split) => {
    if (split !== "test")
      throw new Error("gretel: only the test split is wired (test)");
    return TEST.map((f) => ({
      name: f.name,
      url: `${BASE}/${f.remote}`,
      sha256: f.sha256,
      bytes: f.bytes,
    }));
  },
  async load(dir) {
    const out: GoldCase[] = [];
    for (const f of TEST) {
      const rows = await readParquet(join(dir, f.name), [
        "generated_text",
        "pii_spans",
      ]);
      rows.forEach((r, i) => {
        const spans = JSON.parse(String(r.pii_spans)) as Array<{
          start: number;
          end: number;
          label: string;
        }>;
        out.push({
          id: `${f.lang}-${i}`,
          text: String(r.generated_text),
          language: f.lang,
          gold: spans.map((s) => ({
            start: s.start,
            end: s.end,
            label: s.label,
          })),
        });
      });
    }
    return out;
  },
  labelMap: LABELS,
  configs: deterministicConfigs,
};
