/**
 * One document through a redaction module, as docbench scores it: the
 * module's `redact()` on the file, once per configuration, read back into
 * the shapes the scorer uses. The outcome is what the extension would tell
 * the user: `checked`, `partial` (gaps, or text past a cap), or `unchecked`
 * with its reason (`error` when reading threw).
 */
import type {
  ModuleConfig,
  RedactionModule,
  RedactionOutput,
} from "../../contract/types.ts";

/** The module configurations docbench runs a document through. */
export type ConfigName = "default" | "all";

/**
 * Where a range of the extracted text came from (`TextPart` in the contract).
 */
export interface DocSegmentLike {
  start: number;
  end: number;
  where: string;
  page?: number;
}

/** A module's read of one file, as the scorer uses it. */
export interface PipelineRead {
  outcome: "checked" | "partial" | "unchecked" | "error";
  reason?: string;
  /** What the module read the file as: `text` (a text-like file), `pdf`, `office`, `archive`, `image`. */
  readAs?: string;
  text: string;
  segments: DocSegmentLike[];
  gaps: string[];
  signed: boolean;
  pages?: number;
  /** A text file read only in part (its first 2 MB). */
  partialText?: boolean;
  /** How the redacted version is made for this format: in place (text, PDF, archive) or as a text copy (Office). */
  redaction?: "text" | "pdf" | "archive" | "text-copy" | "image";
  readMs: number;
  error?: string;
}

/** The redacted output of one configuration. */
export interface PipelineRedaction {
  /** `in_place` (same file redacted), `text_copy` (Office: by design), `fallback_text_copy` (a PDF or archive the module could not redact safely). */
  mode: "in_place" | "text_copy" | "fallback_text_copy" | "none" | "error";
  name?: string;
  bytes?: Uint8Array;
  ms: number;
  error?: string;
  /** A PDF that fell back: the findings the module cannot redact in place, each tried alone. */
  failing?: Array<{ start: number; end: number; replacement: string }>;
}

/** One configuration's detections and redaction of a document. */
export interface ConfigRun {
  detections: Array<{
    category: string;
    start: number;
    end: number;
    value: string;
    selected: boolean;
  }>;
  /** The module's rules time. */
  ms: number;
  redaction: PipelineRedaction;
}

const METHOD: Record<string, PipelineRead["redaction"]> = {
  text: "text",
  pdf: "pdf",
  archive: "archive",
  office: "text-copy",
  image: "image",
};

/** The read half of an output. */
export function readOf(out: RedactionOutput): PipelineRead {
  const c = out.coverage;
  const outcome =
    c.checked === "full"
      ? "checked"
      : c.checked === "partial"
        ? "partial"
        : c.reason === "failed" && c.detail
          ? "error"
          : "unchecked";
  return {
    outcome,
    ...(c.reason && c.reason !== "text_cap" ? { reason: c.reason } : {}),
    ...(c.format ? { readAs: c.format } : {}),
    text: out.text,
    segments: (out.parts ?? []).map((p) => ({
      start: p.start,
      end: p.end,
      where: p.where,
      ...(p.page !== undefined ? { page: p.page } : {}),
    })),
    gaps: c.gaps,
    signed: c.signed ?? false,
    ...(c.pages !== undefined ? { pages: c.pages } : {}),
    ...(c.reason === "text_cap" ? { partialText: true } : {}),
    ...(outcome !== "unchecked" &&
    outcome !== "error" &&
    c.format &&
    METHOD[c.format]
      ? { redaction: METHOD[c.format] }
      : {}),
    readMs: out.runtime.stages.find((s) => s.stage === "read")?.ms ?? 0,
    ...(outcome === "error" && c.detail ? { error: c.detail } : {}),
  };
}

/** The detections and redacted version of an output. */
export function runOf(out: RedactionOutput): ConfigRun {
  const spans = out.spans.filter((s) => s.kind === "builtin");
  const r = out.redaction;
  const label = new Map(spans.map((s) => [`${s.start}:${s.end}`, s.label]));
  return {
    detections: spans.map((s) => ({
      category: s.label,
      start: s.start,
      end: s.end,
      value: out.text.slice(s.start, s.end),
      selected: s.redacted,
    })),
    ms: out.runtime.stages.find((s) => s.stage === "rules")?.ms ?? 0,
    redaction: {
      mode: r.mode,
      ...(r.file ? { name: r.file.name, bytes: r.file.bytes } : {}),
      ms: out.runtime.stages.find((s) => s.stage === "redact")?.ms ?? 0,
      ...(r.error ? { error: r.error } : {}),
      ...(r.unredactable
        ? {
            failing: r.unredactable.map((u) => ({
              ...u,
              replacement: `[${label.get(`${u.start}:${u.end}`) ?? "?"}]`,
            })),
          }
        : {}),
    },
  };
}

/** Checks a file with each configuration (Private AI off). */
export async function checkDocument(
  module: RedactionModule,
  configs: Record<ConfigName, ModuleConfig>,
  names: ConfigName[],
  name: string,
  bytes: Uint8Array,
) {
  const outputs: Partial<Record<ConfigName, RedactionOutput>> = {};
  for (const c of names)
    outputs[c] = await module.redact(
      { kind: "document", name, bytes },
      { ...configs[c], privateAi: { runsOn: "off" } },
    );
  return outputs;
}
