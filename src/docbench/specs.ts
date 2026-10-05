/**
 * What the document bench measures, without generating anything: the suite
 * cases (formats x zones, hard negatives, failure files), the size sweeps,
 * and the generator version that keys cached results. Kept free of the
 * writers so the planner (`src/run/plan.ts`) and the dashboard load it
 * cheaply; `cases.ts` and `sweeps.ts` build the documents.
 */
import { createHash } from "node:crypto";
import { loadDetDataset } from "../detbench/dataset.ts";
import type { Lang, Unit } from "./content.ts";

let datasetHash: string | undefined;
/**
 * Hash of `dataset/detbench/`, which the documents are built from: part of
 * every job and file key, so a dataset change regenerates the documents.
 */
export function detDatasetHash(): string {
  datasetHash ??= loadDetDataset().dataset?.hash ?? "invalid";
  return datasetHash;
}

/**
 * Generator version: part of every job key. Bump it whenever a writer or a
 * builder changes what a document holds, so cached results are recomputed.
 */
export const GEN_VERSION = 3;

/** Reporting families. */
export const FORMATS = ["docx", "xlsx", "pptx", "odt", "ods", "odp", "pdf", "text", "zip", "other"] as const;
export type DocFamily = (typeof FORMATS)[number];

export type Outcome = "checked" | "partial" | "unchecked";
export interface Expectation {
  outcome: Outcome;
  /** For `unchecked`: the reason the ref should give (`encrypted`, `scanned`...). */
  reason?: string;
  /** A signed PDF: the read must say so (redaction removes the signature). */
  signed?: boolean;
}

export interface DocSpec {
  id: string;
  family: DocFamily;
  ext: string;
  zone: string;
  lang: Lang;
  kind: "positive" | "negative" | "failure";
  expect: Expectation;
  note?: string;
}

/** A generated document and the ground truth it holds. */
export interface BuiltDoc {
  spec: DocSpec;
  name: string;
  bytes: Uint8Array;
  /** Units placed in the scored zone (items and decoys to find). */
  units: Unit[];
  /** Size measures: words of text placed, PDF pages, spreadsheet cells, zip entries. */
  size: { words: number; pages?: number; cells?: number; rows?: number; slides?: number; entries?: number };
}

/** Zones scored per family (positive cases). Field zones hold label/value rows; the others prose. */
export const ZONES: Record<string, { family: DocFamily; ext: string; zones: string[] }> = {
  docx: { family: "docx", ext: "docx", zones: ["body", "table_cell", "header", "footer", "footnote", "endnote", "comment", "tracked_deletion", "text_box", "split_runs", "hyperlink", "metadata", "embedded"] },
  xlsx: { family: "xlsx", ext: "xlsx", zones: ["cell", "hidden_sheet", "very_hidden_sheet", "formula_result", "cell_comment", "sheet_header", "metadata"] },
  pptx: { family: "pptx", ext: "pptx", zones: ["slide", "slide_table", "speaker_notes", "hidden_slide", "comment", "metadata"] },
  odt: { family: "odt", ext: "odt", zones: ["body", "table_cell", "header", "footer", "comment", "tracked_deletion", "metadata"] },
  ods: { family: "ods", ext: "ods", zones: ["cell", "hidden_sheet", "cell_comment", "metadata"] },
  odp: { family: "odp", ext: "odp", zones: ["slide", "speaker_notes"] },
  pdf: { family: "pdf", ext: "pdf", zones: ["page", "inline", "inline_email", "table_cell", "two_column", "line_wrapped", "hyphenated", "form_field", "annotation", "bookmark", "metadata"] },
  txt: { family: "text", ext: "txt", zones: ["body"] },
  md: { family: "text", ext: "md", zones: ["body"] },
  csv: { family: "text", ext: "csv", zones: ["cell"] },
  json: { family: "text", ext: "json", zones: ["value"] },
  log: { family: "text", ext: "log", zones: ["body"] },
  html: { family: "text", ext: "html", zones: ["body"] },
  zip: { family: "zip", ext: "zip", zones: ["entry_txt", "nested_zip", "entry_docx", "entry_pdf", "entry_csv"] },
};

const NEGATIVES: Array<Omit<DocSpec, "kind" | "expect" | "lang"> & { langs: Lang[] }> = [
  { id: "docx-bibliography", family: "docx", ext: "docx", zone: "bibliography", langs: ["en", "fr"], note: "detbench reference_links negatives (DOIs, ISBNs, ARK and commit links) as a reference list" },
  { id: "pdf-bibliography", family: "pdf", ext: "pdf", zone: "bibliography", langs: ["en", "fr"] },
  { id: "txt-diagnostic", family: "text", ext: "log", zone: "diagnostic_dump", langs: ["en", "fr"], note: "detbench negative logs, configs and code (SHAs, UUIDs, timestamps, versions, ports)" },
  { id: "pdf-diagnostic", family: "pdf", ext: "pdf", zone: "diagnostic_dump", langs: ["en"] },
  { id: "xlsx-invoice", family: "xlsx", ext: "xlsx", zone: "invoice_fields", langs: ["en", "fr"], note: "detbench decoys as label/value rows: order numbers, prices, versions, hashes" },
  { id: "xlsx-orders", family: "xlsx", ext: "xlsx", zone: "numeric_sheet", langs: ["en", "fr"], note: "10,000 order rows (detbench orders_tsv / commandes_tsv generators) as cells" },
  { id: "csv-orders", family: "text", ext: "csv", zone: "numeric_sheet", langs: ["en"], note: "20,000 order rows as CSV" },
  { id: "ods-orders", family: "ods", ext: "ods", zone: "numeric_sheet", langs: ["fr"] },
  { id: "pptx-negative", family: "pptx", ext: "pptx", zone: "slide", langs: ["en", "fr"] },
];

const FAILURES: DocSpec[] = (
  [
    ["pdf-encrypted", "pdf", "pdf", "encrypted", { outcome: "unchecked", reason: "encrypted" }],
    ["docx-encrypted", "docx", "docx", "encrypted", { outcome: "unchecked", reason: "encrypted" }],
    ["xlsx-encrypted", "xlsx", "xlsx", "encrypted", { outcome: "unchecked", reason: "encrypted" }],
    ["odt-encrypted", "odt", "odt", "encrypted", { outcome: "unchecked", reason: "encrypted" }],
    ["zip-encrypted", "zip", "zip", "encrypted", { outcome: "unchecked", reason: "encrypted" }],
    ["zip-partly-encrypted", "zip", "zip", "encrypted_entry", { outcome: "partial" }],
    ["pdf-scanned", "pdf", "pdf", "scanned", { outcome: "unchecked", reason: "scanned" }],
    ["pdf-partly-scanned", "pdf", "pdf", "scanned_page", { outcome: "partial" }],
    ["pdf-signed", "pdf", "pdf", "signed", { outcome: "checked", signed: true }],
    ["pdf-attachment", "pdf", "pdf", "attached_file", { outcome: "partial" }],
    ["zip-bomb", "zip", "zip", "zip_bomb", { outcome: "partial" }],
    ["zip-nested-too-deep", "zip", "zip", "nesting", { outcome: "partial" }],
    ["zip-too-many-entries", "zip", "zip", "entry_count", { outcome: "unchecked", reason: "unreadable" }],
    ["docx-bomb", "docx", "docx", "zip_bomb", { outcome: "partial" }],
    ["docm-macros", "docx", "docm", "macros", { outcome: "partial" }],
    ["xlsx-connections", "xlsx", "xlsx", "data_connection", { outcome: "partial" }],
    ["doc-legacy", "other", "doc", "legacy_format", { outcome: "unchecked", reason: "legacyOffice" }],
    ["docx-truncated", "docx", "docx", "damaged", { outcome: "unchecked", reason: "unreadable" }],
    ["docx-not-office", "docx", "docx", "wrong_package", { outcome: "unchecked", reason: "office" }],
    ["pdf-not-pdf", "pdf", "pdf", "wrong_bytes", { outcome: "unchecked", reason: "unreadable" }],
    ["txt-unbroken-run", "text", "txt", "unbroken_run", { outcome: "unchecked", reason: "unbroken" }],
    ["txt-over-scan-cap", "text", "txt", "scan_cap", { outcome: "partial" }],
    ["png-image", "other", "png", "image", { outcome: "unchecked", reason: "image" }],
  ] as const
).map(([id, family, ext, zone, expect]) => ({ id, family, ext, zone, lang: "en" as Lang, kind: "failure" as const, expect: { ...expect } as Expectation }));

/** Every case of the suite, in a stable order. */
export function suiteSpecs(): DocSpec[] {
  const out: DocSpec[] = [];
  for (const [key, def] of Object.entries(ZONES))
    for (const zone of def.zones)
      for (const lang of ["en", "fr"] as const)
        out.push({ id: `${key}-${zone}-${lang}`, family: def.family, ext: def.ext, zone, lang, kind: "positive", expect: { outcome: "checked" } });
  for (const n of NEGATIVES)
    for (const lang of n.langs) out.push({ id: `${n.id}-${lang}`, family: n.family, ext: n.ext, zone: n.zone, lang, kind: "negative", expect: { outcome: "checked" }, ...(n.note ? { note: n.note } : {}) });
  out.push(...FAILURES);
  return out;
}

export const specHash = (spec: unknown, seed: number) => createHash("sha256").update(JSON.stringify([GEN_VERSION, detDatasetHash(), seed, spec])).digest("hex").slice(0, 16);

export const SWEEP_TYPES = ["txt", "csv", "docx", "xlsx", "pptx", "pdf", "odt", "ods", "zip"] as const;
export type SweepType = (typeof SWEEP_TYPES)[number];
export type SweepUnit = "words" | "rows" | "slides" | "pages" | "entries";

export const SWEEP_UNITS: Record<SweepType, { unit: SweepUnit; family: DocFamily; ext: string }> = {
  txt: { unit: "words", family: "text", ext: "txt" },
  csv: { unit: "rows", family: "text", ext: "csv" },
  docx: { unit: "words", family: "docx", ext: "docx" },
  xlsx: { unit: "rows", family: "xlsx", ext: "xlsx" },
  pptx: { unit: "slides", family: "pptx", ext: "pptx" },
  pdf: { unit: "pages", family: "pdf", ext: "pdf" },
  odt: { unit: "words", family: "odt", ext: "odt" },
  ods: { unit: "rows", family: "ods", ext: "ods" },
  zip: { unit: "entries", family: "zip", ext: "zip" },
};

/** Sizes per tier. `quick` stops before the slow end; `full` reaches the extension's caps (2 MB of text, 5,000 entries). */
export const SWEEP_SIZES: Record<"smoke" | "quick" | "full", Record<SweepType, number[]>> = {
  smoke: { txt: [1_000, 10_000], csv: [1_000, 10_000], docx: [1_000, 10_000], xlsx: [1_000, 10_000], pptx: [10, 50], pdf: [2, 20], odt: [1_000], ods: [1_000], zip: [10, 100] },
  quick: {
    txt: [1_000, 5_000, 20_000, 100_000],
    csv: [1_000, 5_000, 20_000, 60_000],
    docx: [1_000, 5_000, 20_000, 100_000],
    xlsx: [1_000, 5_000, 20_000, 60_000],
    pptx: [10, 50, 200],
    pdf: [2, 10, 50, 200],
    odt: [1_000, 10_000, 50_000],
    ods: [1_000, 10_000, 30_000],
    zip: [10, 100, 1_000],
  },
  full: {
    txt: [1_000, 5_000, 20_000, 100_000, 300_000],
    csv: [1_000, 5_000, 20_000, 60_000, 100_000],
    docx: [1_000, 5_000, 20_000, 100_000, 300_000],
    xlsx: [1_000, 5_000, 20_000, 60_000, 100_000],
    pptx: [10, 50, 200, 500],
    pdf: [2, 10, 50, 200, 500],
    odt: [1_000, 10_000, 50_000, 150_000],
    ods: [1_000, 10_000, 30_000, 60_000],
    zip: [10, 100, 1_000, 4_000],
  },
};

export interface SweepSpec {
  id: string;
  type: SweepType;
  unit: SweepUnit;
  size: number;
  lang: "en";
}

export function sweepSpecs(tier: "smoke" | "quick" | "full", types: readonly SweepType[] = SWEEP_TYPES): SweepSpec[] {
  return types.flatMap((type) => SWEEP_SIZES[tier][type].map((size) => ({ id: `sweep-${type}-${size}`, type, unit: SWEEP_UNITS[type].unit, size, lang: "en" as const })));
}

export const sweepHash = (spec: SweepSpec, seed: number) => createHash("sha256").update(JSON.stringify([GEN_VERSION, detDatasetHash(), seed, "sweep", spec])).digest("hex").slice(0, 16);

