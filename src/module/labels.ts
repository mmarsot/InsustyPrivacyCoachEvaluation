/**
 * The extension's category names mapped to the contract's built-in labels.
 * Today's names are the labels themselves; older refs called secrets
 * `API_KEY`, and the other aliases cover plausible spellings of the
 * categories, so a ref that picks one of them is scored without edits.
 * SIREN, SIRET and VAT numbers are `COMPANY_ID`: a ref that files them under
 * `NATIONAL_ID` scores them as the wrong label.
 */
import { BUILTIN_LABELS, type BuiltinLabel } from "../../contract/types.ts";

export const CATEGORY_ALIASES: Record<string, BuiltinLabel> = {
  API_KEY: "SECRET",
  SECRET: "SECRET",
  PRIVATE_KEY: "SECRET",
  PASSWORD: "SECRET",
  CREDENTIAL: "SECRET",
  EMAIL: "EMAIL",
  PHONE: "PHONE",
  ADDRESS: "ADDRESS",
  FINANCIAL: "FINANCIAL",
  IBAN: "FINANCIAL",
  CARD: "FINANCIAL",
  NATIONAL_ID: "NATIONAL_ID",
  DATE_OF_BIRTH: "DATE_OF_BIRTH",
  DOB: "DATE_OF_BIRTH",
  IP: "IP",
  IP_ADDRESS: "IP",
  NETWORK: "IP",
  COMPANY_ID: "COMPANY_ID",
  COMPANY: "COMPANY_ID",
  BUSINESS_ID: "COMPANY_ID",
};

export const toBuiltin = (category: string): BuiltinLabel | null =>
  CATEGORY_ALIASES[category] ??
  ((BUILTIN_LABELS as readonly string[]).includes(category)
    ? (category as BuiltinLabel)
    : null);
