/**
 * Runs one document through an extension ref the way the extension checks
 * an attached file (`src/file-attach.ts` `checkFile` and `redactedVersion`
 * at the ref), with every step timed:
 *
 *   1. `readFileForCheck` classifies the file by its bytes and name (text,
 *      document, or not checkable);
 *   2. `readDocument` reads a PDF, Office/OpenDocument file or zip (PDFium
 *      and the ref's own part map), giving the text, its parts and its gaps;
 *   3. `detectSensitiveData` scans the whole text, once per configuration;
 *      the selected findings (a disabled category starts unselected, as in
 *      `reviewDetectionsOf`) become `[CATEGORY]` replacements;
 *   4. the redacted version is written: a text file re-encoded as it was, a
 *      PDF or archive by `redactDocument`, falling back to the redacted
 *      text copy when that throws (D2), an Office file as its text copy.
 *
 * The outcome is what the extension would tell the user: `checked`,
 * `partial` (gaps, or text past a cap), or `unchecked` with its reason.
 */
import { performance } from "node:perf_hooks";
import type { DocReaderApi, DocResultLike, DocSegmentLike, RangeLike, RawDetection } from "./ext.ts";

export type ConfigName = "default" | "all";

export interface PipelineRead {
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
  redaction?: "text" | "pdf" | "archive" | "text-copy";
  readMs: number;
  error?: string;
  /** Internal: what the redaction needs. */
  doc?: Extract<DocResultLike, { kind: "document" }>;
  textRead?: { encoding: string; bom: boolean; checkedBytes: number };
}

export interface PipelineRedaction {
  /** `in_place` (same file redacted), `text_copy` (Office: by design), `fallback_text_copy` (a PDF or archive the ref could not redact safely). */
  mode: "in_place" | "text_copy" | "fallback_text_copy" | "none" | "error";
  name?: string;
  bytes?: Uint8Array;
  ms: number;
  error?: string;
}

const errorText = (e: unknown) => (e instanceof Error ? `${e.constructor.name}: ${e.message}` : String(e));

/** Steps 1 and 2: read and classify. */
export async function readForCheck(api: DocReaderApi, name: string, bytes: Uint8Array): Promise<PipelineRead> {
  const t0 = performance.now();
  const empty = { text: "", segments: [], gaps: [], signed: false };
  try {
    const read = await api.readFile(new File([bytes as BlobPart], name));
    if (read.kind === "unchecked") return { ...empty, outcome: "unchecked", reason: read.reason, readAs: read.format, readMs: performance.now() - t0 };
    if (read.kind === "text") {
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
    }
    if (!api.readDocument) return { ...empty, outcome: "unchecked", reason: "not_read_by_ref", readAs: read.format, readMs: performance.now() - t0 };
    const doc = await api.readDocument(bytes, name, read.format);
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
}

/** Step 3: the rule-based detector on the whole text. */
export function detect(api: DocReaderApi, text: string, config: ConfigName): { detections: Array<RawDetection & { selected: boolean }>; ms: number } {
  const t0 = performance.now();
  const raw = text ? api.detect(text, config) : [];
  const ms = performance.now() - t0;
  const categories = (api.configs[config].categories ?? {}) as Record<string, boolean>;
  return { detections: raw.map((d) => ({ category: d.category, start: d.start, end: d.end, value: d.value ?? text.slice(d.start, d.end), selected: categories[d.category] !== false })), ms };
}

/** The selected findings as ranges, sorted (`rangesOf` at the ref). */
export const rangesOf = (detections: Array<RawDetection & { selected: boolean }>): RangeLike[] =>
  detections
    .filter((d) => d.selected)
    .sort((a, b) => a.start - b.start)
    .map((d) => ({ start: d.start, end: d.end, replacement: `[${d.category}]` }));

/** `text` with sorted, non-overlapping ranges replaced, for refs without `src/redaction.ts`. */
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

/** Step 4: the redacted version the extension would attach. */
export async function redactForAttach(api: DocReaderApi, name: string, bytes: Uint8Array, read: PipelineRead, ranges: RangeLike[]): Promise<PipelineRedaction> {
  const t0 = performance.now();
  if (!ranges.length) return { mode: "none", ms: 0 };
  const copyName = name.replace(/(\.[^./]+)?$/, " (redacted).txt");
  const textCopy = () => {
    if (!api.textCopy || !read.doc) throw new Error("The ref has no text copy.");
    return new TextEncoder().encode(api.textCopy(read.doc.text, read.doc.segments, ranges));
  };
  try {
    if (read.redaction === "text") {
      const redacted = api.redactText ? api.redactText(read.text, ranges) : replaceRanges(read.text, ranges);
      const tr = read.textRead!;
      const body = api.encodeText ? api.encodeText(redacted, tr.encoding, tr.bom) : new TextEncoder().encode(redacted);
      const rest = bytes.subarray(tr.checkedBytes);
      const out = new Uint8Array(body.length + rest.length);
      out.set(body);
      out.set(rest, body.length);
      return { mode: "in_place", name, bytes: out, ms: performance.now() - t0 };
    }
    if (read.redaction === "text-copy") return { mode: "text_copy", name: copyName, bytes: textCopy(), ms: performance.now() - t0 };
    try {
      const out = await api.redactDocument!(bytes, name, read.doc!, ranges);
      return { mode: "in_place", name: out.name, bytes: out.bytes, ms: performance.now() - t0 };
    } catch (error) {
      // redactedVersion: any failure of the document worker falls back to the text copy.
      return { mode: "fallback_text_copy", name: copyName, bytes: textCopy(), ms: performance.now() - t0, error: errorText(error) };
    }
  } catch (error) {
    return { mode: "error", ms: performance.now() - t0, error: errorText(error) };
  }
}
