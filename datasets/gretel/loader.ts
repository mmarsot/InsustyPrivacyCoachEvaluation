/**
 * Gretel synthetic PII finance multilingual (Gretel.ai, 2024): synthetic
 * financial documents with character spans for 29 PII types, the bench's
 * French source next to English. Scored on the English and French test
 * files (3,334 documents).
 *
 * Its 29 labels are in contract.json; how a module's output answers them is
 * the module's dataset adapter (`modules/<module>/dataset-adapters/gretel.json`).
 */
import { join } from "node:path";
import type { DatasetLoader, GoldCase } from "../../engine/dataset.ts";
import { readParquet } from "../../engine/parquet.ts";
import manifest from "./manifest.json" with { type: "json" };

const REVISION = manifest.source.revision;
const BASE = `https://huggingface.co/datasets/gretelai/synthetic_pii_finance_multilingual/resolve/${REVISION}/data`;
const TEST = [
  {
    lang: "en",
    name: "English_test.parquet",
    remote: "English_test-00000-of-00001.parquet",
    sha256: "c02b06d3c5b7c375525136d6f74acc52ab8fc07fa863d0aa50734910ec0ef2ad",
    bytes: 2720729,
  },
  {
    lang: "fr",
    name: "France_test.parquet",
    remote: "France_test-00000-of-00001.parquet",
    sha256: "39fc2777822bbecab2d89bb23cbed40d9825ff4117897b8b025c02287f4ba845",
    bytes: 397822,
  },
];

/**
 * Gretel's synthetic finance PII dataset, English and French documents of its
 * test split.
 */
export default {
  files: (split) => {
    if (split !== "test")
      throw new Error("gretel: only the test split is wired (test)");
    return TEST.map((f) => ({
      name: f.name,
      url: `${BASE}/${f.remote}`,
      sha256: f.sha256,
      bytes: f.bytes,
    }));
  },
  async load(dir) {
    const out: GoldCase[] = [];
    for (const f of TEST) {
      const rows = await readParquet(join(dir, f.name), [
        "generated_text",
        "pii_spans",
      ]);
      rows.forEach((r, i) => {
        const spans = JSON.parse(String(r.pii_spans)) as Array<{
          start: number;
          end: number;
          label: string;
        }>;
        out.push({
          id: `${f.lang}-${i}`,
          text: String(r.generated_text),
          language: f.lang,
          gold: spans.map((s) => ({
            start: s.start,
            end: s.end,
            label: s.label,
          })),
        });
      });
    }
    return out;
  },
} satisfies DatasetLoader;
