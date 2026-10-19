/** Loads, validates and renders the deterministic-redaction dataset (`datasets/insusty-builtin/cases/`). */
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { DATASETS_ROOT } from "../../engine/paths.ts";
import { KIND_VALIDATORS } from "./checksums.ts";
import { GENERATORS, generateText, MAX_GENERATED_ROWS } from "./generate.ts";
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
  type Zone,
} from "./schema.ts";

/** The detbench dataset: one `<lang>.jsonl` of case sources per language. */
export const DETBENCH_DIR = join(DATASETS_ROOT, "insusty-builtin", "cases");
/** Detbench languages, one dataset file each. */
export const DETBENCH_LANGS = ["en", "fr"] as const;

/** A `{{key}}` placeholder in a template; keys are lower-case snake case. */
const PLACEHOLDER = /\{\{([a-z0-9_]+)\}\}/g;

/** Splits a template into literal text and placeholder parts; a generated placeholder becomes literal text. */
export function parseTemplate(
  source: Pick<DetCaseSource, "template" | "items" | "decoys" | "generated">,
): Part[] {
  const parts: Part[] = [];
  let last = 0;
  for (const m of source.template.matchAll(PLACEHOLDER)) {
    const index = m.index ?? 0;
    if (index > last)
      parts.push({ t: "text", s: source.template.slice(last, index) });
    const key = m[1]!;
    const item = source.items?.[key];
    const decoy = source.decoys?.[key];
    const generated = source.generated?.[key];
    if (item) parts.push({ t: "item", key, s: item.value });
    else if (decoy) parts.push({ t: "decoy", key, s: decoy.value });
    else if (generated) parts.push({ t: "text", s: generateText(generated) });
    else throw new Error(`unknown placeholder {{${key}}}`);
    last = index + m[0].length;
  }
  if (last < source.template.length)
    parts.push({ t: "text", s: source.template.slice(last) });
  return parts;
}

/**
 * The [start, end) ranges of a text that are code, as Markdown reads them: a
 * block fenced by ``` or ~~~ (fence lines included; an unclosed fence runs to
 * the end), or lines indented by four spaces or a tab after a blank line or
 * another indented line. Inline `code` stays prose.
 */
export function codeRanges(text: string): Array<[number, number]> {
  const ranges: Array<[number, number]> = [];
  let offset = 0;
  let fence: { char: string; length: number; start: number } | null = null;
  let previous: "blank" | "indented" | "text" = "blank";
  for (const line of text.split("\n")) {
    const end = offset + line.length;
    const marker = /^ {0,3}(`{3,}|~{3,})/.exec(line);
    if (fence) {
      if (
        marker &&
        marker[1]![0] === fence.char &&
        marker[1]!.length >= fence.length &&
        !line.slice(marker[0].length).trim()
      ) {
        ranges.push([fence.start, end]);
        fence = null;
      }
    } else if (marker) {
      fence = {
        char: marker[1]![0]!,
        length: marker[1]!.length,
        start: offset,
      };
    } else if (!line.trim()) {
      previous = previous === "indented" ? "indented" : "blank";
    } else if (/^(?: {4}|\t)/.test(line) && previous !== "text") {
      ranges.push([offset, end]);
      previous = "indented";
    } else {
      previous = "text";
    }
    if (marker || fence) previous = "text";
    offset = end + 1;
  }
  if (fence) ranges.push([fence.start, text.length]);
  return ranges;
}

/** The zone of a text position, given the text's `codeRanges`. */
export const zoneAt = (ranges: Array<[number, number]>, at: number): Zone =>
  ranges.some(([s, e]) => s <= at && at < e) ? "code" : "prose";

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
      gold.push({
        key: part.key,
        category: item.category,
        kind: item.kind,
        start,
        end: text.length,
        value: part.s,
        zone: "prose",
      });
    } else if (part.t === "decoy") {
      decoySpans.push({
        key: part.key,
        kind: decoys[part.key]!.kind,
        start,
        end: text.length,
        value: part.s,
        zone: "prose",
      });
    }
  }
  const code = codeRanges(text);
  for (const span of [...gold, ...decoySpans])
    span.zone = zoneAt(code, span.start);
  return { text, gold, decoySpans };
}

/**
 * Derived from the items' categories, never written by hand, so it cannot drift
 * from them.
 */
export function caseType(items: DetCase["items"]): DetCaseType {
  const categories = new Set(Object.values(items).map((i) => i.category));
  return categories.size === 0
    ? "negative"
    : categories.size === 1
      ? "single"
      : "multi";
}

/** Builds a rendered case from parts (used for base cases and perturbed variants). */
export function buildCase(
  base: Omit<DetCase, "parts" | "text" | "gold" | "decoySpans" | "type">,
  parts: Part[],
): DetCase {
  return {
    ...base,
    type: caseType(base.items),
    parts,
    ...renderParts(parts, base.items, base.decoys),
  };
}

/** Schema and ground-truth checks for one source line. */
export function validateSource(source: DetCaseSource, lang: string): string[] {
  const issues: string[] = [];
  const where = source.id ?? "(no id)";
  if (!/^(en|fr)-\d{3}$/.test(source.id ?? ""))
    issues.push(`${where}: id must be <lang>-<nnn>`);
  if (source.lang !== lang)
    issues.push(`${where}: lang ${source.lang} in the ${lang} file`);
  if (!(REGISTERS as readonly string[]).includes(source.register))
    issues.push(`${where}: unknown register ${source.register}`);
  if (typeof source.template !== "string" || !source.template.trim())
    issues.push(`${where}: empty template`);
  const used = new Set(
    [...String(source.template).matchAll(PLACEHOLDER)].map((m) => m[1]!),
  );
  const itemKeys = Object.keys(source.items ?? {});
  const decoyKeys = Object.keys(source.decoys ?? {});
  const generatedKeys = Object.keys(source.generated ?? {});
  const defined = [...itemKeys, ...decoyKeys, ...generatedKeys];
  for (const key of used)
    if (!defined.includes(key))
      issues.push(`${where}: {{${key}}} is not defined`);
  for (const key of defined)
    if (!used.has(key)) issues.push(`${where}: ${key} is defined but unused`);
  if (new Set(defined).size < defined.length)
    issues.push(`${where}: a key is defined twice (item, decoy or generated)`);
  for (const [key, spec] of Object.entries(source.generated ?? {})) {
    if (!GENERATORS[spec.generator])
      issues.push(
        `${where}: generated ${key} has unknown generator ${spec.generator} (known: ${Object.keys(GENERATORS).join(", ")})`,
      );
    if (!Number.isInteger(spec.from) || spec.from < 0)
      issues.push(`${where}: generated ${key} needs an integer from >= 0`);
    if (
      !Number.isInteger(spec.count) ||
      spec.count < 1 ||
      spec.count > MAX_GENERATED_ROWS
    )
      issues.push(
        `${where}: generated ${key} needs an integer count from 1 to ${MAX_GENERATED_ROWS}`,
      );
  }
  if (/\{\{|\}\}/.test(String(source.template).replace(PLACEHOLDER, "")))
    issues.push(`${where}: malformed placeholder`);
  for (const [key, item] of Object.entries(source.items ?? {})) {
    if (!(DET_CATEGORIES as readonly string[]).includes(item.category)) {
      issues.push(`${where}: ${key} has unknown category ${item.category}`);
      continue;
    }
    if (!ITEM_KINDS[item.category].includes(item.kind))
      issues.push(
        `${where}: ${key} kind ${item.kind} is not a ${item.category} kind`,
      );
    if (!item.value || item.value !== item.value.trim())
      issues.push(`${where}: ${key} value is empty or padded`);
    const validate = KIND_VALIDATORS[item.kind];
    if (validate && !validate(item.value))
      issues.push(
        `${where}: ${key} ${item.kind} "${item.value}" fails its checksum`,
      );
    if (item.kind === "dob") {
      const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(item.iso ?? "");
      if (!m) issues.push(`${where}: ${key} dob needs iso YYYY-MM-DD`);
      else if (!item.value.includes(m[1]!))
        issues.push(`${where}: ${key} dob value does not contain the iso year`);
    }
  }
  for (const [key, decoy] of Object.entries(source.decoys ?? {})) {
    if (!(DECOY_KINDS as readonly string[]).includes(decoy.kind))
      issues.push(`${where}: decoy ${key} has unknown kind ${decoy.kind}`);
    if (!decoy.value) issues.push(`${where}: decoy ${key} is empty`);
    if (decoy.kind === "invalid_checksum") {
      const validate = KIND_VALIDATORS[decoy.of ?? ""];
      if (!validate)
        issues.push(
          `${where}: decoy ${key} needs "of", one of ${Object.keys(KIND_VALIDATORS).join(", ")}`,
        );
      else if (validate(decoy.value))
        issues.push(
          `${where}: decoy ${key} "${decoy.value}" passes the ${decoy.of} checksum`,
        );
    } else if (decoy.of !== undefined)
      issues.push(`${where}: decoy ${key}: "of" is only for invalid_checksum`);
  }
  return issues;
}

/** The rendered base case of a (valid) source line. */
export function caseFromSource(source: DetCaseSource): DetCase {
  return buildCase(
    {
      id: source.id,
      baseId: source.id,
      lang: source.lang,
      register: source.register,
      tags: source.tags ?? [],
      perturbation: "none",
      ...(source.generated ? { large: true } : {}),
      items: source.items ?? {},
      decoys: source.decoys ?? {},
    },
    parseTemplate(source),
  );
}

/** The rendered base cases (perturbed variants are derived per run). */
export interface DetDataset {
  cases: DetCase[];
  /** sha256 of the dataset files and generated texts, for run metadata. */
  hash: string;
}

/** Reads and validates every `datasets/insusty-builtin/cases/<lang>.jsonl` file. */
export function loadDetDataset(dir = DETBENCH_DIR): {
  dataset?: DetDataset;
  issues: string[];
} {
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
      const built = caseFromSource(source);
      // Generated text comes from code, not the file: hash it so a generator change shows as a new dataset.
      if (source.generated) hash.update(built.text);
      cases.push(built);
    });
  }
  return {
    dataset: issues.length ? undefined : { cases, hash: hash.digest("hex") },
    issues,
  };
}
