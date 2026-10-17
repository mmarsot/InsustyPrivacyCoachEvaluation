/**
 * How the extension checks an attached file (`src/files/file-attach.ts`
 * `checkFile` and `redactedVersion` at the ref), driven through the ref's own
 * modules:
 *
 *   1. `readFileForCheck` classifies the file by its bytes and name (text,
 *      document, or not checkable);
 *   2. `readDocument` reads a PDF, Office/OpenDocument file or zip (PDFium
 *      from the ref's locked package, the ref's own part map), giving the
 *      text, its parts and its gaps;
 *   3. the caller detects on the text;
 *   4. the redacted version: a text file re-encoded as it was, a PDF or
 *      archive by `redactDocument`, falling back to the redacted text copy
 *      when that throws (D2), an Office file as its text copy.
 *
 * A ref from before the document worker reads PDFs, Office files and zips as
 * "not read by this ref"; a ref without the file check reads every file as
 * UTF-8 text. OCR is not wired in Node yet, so images and scanned pages are
 * reported as the ref reports them with OCR off.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { performance } from "node:perf_hooks";
import { pathToFileURL } from "node:url";
import type { ModuleRef } from "./materialize.ts";

export interface DocSegmentLike {
  start: number;
  end: number;
  where: string;
  source: { type: string; path: string[]; page?: number; office?: boolean };
}
export type DocResultLike =
  | {
      kind: "document";
      format: "pdf" | "office" | "archive" | "image";
      text: string;
      segments: DocSegmentLike[];
      gaps: string[];
      signed: boolean;
      pages?: number;
      redaction: "pdf" | "archive" | "text-copy" | "image";
    }
  | { kind: "unchecked"; format: string; reason: string };
type FileReadLike =
  | { kind: "text"; format: string; text: string; encoding: string; bom: boolean; checkedBytes: number; partial: boolean }
  | { kind: "document"; format: "pdf" | "office" | "archive" | "image" }
  | { kind: "unchecked"; format: string; reason: string };
export interface RangeLike {
  start: number;
  end: number;
  replacement: string;
}

/** The document half of the ref's bundle. */
export interface DocumentBundle {
  fileCheck?: {
    readFileForCheck: (file: File) => Promise<FileReadLike>;
    encodeText: (text: string, encoding: string, bom: boolean) => Uint8Array;
    FILE_MAX_BYTES?: number;
    FILE_SCAN_BYTES?: number;
  };
  documentReader?: {
    readDocument: (bytes: Uint8Array, name: string, format: string, env: unknown) => Promise<DocResultLike>;
    redactDocument: (bytes: Uint8Array, name: string, read: unknown, ranges: RangeLike[], options: unknown, env: unknown) => Promise<{ name: string; type: string; bytes: Uint8Array }>;
  };
  documentModel?: {
    textCopy: (text: string, segments: DocSegmentLike[], ranges: RangeLike[]) => string;
    DOCUMENT_TEXT_LIMIT?: number;
  };
  redaction?: { redactPrompt: (text: string, detections: Array<RangeLike & { selected: boolean }>) => string };
}

export interface DocRead {
  outcome: "checked" | "partial" | "unchecked" | "error";
  reason?: string;
  /** What the ref read: `text` (a text-like file), `pdf`, `office`, `archive`. */
  readAs?: string;
  text: string;
  segments: DocSegmentLike[];
  gaps: string[];
  signed: boolean;
  pages?: number;
  /** A text file read only in part (its first 2 MB). */
  partialText?: boolean;
  /** How the redacted version is made: in place (text, PDF, archive) or as a text copy (Office). */
  redaction?: "text" | "pdf" | "archive" | "text-copy" | "image";
  readMs: number;
  error?: string;
  doc?: Extract<DocResultLike, { kind: "document" }>;
  textRead?: { encoding: string; bom: boolean; checkedBytes: number };
}

export interface DocRedaction {
  mode: "in_place" | "text_copy" | "fallback_text_copy" | "none" | "error";
  name?: string;
  type?: string;
  bytes?: Uint8Array;
  ms: number;
  error?: string;
  /** A PDF that fell back: the findings the ref cannot redact in place, each tried alone (at most 40). */
  failing?: RangeLike[];
}

const errorText = (e: unknown) => (e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e));

/** `text` with sorted, non-overlapping ranges replaced, for refs without a redaction module. */
function replaceRanges(text: string, ranges: RangeLike[]): string {
  let out = "";
  let cursor = 0;
  for (const r of ranges) {
    if (r.start < cursor) continue;
    out += text.slice(cursor, r.start) + r.replacement;
    cursor = r.end;
  }
  return out + text.slice(cursor);
}

export interface DocumentPath {
  read(name: string, bytes: Uint8Array): Promise<DocRead>;
  redact(name: string, bytes: Uint8Array, read: DocRead, ranges: RangeLike[]): Promise<DocRedaction>;
  /** Caps the ref applies. */
  limits: Record<string, number>;
  /** Whether the ref reads PDFs, Office files and zips. */
  readsDocuments: boolean;
}

/** The ref's file check as two steps; PDFium is initialised once, on first use, from the ref's own wasm. */
export function documentPath(ref: ModuleRef, mod: DocumentBundle): DocumentPath {
  let pdfium: Promise<unknown> | undefined;
  const loadPdfium = () => {
    pdfium ??= (async () => {
      if (!ref.pdfiumWasm) throw new Error("The ref has no PDFium.");
      const { init } = (await import(pathToFileURL(join(ref.dir, "node_modules", "@embedpdf", "pdfium", "dist", "index.js")).href)) as {
        init: (o: { wasmBinary: ArrayBuffer; locateFile?: (f: string) => string }) => Promise<{ PDFiumExt_Init(): void }>;
      };
      const wasm = readFileSync(ref.pdfiumWasm);
      const module = await init({ wasmBinary: wasm.buffer.slice(wasm.byteOffset, wasm.byteOffset + wasm.byteLength) as ArrayBuffer, locateFile: (f) => f });
      module.PDFiumExt_Init();
      return module;
    })();
    return pdfium;
  };
  const env = { pdfium: loadPdfium };
  const reader = mod.documentReader;
  const readFile = mod.fileCheck
    ? (file: File) => mod.fileCheck!.readFileForCheck(file)
    : async (file: File): Promise<FileReadLike> => {
        const text = new TextDecoder("utf-8").decode(new Uint8Array(await file.arrayBuffer()));
        return { kind: "text", format: "text", text, encoding: "utf-8", bom: false, checkedBytes: file.size, partial: false };
      };
  const textCopyOf = (read: DocRead, ranges: RangeLike[]) => {
    if (!mod.documentModel || !read.doc) throw new Error("The ref has no text copy.");
    return new TextEncoder().encode(mod.documentModel.textCopy(read.doc.text, read.doc.segments, ranges));
  };
  return {
    readsDocuments: !!reader,
    limits: {
      ...(mod.fileCheck?.FILE_MAX_BYTES ? { fileMaxBytes: mod.fileCheck.FILE_MAX_BYTES } : {}),
      ...(mod.fileCheck?.FILE_SCAN_BYTES ? { fileScanBytes: mod.fileCheck.FILE_SCAN_BYTES } : {}),
      ...(mod.documentModel?.DOCUMENT_TEXT_LIMIT ? { documentTextLimit: mod.documentModel.DOCUMENT_TEXT_LIMIT } : {}),
    },
    async read(name, bytes) {
      const t0 = performance.now();
      const empty = { text: "", segments: [], gaps: [], signed: false };
      try {
        const read = await readFile(new File([bytes as BlobPart], name));
        if (read.kind === "unchecked") return { ...empty, outcome: "unchecked", reason: read.reason, readAs: read.format, readMs: performance.now() - t0 };
        if (read.kind === "text")
          return {
            ...empty,
            outcome: read.partial ? "partial" : "checked",
            readAs: "text",
            text: read.text,
            segments: [{ start: 0, end: read.text.length, where: name, source: { type: "text", path: [] } }],
            partialText: read.partial,
            redaction: "text",
            readMs: performance.now() - t0,
            textRead: { encoding: read.encoding, bom: read.bom, checkedBytes: read.checkedBytes },
          };
        if (!reader) return { ...empty, outcome: "unchecked", reason: "not_read_by_ref", readAs: read.format, readMs: performance.now() - t0 };
        const doc = await reader.readDocument(bytes, name, read.format, env);
        if (doc.kind === "unchecked") return { ...empty, outcome: "unchecked", reason: doc.reason, readAs: doc.format, readMs: performance.now() - t0 };
        return {
          outcome: doc.gaps.length ? "partial" : "checked",
          readAs: doc.format,
          text: doc.text,
          segments: doc.segments,
          gaps: doc.gaps,
          signed: doc.signed,
          ...(doc.pages !== undefined ? { pages: doc.pages } : {}),
          redaction: doc.redaction,
          readMs: performance.now() - t0,
          doc,
        };
      } catch (error) {
        // The extension reports a file it failed to read as not checked ("failed"), never clean.
        return { ...empty, outcome: "error", reason: "failed", readMs: performance.now() - t0, error: errorText(error) };
      }
    },
    async redact(name, bytes, read, ranges) {
      const t0 = performance.now();
      if (!ranges.length) return { mode: "none", ms: 0 };
      const copyName = name.replace(/(\.[^./]+)?$/, " (redacted).txt");
      try {
        if (read.redaction === "text") {
          const redacted = mod.redaction ? mod.redaction.redactPrompt(read.text, ranges.map((r) => ({ ...r, selected: true }))) : replaceRanges(read.text, ranges);
          const tr = read.textRead!;
          const body = mod.fileCheck ? mod.fileCheck.encodeText(redacted, tr.encoding, tr.bom) : new TextEncoder().encode(redacted);
          const rest = bytes.subarray(tr.checkedBytes);
          const out = new Uint8Array(body.length + rest.length);
          out.set(body);
          out.set(rest, body.length);
          return { mode: "in_place", name, type: "text/plain", bytes: out, ms: performance.now() - t0 };
        }
        if (read.redaction === "text-copy") return { mode: "text_copy", name: copyName, type: "text/plain", bytes: textCopyOf(read, ranges), ms: performance.now() - t0 };
        try {
          const out = await reader!.redactDocument(bytes, name, read.doc!, ranges, { mark: false }, env);
          return { mode: "in_place", name: out.name, type: out.type, bytes: out.bytes, ms: performance.now() - t0 };
        } catch (error) {
          // redactedVersion: any failure of the document worker falls back to the text copy.
          const ms = performance.now() - t0;
          // Not timed: which findings fail on their own (at most 40 tried).
          const failing: RangeLike[] = [];
          if (read.redaction === "pdf")
            for (const range of ranges.slice(0, 40))
              try {
                await reader!.redactDocument(bytes, name, read.doc!, [range], { mark: false }, env);
              } catch {
                failing.push(range);
              }
          return { mode: "fallback_text_copy", name: copyName, type: "text/plain", bytes: textCopyOf(read, ranges), ms, error: errorText(error), ...(read.redaction === "pdf" ? { failing } : {}) };
        }
      } catch (error) {
        return { mode: "error", ms: performance.now() - t0, error: errorText(error) };
      }
    },
  };
}
