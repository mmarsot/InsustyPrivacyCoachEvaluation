/** Loads, validates and renders the deterministic-redaction dataset (`dataset/detbench/`). */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATASET_DIR } from "../paths.ts";
import { KIND_VALIDATORS } from "./checksums.ts";
import {
  DECOY_KINDS,
  DET_CATEGORIES,
  ITEM_KINDS,
  REGISTERS,
  type DecoySpan,
  type DetCase,
  type DetCaseSource,
  type DetCaseType,
  type GoldSpan,
  type Part,
} from "./schema.ts";

export const DETBENCH_DIR = join(DATASET_DIR, "detbench");
export const DETBENCH_LANGS = ["en", "fr"] as const;

const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g;

/** Splits a template into literal text and placeholder parts. */
export function parseTemplate(source: Pick<DetCaseSource, "template" | "items" | "decoys">): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of source.template.matchAll(PLACEHOLDER)) {
    const index = m.index ?? 0;
    if (index > last) parts.push({ t: "text", s: source.template.slice(last, index) });
    const key = m[1]!;
    const item = source.items?.[key];
    const decoy = source.decoys?.[key];
    if (item) parts.push({ t: "item", key, s: item.value });
    else if (decoy) parts.push({ t: "decoy", key, s: decoy.value });
    else throw new Error(`unknown placeholder {{${key}}}`);
    last = index + m[0].length;
  }
  if (last < source.template.length) parts.push({ t: "text", s: source.template.slice(last) });
  return parts;
}

/** Concatenates parts into the prompt text and the exact item and decoy spans. */
export function renderParts(
  parts: Part[],
  items: DetCase["items"],
  decoys: DetCase["decoys"],
): { text: string; gold: GoldSpan[]; decoySpans: DecoySpan[] } {
  let text = "";
  const gold: GoldSpan[] = [];
  const decoySpans: DecoySpan[] = [];
  for (const part of parts) {
    const start = text.length;
    text += part.s;
    if (part.t === "item") {
      const item = items[part.key]!;
      gold.push({ key: part.key, category: item.category, kind: item.kind, start, end: text.length, value: part.s });
    } else if (part.t === "decoy") {
      decoySpans.push({ key: part.key, kind: decoys[part.key]!.kind, start, end: text.length, value: part.s });
    }
  }
  return { text, gold, decoySpans };
}

export function caseType(items: DetCase["items"]): DetCaseType {
  const categories = new Set(Object.values(items).map((i) => i.category));
  return categories.size === 0 ? "negative" : categories.size === 1 ? "single" : "multi";
}

/** Builds a rendered case from parts (used for base cases and perturbed variants). */
export function buildCase(
  base: Omit<DetCase, "parts" | "text" | "gold" | "decoySpans" | "type">,
  parts: Part[],
): DetCase {
  return { ...base, type: caseType(base.items), parts, ...renderParts(parts, base.items, base.decoys) };
}

/** Schema and ground-truth checks for one source line. */
export function validateSource(source: DetCaseSource, lang: string): string[] {
  const issues: string[] = [];
  const where = source.id ?? "(no id)";
  if (!/^(en|fr)-\d{3}$/.test(source.id ?? "")) issues.push(`${where}: id must be <lang>-<nnn>`);
  if (source.lang !== lang) issues.push(`${where}: lang ${source.lang} in the ${lang} file`);
  if (!(REGISTERS as readonly string[]).includes(source.register)) issues.push(`${where}: unknown register ${source.register}`);
  if (typeof source.template !== "string" || !source.template.trim()) issues.push(`${where}: empty template`);
  const used = new Set([...String(source.template).matchAll(PLACEHOLDER)].map((m) => m[1]!));
  const itemKeys = Object.keys(source.items ?? {});
  const decoyKeys = Object.keys(source.decoys ?? {});
  for (const key of used) if (!itemKeys.includes(key) && !decoyKeys.includes(key)) issues.push(`${where}: {{${key}}} is not defined`);
  for (const key of [...itemKeys, ...decoyKeys]) if (!used.has(key)) issues.push(`${where}: ${key} is defined but unused`);
  for (const key of itemKeys) if (decoyKeys.includes(key)) issues.push(`${where}: ${key} is both an item and a decoy`);
  if (/\{\{|\}\}/.test(String(source.template).replace(PLACEHOLDER, ""))) issues.push(`${where}: malformed placeholder`);
  for (const [key, item] of Object.entries(source.items ?? {})) {
    if (!(DET_CATEGORIES as readonly string[]).includes(item.category)) {
      issues.push(`${where}: ${key} has unknown category ${item.category}`);
      continue;
    }
    if (!ITEM_KINDS[item.category].includes(item.kind)) issues.push(`${where}: ${key} kind ${item.kind} is not a ${item.category} kind`);
    if (!item.value || item.value !== item.value.trim()) issues.push(`${where}: ${key} value is empty or padded`);
    const validate = KIND_VALIDATORS[item.kind];
    if (validate && !validate(item.value)) issues.push(`${where}: ${key} ${item.kind} "${item.value}" fails its checksum`);
    if (item.kind === "dob") {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.iso ?? "");
      if (!m) issues.push(`${where}: ${key} dob needs iso YYYY-MM-DD`);
      else if (!item.value.includes(m[1]!)) issues.push(`${where}: ${key} dob value does not contain the iso year`);
    }
  }
  for (const [key, decoy] of Object.entries(source.decoys ?? {})) {
    if (!(DECOY_KINDS as readonly string[]).includes(decoy.kind)) issues.push(`${where}: decoy ${key} has unknown kind ${decoy.kind}`);
    if (!decoy.value) issues.push(`${where}: decoy ${key} is empty`);
  }
  return issues;
}

export interface DetDataset {
  cases: DetCase[];
  /** sha256 of the dataset files, for run metadata. */
  hash: string;
}

/** Reads and validates every `dataset/detbench/<lang>.jsonl` file. */
export function loadDetDataset(dir = DETBENCH_DIR): { dataset?: DetDataset; issues: string[] } {
  const issues: string[] = [];
  const cases: DetCase[] = [];
  const hash = createHash("sha256");
  const ids = new Set<string>();
  for (const lang of DETBENCH_LANGS) {
    const file = join(dir, `${lang}.jsonl`);
    if (!existsSync(file)) {
      issues.push(`missing ${file}`);
      continue;
    }
    const raw = readFileSync(file, "utf8");
    hash.update(raw);
    raw.split("\n").forEach((line, index) => {
      if (!line.trim()) return;
      let source: DetCaseSource;
      try {
        source = JSON.parse(line) as DetCaseSource;
      } catch (error) {
        issues.push(`${lang}.jsonl:${index + 1}: ${(error as Error).message}`);
        return;
      }
      const found = validateSource(source, lang);
      if (ids.has(source.id)) found.push(`${source.id}: duplicate id`);
      ids.add(source.id);
      if (found.length) {
        issues.push(...found);
        return;
      }
      const items = source.items ?? {};
      const decoys = source.decoys ?? {};
      cases.push(
        buildCase(
          { id: source.id, baseId: source.id, lang: source.lang, register: source.register, tags: source.tags ?? [], perturbation: "none", items, decoys },
          parseTemplate(source),
        ),
      );
    });
  }
  return { dataset: issues.length ? undefined : { cases, hash: hash.digest("hex") }, issues };
}
