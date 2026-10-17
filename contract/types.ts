/**
 * Redaction contract v1: what a redaction module takes and returns, so a
 * harness can score any implementation (the extension's module at a git
 * ref, a baseline such as Presidio, a third party's module) the same way.
 *
 * The harness never reaches past these types. A module states the contract
 * version it implements (`RedactionModule.contract`); a harness accepts a
 * module whose major version equals its own (`isCompatibleContract`). Any
 * change a harness or module could misread is a major bump; new optional
 * fields are a minor bump. The JSON form of every type is
 * `contract/redaction-contract.schema.json`, and `contract/conformance.ts`
 * checks a module against both.
 */

/** Semver of this contract. */
export const CONTRACT_VERSION = "1.0.0";

/**
 * Built-in labels: what a rules engine finds without configuration. A module
 * declares the ones it supports (`ModuleCapabilities.builtins`); a benchmark
 * adapter maps its own labels onto these or onto custom labels.
 */
export const BUILTIN_LABELS = [
  "SECRET",
  "FINANCIAL",
  "NATIONAL_ID",
  "DATE_OF_BIRTH",
  "PHONE",
  "EMAIL",
  "ADDRESS",
  "IP",
  "COMPANY_ID",
] as const;
export type BuiltinLabel = (typeof BUILTIN_LABELS)[number];

// ------------------------------------------------------------------ input

export type RedactionInput =
  | {
      kind: "text";
      text: string;
      /** A hint only (BCP 47 primary tag, e.g. `en`, `fr`); modules may guess themselves. */
      language?: string;
    }
  | {
      kind: "document";
      /** The file name as attached, extension included: modules may classify by it. */
      name: string;
      bytes: Uint8Array;
    };

/** A label the user defines and Private AI looks for (zero-shot: a name, a description, up to a few examples). */
export interface CustomLabel {
  label: string;
  description: string;
  examples: string[];
}

export interface ModuleConfig {
  /** Built-in labels on (`true`), found but not redacted by default (`false`), or absent (the module's default). */
  builtins: Partial<Record<BuiltinLabel, boolean>>;
  /** ISO 3166-1 alpha-2 codes of the countries whose postal addresses are looked for; empty = the module's default. */
  addressCountries: string[];
  customLabels: CustomLabel[];
  privateAi: {
    /** Where custom labels are reviewed: nowhere, on this device, or on a connected (remote, possibly paid) model. */
    runsOn: "off" | "device" | "connected";
    /** The module's model id; absent = the module's default for `runsOn`. */
    model?: string;
    backend?: "wasm" | "webgpu";
  };
  /** Reading text in images and scanned pages. */
  ocr: { enabled: boolean; languages: string[] };
  /** Module-specific caps (characters, pages, bytes...), by name. */
  limits?: Record<string, number>;
}

// ------------------------------------------------------------------ output

export type SpanSource =
  /** A deterministic rule (regex, checksum, validator, dictionary). */
  | "rules"
  /** A language model's answer. */
  | "model"
  /** A pattern derived from a custom label's examples. */
  | "pattern"
  /** A literal the module learned from the user's earlier reviews. */
  | "learned";

export interface Span {
  /** UTF-16 offsets into `RedactionOutput.text`, `start < end`. */
  start: number;
  end: number;
  /** A `BuiltinLabel` when `kind` is `builtin`, else a configured custom label. */
  label: string;
  kind: "builtin" | "custom";
  /** Finer type inside the label (the rule that fired: `iban`, `card`, `fr-nir`...), so adapters can split a label without guessing. */
  subtype?: string;
  source: SpanSource;
  /** Whether the module's redaction covers this span (a built-in label switched off is found but not redacted). */
  redacted: boolean;
  /** 0..1 when the module has a calibrated score. */
  confidence?: number;
  /** Documents: 1-based page, and the box on it in PDF points `[x0, y0, x1, y1]`, when known. */
  page?: number;
  box?: [number, number, number, number];
}

/** Where a range of `text` came from in a document (a page, a sheet, a footnote, a zip entry...). */
export interface TextPart {
  start: number;
  end: number;
  where: string;
  page?: number;
}

export interface RedactedFile {
  name: string;
  /** Media type. */
  type: string;
  bytes: Uint8Array;
}

export interface Redaction {
  /** Text input: the text with every redacted span replaced. */
  text?: string;
  /** Document input: the file to send instead of the original, when anything was redacted. */
  file?: RedactedFile;
  /**
   * How a document was redacted: in place (the same format), as a text copy
   * (by design for the format, or as a fallback when in-place redaction was
   * unsafe), not at all (nothing to redact), or failed.
   */
  mode: "in_place" | "text_copy" | "fallback_text_copy" | "none" | "error";
  /** The module re-read its own output and found no redacted value left. */
  leakChecked: boolean;
  /** Spans the module could not redact in place (they forced a fallback). */
  unredactable?: Array<{ start: number; end: number }>;
  error?: string;
}

export interface Coverage {
  /** `full`: every part read; `partial`: some parts or text past a cap skipped; `none`: not checked. */
  checked: "full" | "partial" | "none";
  /** Why a file was not (or only partly) checked: `encrypted`, `scanned`, `unsupported`, `too_large`, `failed`... */
  reason?: string;
  /** Parts skipped, in the module's words. */
  gaps: string[];
  /** The format the module read the input as (`text`, `pdf`, `office`, `archive`, `image`...). */
  format?: string;
  pages?: number;
  /** Pages or images read with OCR. */
  ocrPages: number;
  /** A digitally signed document (redacting it breaks the signature). */
  signed?: boolean;
  /** The module's own words on what happened (an error message, a cap), for diagnosis. */
  detail?: string;
}

export type Stage = "read" | "ocr" | "rules" | "model" | "redact" | "verify";

export interface StageTiming {
  stage: Stage;
  ms: number;
  pages?: number;
  /** Model stage: requests sent (one per label and chunk for the extension). */
  requests?: number;
}

/** The machine a run's absolute speed and memory were measured on: compare those numbers only within one profile. */
export interface MachineProfile {
  /** A stable name for a declared reference machine, or `adhoc` for anything else. */
  id: string;
  cpu: string;
  cores: number;
  ramMb: number;
  os: string;
  node?: string;
  python?: string;
  chrome?: string;
  powerMode?: string;
}

/** One model request, for diagnosis (format compliance, timeouts, cost). */
export interface ModelRequestTrace {
  label?: string;
  ms: number;
  promptTokens?: number;
  outputTokens?: number;
  finishReason?: string;
  /** The model's raw answer, before the module's parsing. */
  output?: string;
  /** The answer confidence the module filtered on, when any. */
  confidence?: number;
  cached?: boolean;
}

export interface RuntimeReport {
  stages: StageTiming[];
  /** Total wall time of the call. */
  totalMs: number;
  /** Peak resident memory of the process running the module, during the call when the platform can reset the peak, else since start. */
  peakRssMb?: number;
  /** Characters of text checked per second (`text.length / totalMs`). */
  charsPerSecond?: number;
  pagesPerMinute?: number;
  backend?: {
    name: "wasm" | "webgpu" | "native" | "python" | "api";
    threads?: number;
    dtype?: string;
  };
  model?: {
    id: string;
    /** Weights on disk / downloaded. */
    bytes?: number;
    /** `true` when this call loaded the model (its load time is in the `model` stage). */
    cold: boolean;
    loadMs?: number;
    /** Time spent preparing reusable prompt prefixes for this configuration (once per configuration, included in the `model` stage when this call did it). */
    prepareMs?: number;
  };
  /** Set for paths that leave the device; `connected` is always true then. */
  cost?: { usd: number; provider: string; connected: true };
  requests?: ModelRequestTrace[];
  machine?: MachineProfile;
}

export interface RedactionOutput {
  /** The contract version the module implements. */
  contract: string;
  module: ModuleInfo;
  /** The text the module checked: the input text, or what it extracted from the document. */
  text: string;
  /** Documents: where each range of `text` came from. */
  parts?: TextPart[];
  spans: Span[];
  redaction: Redaction;
  coverage: Coverage;
  runtime: RuntimeReport;
}

// ------------------------------------------------------------------ module

export interface ModuleInfo {
  name: string;
  version: string;
  /** The source revision, when the module is built from one (a git sha). */
  sha?: string;
}

export interface ModuleCapabilities {
  builtins: BuiltinLabel[];
  customLabels: boolean;
  documents: boolean;
  ocr: boolean;
  privateAi: Array<"device" | "connected">;
  /** Countries whose postal addresses the module can look for (ISO alpha-2), when it declares them. */
  addressCountries?: string[];
  /** The models Private AI can run, and the one a new user gets (`default`). */
  models?: Array<{
    id: string;
    runsOn: "device" | "connected";
    default?: boolean;
    bytes?: number;
  }>;
}

/** What a harness drives. One call checks one input with one configuration; calls may be repeated on one instance (warm). */
export interface RedactionModule {
  contract: string;
  info: ModuleInfo;
  capabilities: ModuleCapabilities;
  /** The configuration a new user gets. */
  defaultConfig(): ModuleConfig;
  redact(input: RedactionInput, config: ModuleConfig): Promise<RedactionOutput>;
  /**
   * Optional warm-up for a configuration (load a model, prepare prompt
   * prefixes), so later `redact` calls measure warm latency. Reports what it
   * spent.
   */
  prepare?(config: ModuleConfig): Promise<PrepareReport>;
  dispose?(): Promise<void>;
}

export interface PrepareReport {
  loadMs?: number;
  prepareMs?: number;
  backend?: RuntimeReport["backend"];
}

/** A harness at `harness` accepts a module implementing `module` when the major versions match. */
export function isCompatibleContract(
  module: string,
  harness: string = CONTRACT_VERSION,
): boolean {
  const major = (v: string) => /^(\d+)\.\d+\.\d+$/.exec(v)?.[1];
  return major(module) !== undefined && major(module) === major(harness);
}
