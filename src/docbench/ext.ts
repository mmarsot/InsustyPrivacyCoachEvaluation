/**
 * Materializes an extension ref's file check for the document bench: the
 * same read-only path as detbench (`src/detbench/ext.ts`), with the ref's
 * file readers added to its detector.
 *
 *   1. `git archive` copies the ref's `src`, `package.json` and
 *      `package-lock.json` into `cache/docbench/ext/<sha>/` (the clone is
 *      never touched).
 *   2. The npm packages those modules import (`@embedpdf/pdfium`, `fflate`,
 *      the detector's own) are installed at the versions the ref's
 *      package-lock pins.
 *   3. esbuild bundles `src/file-check.ts`, `src/document-reader.ts`,
 *      `src/document-model.ts`, `src/detector.ts` and `src/config.ts` into
 *      `bench-docs.mjs`, resolving packages only from that install.
 *
 * A ref from before the document worker (no `src/document-reader.ts`) still
 * loads: its PDFs, Office files and zips are then scored as "not read by
 * this ref". A ref without `src/file-check.ts` (before attached files) runs
 * only the detector on text-like files, read as UTF-8.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { archiveCommit, resolveCommit } from "../ext/ref.ts";
import { CACHE_DIR } from "../paths.ts";
import { importedPackages, installLocked, isBuiltin } from "../detbench/ext.ts";

export const DOC_EXT_CACHE_DIR = join(CACHE_DIR, "docbench", "ext");

/** Bundle layout version: bump when the entry below changes, so cached bundles are rebuilt. */
const BUNDLE_VERSION = 3;

const MODULES: ReadonlyArray<{ name: string; file: string; required: boolean }> = [
  { name: "detector", file: "src/detector.ts", required: true },
  { name: "config", file: "src/config.ts", required: true },
  { name: "fileCheck", file: "src/file-check.ts", required: false },
  { name: "documentReader", file: "src/document-reader.ts", required: false },
  { name: "documentModel", file: "src/document-model.ts", required: false },
  { name: "redaction", file: "src/redaction.ts", required: false },
];

export interface DocReaderRef {
  ref: string;
  sha: string;
  subject: string;
  committedAt: string;
  dir: string;
  bundle: string;
  /** PDFium's WebAssembly binary from the ref's locked `@embedpdf/pdfium`, when the ref reads PDFs. */
  pdfiumWasm?: string;
  /** Which of the optional modules the ref has. */
  modules: string[];
  packages: Record<string, string>;
}

/** Resolves and materializes the file check of a ref; cached per commit sha. */
export async function materializeDocReader(repo: string, ref: string, log: (line: string) => void = console.log): Promise<DocReaderRef> {
  const { sha, subject, committedAt } = resolveCommit(repo, ref);
  const dir = join(DOC_EXT_CACHE_DIR, sha);
  const metaFile = join(dir, "bundle.json");
  const fresh = existsSync(metaFile) && (JSON.parse(readFileSync(metaFile, "utf8")) as { version: number }).version === BUNDLE_VERSION;
  if (!fresh) {
    log(`materializing the file check of ${ref} (${sha.slice(0, 8)})`);
    const staging = `${dir}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    archiveCommit(repo, sha, ["src", "package.json", "package-lock.json"], staging);
    const present = MODULES.filter((m) => existsSync(join(staging, m.file)));
    const missing = MODULES.filter((m) => m.required && !present.includes(m));
    if (missing.length) throw new Error(`Ref ${ref} (${sha.slice(0, 8)}) lacks ${missing.map((m) => m.file).join(", ")}; docbench cannot drive it.`);
    const entry = join(staging, "bench-docs-entry.ts");
    writeFileSync(entry, present.map((m) => `export * as ${m.name} from "./${m.file}";`).join("\n") + "\n");
    // PDFium is loaded by the ref's document worker, not imported by the reader (types only): install it too.
    const lock = existsSync(join(staging, "package-lock.json")) ? (JSON.parse(readFileSync(join(staging, "package-lock.json"), "utf8")) as { packages?: Record<string, unknown> }) : {};
    const extra = present.some((m) => m.name === "documentReader") && lock.packages?.["node_modules/@embedpdf/pdfium"] ? ["@embedpdf/pdfium"] : [];
    const packages = installLocked(staging, [...new Set([...(await importedPackages(entry)), ...extra])].sort(), log);
    await build({
      entryPoints: [entry],
      outfile: join(staging, "bench-docs.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      nodePaths: [],
      plugins: [
        {
          name: "ref-packages-only",
          setup(b) {
            b.onResolve({ filter: /^[^./]/ }, async (args) => {
              if (isBuiltin(args.path) || args.pluginData === "inner") return undefined;
              const result = await b.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: "inner" });
              if (result.errors.length) return result;
              if (!result.path.startsWith(join(staging, "node_modules")))
                return { errors: [{ text: `${args.path} resolved outside the ref's locked packages (${result.path})` }] };
              return result;
            });
          },
        },
      ],
      logLevel: "error",
    });
    const wasm = join(staging, "node_modules", "@embedpdf", "pdfium", "dist", "pdfium.wasm");
    writeFileSync(
      join(staging, "bundle.json"),
      JSON.stringify({ version: BUNDLE_VERSION, modules: present.map((m) => m.name), packages, pdfiumWasm: existsSync(wasm) ? "node_modules/@embedpdf/pdfium/dist/pdfium.wasm" : null }, null, 2) + "\n",
    );
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(DOC_EXT_CACHE_DIR, { recursive: true });
    renameSync(staging, dir);
  }
  const meta = JSON.parse(readFileSync(metaFile, "utf8")) as { modules: string[]; packages: Record<string, string>; pdfiumWasm: string | null };
  return {
    ref,
    sha,
    subject,
    committedAt,
    dir,
    bundle: join(dir, "bench-docs.mjs"),
    ...(meta.pdfiumWasm ? { pdfiumWasm: join(dir, meta.pdfiumWasm) } : {}),
    modules: meta.modules,
    packages: meta.packages,
  };
}

// ------------------------------------------------------------ the ref's API, as the bench drives it

export interface RawDetection {
  category: string;
  start: number;
  end: number;
  value: string;
}
export interface DocSegmentLike {
  start: number;
  end: number;
  where: string;
  source: { type: string; path: string[]; page?: number; office?: boolean };
}
export type DocResultLike =
  | {
      kind: "document";
      format: "pdf" | "office" | "archive";
      text: string;
      segments: DocSegmentLike[];
      gaps: string[];
      signed: boolean;
      pages?: number;
      redaction: "pdf" | "archive" | "text-copy";
    }
  | { kind: "unchecked"; format: string; reason: string };
export type FileReadLike =
  | { kind: "text"; format: string; text: string; encoding: string; bom: boolean; checkedBytes: number; partial: boolean }
  | { kind: "document"; format: "pdf" | "office" | "archive" }
  | { kind: "unchecked"; format: string; reason: string };
export interface RangeLike {
  start: number;
  end: number;
  replacement: string;
}

/** What one ref offers the document bench, loaded from its bundle. */
export interface DocReaderApi {
  modules: string[];
  /** `readFileForCheck`, or a plain UTF-8 read for refs without it. */
  readFile(file: File): Promise<FileReadLike>;
  /** `readDocument` with PDFium loaded from the ref's package; undefined when the ref has no document reader. */
  readDocument?: (bytes: Uint8Array, name: string, format: "pdf" | "office" | "archive") => Promise<DocResultLike>;
  /** `redactDocument` (PDFs and archives). */
  redactDocument?: (bytes: Uint8Array, name: string, read: Extract<DocResultLike, { kind: "document" }>, ranges: RangeLike[]) => Promise<{ name: string; type: string; bytes: Uint8Array }>;
  /** `textCopy` (Office files' redacted copy). */
  textCopy?: (text: string, segments: DocSegmentLike[], ranges: RangeLike[]) => string;
  /** `redactPrompt`: a text file's redacted text. */
  redactText?: (text: string, ranges: RangeLike[]) => string;
  /** `redactedFile`'s encoding of a text file (`encodeText`). */
  encodeText?: (text: string, encoding: string, bom: boolean) => Uint8Array;
  /** `detectSensitiveData` with the given configuration name. */
  detect(text: string, config: "default" | "all"): RawDetection[];
  configs: Record<"default" | "all", Record<string, unknown>>;
  refCategories: string[];
  /** The Private AI size threshold for files (`DEFAULT_CONFIG.localAi.fileReviewLimit`) and the offered values. */
  fileReviewLimit?: number;
  fileReviewLimits?: number[];
  /** Caps the ref applies, for the report. */
  limits: Record<string, unknown>;
}

type Bundle = {
  detector: { detectSensitiveData: (text: string, config: unknown) => RawDetection[] };
  config: {
    DEFAULT_CONFIG: Record<string, unknown>;
    CATEGORIES?: string[];
    FILE_REVIEW_LIMITS?: readonly number[];
  };
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
  redaction?: { redactPrompt: (text: string, detections: Array<RangeLike & { selected: boolean }>) => string };
  documentModel?: {
    textCopy: (text: string, segments: DocSegmentLike[], ranges: RangeLike[]) => string;
    DOCUMENT_TEXT_LIMIT?: number;
  };
};

/** Loads a materialized bundle; PDFium is initialised once, on first use, from the ref's own wasm. */
export async function loadDocReader(ref: DocReaderRef): Promise<DocReaderApi> {
  const mod = (await import(pathToFileURL(ref.bundle).href)) as Bundle;
  const base = mod.config.DEFAULT_CONFIG;
  const baseCategories = (base.categories ?? {}) as Record<string, boolean>;
  const refCategories = mod.config.CATEGORIES ?? Object.keys(baseCategories);
  const all = structuredClone(base);
  all.categories = Object.fromEntries(refCategories.map((c) => [c, true]));
  const configs = { default: structuredClone(base), all };
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
  return {
    modules: ref.modules,
    readFile: mod.fileCheck
      ? (file) => mod.fileCheck!.readFileForCheck(file)
      : async (file) => {
          const text = new TextDecoder("utf-8").decode(new Uint8Array(await file.arrayBuffer()));
          return { kind: "text", format: "text", text, encoding: "utf-8", bom: false, checkedBytes: file.size, partial: false };
        },
    ...(reader
      ? {
          readDocument: (bytes, name, format) => reader.readDocument(bytes, name, format, env),
          redactDocument: (bytes, name, read, ranges) => reader.redactDocument(bytes, name, read, ranges, { mark: false }, env),
        }
      : {}),
    ...(mod.documentModel ? { textCopy: (text, segments, ranges) => mod.documentModel!.textCopy(text, segments, ranges) } : {}),
    ...(mod.redaction ? { redactText: (text, ranges) => mod.redaction!.redactPrompt(text, ranges.map((r) => ({ ...r, selected: true }))) } : {}),
    ...(mod.fileCheck ? { encodeText: (text, encoding, bom) => mod.fileCheck!.encodeText(text, encoding, bom) } : {}),
    detect: (text, name) => mod.detector.detectSensitiveData(text, configs[name]),
    configs,
    refCategories,
    ...(typeof (base.localAi as { fileReviewLimit?: unknown } | undefined)?.fileReviewLimit === "number"
      ? { fileReviewLimit: (base.localAi as { fileReviewLimit: number }).fileReviewLimit }
      : {}),
    ...(mod.config.FILE_REVIEW_LIMITS ? { fileReviewLimits: [...mod.config.FILE_REVIEW_LIMITS] } : {}),
    limits: {
      ...(mod.fileCheck?.FILE_MAX_BYTES ? { fileMaxBytes: mod.fileCheck.FILE_MAX_BYTES } : {}),
      ...(mod.fileCheck?.FILE_SCAN_BYTES ? { fileScanBytes: mod.fileCheck.FILE_SCAN_BYTES } : {}),
      ...(mod.documentModel?.DOCUMENT_TEXT_LIMIT ? { documentTextLimit: mod.documentModel.DOCUMENT_TEXT_LIMIT } : {}),
    },
  };
}
