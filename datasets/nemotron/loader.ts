/**
 * Nemotron-PII (NVIDIA, 2025): synthetic, persona-grounded English records
 * (US and international locales) with character spans for 55 PII/PHI types.
 * The test file holds 100,000 records (96 M characters), so a default run
 * scores a pinned, seeded sample of 3,000 (`--limit 0` for all).
 *
 * Its 55 labels are in contract.json; how a module's output answers them is
 * the module's dataset adapter
 * (`modules/<module>/dataset-adapters/nemotron.json`).
 */
import { join } from "node:path";
import type { DatasetLoader, GoldCase } from "../../engine/dataset.ts";
import { readParquet } from "../../engine/parquet.ts";
import manifest from "./manifest.json" with { type: "json" };

const REVISION = manifest.source.revision;
const FILE = {
  name: "test.parquet",
  url: `https://huggingface.co/datasets/nvidia/Nemotron-PII/resolve/${REVISION}/data/test-00000-of-00001.parquet`,
  sha256: "1a4b0512ecb5370f0992d29d0f9c07351e6de13f0d7ea33bb18cecb984780247",
  bytes: 150968398,
};

/** `[{'start': 0, 'end': 5, 'text': '...', 'label': 'first_name'}, ...]` (a Python literal). */
const SPAN =
  /'start': (\d+), 'end': (\d+), 'text': .*?, 'label': '([a-z_0-9]+)'\}/gs;

/**
 * NVIDIA's Nemotron-PII dataset; its split is large, so a default run scores a
 * pinned, seeded sample (`defaultLimit`).
 */
export default {
  defaultLimit: 3000,
  files: (split) => {
    if (split !== "test")
      throw new Error("nemotron-pii: only the test split is wired (test)");
    return [FILE];
  },
  async load(dir) {
    const rows = await readParquet(join(dir, FILE.name), [
      "uid",
      "locale",
      "text",
      "spans",
    ]);
    return rows.map((r): GoldCase => ({
      id: `${String(r.locale)}-${String(r.uid)}`,
      text: String(r.text),
      language: "en",
      gold: [...String(r.spans).matchAll(SPAN)].map((m) => ({
        start: Number(m[1]),
        end: Number(m[2]),
        label: m[3]!,
      })),
    }));
  },
} satisfies DatasetLoader;
