/**
 * Generated text for large cases (`generated` in a dataset line).
 *
 * A placeholder listed under `generated` renders as plain text built by a
 * named generator here, so a case of thousands of spreadsheet rows stays one
 * short line on disk. Generators are pure arithmetic on the row number: the
 * same parameters always give the same text. Generated text holds no item and
 * no labelled decoy; every detection inside it counts as a false positive.
 * Changing a generator changes every case that uses it, so add a new name
 * instead.
 */
import type { DetGenerated } from "./schema.ts";

/** Status cells that read as US state codes or short words (`ok`, `in`, `me`, `or`, `de`, `la`...). */
const EN_STATUS = ["ok", "in", "me", "or", "ok", "shipped", "on hold", "OK", "IN", "de", "la", "pa"];
const FR_STATUS = ["ok", "en cours", "la", "de", "livré", "ok", "en stock", "le", "à relancer", "OK"];
const FR_ITEMS = ["Palettes bois", "Vis inox M6", "Carton de rangement", "Gaine technique", "Rouleau adhésif", "Plaque de plâtre", "Joint silicone"];

/**
 * Generators by name. `orders_tsv` mirrors the spreadsheet of the document-
 * upload research (`ORD-0-10000⇥Customer 230⇥35000⇥note 10000⇥ok`): from row
 * 10000 on, the amount and the note number have five digits and sit next to
 * short status cells. `commandes_tsv` is a French order export: quantity,
 * item, five-digit amount in cents, status.
 */
export const GENERATORS: Record<string, (row: number) => string> = {
  orders_tsv: (n) => `ORD-0-${n}\tCustomer ${n % 977}\t${(n * 7) / 2}\tnote ${n}\t${EN_STATUS[n % EN_STATUS.length]}`,
  commandes_tsv: (n) =>
    `CMD-${n}\t${(n % 48) + 2}\t${FR_ITEMS[n % FR_ITEMS.length]}\t${10000 + ((n * 37) % 89999)}\t${FR_STATUS[n % FR_STATUS.length]}`,
};

/** Rows `from` .. `from + count - 1`, one per line, no trailing newline. */
export function generateText(spec: DetGenerated): string {
  const generator = GENERATORS[spec.generator];
  if (!generator) throw new Error(`unknown generator ${spec.generator}`);
  const rows: string[] = [];
  for (let n = spec.from; n < spec.from + spec.count; n++) rows.push(generator(n));
  return rows.join("\n");
}

/** Largest `count` a dataset line may ask for (bench runtime grows linearly with it). */
export const MAX_GENERATED_ROWS = 20000;
