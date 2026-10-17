/**
 * Benchmark adapters: a published dataset, its pinned files, and how its
 * labels map onto the redaction contract's labels. Adapters sit on the
 * contract only, so any contract implementation (the extension's module,
 * Presidio, a third party's) is scored the same way.
 *
 * A gold label maps to a built-in label (possibly many-to-one, with a
 * subtype), to a custom label (Private AI territory), or `out_of_scope`:
 * a type the module has no rule for. Out-of-scope gold is reported in its
 * own row and in the benchmark-native total, never in the headline.
 */
import type {
  BuiltinLabel,
  ModuleConfig,
  RedactionModule,
} from "../../contract/types.ts";

/**
 * Where a gold label lands. `builtin` lists the contract labels a correct
 * typed prediction may carry: one for a finer benchmark label mapped down
 * (Gretel `iban` → FINANCIAL), several for a coarser one mapped up (TAB
 * `CODE` ← PHONE, NATIONAL_ID, FINANCIAL...).
 */
export type LabelTarget =
  | { builtin: BuiltinLabel[]; subtype?: string }
  | { custom: string }
  | "out_of_scope";

export interface GoldSpan {
  start: number;
  end: number;
  /** The dataset's own label. */
  label: string;
  /** Co-reference: mentions of one entity share it (TAB). */
  entity?: string;
  /** Which annotator marked it (TAB has several per document). */
  annotator?: string;
  /** TAB's masking decision: only DIRECT and QUASI mentions must be masked. */
  identifier?: "DIRECT" | "QUASI" | "NO_MASK";
}

export interface GoldCase {
  id: string;
  text: string;
  language: string;
  /** Spans that must be masked (TAB: DIRECT and QUASI only). */
  gold: GoldSpan[];
  /** Spans annotated as safe to keep (TAB's NO_MASK); a prediction there is over-masking, not a miss. */
  keep?: GoldSpan[];
  annotators?: string[];
}

export interface DatasetFile {
  /** File name in the cache directory. */
  name: string;
  url: string;
  sha256: string;
  bytes: number;
}

export interface BenchmarkAdapter {
  id: string;
  title: string;
  /** The pinned upstream revision (git commit). */
  revision: string;
  license: { spdx: string; url: string; note: string };
  homepage: string;
  citation: string;
  languages: string[];
  splits: string[];
  defaultSplit: string;
  /** Files per split, pinned by hash. */
  files(split: string): DatasetFile[];
  /** Reads a split from the downloaded files. */
  load(dir: string, split: string): Promise<GoldCase[]>;
  labelMap: Record<string, LabelTarget>;
  /** The module configurations the benchmark is scored with, by name; `default` is the module's own. */
  configs(module: RedactionModule): Record<string, ModuleConfig>;
  /** Extra benchmark-native metrics (TAB's entity-level recall), next to the common ones. */
  native?(
    cases: GoldCase[],
    masked: Map<string, Array<{ start: number; end: number }>>,
    labelMap: Record<string, LabelTarget>,
  ): Record<string, number | null>;
  /** How many cases a default run scores (a pinned, seeded sample of a large split); 0 = all. */
  defaultLimit?: number;
}
