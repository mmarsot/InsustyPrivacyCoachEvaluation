/**
 * Deterministic PDF writers for the document bench.
 *
 * `writePdf` lays out text with pdf-lib (Helvetica, WinAnsi, A4): paragraphs
 * wrapped to the column width, tables as ruled grids, one or two columns,
 * then the extras a PDF can hold: filled AcroForm text fields, sticky-note
 * comments, bookmarks, document information (author, title...), an attached
 * file, image-only ("scanned") pages and a signature field. Dates and ids
 * are fixed, so the same spec gives the same bytes.
 *
 * `writeEncryptedPdf` writes a small password-protected PDF by hand
 * (standard security handler, RC4 40-bit, revision 2), which pdf-lib cannot.
 */
import { createHash } from "node:crypto";
import { deflateSync } from "node:zlib";
import { PDFArray, PDFDict, PDFDocument, PDFHexString, PDFName, PDFNumber, PDFString, StandardFonts, rgb, type PDFFont, type PDFPage, type PDFRef } from "pdf-lib";
import type { Block } from "./ooxml.ts";
import { concat, crc32 } from "./zip.ts";

export interface PdfSpec {
  blocks: Block[];
  columns?: 1 | 2;
  fontSize?: number;
  /** Filled text fields (the reader flattens them into the page). */
  formFields?: Array<{ name: string; value: string }>;
  /** Sticky-note comments on the first page. */
  annotations?: string[];
  bookmarks?: string[];
  info?: { author?: string; title?: string; subject?: string; keywords?: string; creator?: string };
  attachment?: { name: string; content: string };
  /** Image-only pages appended after the text (a scan with no text layer). */
  scannedPages?: number;
  /** No text at all: every page is an image. */
  scanOnly?: number;
  /** A signature field with a (dummy) signature value. */
  signed?: boolean;
}

const FIXED_DATE = new Date("2026-01-02T10:00:00Z");
const A4: [number, number] = [595.28, 841.89];
const MARGIN = 56;

/** WinAnsi can encode Latin-1 and a few typographic marks; anything else becomes "?". */
const WIN_ANSI_EXTRA = "€‚ƒ„…†‡ˆ‰Š‹ŒŽ‘’“”•–—˜™š›œžŸ";
export const winAnsiSafe = (s: string) => [...s].map((c) => (c.charCodeAt(0) < 256 || WIN_ANSI_EXTRA.includes(c) ? c : "?")).join("").replace(/\t/g, "    ");

/** Greedy word wrap to `width` points; a word longer than a line is cut. */
function wrap(text: string, font: PDFFont, size: number, width: number): string[] {
  const lines: string[] = [];
  for (const raw of text.split("\n")) {
    const words = winAnsiSafe(raw).split(/ +/);
    let line = "";
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (font.widthOfTextAtSize(next, size) <= width || !line) {
        if (font.widthOfTextAtSize(next, size) <= width) line = next;
        else {
          // A single word wider than the line: cut it.
          let rest = word;
          while (font.widthOfTextAtSize(rest, size) > width) {
            let cut = rest.length - 1;
            while (cut > 1 && font.widthOfTextAtSize(rest.slice(0, cut), size) > width) cut--;
            lines.push(rest.slice(0, cut));
            rest = rest.slice(cut);
          }
          line = rest;
        }
      } else {
        lines.push(line);
        line = word;
      }
    }
    lines.push(line);
  }
  return lines;
}

/** A tiny grayscale PNG with ink-like strokes, standing in for a scanned page. */
export function scanPng(width: number, height: number, seed: number): Uint8Array {
  const raw = new Uint8Array((width + 1) * height);
  let s = seed >>> 0 || 1;
  const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 2 ** 32);
  for (let y = 0; y < height; y++) {
    raw[y * (width + 1)] = 0;
    const textLine = y % 18 > 4 && y % 18 < 14 && y > 30 && y < height - 30;
    for (let x = 0; x < width; x++) {
      const ink = textLine && x > 30 && x < width - 30 && rnd() < 0.35 ? 40 : 235 + Math.floor(rnd() * 20);
      raw[y * (width + 1) + 1 + x] = ink;
    }
  }
  const chunk = (type: string, data: Uint8Array) => {
    const head = new Uint8Array(8);
    new DataView(head.buffer).setUint32(0, data.length);
    head.set(new TextEncoder().encode(type), 4);
    const crc = new Uint8Array(4);
    new DataView(crc.buffer).setUint32(0, crc32(concat([head.subarray(4), data])));
    return concat([head, data, crc]);
  };
  const ihdr = new Uint8Array(13);
  const v = new DataView(ihdr.buffer);
  v.setUint32(0, width);
  v.setUint32(4, height);
  ihdr[8] = 8;
  ihdr[9] = 0;
  return concat([new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", new Uint8Array(deflateSync(raw))), chunk("IEND", new Uint8Array(0))]);
}

export async function writePdf(spec: PdfSpec): Promise<Uint8Array> {
  const doc = await PDFDocument.create({ updateMetadata: false });
  doc.setCreationDate(FIXED_DATE);
  doc.setModificationDate(FIXED_DATE);
  doc.setProducer("BenchWriter 1.0");
  doc.setCreator(spec.info?.creator ?? "BenchWriter");
  if (spec.info?.author) doc.setAuthor(spec.info.author);
  if (spec.info?.title) doc.setTitle(spec.info.title);
  if (spec.info?.subject) doc.setSubject(spec.info.subject);
  if (spec.info?.keywords) doc.setKeywords([spec.info.keywords]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const size = spec.fontSize ?? 10.5;
  const leading = size * 1.35;
  const columns = spec.columns ?? 1;
  const gutter = 24;
  const colWidth = (A4[0] - 2 * MARGIN - (columns - 1) * gutter) / columns;
  const pages: PDFPage[] = [];
  let page: PDFPage | undefined;
  let col = 0;
  let y = 0;
  const newPage = () => {
    page = doc.addPage(A4);
    pages.push(page);
    col = 0;
    y = A4[1] - MARGIN;
  };
  const nextLine = () => {
    if (!page || y - leading < MARGIN) {
      if (page && col + 1 < columns) {
        col++;
        y = A4[1] - MARGIN;
      } else newPage();
    }
    y -= leading;
    return MARGIN + col * (colWidth + gutter);
  };
  if (!spec.scanOnly) {
    for (const block of spec.blocks) {
      if (block.type === "p") {
        for (const line of wrap(block.text, font, size, colWidth)) {
          const x = nextLine();
          if (line) page!.drawText(line, { x, y, size, font });
        }
        y -= leading * 0.5;
      } else {
        const cols = Math.max(...block.rows.map((r) => r.length));
        const cellW = colWidth / cols;
        for (const row of block.rows) {
          const cellLines = row.map((c) => wrap(c, font, size - 1, cellW - 8));
          const height = Math.max(1, ...cellLines.map((l) => l.length));
          const x0 = nextLine();
          const top = y + leading - 3;
          for (let i = 1; i < height; i++) nextLine();
          cellLines.forEach((lines, ci) =>
            lines.forEach((line, li) => page!.drawText(line, { x: x0 + ci * cellW + 4, y: top - 3 - (li + 1) * leading + 3, size: size - 1, font })),
          );
          page!.drawRectangle({ x: x0, y: y - 4, width: cellW * cols, height: top - y + 4, borderColor: rgb(0.6, 0.6, 0.6), borderWidth: 0.5 });
          for (let ci = 1; ci < cols; ci++) page!.drawLine({ start: { x: x0 + ci * cellW, y: y - 4 }, end: { x: x0 + ci * cellW, y: top }, thickness: 0.5, color: rgb(0.6, 0.6, 0.6) });
        }
        y -= leading * 0.5;
      }
    }
  }
  const scans = spec.scanOnly ?? spec.scannedPages ?? 0;
  for (let i = 0; i < scans; i++) {
    const png = await doc.embedPng(scanPng(420, 600, 7 + i));
    const p = doc.addPage(A4);
    pages.push(p);
    p.drawImage(png, { x: 40, y: 40, width: A4[0] - 80, height: A4[1] - 80 });
  }
  if (!pages.length) newPage();
  const first = pages[0]!;
  if (spec.formFields?.length) {
    const form = doc.getForm();
    spec.formFields.forEach((f, i) => {
      const field = form.createTextField(f.name);
      field.setText(winAnsiSafe(f.value));
      field.addToPage(first, { x: MARGIN, y: 120 + i * 26, width: A4[0] - 2 * MARGIN, height: 20, font });
    });
    form.updateFieldAppearances(font);
  }
  const annots: PDFRef[] = [];
  for (const [i, text] of (spec.annotations ?? []).entries()) {
    annots.push(
      doc.context.register(
        doc.context.obj({ Type: "Annot", Subtype: "Text", Rect: [A4[0] - 60, A4[1] - 80 - i * 30, A4[0] - 40, A4[1] - 60 - i * 30], Contents: PDFHexString.fromText(text), T: PDFString.of("Reviewer"), Open: false, F: 4 }),
      ),
    );
  }
  if (spec.signed) {
    const sig = doc.context.register(
      doc.context.obj({ Type: "Sig", Filter: "Adobe.PPKLite", SubFilter: "adbe.pkcs7.detached", ByteRange: [0, 0, 0, 0], Contents: PDFHexString.of("0".repeat(512)), M: PDFString.of("D:20260102100000Z"), Name: PDFString.of("Bench Signer") }),
    );
    const widget = doc.context.register(
      doc.context.obj({ Type: "Annot", Subtype: "Widget", FT: "Sig", T: PDFString.of("Signature1"), V: sig, Rect: [0, 0, 0, 0], F: 132, P: first.ref }),
    );
    annots.push(widget);
    const acro = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
    if (acro) {
      acro.set(PDFName.of("SigFlags"), PDFNumber.of(3));
      const fields = acro.lookupMaybe(PDFName.of("Fields"), PDFArray);
      if (fields) fields.push(widget);
      else acro.set(PDFName.of("Fields"), doc.context.obj([widget]));
    } else doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [widget], SigFlags: 3 }));
  }
  if (annots.length) {
    const existing = first.node.Annots();
    if (existing) for (const a of annots) existing.push(a);
    else first.node.set(PDFName.of("Annots"), doc.context.obj(annots));
  }
  if (spec.bookmarks?.length) {
    const outlines = doc.context.nextRef();
    const refs = spec.bookmarks.map(() => doc.context.nextRef());
    spec.bookmarks.forEach((title, i) => {
      doc.context.assign(
        refs[i]!,
        doc.context.obj({
          Title: PDFHexString.fromText(title),
          Parent: outlines,
          ...(i > 0 ? { Prev: refs[i - 1]! } : {}),
          ...(i < refs.length - 1 ? { Next: refs[i + 1]! } : {}),
          Dest: [first.ref, "XYZ", null, null, null],
        }),
      );
    });
    doc.context.assign(outlines, doc.context.obj({ Type: "Outlines", First: refs[0]!, Last: refs[refs.length - 1]!, Count: refs.length }));
    doc.catalog.set(PDFName.of("Outlines"), outlines);
  }
  if (spec.attachment) await doc.attach(new TextEncoder().encode(spec.attachment.content), spec.attachment.name, { mimeType: "text/plain", creationDate: FIXED_DATE, modificationDate: FIXED_DATE });
  return doc.save({ useObjectStreams: false });
}

// ------------------------------------------------------------ encrypted (hand-written, RC4 40-bit)

function rc4(key: Uint8Array, data: Uint8Array): Uint8Array {
  const s = new Uint8Array(256).map((_, i) => i);
  for (let i = 0, j = 0; i < 256; i++) {
    j = (j + s[i]! + key[i % key.length]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
  }
  const out = new Uint8Array(data.length);
  for (let k = 0, i = 0, j = 0; k < data.length; k++) {
    i = (i + 1) & 0xff;
    j = (j + s[i]!) & 0xff;
    [s[i], s[j]] = [s[j]!, s[i]!];
    out[k] = data[k]! ^ s[(s[i]! + s[j]!) & 0xff]!;
  }
  return out;
}
const md5 = (...parts: Uint8Array[]) => new Uint8Array(createHash("md5").update(concat(parts)).digest());
const PAD = Uint8Array.from([0x28, 0xbf, 0x4e, 0x5e, 0x4e, 0x75, 0x8a, 0x41, 0x64, 0x00, 0x4e, 0x56, 0xff, 0xfa, 0x01, 0x08, 0x2e, 0x2e, 0x00, 0xb6, 0xd0, 0x68, 0x3e, 0x80, 0x2f, 0x0c, 0xa9, 0xfe, 0x64, 0x53, 0x69, 0x7a]);
const padded = (password: string) => {
  const p = new TextEncoder().encode(password).subarray(0, 32);
  return concat([p, PAD.subarray(0, 32 - p.length)]);
};
const hex = (b: Uint8Array) => Buffer.from(b).toString("hex");

/** A one-page PDF readable only with `userPassword` (RC4 40-bit, R2), with `lines` of text. */
export function writeEncryptedPdf(lines: string[], userPassword: string, ownerPassword = `${userPassword}-owner`): Uint8Array {
  const id = md5(new TextEncoder().encode(`docbench:${lines.join("|")}`));
  const P = -44; // print + copy allowed
  const o = rc4(md5(padded(ownerPassword)).subarray(0, 5), padded(userPassword));
  const pBytes = new Uint8Array(4);
  new DataView(pBytes.buffer).setInt32(0, P, true);
  const key = md5(padded(userPassword), o, pBytes, id).subarray(0, 5);
  const u = rc4(key, PAD);
  const objKey = (num: number) => md5(key, Uint8Array.from([num & 0xff, (num >> 8) & 0xff, (num >> 16) & 0xff, 0, 0])).subarray(0, 10);
  const content = new TextEncoder().encode(
    `BT /F1 11 Tf 56 780 Td 15 TL ${lines.map((l) => `(${winAnsiSafe(l).replace(/[\\()]/g, (c) => `\\${c}`)}) Tj T*`).join(" ")} ET`,
  );
  const stream = rc4(objKey(4), content);
  const objects = [
    `1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n`,
    `2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n`,
    `3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 595.28 841.89] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>\nendobj\n`,
    null,
    `5 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>\nendobj\n`,
    `6 0 obj\n<< /Filter /Standard /V 1 /R 2 /O <${hex(o)}> /U <${hex(u)}> /P ${P} >>\nendobj\n`,
  ];
  const enc = new TextEncoder();
  const chunks: Uint8Array[] = [enc.encode("%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")];
  let offset = chunks[0]!.length;
  const offsets: number[] = [];
  objects.forEach((obj, i) => {
    offsets.push(offset);
    const bytes = obj ? enc.encode(obj) : concat([enc.encode(`${i + 1} 0 obj\n<< /Length ${stream.length} >>\nstream\n`), stream, enc.encode("\nendstream\nendobj\n")]);
    chunks.push(bytes);
    offset += bytes.length;
  });
  const xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o2) => `${String(o2).padStart(10, "0")} 00000 n \n`).join("")}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R /Encrypt 6 0 R /ID [<${hex(id)}> <${hex(id)}>] >>\nstartxref\n${offset}\n%%EOF\n`;
  chunks.push(enc.encode(xref));
  return concat(chunks);
}
