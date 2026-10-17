/**
 * TAB, the Text Anonymization Benchmark (Pilán et al., Computational
 * Linguistics 48(4), 2022): 1,268 English ECHR judgements, mentions marked
 * DIRECT, QUASI or NO_MASK by one or more annotators, grouped into entities.
 *
 * Only DIRECT and QUASI mentions must be masked. The product's built-ins
 * cover TAB's `CODE` (case numbers, phone, passport, account numbers...):
 * any identifier label counts as a typed hit there. PERSON and ORG are
 * custom-label territory (Private AI); DATETIME, LOC, DEM, QUANTITY and MISC
 * have no rule. All of those are reported outside the headline, with TAB's
 * native totals. `native` adds TAB's entity-level recall (ER_di, ER_qi: an
 * entity counts only when every one of its mentions is masked), micro-averaged
 * over annotators as the paper defines it.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { deterministicConfigs } from "./configs.ts";
import type { BenchmarkAdapter, GoldCase, GoldSpan, LabelTarget } from "./types.ts";

const REVISION = "558e09e26d6b36f5f78440074e6a233946d98bd9";
const RAW = `https://raw.githubusercontent.com/NorskRegnesentral/text-anonymization-benchmark/${REVISION}`;
const FILES: Record<string, { name: string; sha256: string; bytes: number }> = {
  dev: { name: "echr_dev.json", sha256: "8c3c7306f46b8d54debeb38ae11d8b0b8bcf4bdccbc3b6f13c12ad7be16893ec", bytes: 12643092 },
  test: { name: "echr_test.json", sha256: "cd0f0f15f84a8739654c7cf30c6be8ce27b051ef73974d39d792a0cb8c846379", bytes: 13103290 },
};

interface TabDoc {
  doc_id: string;
  text: string;
  annotations: Record<string, { entity_mentions: Array<{ entity_type: string; start_offset: number; end_offset: number; identifier_type: "DIRECT" | "QUASI" | "NO_MASK"; entity_id: string }> }>;
}

const IDENTIFIERS = ["SECRET", "FINANCIAL", "NATIONAL_ID", "PHONE", "EMAIL", "IP", "COMPANY_ID"] as const;

const LABELS: Record<string, LabelTarget> = {
  CODE: { builtin: [...IDENTIFIERS] },
  PERSON: { custom: "Person names" },
  ORG: { custom: "Organisations" },
  DATETIME: "out_of_scope",
  LOC: "out_of_scope",
  DEM: "out_of_scope",
  QUANTITY: "out_of_scope",
  MISC: "out_of_scope",
};

/** Share of entities (per annotator) whose every mention is fully masked. */
function entityRecall(cases: GoldCase[], masked: Map<string, Array<{ start: number; end: number }>>, identifier: "DIRECT" | "QUASI", keep: (label: string) => boolean): number | null {
  let total = 0;
  let found = 0;
  for (const c of cases) {
    const cover = new Uint8Array(c.text.length);
    for (const m of masked.get(c.id) ?? []) cover.fill(1, m.start, m.end);
    const entities = new Map<string, GoldSpan[]>();
    for (const g of c.gold) if (g.identifier === identifier && keep(g.label)) entities.set(`${g.annotator}\u0000${g.entity}`, [...(entities.get(`${g.annotator}\u0000${g.entity}`) ?? []), g]);
    for (const mentions of entities.values()) {
      total++;
      // A mention is masked when every non-space character of it is.
      const masked = (g: GoldSpan) => {
        for (let i = g.start; i < g.end; i++) if (cover[i] !== 1 && !/\s/u.test(c.text[i]!)) return false;
        return true;
      };
      if (mentions.every(masked)) found++;
    }
  }
  return total ? found / total : null;
}

export const tab: BenchmarkAdapter = {
  id: "tab",
  title: "Text Anonymization Benchmark (TAB, ECHR)",
  revision: REVISION,
  license: { spdx: "MIT", url: `${RAW}/LICENSE.txt`, note: "MIT (LICENSE.txt in the repository): commercial use and publication of results allowed." },
  homepage: "https://github.com/NorskRegnesentral/text-anonymization-benchmark",
  citation: "Pilán, Lison, Øvrelid, Papadopoulou, Sánchez, Batet (2022). The Text Anonymization Benchmark (TAB). Computational Linguistics 48(4).",
  languages: ["en"],
  splits: ["dev", "test"],
  defaultSplit: "test",
  files: (split) => {
    const f = FILES[split];
    if (!f) throw new Error(`tab has no split ${split} (dev, test)`);
    return [{ ...f, url: `${RAW}/${f.name}` }];
  },
  async load(dir, split) {
    const docs = JSON.parse(readFileSync(join(dir, FILES[split]!.name), "utf8")) as TabDoc[];
    return docs.map((d) => {
      const gold: GoldSpan[] = [];
      const keep: GoldSpan[] = [];
      for (const [annotator, a] of Object.entries(d.annotations))
        for (const m of a.entity_mentions) {
          const span: GoldSpan = { start: m.start_offset, end: m.end_offset, label: m.entity_type, entity: m.entity_id, annotator, identifier: m.identifier_type };
          (m.identifier_type === "NO_MASK" ? keep : gold).push(span);
        }
      return { id: d.doc_id, text: d.text, language: "en", gold, keep, annotators: Object.keys(d.annotations) };
    });
  },
  labelMap: LABELS,
  configs: deterministicConfigs,
  native(cases, masked, labelMap) {
    const inScope = (label: string) => typeof labelMap[label] === "object" && "builtin" in (labelMap[label] as object);
    return {
      ER_di_in_scope: entityRecall(cases, masked, "DIRECT", inScope),
      ER_qi_in_scope: entityRecall(cases, masked, "QUASI", inScope),
      ER_di: entityRecall(cases, masked, "DIRECT", () => true),
      ER_qi: entityRecall(cases, masked, "QUASI", () => true),
    };
  },
};
