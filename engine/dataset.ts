/**
 * What a dataset folder declares and exports:
 *
 * - `datasets/<id>/manifest.json`: where it comes from (source, pinned
 *   revision, licence, citation);
 * - `datasets/<id>/contract.json`: the output it expects, i.e. the labels it
 *   scores (each with one line of meaning), its input kind and its scorer. It
 *   says nothing about any module: each module maps its own output onto these
 *   labels in `modules/<module>/dataset-adapters/<id>.json` (`adapter.ts`);
 * - `datasets/<id>/loader.ts` (published datasets): its pinned files and how
 *   to read them into cases whose gold spans carry the dataset's own labels.
 */
import type { BuiltinLabel } from "../contract/types.ts";

/**
 * Where a gold label lands for one module, as the literature scorer reads it.
 * `builtin` lists the contract labels a correct typed prediction may carry:
 * one for a finer dataset label mapped down (Gretel `iban` → FINANCIAL),
 * several for a coarser one mapped up (TAB `CODE` ← PHONE, NATIONAL_ID,
 * FINANCIAL...). `custom` is a custom label (Private AI territory);
 * `out_of_scope` is a label the module cannot produce (its adapter lists it
 * under `missing`): it is reported in its own row and in the dataset-native
 * total, never in the headline.
 */
export type LabelTarget =
  | { builtin: BuiltinLabel[]; subtype?: string }
  | { custom: string }
  | "out_of_scope";

/** A dataset annotation: UTF-16 offsets into `GoldCase.text`. */
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

/** One dataset document and its annotations, in the harness's common form. */
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

/**
 * A pinned dataset file: a download whose SHA-256 differs is deleted and
 * stops the run; `bytes` is for the progress line.
 */
export interface DatasetFile {
  /** File name in the cache directory. */
  name: string;
  url: string;
  sha256: string;
  bytes: number;
}

/** `datasets/<id>/manifest.json`. */
export interface DatasetManifest {
  /** The folder name. */
  id: string;
  /**
   * The id cached outputs, seeded samples and run files use. It predates the
   * folder name for published datasets (`gretel-pii-finance-multilingual`):
   * never change it, or every cached output reruns.
   */
  resultsId?: string;
  title: string;
  /** `ours`: written or generated in this repository; `published`: a pinned download. */
  origin: "ours" | "published";
  source: { url?: string; revision?: string; note?: string };
  licence: {
    spdx: string;
    url?: string;
    note: string;
    /** Whether a commercial project may publish results on it (checked on the card at the pinned revision). */
    commercialResults: boolean;
  };
  citation?: string;
  languages: string[];
  size: string;
  /** A listed dataset that is not wired, and why (a licence decision, for example). */
  blocked?: string;
}

/** `datasets/<id>/contract.json`: the output a dataset expects. */
export interface DatasetContract {
  dataset: string;
  /** Semver; a new label is a minor bump, a changed meaning a major one. */
  version: string;
  input: "text" | "document";
  /** Which engine scorer reads it (`engine/scorers/<scorer>/`). */
  scorer: "custom-passages" | "builtin-spans" | "documents" | "literature";
  /** The labels it scores, with one line of meaning each; `per-case`: custom labels that come with each case. */
  labels: Record<string, string> | "per-case";
  /** Custom labels some cases also carry (insusty-documents' Private AI suite). */
  customLabels?: "per-case";
  splits: string[];
  defaultSplit?: string;
  /** Named sizes a run can pick (`smoke`, `quick`, `full`...): cases, 0 = all. */
  tiers?: Record<string, number>;
}

/** What `datasets/<id>/loader.ts` exports as default (published datasets). */
export interface DatasetLoader {
  /** Files per split, pinned by hash. */
  files(split: string): DatasetFile[];
  /** Reads a split from the downloaded files. */
  load(dir: string, split: string): Promise<GoldCase[]>;
  /** Extra dataset-native metrics (TAB's entity-level recall), next to the common ones. */
  native?(
    cases: GoldCase[],
    masked: Map<string, Array<{ start: number; end: number }>>,
    labelMap: Record<string, LabelTarget>,
  ): Record<string, number | null>;
  /** How many cases a default run scores (a pinned, seeded sample of a large split); 0 = all. */
  defaultLimit?: number;
}

/**
 * A published dataset as the literature runner uses it: its manifest and
 * contract facts plus its loader.
 */
export interface LiteratureDataset extends DatasetLoader {
  /** `DatasetManifest.resultsId`, else the folder name. */
  id: string;
  /** The folder name. */
  folder: string;
  title: string;
  /** The pinned upstream revision (git commit). */
  revision: string;
  license: { spdx: string; url: string; note: string };
  homepage: string;
  citation: string;
  languages: string[];
  splits: string[];
  defaultSplit: string;
}
