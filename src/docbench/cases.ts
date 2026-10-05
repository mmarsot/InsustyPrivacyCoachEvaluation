/**
 * The document bench's cases: which documents exist (`suiteSpecs`), and how
 * each one is written (`buildDoc`). A case is a spec (format, zone,
 * language, kind, expected outcome); its bytes are generated on demand from
 * the spec, the seed and the detbench ground truth (`content.ts`), so only
 * this code is committed, never the files.
 *
 * Three kinds of case:
 * - `positive`: labelled values placed in one zone of one format (a Word
 *   footnote, a hidden sheet, PDF speaker notes...), next to neutral filler;
 * - `negative`: hard negatives only (bibliographies, diagnostic dumps,
 *   invoices, numeric sheets): every detection is a false alarm;
 * - `failure`: files the extension must report as not checked or partly
 *   checked, never as clean (encrypted, scanned, zip bombs, signed PDFs...).
 */
import { inflateRawSync } from "node:zlib";
import { GENERATORS } from "../detbench/generate.ts";
import { fillerParagraphs, pickUnits, rngFor, type ContentPools, type Lang, type Rng, type Unit } from "./content.ts";
import { writeEncryptedOffice, writeLegacyDoc } from "./writers/cfb.ts";
import { writeOdp, writeOds, writeOdt } from "./writers/odf.ts";
import { writeDocx, writePptx, writeXlsx, type Block, type Cell } from "./writers/ooxml.ts";
import { scanPng, writeEncryptedPdf, writePdf } from "./writers/pdf.ts";
import type { BuiltDoc, DocSpec, Expectation } from "./specs.ts";
import { writeZip, zeroBomb, type ZipInput } from "./writers/zip.ts";

// ------------------------------------------------------------ helpers

const lines = (units: Unit[]) => units.flatMap((u) => u.text.split("\n"));
const fieldLine = (u: Unit, sep = ": ") => `${u.field!.label}${sep}${u.field!.value}`;
/** Filler paragraphs with the units' paragraphs interleaved. */
function interleave(filler: string[], units: Unit[]): string[] {
  const out: string[] = [];
  const step = Math.max(1, Math.floor(filler.length / (units.length + 1)));
  let u = 0;
  filler.forEach((p, i) => {
    out.push(p);
    if ((i + 1) % step === 0 && u < units.length) out.push(units[u++]!.text);
  });
  while (u < units.length) out.push(units[u++]!.text);
  return out;
}
const paragraphs = (texts: string[]): Block[] => texts.map((text) => ({ type: "p", text }));
const words = (texts: string[]) => texts.join(" ").split(/\s+/).filter(Boolean).length;
const csvCell = (v: string) => (/[",\n;]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v);
const htmlEscape = (s: string) => s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);

/** A value broken over two lines: at a space near its middle, or with a hyphen when it has none. */
export function breakValue(value: string, hyphen: boolean): string {
  const mid = Math.floor(value.length / 2);
  if (!hyphen) {
    const spaces = [...value.matchAll(/ /g)].map((m) => m.index!);
    if (!spaces.length) return value;
    const at = spaces.reduce((a, b) => (Math.abs(b - mid) < Math.abs(a - mid) ? b : a));
    return `${value.slice(0, at)}\n${value.slice(at + 1)}`;
  }
  return `${value.slice(0, mid)}-\n${value.slice(mid)}`;
}

/** Order rows from the detbench generators, as cells. */
function orderRows(lang: Lang, from: number, count: number): Cell[][] {
  const gen = GENERATORS[lang === "en" ? "orders_tsv" : "commandes_tsv"]!;
  const rows: Cell[][] = [lang === "en" ? ["Order", "Customer", "Amount", "Note", "Status"] : ["Commande", "Qté", "Article", "Montant", "Statut"]];
  for (let n = from; n < from + count; n++) rows.push(gen(n).split("\t").map((c) => (/^\d+(\.\d+)?$/.test(c) ? Number(c) : c)));
  return rows;
}

// ------------------------------------------------------------ builders

interface Ctx {
  spec: DocSpec;
  pools: ContentPools;
  rng: Rng;
  lang: Lang;
  taken: Set<string>;
}
type Built = { bytes: Uint8Array; units: Unit[]; size?: Partial<BuiltDoc["size"]>; texts?: string[] };

const prose = (c: Ctx, n = 3) => pickUnits(c.pools.prose[c.lang], n, c.rng, c.taken);
const shortProse = (c: Ctx, n = 3) => pickUnits(c.pools.shortProse[c.lang], n, c.rng, c.taken);
const fields = (c: Ctx, n = 6) => pickUnits(c.pools.fields[c.lang], n, c.rng, c.taken, true);
const decoyFields = (c: Ctx, n = 3) => pickUnits(c.pools.decoyFields[c.lang], n, c.rng, c.taken, true);
const filler = (c: Ctx, w = 220) => fillerParagraphs(c.lang, w, c.rng);
const title = (lang: Lang) => (lang === "en" ? "Project update" : "Point d'avancement");
/** Field and decoy rows, shuffled together, under a header row. */
function fieldRows(c: Ctx, f: Unit[], d: Unit[]): string[][] {
  const rows = [...f, ...d].map((u) => [u.field!.label, u.field!.value]);
  const order = rows.map((r, i) => [c.rng(), i] as const).sort((a, b) => a[0] - b[0]);
  return [[c.lang === "en" ? "Field" : "Champ", c.lang === "en" ? "Value" : "Valeur"], ...order.map(([, i]) => rows[i]!)];
}

async function buildPositive(c: Ctx): Promise<Built> {
  const { spec, lang } = c;
  const key = spec.id.split("-")[0]!;
  const z = spec.zone;
  const fill = filler(c);
  if (key === "docx") {
    const base = { title: title(lang), body: paragraphs(fill) as Block[] };
    if (z === "body") {
      const u = prose(c);
      return { bytes: writeDocx({ title: title(lang), body: paragraphs(interleave(fill, u)) }), units: u, texts: [...fill, ...lines(u)] };
    }
    if (z === "table_cell") {
      const f = fields(c);
      const d = decoyFields(c);
      return { bytes: writeDocx({ ...base, body: [...base.body, { type: "table", rows: fieldRows(c, f, d) }] }), units: [...f, ...d], texts: fill };
    }
    if (z === "header" || z === "footer") {
      const f = fields(c, 3);
      return { bytes: writeDocx({ ...base, [z]: f.map((u) => fieldLine(u)) }), units: f, texts: fill };
    }
    if (z === "footnote" || z === "endnote" || z === "comment" || z === "text_box") {
      const u = shortProse(c);
      const prop = { footnote: "footnotes", endnote: "endnotes", comment: "comments", text_box: "textBoxes" }[z]!;
      return { bytes: writeDocx({ ...base, [prop]: u.map((x) => x.text) }), units: u, texts: fill };
    }
    if (z === "tracked_deletion") {
      const u = prose(c);
      return { bytes: writeDocx({ ...base, deletions: u.map((x) => x.text.replace(/\n+/g, " ")) }), units: u.map((x) => ({ ...x, text: x.text.replace(/\n+/g, " ") })), texts: fill };
    }
    if (z === "split_runs") {
      const f = fields(c);
      return { bytes: writeDocx({ ...base, splitRuns: f.map((u) => fieldLine(u)) }), units: f, texts: fill };
    }
    if (z === "hyperlink") {
      const emails = pickUnits(c.pools.fields[lang].filter((u) => u.items[0]?.category === "EMAIL"), 4, c.rng, c.taken);
      return { bytes: writeDocx({ ...base, links: emails.map((u, i) => ({ text: lang === "en" ? `Contact ${i + 1}` : `Contact ${i + 1}`, target: `mailto:${u.field!.value}` })) }), units: emails, texts: fill };
    }
    if (z === "metadata") {
      const email = pickUnits(c.pools.fields[lang].filter((u) => u.items[0]?.category === "EMAIL"), 1, c.rng, c.taken);
      const f = fields(c, 5);
      return { bytes: writeDocx({ ...base, properties: { creator: email[0]!.field!.value, custom: f.map((u) => [u.field!.label, u.field!.value] as [string, string]) } }), units: [...email, ...f], texts: fill };
    }
    if (z === "embedded") {
      const f = fields(c);
      const sheet = writeXlsx({ sheets: [{ name: lang === "en" ? "Contacts" : "Contacts", rows: [["Field", "Value"], ...f.map((u) => [u.field!.label, u.field!.value])] }] });
      return { bytes: writeDocx({ ...base, embedded: [{ name: "Microsoft_Excel_Worksheet1.xlsx", bytes: sheet }] }), units: f, texts: fill };
    }
  }
  if (key === "xlsx" || key === "ods") {
    const f = fields(c);
    const d = decoyFields(c);
    const orders = orderRows(lang, 10_000 + Math.floor(c.rng() * 5000), 60);
    const withFields = (): Cell[][] => {
      const rows = orders.map((r) => [...r]);
      [...f, ...d].forEach((u, i) => rows.splice(1 + Math.floor(((i + 1) * (rows.length - 1)) / (f.length + d.length + 1)), 0, [u.field!.label, u.field!.value]));
      return rows;
    };
    const sheetName = lang === "en" ? "Orders" : "Commandes";
    const hiddenName = lang === "en" ? "Contacts" : "Contacts";
    const cells = (rows: Cell[][]) => rows.reduce((n, r) => n + r.filter((x) => x !== null && x !== "").length, 0);
    if (key === "ods") {
      const odsRows = (rows: Cell[][]) => rows.map((r) => r.map((x) => (typeof x === "object" && x !== null ? x.result : x)));
      if (z === "cell") return { bytes: writeOds({ sheets: [{ name: sheetName, rows: odsRows(withFields()) }] }), units: [...f, ...d], size: { cells: cells(withFields()) } };
      if (z === "hidden_sheet")
        return { bytes: writeOds({ sheets: [{ name: sheetName, rows: odsRows(orders) }, { name: hiddenName, hidden: true, rows: [...f, ...d].map((u) => [u.field!.label, u.field!.value]) }] }), units: [...f, ...d], size: { cells: cells(orders) + 2 * (f.length + d.length) } };
      if (z === "cell_comment")
        return { bytes: writeOds({ sheets: [{ name: sheetName, rows: odsRows(orders), comments: f.map((u, i) => ({ row: 2 + i * 5, col: 1, text: fieldLine(u) })) }] }), units: f, size: { cells: cells(orders) } };
      if (z === "metadata") return { bytes: writeOds({ sheets: [{ name: sheetName, rows: odsRows(orders) }], meta: { title: sheetName, custom: f.map((u) => [u.field!.label, u.field!.value] as [string, string]) } }), units: f, size: { cells: cells(orders) } };
    }
    if (z === "cell") return { bytes: writeXlsx({ sheets: [{ name: sheetName, rows: withFields() }] }), units: [...f, ...d], size: { cells: cells(withFields()) } };
    if (z === "hidden_sheet" || z === "very_hidden_sheet")
      return {
        bytes: writeXlsx({ sheets: [{ name: sheetName, rows: orders }, { name: hiddenName, hidden: z === "hidden_sheet" ? true : "very", rows: [...f, ...d].map((u) => [u.field!.label, u.field!.value]) }] }),
        units: [...f, ...d],
        size: { cells: cells(orders) + 2 * (f.length + d.length) },
      };
    if (z === "formula_result") {
      const rows = orders.map((r) => [...r]);
      f.forEach((u, i) => rows.splice(2 + i * 7, 0, [u.field!.label, { formula: `VLOOKUP("C-${1000 + i}",Directory!A:C,3,FALSE)`, result: u.field!.value }]));
      return { bytes: writeXlsx({ sheets: [{ name: sheetName, rows }] }), units: f, size: { cells: cells(rows) } };
    }
    if (z === "cell_comment")
      return { bytes: writeXlsx({ sheets: [{ name: sheetName, rows: orders, comments: f.map((u, i) => ({ ref: `B${3 + i * 5}`, text: fieldLine(u) })) }] }), units: f, size: { cells: cells(orders) } };
    if (z === "sheet_header") {
      const h = f.slice(0, 3);
      return { bytes: writeXlsx({ sheets: [{ name: sheetName, rows: orders, header: `&L${fieldLine(h[0]!)}&R${fieldLine(h[1]!)}`, footer: `&C${fieldLine(h[2]!)}` }] }), units: h, size: { cells: cells(orders) } };
    }
    if (z === "metadata")
      return { bytes: writeXlsx({ sheets: [{ name: sheetName, rows: orders }], properties: { title: sheetName, custom: f.map((u) => [u.field!.label, u.field!.value] as [string, string]) } }), units: f, size: { cells: cells(orders) } };
  }
  if (key === "pptx" || key === "odp") {
    const fillSlides = fill.map((p, i) => ({ title: `${lang === "en" ? "Slide" : "Diapositive"} ${i + 1}`, body: [p] }));
    if (key === "odp") {
      const u = z === "slide" ? prose(c) : shortProse(c);
      const slides = z === "slide" ? [...fillSlides, ...u.map((x) => ({ title: title(lang), body: x.text.split("\n") }))] : fillSlides.map((s, i) => ({ ...s, ...(u[i] ? { notes: u[i]!.text.split("\n") } : {}) }));
      return { bytes: writeOdp({ slides }), units: u, size: { slides: slides.length }, texts: fill };
    }
    if (z === "slide" || z === "hidden_slide") {
      const u = prose(c);
      const slides = [...fillSlides, ...u.map((x) => ({ title: title(lang), body: x.text.split("\n"), hidden: z === "hidden_slide" }))];
      return { bytes: writePptx({ slides }), units: u, size: { slides: slides.length }, texts: fill };
    }
    if (z === "slide_table") {
      const f = fields(c);
      const d = decoyFields(c);
      return { bytes: writePptx({ slides: [...fillSlides, { title: title(lang), table: fieldRows(c, f, d) }] }), units: [...f, ...d], size: { slides: fillSlides.length + 1 }, texts: fill };
    }
    if (z === "speaker_notes") {
      const u = shortProse(c);
      return { bytes: writePptx({ slides: fillSlides.map((s, i) => ({ ...s, ...(u[i] ? { notes: u[i]!.text.split("\n") } : {}) })) }), units: u, size: { slides: fillSlides.length }, texts: fill };
    }
    if (z === "comment") {
      const u = shortProse(c);
      return { bytes: writePptx({ slides: fillSlides, comments: u.map((x) => x.text) }), units: u, size: { slides: fillSlides.length }, texts: fill };
    }
    if (z === "metadata") {
      const f = fields(c, 5);
      return { bytes: writePptx({ slides: fillSlides, properties: { custom: f.map((u) => [u.field!.label, u.field!.value] as [string, string]) } }), units: f, size: { slides: fillSlides.length }, texts: fill };
    }
  }
  if (key === "odt") {
    const base = { body: paragraphs([title(lang), ...fill]) };
    if (z === "body") {
      const u = prose(c);
      return { bytes: writeOdt({ body: paragraphs([title(lang), ...interleave(fill, u)]) }), units: u, texts: [...fill, ...lines(u)] };
    }
    if (z === "table_cell") {
      const f = fields(c);
      const d = decoyFields(c);
      return { bytes: writeOdt({ body: [...base.body, { type: "table", rows: fieldRows(c, f, d) }] }), units: [...f, ...d], texts: fill };
    }
    if (z === "header" || z === "footer") {
      const f = fields(c, 3);
      return { bytes: writeOdt({ ...base, [z]: f.map((u) => fieldLine(u)) }), units: f, texts: fill };
    }
    if (z === "comment") {
      const u = shortProse(c);
      return { bytes: writeOdt({ ...base, comments: u.map((x) => x.text) }), units: u, texts: fill };
    }
    if (z === "tracked_deletion") {
      const u = prose(c);
      return { bytes: writeOdt({ ...base, deletions: u.map((x) => x.text) }), units: u, texts: fill };
    }
    if (z === "metadata") {
      const f = fields(c, 5);
      return { bytes: writeOdt({ ...base, meta: { title: title(lang), custom: f.map((u) => [u.field!.label, u.field!.value] as [string, string]) } }), units: f, texts: fill };
    }
  }
  if (key === "pdf") {
    const info = { title: title(lang) };
    if (z === "page" || z === "two_column") {
      const u = prose(c);
      return { bytes: await writePdf({ blocks: paragraphs([title(lang), ...interleave(fill, u)]), columns: z === "two_column" ? 2 : 1, info }), units: u, texts: [...fill, ...lines(u)] };
    }
    if (z === "table_cell") {
      const f = fields(c);
      const d = decoyFields(c);
      return { bytes: await writePdf({ blocks: [...paragraphs([title(lang), ...fill]), { type: "table", rows: fieldRows(c, f, d) }], info }), units: [...f, ...d], texts: fill };
    }
    if (z === "inline") {
      // Values with more text after them on the same line (the other field zones end the line with the value).
      // Prefixes and tails vary, so the values land at varied positions on their lines.
      const f = fields(c, 10);
      const heads = lang === "en" ? ["", "Note:", "Updated -", "As agreed,", "Ref."] : ["", "Note :", "Mis à jour -", "Comme convenu,", "Réf."];
      const tails = lang === "en" ? ["(checked on the last review)", "today", "and the rest is unchanged.", "- keep it up to date", "now"] : ["(vérifié lors de la dernière revue)", "aujourd'hui", "et le reste ne change pas.", "- à tenir à jour", "maintenant"];
      const lines = f.map((u, i) => `${heads[i % heads.length]} ${fieldLine(u)} ${tails[(i * 3) % tails.length]}`.trim());
      return { bytes: await writePdf({ blocks: paragraphs([title(lang), ...fill, ...lines]), info }), units: f, texts: fill };
    }
    if (z === "inline_email") {
      // Emails followed by more text on the same line: the ref's PDF redaction refuses some of them (see the redaction probe).
      // Regression case: at 2aece81 an email starting with "j" with text after it on its line cannot be redacted in place
      // ("Text is still readable under a box"), so the whole PDF falls back to its text copy. Up to 4 of those, then others.
      const all = c.pools.fields[lang].filter((u) => u.items[0]?.category === "EMAIL");
      const jEmails = pickUnits(all.filter((u) => /^j/i.test(u.field!.value)), 4, c.rng, c.taken);
      const emails = [...jEmails, ...pickUnits(all, 12 - jEmails.length, c.rng, c.taken)];
      const heads = lang === "en" ? ["Mail", "Please write to", "Contact:", "cc", "Send it to", "Ask"] : ["Mail", "Merci d'écrire à", "Contact :", "cc", "Envoyer à", "Demander à"];
      const tails = lang === "en" ? ["now", "today about the order.", "(sales)", "and keep me in copy.", "x", "for the invoice"] : ["maintenant", "aujourd'hui pour la commande.", "(ventes)", "et me mettre en copie.", "x", "pour la facture"];
      const lines = emails.map((u, i) => `${heads[i % heads.length]} ${u.field!.value} ${tails[(i * 5) % tails.length]}`);
      return { bytes: await writePdf({ blocks: paragraphs([title(lang), ...fill, ...lines]), info }), units: emails, texts: fill };
    }
    if (z === "line_wrapped" || z === "hyphenated") {
      const hyphen = z === "hyphenated";
      const pool = c.pools.fields[lang].filter((u) => (hyphen ? !u.field!.value.includes(" ") && u.field!.value.length >= 8 : u.field!.value.includes(" ")));
      const f = pickUnits(pool, 6, c.rng, c.taken, true);
      const placed = f.map((u) => `${u.field!.label}: ${breakValue(u.field!.value, hyphen)}`);
      return { bytes: await writePdf({ blocks: paragraphs([title(lang), ...fill, ...placed]), info }), units: f, texts: fill };
    }
    if (z === "form_field") {
      const f = fields(c);
      return { bytes: await writePdf({ blocks: paragraphs([title(lang), ...fill]), formFields: f.map((u, i) => ({ name: `field${i + 1}`, value: u.field!.value })), info }), units: f, texts: fill };
    }
    if (z === "annotation") {
      const u = shortProse(c);
      return { bytes: await writePdf({ blocks: paragraphs([title(lang), ...fill]), annotations: u.map((x) => x.text), info }), units: u, texts: fill };
    }
    if (z === "bookmark") {
      const f = fields(c, 4);
      return { bytes: await writePdf({ blocks: paragraphs([title(lang), ...fill]), bookmarks: f.map((u) => fieldLine(u, " ")), info }), units: f, texts: fill };
    }
    if (z === "metadata") {
      const email = pickUnits(c.pools.fields[lang].filter((u) => u.items[0]?.category === "EMAIL"), 1, c.rng, c.taken);
      const f = fields(c, 2);
      return { bytes: await writePdf({ blocks: paragraphs([title(lang), ...fill]), info: { title: title(lang), author: email[0]!.field!.value, subject: fieldLine(f[0]!), keywords: fieldLine(f[1]!) } }), units: [...email, ...f], texts: fill };
    }
  }
  const enc = (s: string) => new TextEncoder().encode(s);
  if (key === "txt" || key === "md" || key === "log" || key === "html") {
    const u = prose(c);
    const paras = interleave(fill, u);
    const text =
      key === "md"
        ? `# ${title(lang)}\n\n${paras.join("\n\n")}\n`
        : key === "log"
          ? paras.flatMap((p) => p.split("\n")).map((l, i) => `2026-01-02T10:${String(i % 60).padStart(2, "0")}:00Z INFO ${l}`).join("\n") + "\n"
          : key === "html"
            ? `<!doctype html>\n<html><head><title>${title(lang)}</title></head><body>\n${paras.map((p) => `<p>${htmlEscape(p).replace(/\n/g, "<br>\n")}</p>`).join("\n")}\n</body></html>\n`
            : `${paras.join("\n\n")}\n`;
    return { bytes: enc(text), units: u, texts: paras };
  }
  if (key === "csv") {
    const f = fields(c);
    const d = decoyFields(c);
    const rows = orderRows(lang, 12_000, 80).map((r) => r.map((x) => String(x ?? "")));
    [...f, ...d].forEach((u, i) => rows.splice(1 + i * 9, 0, [u.field!.label, u.field!.value]));
    return { bytes: enc(rows.map((r) => r.map(csvCell).join(",")).join("\n") + "\n"), units: [...f, ...d], size: { cells: rows.reduce((n, r) => n + r.length, 0), rows: rows.length } };
  }
  if (key === "json") {
    const f = fields(c);
    const d = decoyFields(c);
    const records = [...f, ...d].map((u, i) => ({ id: i + 1, field: u.field!.label, value: u.field!.value, updated: "2026-01-02" }));
    return { bytes: enc(JSON.stringify({ export: title(lang), records }, null, 2) + "\n"), units: [...f, ...d] };
  }
  if (key === "zip") {
    const readme: ZipInput = { name: "README.txt", data: fill.join("\n\n") };
    if (z === "entry_txt" || z === "nested_zip") {
      const u = prose(c);
      const notes: ZipInput = { name: "notes.txt", data: interleave(fill.slice(0, 2), u).join("\n\n") };
      if (z === "entry_txt") return { bytes: writeZip([readme, notes]), units: u, size: { entries: 2 } };
      return { bytes: writeZip([readme, { name: "archive/inner.zip", data: writeZip([{ name: "deep/notes.zip", data: writeZip([notes]) }]) }]), units: u, size: { entries: 2 } };
    }
    if (z === "entry_docx") {
      const u = prose(c);
      return { bytes: writeZip([readme, { name: "report.docx", data: writeDocx({ title: title(lang), body: paragraphs(interleave(fill, u)) }) }]), units: u, size: { entries: 2 } };
    }
    if (z === "entry_pdf") {
      const u = prose(c);
      return { bytes: writeZip([readme, { name: "report.pdf", data: await writePdf({ blocks: paragraphs([title(lang), ...interleave(fill, u)]) }) }]), units: u, size: { entries: 2 } };
    }
    if (z === "entry_csv") {
      const f = fields(c);
      const d = decoyFields(c);
      return { bytes: writeZip([readme, { name: "export/contacts.csv", data: [...f, ...d].map((u) => `${csvCell(u.field!.label)},${csvCell(u.field!.value)}`).join("\n") + "\n" }]), units: [...f, ...d], size: { entries: 2 } };
    }
  }
  throw new Error(`no builder for ${spec.id}`);
}

async function buildNegative(c: Ctx): Promise<Built> {
  const { spec, lang } = c;
  const negs = c.pools.negatives[lang];
  const tagged = (tag: string) => negs.filter((u) => c.pools.cases.find((x) => x.id === u.source)?.tags.includes(tag));
  const ofRegisters = (regs: string[]) => negs.filter((u) => regs.includes(c.pools.cases.find((x) => x.id === u.source)?.register ?? ""));
  const fill = filler(c, 120);
  if (spec.zone === "bibliography") {
    const refs = pickUnits(tagged("reference_links"), 12, c.rng, c.taken);
    const blocks = paragraphs([lang === "en" ? "References" : "Bibliographie", ...fill, ...refs.map((u) => u.text)]);
    return { bytes: spec.family === "pdf" ? await writePdf({ blocks }) : writeDocx({ title: lang === "en" ? "Literature review" : "Revue de littérature", body: blocks }), units: refs, texts: fill };
  }
  if (spec.zone === "diagnostic_dump") {
    const dumps = pickUnits(ofRegisters(["log", "code", "config"]), 12, c.rng, c.taken);
    const text = dumps.map((u) => u.text).join("\n\n----\n\n");
    if (spec.family === "pdf") return { bytes: await writePdf({ blocks: paragraphs(dumps.map((u) => u.text)), fontSize: 9 }), units: dumps };
    return { bytes: new TextEncoder().encode(text + "\n"), units: dumps };
  }
  if (spec.zone === "invoice_fields") {
    const d = pickUnits(c.pools.decoyFields[lang], 40, c.rng, c.taken, true);
    const rows: Cell[][] = [[lang === "en" ? "Field" : "Champ", lang === "en" ? "Value" : "Valeur"], ...d.map((u) => [u.field!.label, u.field!.value])];
    return { bytes: writeXlsx({ sheets: [{ name: lang === "en" ? "Invoice" : "Facture", rows }] }), units: d, size: { cells: rows.length * 2 } };
  }
  if (spec.zone === "numeric_sheet") {
    const count = spec.family === "text" ? 20_000 : 10_000;
    const rows = orderRows(lang, 10_000, count);
    const cells = rows.reduce((n, r) => n + r.length, 0);
    if (spec.family === "text") return { bytes: new TextEncoder().encode(rows.map((r) => r.map((x) => csvCell(String(x ?? ""))).join(",")).join("\n") + "\n"), units: [], size: { cells, rows: rows.length } };
    if (spec.family === "ods") return { bytes: writeOds({ sheets: [{ name: "Commandes", rows: rows.map((r) => r.map((x) => (typeof x === "object" && x !== null ? x.result : x))) }] }), units: [], size: { cells, rows: rows.length } };
    return { bytes: writeXlsx({ sheets: [{ name: lang === "en" ? "Orders" : "Commandes", rows }] }), units: [], size: { cells, rows: rows.length } };
  }
  if (spec.zone === "slide") {
    const u = pickUnits(ofRegisters(["chat", "notes", "doc", "email", "ticket"]), 6, c.rng, c.taken);
    return { bytes: writePptx({ slides: [...fill.map((p) => ({ title: title(lang), body: [p] })), ...u.map((x) => ({ title: title(lang), body: x.text.split("\n") }))] }), units: u, size: { slides: fill.length + u.length }, texts: fill };
  }
  throw new Error(`no builder for ${spec.id}`);
}

async function buildFailure(c: Ctx): Promise<Built> {
  const { spec } = c;
  const enc = (s: string) => new TextEncoder().encode(s);
  const u = prose(c, 2);
  const fill = filler(c, 150);
  const body = paragraphs(interleave(fill, u));
  switch (spec.id) {
    case "pdf-encrypted":
      return { bytes: writeEncryptedPdf(lines(u), "s3cret-pass"), units: u };
    case "docx-encrypted":
    case "xlsx-encrypted":
      return { bytes: writeEncryptedOffice(spec.id.length), units: [] };
    case "odt-encrypted": {
      const odt = writeOdt({ body });
      // An ODF package whose manifest declares encrypted entries, as LibreOffice saves one with a password.
      const manifest = `<?xml version="1.0" encoding="UTF-8"?>\n<manifest:manifest xmlns:manifest="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0" manifest:version="1.3"><manifest:file-entry manifest:full-path="/" manifest:media-type="application/vnd.oasis.opendocument.text"/><manifest:file-entry manifest:full-path="content.xml" manifest:media-type="text/xml" manifest:size="2048"><manifest:encryption-data manifest:checksum-type="urn:oasis:names:tc:opendocument:xmlns:manifest:1.0#sha256-1k" manifest:checksum="AAAA"><manifest:algorithm manifest:algorithm-name="http://www.w3.org/2001/04/xmlenc#aes256-cbc" manifest:initialisation-vector="AAAA"/><manifest:key-derivation manifest:key-derivation-name="PBKDF2" manifest:key-size="32" manifest:iteration-count="100000" manifest:salt="AAAA"/></manifest:encryption-data></manifest:file-entry></manifest:manifest>`;
      void odt;
      return {
        bytes: writeZip([
          { name: "mimetype", data: "application/vnd.oasis.opendocument.text", method: 0 },
          { name: "content.xml", data: new Uint8Array(2048).map((_, i) => (i * 131 + 7) & 0xff), method: 0 },
          { name: "META-INF/manifest.xml", data: manifest },
        ]),
        units: [],
      };
    }
    case "zip-encrypted":
      return { bytes: writeZip(u.map((x, i) => ({ name: `notes-${i + 1}.txt`, data: x.text, password: "s3cret-pass" }))), units: [] };
    case "zip-partly-encrypted":
      return { bytes: writeZip([{ name: "private.txt", data: u[0]!.text, password: "s3cret-pass" }, { name: "notes.txt", data: u[1]!.text }]), units: [u[1]!] };
    case "pdf-scanned":
      return { bytes: await writePdf({ blocks: [], scanOnly: 2 }), units: [] };
    case "pdf-partly-scanned":
      return { bytes: await writePdf({ blocks: body, scannedPages: 2 }), units: u };
    case "pdf-signed":
      return { bytes: await writePdf({ blocks: body, signed: true }), units: u };
    case "pdf-attachment":
      return { bytes: await writePdf({ blocks: body, attachment: { name: "contacts.txt", content: fill[0] ?? "contacts" } }), units: u };
    case "zip-bomb":
      return { bytes: writeZip([{ name: "data/huge.log", data: "", raw: zeroBomb(80 * 1024 * 1024) }, { name: "notes.txt", data: u.map((x) => x.text).join("\n\n") }]), units: u, size: { entries: 2 } };
    case "zip-nested-too-deep": {
      let nest = writeZip([{ name: "notes.txt", data: u[0]!.text }]);
      for (let i = 0; i < 4; i++) nest = writeZip([{ name: `level${4 - i}.zip`, data: nest }]);
      return { bytes: writeZip([{ name: "outer-notes.txt", data: u[1]!.text }, { name: "nested.zip", data: nest }]), units: [u[1]!] };
    }
    case "zip-too-many-entries":
      return { bytes: writeZip(Array.from({ length: 5_001 }, (_, i) => ({ name: `parts/part-${String(i).padStart(5, "0")}.txt`, data: `part ${i}`, method: 0 as const }))), units: [], size: { entries: 5_001 } };
    case "docx-bomb": {
      const doc = writeDocx({ title: title(c.lang), body });
      // The same package whose main part inflates to 70 MB: past the 64 MB entry cap, so its body is never read.
      return { bytes: writeZip(unzipForRebuild(doc).map((e) => (e.name === "word/document.xml" ? { name: e.name, data: "", raw: zeroBomb(70 * 1024 * 1024) } : e))), units: [] };
    }
    case "docm-macros":
      return { bytes: writeDocx({ title: title(c.lang), body, macros: true }), units: u };
    case "xlsx-connections": {
      const f = fields(c);
      const book = writeXlsx({ sheets: [{ name: "Data", rows: [["Field", "Value"], ...f.map((x) => [x.field!.label, x.field!.value])] }] });
      return { bytes: writeZip([...unzipForRebuild(book), { name: "xl/connections.xml", data: '<?xml version="1.0" encoding="UTF-8"?><connections xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><connection id="1" name="Sales DB" type="1" refreshedVersion="6"><dbPr connection="DSN=Sales" command="SELECT * FROM orders"/></connection></connections>' }]), units: f };
    }
    case "doc-legacy":
      return { bytes: writeLegacyDoc(11), units: [] };
    case "docx-truncated": {
      const doc = writeDocx({ title: title(c.lang), body });
      return { bytes: doc.subarray(0, Math.floor(doc.length * 0.6)), units: [] };
    }
    case "docx-not-office":
      return { bytes: writeZip([{ name: "index.xml", data: "<document/>" }, { name: "Data/notes.txt", data: u[0]!.text }]), units: [] };
    case "pdf-not-pdf":
      return { bytes: enc(`This is not a PDF.\n${u[0]!.text}\n`), units: [] };
    case "txt-unbroken-run": {
      let b64 = "";
      const rng = rngFor("unbroken");
      const abc = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
      for (let i = 0; i < 60_000; i++) b64 += abc[Math.floor(rng() * 64)];
      return { bytes: enc(`${u[0]!.text}\n\nimage=${b64}\n`), units: [] };
    }
    case "txt-over-scan-cap": {
      const big = fillerParagraphs(c.lang, 450_000, c.rng).join("\n\n");
      return { bytes: enc(`${u.map((x) => x.text).join("\n\n")}\n\n${big}\n`), units: u, size: { words: 450_000 } };
    }
    case "png-image":
      return { bytes: scanPng(200, 120, 3), units: [] };
  }
  throw new Error(`no builder for ${spec.id}`);
}

/** Re-lists a zip written by `writeZip` (deflated entries) as inputs, to add parts to it. */
export function unzipForRebuild(zip: Uint8Array): ZipInput[] {
  const view = new DataView(zip.buffer, zip.byteOffset, zip.byteLength);
  const out: ZipInput[] = [];
  let at = 0;
  while (view.getUint32(at, true) === 0x04034b50) {
    const method = view.getUint16(at + 8, true);
    const csize = view.getUint32(at + 18, true);
    const nlen = view.getUint16(at + 26, true);
    const xlen = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(zip.subarray(at + 30, at + 30 + nlen));
    const data = zip.subarray(at + 30 + nlen + xlen, at + 30 + nlen + xlen + csize);
    out.push({ name, data: method === 8 ? new Uint8Array(inflateRawSync(data)) : data, method: method === 0 ? 0 : 8 });
    at += 30 + nlen + xlen + csize;
  }
  return out;
}

/** File name of a case's document. */
export const docName = (spec: DocSpec) =>
  ({ docx: "report", xlsx: "workbook", pptx: "deck", odt: "report", ods: "workbook", odp: "deck", pdf: "document", text: "notes", zip: "archive", other: "file" })[spec.family] + `.${spec.ext}`;

/** Generates one suite case's document. */
export async function buildDoc(spec: DocSpec, pools: ContentPools, seed: number): Promise<BuiltDoc> {
  const ctx: Ctx = { spec, pools, rng: rngFor(`docbench:${seed}:${spec.id}`), lang: spec.lang, taken: new Set() };
  const built = spec.kind === "positive" ? await buildPositive(ctx) : spec.kind === "negative" ? await buildNegative(ctx) : await buildFailure(ctx);
  const placedWords = words([...(built.texts ?? []), ...built.units.map((u) => u.text)]);
  return { spec, name: docName(spec), bytes: built.bytes, units: built.units, size: { words: placedWords, ...built.size } };
}

