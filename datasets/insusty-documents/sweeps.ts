/**
 * Size sweeps: the same kind of document at growing sizes, per type, so the
 * report can fit time and memory against size (words, rows, slides, pages,
 * zip entries) and show where the Private AI size threshold should sit.
 *
 * Each sweep document holds labelled values at a fixed density (one prose
 * unit per ~1,000 words, one field row per 500 rows, one per 5 slides or 10
 * entries) next to filler or order rows, so recall and false alarms are
 * measured at every size too. Values repeat once the pools run out; they are
 * then matched by count.
 */
import { GENERATORS } from "../insusty-builtin/generate.ts";
import {
  fillerParagraphs,
  rngFor,
  shuffled,
  type ContentPools,
  type Unit,
} from "./content.ts";
import { SWEEP_UNITS, type BuiltDoc, type SweepSpec } from "./specs.ts";
import { writeOds, writeOdt } from "./writers/odf.ts";
import { writeDocx, writePptx, writeXlsx, type Cell } from "./writers/ooxml.ts";
import { writePdf } from "./writers/pdf.ts";
import { writeZip } from "./writers/zip.ts";

/** Words per PDF page at the writer's 10.5 pt Helvetica on A4 (measured: the report shows actual pages). */
const PDF_WORDS_PER_PAGE = 520;

/** An endless supply of units from a pool, reshuffled each round. */
function supply(pool: Unit[], seed: string): () => Unit {
  const rng = rngFor(seed);
  let queue: Unit[] = [];
  return () => {
    if (!queue.length) queue = shuffled(pool, rng);
    return queue.shift()!;
  };
}

/**
 * Generates one sweep document; the same spec, pools and seed always give the
 * same bytes.
 */
export async function buildSweepDoc(
  spec: SweepSpec,
  pools: ContentPools,
  seed: number,
): Promise<BuiltDoc> {
  const rng = rngFor(`docbench:${seed}:${spec.id}`);
  const nextProse = supply(pools.prose.en, `${seed}:${spec.id}:prose`);
  const nextField = supply(pools.fields.en, `${seed}:${spec.id}:fields`);
  const units: Unit[] = [];
  const name = `${spec.type === "csv" ? "export" : "document"}.${SWEEP_UNITS[spec.type].ext}`;
  const spec2 = {
    id: spec.id,
    family: SWEEP_UNITS[spec.type].family,
    ext: SWEEP_UNITS[spec.type].ext,
    zone: `sweep_${spec.unit}`,
    lang: "en" as const,
    kind: "positive" as const,
    expect: { outcome: "checked" as const },
  };
  /** Filler of `n` words with one prose unit per ~1,000 words. */
  const proseOf = (n: number) => {
    const paras = fillerParagraphs("en", n, rng);
    const out: string[] = [];
    let w = 0;
    let next = 500;
    for (const p of paras) {
      out.push(p);
      w += p.split(/\s+/).length;
      if (w >= next) {
        const u = nextProse();
        units.push(u);
        out.push(u.text);
        next += 1000;
      }
    }
    return out;
  };
  /** `n` order rows with one field row per 500 rows. */
  const rowsOf = (n: number): Cell[][] => {
    const gen = GENERATORS.orders_tsv!;
    const rows: Cell[][] = [["Order", "Customer", "Amount", "Note", "Status"]];
    for (let i = 0; i < n; i++) {
      if (i % 500 === 250) {
        const u = nextField();
        units.push(u);
        rows.push([u.field!.label, u.field!.value]);
      } else
        rows.push(
          gen(10_000 + i)
            .split("\t")
            .map((c) => (/^\d+(\.\d+)?$/.test(c) ? Number(c) : c)),
        );
    }
    return rows;
  };
  const cellCount = (rows: Cell[][]) => rows.reduce((k, r) => k + r.length, 0);
  let bytes: Uint8Array;
  const size: BuiltDoc["size"] = { words: 0 };
  switch (spec.type) {
    case "txt": {
      const paras = proseOf(spec.size);
      bytes = new TextEncoder().encode(paras.join("\n\n") + "\n");
      size.words = spec.size;
      break;
    }
    case "docx": {
      bytes = writeDocx({
        title: "Annual report",
        body: proseOf(spec.size).map((text) => ({ type: "p", text })),
      });
      size.words = spec.size;
      break;
    }
    case "odt": {
      bytes = writeOdt({
        body: proseOf(spec.size).map((text) => ({ type: "p", text })),
      });
      size.words = spec.size;
      break;
    }
    case "pdf": {
      const paras = proseOf(spec.size * PDF_WORDS_PER_PAGE);
      bytes = await writePdf({
        blocks: paras.map((text) => ({ type: "p", text })),
      });
      size.words = spec.size * PDF_WORDS_PER_PAGE;
      size.pages = spec.size;
      break;
    }
    case "csv": {
      const rows = rowsOf(spec.size);
      bytes = new TextEncoder().encode(
        rows
          .map((r) =>
            r
              .map((x) =>
                typeof x === "string" && /[",\n]/.test(x)
                  ? `"${x.replace(/"/g, '""')}"`
                  : String(x ?? ""),
              )
              .join(","),
          )
          .join("\n") + "\n",
      );
      size.rows = spec.size;
      size.cells = cellCount(rows);
      break;
    }
    case "xlsx": {
      const rows = rowsOf(spec.size);
      bytes = writeXlsx({ sheets: [{ name: "Orders", rows }] });
      size.rows = spec.size;
      size.cells = cellCount(rows);
      break;
    }
    case "ods": {
      const rows = rowsOf(spec.size);
      bytes = writeOds({
        sheets: [
          {
            name: "Orders",
            rows: rows.map((r) =>
              r.map((x) =>
                typeof x === "object" && x !== null ? x.result : x,
              ),
            ),
          },
        ],
      });
      size.rows = spec.size;
      size.cells = cellCount(rows);
      break;
    }
    case "pptx": {
      const slides = [];
      for (let i = 0; i < spec.size; i++) {
        const body = fillerParagraphs("en", 45, rng);
        let notes: string[] | undefined;
        if (i % 5 === 2) {
          const u = nextProse();
          units.push(u);
          notes = u.text.split("\n");
        }
        slides.push({
          title: `Slide ${i + 1}`,
          body,
          ...(notes ? { notes } : {}),
        });
      }
      bytes = writePptx({ slides });
      size.slides = spec.size;
      size.words = spec.size * 50;
      break;
    }
    case "zip": {
      const entries = [];
      for (let i = 0; i < spec.size; i++) {
        const text = fillerParagraphs("en", 90, rng);
        if (i % 10 === 5) {
          const u = nextField();
          units.push(u);
          text.push(`${u.field!.label}: ${u.field!.value}`);
        }
        entries.push({
          name: `notes/note-${String(i).padStart(5, "0")}.txt`,
          data: text.join("\n\n") + "\n",
        });
      }
      bytes = writeZip(entries);
      size.entries = spec.size;
      size.words = spec.size * 95;
      break;
    }
  }
  return { spec: spec2, name, bytes, units, size };
}
