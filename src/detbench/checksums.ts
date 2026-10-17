/**
 * Checksum validators for the identifiers in the deterministic-redaction
 * dataset. Every value of these kinds must pass, so a miss is the detector's
 * fault, not a malformed fixture. They take the value as written (spaces,
 * dots and dashes are ignored).
 */

/** The value without spaces (incl. no-break spaces), dots, dashes and slashes. */
export const compact = (value: string): string =>
  value.replace(/[\s.\-/]/gu, "");

const digitsOnly = (value: string) => /^\d+$/.test(value);

/** Letters become 10..35, as in IBAN and RIB key computations. */
const lettersToDigits = (value: string): string =>
  value.toUpperCase().replace(/[A-Z]/g, (c) => String(c.charCodeAt(0) - 55));

/** Remainder of a long decimal string mod 97, in chunks. */
export function mod97(digits: string): number {
  let rest = 0;
  for (let i = 0; i < digits.length; i += 7)
    rest = Number(`${rest}${digits.slice(i, i + 7)}`) % 97;
  return rest;
}

/** ISO 13616 IBAN: country, 2 check digits, BBAN; mod 97 of the rearranged number is 1. */
export function isValidIban(value: string): boolean {
  const iban = compact(value).toUpperCase();
  if (!/^[A-Z]{2}\d{2}[A-Z0-9]{11,30}$/.test(iban)) return false;
  return mod97(lettersToDigits(iban.slice(4) + iban.slice(0, 4))) === 1;
}

/** Check digits for an IBAN given its country and BBAN. */
export function ibanCheckDigits(country: string, bban: string): string {
  const rest = mod97(lettersToDigits(`${bban}${country}00`));
  return String(98 - rest).padStart(2, "0");
}

/** French RIB key over bank (5), branch (5) and account (11) codes. */
export function ribKey(bank: string, branch: string, account: string): string {
  // Letters map to digits per the RIB table (A/J -> 1, B/K/S -> 2, ...).
  const ribDigits = (s: string) =>
    s
      .toUpperCase()
      .replace(/[A-Z]/g, (c) =>
        "12345678912345678923456789".charAt(c.charCodeAt(0) - 65),
      );
  const b = Number(ribDigits(bank));
  const g = Number(ribDigits(branch));
  const a = mod97(ribDigits(account));
  return String(97 - ((89 * b + 15 * g + 3 * a) % 97)).padStart(2, "0");
}

/** A French IBAN whose RIB key and IBAN check digits are both valid. */
export function frenchIban(
  bank: string,
  branch: string,
  account: string,
): string {
  const bban = `${bank}${branch}${account}${ribKey(bank, branch, account)}`;
  return `FR${ibanCheckDigits("FR", bban)}${bban}`;
}

/** Luhn (mod 10), used by payment cards, SIREN and SIRET. */
export function luhn(value: string): boolean {
  const digits = compact(value);
  if (!digitsOnly(digits) || digits.length < 2) return false;
  let sum = 0;
  for (let i = 0; i < digits.length; i++) {
    let d = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      d *= 2;
      if (d > 9) d -= 9;
    }
    sum += d;
  }
  return sum % 10 === 0;
}

/** The Luhn check digit to append to `partial`. */
export function luhnCheckDigit(partial: string): string {
  for (let d = 0; d <= 9; d++) if (luhn(`${partial}${d}`)) return String(d);
  throw new Error("unreachable");
}

export const isValidCard = (value: string): boolean => {
  const digits = compact(value);
  return /^\d{13,19}$/.test(digits) && luhn(digits);
};

/** French SIREN: 9 digits, Luhn. */
export const isValidSiren = (value: string): boolean =>
  /^\d{9}$/.test(compact(value)) && luhn(value);

/** French SIRET: SIREN + 5-digit establishment number, Luhn over all 14 digits. */
export const isValidSiret = (value: string): boolean =>
  /^\d{14}$/.test(compact(value)) && luhn(value);

/** French intra-EU VAT number: FR + key + SIREN, key = (12 + 3 * (SIREN mod 97)) mod 97. */
export function frenchVatKey(siren: string): string {
  return String((12 + 3 * (Number(siren) % 97)) % 97).padStart(2, "0");
}
export function isValidFrenchVat(value: string): boolean {
  const v = compact(value).toUpperCase();
  const m = /^FR(\d{2})(\d{9})$/.exec(v);
  return !!m && isValidSiren(m[2]!) && m[1] === frenchVatKey(m[2]!);
}

/** French NIR (social security number): 13 characters + key = 97 - (number mod 97); Corsica 2A/2B count as 19/18. */
export function nirKey(first13: string): string {
  const n = first13.toUpperCase().replace("2A", "19").replace("2B", "18");
  return String(97 - Number(BigInt(n) % 97n)).padStart(2, "0");
}
export function isValidNir(value: string): boolean {
  const v = compact(value).toUpperCase();
  const m = /^([12]\d{4}(?:\d{2}|2A|2B)\d{6})(\d{2})$/.exec(v);
  return !!m && nirKey(m[1]!) === m[2];
}

/** UK NHS number: 10 digits, mod 11 with weights 10..2; a check value of 10 is never issued. */
export function isValidNhs(value: string): boolean {
  const digits = compact(value);
  if (!/^\d{10}$/.test(digits)) return false;
  let sum = 0;
  for (let i = 0; i < 9; i++) sum += Number(digits[i]) * (10 - i);
  const check = 11 - (sum % 11);
  if (check === 10) return false;
  return (check === 11 ? 0 : check) === Number(digits[9]);
}

/** US SSN structural rules: area not 000/666/9xx, group not 00, serial not 0000. */
export function isValidSsn(value: string): boolean {
  const digits = compact(value);
  const m = /^(\d{3})(\d{2})(\d{4})$/.exec(digits);
  if (!m) return false;
  return (
    m[1] !== "000" &&
    m[1] !== "666" &&
    !m[1]!.startsWith("9") &&
    m[2] !== "00" &&
    m[3] !== "0000"
  );
}

/**
 * UK National Insurance number: two prefix letters (not D, F, I, Q, U, V; the
 * second not O; not BG, GB, KN, NK, NT, TN, ZZ), six digits, suffix A-D.
 */
export function isValidNino(value: string): boolean {
  const m = /^([A-Z]{2})\d{6}[A-D]$/.exec(compact(value).toUpperCase());
  if (!m) return false;
  const [a, b] = m[1]!;
  return (
    !/[DFIQUV]/.test(a!) &&
    !/[DFIOQUV]/.test(b!) &&
    !["BG", "GB", "KN", "NK", "NT", "TN", "ZZ"].includes(m[1]!)
  );
}

/** SWIFT/BIC shape: bank (4 letters), country (2 letters), location (2), optional branch (3). */
export const isValidBic = (value: string): boolean =>
  /^[A-Z]{4}[A-Z]{2}[A-Z0-9]{2}(?:[A-Z0-9]{3})?$/.test(value.toUpperCase());

/** Validators by item kind; kinds without a checksum are not listed. */
export const KIND_VALIDATORS: Record<string, (value: string) => boolean> = {
  iban: isValidIban,
  card: isValidCard,
  siren: isValidSiren,
  siret: isValidSiret,
  tva: isValidFrenchVat,
  nir: isValidNir,
  nhs: isValidNhs,
  nino: isValidNino,
  ssn: isValidSsn,
  bic: isValidBic,
};
