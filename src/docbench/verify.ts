/**
 * Independent text extraction of a redacted output, to verify that the
 * values the ref redacted are really gone. It does not use the ref's
 * readers: zips are walked with our own local-header parser and Node's
 * zlib, PDFs are read with Poppler's `pdftotext` when it is installed, plus
 * every literal and hex string of every inflated stream and the raw bytes
 * (so metadata, annotations and form values are seen too), and text files
 * are decoded as UTF-8 or UTF-16.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { inflateRawSync, inflateSync } from "node:zlib";
import { CACHE_DIR } from "../paths.ts";

let pdftotextPath: string | null | undefined;
/** Path of Poppler's pdftotext, or null when it is not installed. */
export function pdftotext(): string | null {
  if (pdftotextPath === undefined) {
    try {
      pdftotextPath =
        execFileSync("which", ["pdftotext"], { encoding: "utf8" }).trim() ||
        null;
    } catch {
      pdftotextPath = null;
    }
  }
  return pdftotextPath;
}

const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");

/** Literal `( … )` and hex `< … >` strings of a PDF content or object stream, decoded as Latin-1 / UTF-16BE. */
function pdfStrings(src: string): string {
  const out: string[] = [];
  for (const m of src.matchAll(/\((?:\\.|[^\\()])*\)/g))
    out.push(
      m[0]
        .slice(1, -1)
        .replace(/\\([()\\])/g, "$1")
        .replace(/\\n/g, "\n"),
    );
  for (const m of src.matchAll(/<([0-9A-Fa-f\s]{4,})>/g)) {
    const hex = m[1]!.replace(/\s+/g, "");
    const bytes = Buffer.from(hex.length % 2 ? `${hex}0` : hex, "hex");
    out.push(
      bytes[0] === 0xfe && bytes[1] === 0xff
        ? Buffer.from(bytes.subarray(2)).swap16().toString("utf16le")
        : bytes.toString("latin1"),
    );
  }
  return out.join("\n");
}

/** The reading methods of the independent reader; each one is a full view of the output. */
export type View = "text" | "strings" | "pdftotext";
export type Views = Record<View, string>;

function pdfViews(bytes: Uint8Array): Views {
  const raw = latin1(bytes);
  const strings: string[] = [pdfStrings(raw)];
  const inflated: string[] = [];
  for (const m of raw.matchAll(/stream\r?\n/g)) {
    const start = m.index! + m[0].length;
    const end = raw.indexOf("endstream", start);
    if (end < 0) continue;
    try {
      const text = latin1(inflateSync(bytes.subarray(start, end)));
      inflated.push(text);
      strings.push(pdfStrings(text));
    } catch {
      /* not deflated */
    }
  }
  let poppler = "";
  const tool = pdftotext();
  if (tool) {
    const dir = mkdtempSync(join(CACHE_DIR, "tmp", "verify-"));
    try {
      const file = join(dir, "out.pdf");
      writeFileSync(file, bytes);
      poppler = execFileSync(tool, ["-q", "-enc", "UTF-8", file, "-"], {
        encoding: "utf8",
        maxBuffer: 256 * 1024 * 1024,
        stdio: ["ignore", "pipe", "ignore"],
      });
    } catch {
      /* unreadable by Poppler: the other views still count */
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  }
  return {
    text: [raw, ...inflated].join("\n"),
    strings: strings.join("\n"),
    pdftotext: poppler,
  };
}

/** Entries of a zip, from its local headers (data descriptors not needed: our writer and the ref's never use them). */
function zipEntries(
  bytes: Uint8Array,
): Array<{ name: string; data: Uint8Array }> {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  const out: Array<{ name: string; data: Uint8Array }> = [];
  let at = 0;
  while (at + 30 <= bytes.length && view.getUint32(at, true) === 0x04034b50) {
    const flags = view.getUint16(at + 6, true);
    const method = view.getUint16(at + 8, true);
    const csize = view.getUint32(at + 18, true);
    const nlen = view.getUint16(at + 26, true);
    const xlen = view.getUint16(at + 28, true);
    const name = new TextDecoder().decode(
      bytes.subarray(at + 30, at + 30 + nlen),
    );
    const data = bytes.subarray(
      at + 30 + nlen + xlen,
      at + 30 + nlen + xlen + csize,
    );
    if (!(flags & 1)) {
      try {
        out.push({
          name,
          data: method === 8 ? new Uint8Array(inflateRawSync(data)) : data,
        });
      } catch {
        out.push({ name, data });
      }
    }
    at += 30 + nlen + xlen + csize;
  }
  return out;
}

function decodeText(bytes: Uint8Array): string {
  if (bytes[0] === 0xff && bytes[1] === 0xfe)
    return Buffer.from(bytes.subarray(2)).toString("utf16le");
  if (bytes[0] === 0xfe && bytes[1] === 0xff)
    return Buffer.from(bytes.subarray(2)).swap16().toString("utf16le");
  return new TextDecoder("utf-8").decode(bytes);
}

/** What an independent reader finds in `bytes`, per reading method (recursively for archives and Office packages). */
export function independentViews(bytes: Uint8Array, depth = 0): Views {
  if (bytes[0] === 0x50 && bytes[1] === 0x4b && depth < 6) {
    const views: Views = { text: "", strings: "", pdftotext: "" };
    for (const e of zipEntries(bytes)) {
      const inner = independentViews(e.data, depth + 1);
      for (const k of Object.keys(views) as View[])
        views[k] += `\n${e.name}\n${inner[k] || inner.text}`;
    }
    return views;
  }
  if (latin1(bytes.subarray(0, 1024)).includes("%PDF-")) return pdfViews(bytes);
  const text = decodeText(bytes);
  return { text, strings: text, pdftotext: text };
}

/** Collapses whitespace runs, so a value matches text however its spaces were laid out. */
export const normalizeSpaces = (s: string) => s.replace(/\s+/g, " ").trim();
