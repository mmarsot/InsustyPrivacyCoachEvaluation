/**
 * Aggregates document-bench results into the metrics the report, the CLI
 * summary and the dashboard show:
 *
 * - per format x zone (positive cases): extraction recall, then detection
 *   recall among extracted values, end-to-end recall, precision, F1, and the
 *   redaction check (values gone from the redacted output, leaks);
 * - false alarms of hard-negative documents, per page, per 10,000 cells and
 *   per 1,000 words;
 * - classification of every case (failure files above all): accuracy and
 *   silent cleans;
 * - size sweeps: time and peak memory per point, with a power-law fit
 *   (time = a * size^b) per type and step.
 */
import type { DocJobResult } from "./types.ts";

/** The module configurations docbench scores (`src/detbench/ext.ts`). */
export type ConfigName = "default" | "all";

const ratio = (a: number, b: number): number | null => (b ? a / b : null);
const f1 = (p: number | null, r: number | null) =>
  p === null || r === null || p + r === 0 ? null : (2 * p * r) / (p + r);

/**
 * Positive cases of one format and zone. Rates are 0..1, null when their
 * denominator is zero.
 */
export interface ZoneMetrics {
  family: string;
  zone: string;
  cases: number;
  items: number;
  extracted: number;
  extractionRecall: number | null;
  configs: Record<
    string,
    {
      found: number;
      /** Detected among extracted values. */
      detectionRecall: number | null;
      /** Detected among all placed values. */
      recall: number | null;
      precision: number | null;
      f1: number | null;
      tp: number;
      falseAlarms: number;
      redactedLeakFree: number;
      removed: number;
      leaked: number;
    }
  >;
  /** Redaction modes seen (default config). */
  modes: Record<string, number>;
  /** Cases whose read did not match the expectation (a positive case reported partial...). */
  misclassified: number;
}

/**
 * One hard-negative document: its false alarms, also per page, per 10,000 cells
 * and per 1,000 words where the format has them.
 */
export interface NegativeMetrics {
  caseId: string;
  family: string;
  zone: string;
  lang: string;
  decoys: number;
  configs: Record<
    string,
    {
      falseAlarms: number;
      decoysFlagged: number;
      perPage: number | null;
      per10kCells: number | null;
      per1kWords: number | null;
    }
  >;
  pages: number | null;
  cells: number | null;
  words: number | null;
  samples: Array<{ category: string; value: string; where: string }>;
}

/**
 * One case's read against its expectation; a `silentClean` is the failure that
 * matters most.
 */
export interface ClassificationRow {
  caseId: string;
  kind: string;
  family: string;
  zone: string;
  expected: string;
  got: string;
  ok: boolean;
  silentClean: boolean;
  gaps: string[];
  error?: string;
}

/**
 * One measured sweep document: sizes, step times in milliseconds, memory in MB
 * (`deltaMb` over the worker's baseline), and recall at that size.
 */
export interface SweepPoint {
  id: string;
  type: string;
  unit: string;
  size: number;
  bytes: number;
  chars: number;
  pages: number | null;
  outcome: string;
  gaps: string[];
  readMs: number;
  detectMs: Record<string, number>;
  redactMs: number | null;
  redactionMode: string;
  totalMs: number;
  peakMb: number | null;
  deltaMb: number | null;
  items: number;
  extracted: number;
  found: Record<string, number>;
  falseAlarms: Record<string, number>;
}

/** A power-law fit of time (milliseconds) against size. */
export interface PowerFit {
  /** time = a * size^b, fitted on log-log points (least squares). */
  a: number;
  b: number;
  r2: number;
  points: number;
}

/**
 * How one sweep type scales: time fits per step, a linear memory fit, and the
 * sizes that fit within a time budget.
 */
export interface SweepFit {
  type: string;
  unit: string;
  read: PowerFit | null;
  detect: PowerFit | null;
  total: PowerFit | null;
  /** Peak memory over the process baseline, linear in size: delta = c + k * size. */
  memory: { c: number; k: number; r2: number } | null;
  /** Time per 1,000 characters of extracted text at the largest point. */
  msPerKChar: number | null;
  /** Largest size whose total check time stays within 1 s and within 5 s (from the fit, at most the largest fitted size). */
  sizeWithin1s: number | null;
  sizeWithin5s: number | null;
  /** The budget was not reached within the measured sizes: the size is a lower bound. */
  within1sAtLeast: boolean;
  within5sAtLeast: boolean;
  /** Points left out of the fits: the ref read only part of them (a text cap, an entry cap). */
  capped: number[];
}

/**
 * Everything the report, the CLI summary and the dashboard show for one
 * docbench run.
 */
export interface DocSummary {
  ref: string;
  sha: string;
  overall: {
    positives: number;
    items: number;
    extracted: number;
    extractionRecall: number | null;
    configs: Record<
      string,
      {
        recall: number | null;
        detectionRecall: number | null;
        precision: number | null;
        f1: number | null;
        leaked: number;
        removed: number;
        redactedLeakFree: number;
      }
    >;
    classification: {
      cases: number;
      ok: number;
      accuracy: number | null;
      silentClean: number;
    };
    failures: {
      cases: number;
      ok: number;
      accuracy: number | null;
      silentClean: number;
    };
    negatives: Record<
      string,
      { falseAlarms: number; docs: number; docsWithFalseAlarm: number }
    >;
    /** PDFs with findings (first configuration): redacted in place or fallen back to the text copy, and the findings that fail alone. */
    pdfRedaction: {
      inPlace: number;
      fallback: number;
      textCopy: number;
      error: number;
      findings: number;
      failing: number;
      failingByCategory: Record<string, number>;
      failingExamples: string[];
    };
  };
  zones: ZoneMetrics[];
  families: ZoneMetrics[];
  categories: Array<{
    category: string;
    items: number;
    extracted: number;
    found: Record<string, number>;
  }>;
  negatives: NegativeMetrics[];
  classification: ClassificationRow[];
  sweeps: SweepPoint[];
  fits: SweepFit[];
  timing: Array<{
    family: string;
    cases: number;
    readMsP50: number;
    detectMsP50: number;
    redactMsP50: number | null;
  }>;
}

const p50 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};

/**
 * The metrics of the positive cases of one format and zone, per configuration.
 */
function zoneMetrics(
  rows: DocJobResult[],
  family: string,
  zone: string,
  configs: ConfigName[],
): ZoneMetrics {
  const items = rows.flatMap((r) => r.items);
  const extracted = items.filter((i) => i.extracted).length;
  const out: ZoneMetrics = {
    family,
    zone,
    cases: rows.length,
    items: items.length,
    extracted,
    extractionRecall: ratio(extracted, items.length),
    configs: {},
    modes: {},
    misclassified: rows.filter((r) => !r.classification.ok).length,
  };
  for (const c of configs) {
    const found = items.filter((i) => i.cfg[c]?.found).length;
    const tp = rows.reduce((n, r) => n + (r.configs[c]?.tp ?? 0), 0);
    const fa = rows.reduce((n, r) => n + (r.configs[c]?.falseAlarms ?? 0), 0);
    const precision = ratio(tp, tp + fa);
    const recall = ratio(found, items.length);
    out.configs[c] = {
      found,
      detectionRecall: ratio(found, extracted),
      recall,
      precision,
      f1: f1(precision, recall),
      tp,
      falseAlarms: fa,
      redactedLeakFree: items.filter(
        (i) => i.cfg[c]?.redacted && i.cfg[c]?.leakFree,
      ).length,
      removed: rows.reduce(
        (n, r) => n + (r.configs[c]?.redaction.removed ?? 0),
        0,
      ),
      leaked: rows.reduce(
        (n, r) => n + (r.configs[c]?.redaction.leaked ?? 0),
        0,
      ),
    };
  }
  for (const r of rows) {
    const mode = r.configs[configs[0]!]?.redaction.mode ?? "none";
    out.modes[mode] = (out.modes[mode] ?? 0) + 1;
  }
  return out;
}

/** Least-squares fit of log(y) = log(a) + b log(x). */
export function powerFit(points: Array<[number, number]>): PowerFit | null {
  const pts = points.filter(([x, y]) => x > 0 && y > 0);
  if (pts.length < 2) return null;
  const lx = pts.map(([x]) => Math.log(x));
  const ly = pts.map(([, y]) => Math.log(y));
  const mx = lx.reduce((a, b) => a + b, 0) / lx.length;
  const my = ly.reduce((a, b) => a + b, 0) / ly.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (let i = 0; i < lx.length; i++) {
    sxy += (lx[i]! - mx) * (ly[i]! - my);
    sxx += (lx[i]! - mx) ** 2;
    syy += (ly[i]! - my) ** 2;
  }
  if (!sxx) return null;
  const b = sxy / sxx;
  const a = Math.exp(my - b * mx);
  return { a, b, r2: syy ? (sxy * sxy) / (sxx * syy) : 1, points: pts.length };
}

function linearFit(
  points: Array<[number, number]>,
): { c: number; k: number; r2: number } | null {
  if (points.length < 2) return null;
  const mx = points.reduce((a, [x]) => a + x, 0) / points.length;
  const my = points.reduce((a, [, y]) => a + y, 0) / points.length;
  let sxy = 0;
  let sxx = 0;
  let syy = 0;
  for (const [x, y] of points) {
    sxy += (x - mx) * (y - my);
    sxx += (x - mx) ** 2;
    syy += (y - my) ** 2;
  }
  if (!sxx) return null;
  const k = sxy / sxx;
  return { c: my - k * mx, k, r2: syy ? (sxy * sxy) / (sxx * syy) : 1 };
}

/** Largest size within `ms` by the fit, never past the largest measured size (then a lower bound). */
const sizeWithin = (
  fit: PowerFit | null,
  ms: number,
  maxMeasured: number,
): { size: number | null; atLeast: boolean } => {
  if (!fit || fit.b <= 0) return { size: null, atLeast: false };
  const s = (ms / fit.a) ** (1 / fit.b);
  if (!Number.isFinite(s)) return { size: null, atLeast: false };
  return s >= maxMeasured
    ? { size: maxMeasured, atLeast: true }
    : { size: Math.round(s), atLeast: false };
};

/** Summarizes a run's results for the configurations it scored. */
export function summarizeDocs(
  results: DocJobResult[],
  configs: ConfigName[],
  ref: { ref: string; sha: string },
): DocSummary {
  const suite = results.filter((r) => r.track === "suite");
  const positives = suite.filter((r) => r.spec.kind === "positive");
  const byZone = new Map<string, DocJobResult[]>();
  const byFamily = new Map<string, DocJobResult[]>();
  for (const r of positives) {
    // Text-like files share zone names (body, cell): keep each extension apart.
    const zkey = `${r.spec.family}\u0000${r.spec.family === "text" ? `${r.spec.ext} ${r.spec.zone}` : r.spec.zone}`;
    byZone.set(zkey, [...(byZone.get(zkey) ?? []), r]);
    byFamily.set(r.spec.family, [...(byFamily.get(r.spec.family) ?? []), r]);
  }
  const zones = [...byZone.entries()].map(([k, rows]) => {
    const [family, zone] = k.split("\u0000") as [string, string];
    return zoneMetrics(rows, family, zone, configs);
  });
  const families = [...byFamily.entries()].map(([family, rows]) =>
    zoneMetrics(rows, family, "all zones", configs),
  );
  const all = zoneMetrics(positives, "all", "all", configs);
  const cats = new Map<
    string,
    {
      category: string;
      items: number;
      extracted: number;
      found: Record<string, number>;
    }
  >();
  for (const i of positives.flatMap((r) => r.items)) {
    const e = cats.get(i.category) ?? {
      category: i.category,
      items: 0,
      extracted: 0,
      found: Object.fromEntries(configs.map((c) => [c, 0])),
    };
    e.items++;
    if (i.extracted) e.extracted++;
    for (const c of configs) if (i.cfg[c]?.found) e.found[c]!++;
    cats.set(i.category, e);
  }
  const negatives: NegativeMetrics[] = suite
    .filter((r) => r.spec.kind === "negative")
    .map((r) => {
      const pages = r.read.pages ?? null;
      const cells = r.size.cells ?? null;
      const words = r.read.chars ? Math.round(r.read.chars / 6) : null;
      return {
        caseId: r.jobId,
        family: r.spec.family,
        zone: r.spec.zone,
        lang: r.spec.lang,
        decoys: r.decoys.length,
        pages,
        cells,
        words,
        configs: Object.fromEntries(
          configs.map((c) => {
            const fa = r.configs[c]?.falseAlarms ?? 0;
            return [
              c,
              {
                falseAlarms: fa,
                decoysFlagged: r.decoys.filter((d) => d.flagged[c]).length,
                perPage: pages ? fa / pages : null,
                per10kCells: cells ? (fa * 10_000) / cells : null,
                per1kWords: words ? (fa * 1000) / words : null,
              },
            ];
          }),
        ),
        samples: (
          r.configs[configs[configs.length - 1]!]?.falseAlarmSamples ?? []
        )
          .slice(0, 6)
          .map(({ category, value, where }) => ({ category, value, where })),
      };
    });
  const classification: ClassificationRow[] = suite.map((r) => ({
    caseId: r.jobId,
    kind: r.spec.kind,
    family: r.spec.family,
    zone: r.spec.zone,
    expected: `${r.classification.expected.outcome}${r.classification.expected.reason ? `:${r.classification.expected.reason}` : ""}${r.classification.expected.signed ? "+signed" : ""}`,
    got: r.classification.got,
    ok: r.classification.ok,
    silentClean: r.classification.silentClean,
    gaps: r.read.gaps,
    ...(r.read.error ? { error: r.read.error } : {}),
  }));
  const failures = classification.filter((c) => c.kind === "failure");
  const pdfModes = {
    inPlace: 0,
    fallback: 0,
    textCopy: 0,
    error: 0,
    findings: 0,
    failing: 0,
    failingByCategory: {} as Record<string, number>,
    failingExamples: [] as string[],
  };
  for (const r of suite.filter((x) => x.read.redaction === "pdf")) {
    const m = r.configs[configs[0]!]?.redaction.mode;
    if (m === "in_place") pdfModes.inPlace++;
    else if (m === "fallback_text_copy") pdfModes.fallback++;
    else if (m === "text_copy") pdfModes.textCopy++;
    else if (m === "error") pdfModes.error++;
    if (m && m !== "none")
      pdfModes.findings += r.configs[configs[0]!]?.selected ?? 0;
    for (const f of r.configs[configs[0]!]?.redaction.failing ?? []) {
      pdfModes.failing++;
      pdfModes.failingByCategory[f.category] =
        (pdfModes.failingByCategory[f.category] ?? 0) + 1;
      if (pdfModes.failingExamples.length < 8)
        pdfModes.failingExamples.push(`${f.category}: ${f.value}`);
    }
  }
  const sweeps: SweepPoint[] = results
    .filter((r) => r.track === "sweep" && r.sweep)
    .map((r) => {
      const detect = r.timing.detectMs;
      const first = configs[0]!;
      return {
        id: r.jobId,
        type: r.sweep!.type,
        unit: r.sweep!.unit,
        size: r.sweep!.size,
        bytes: r.bytes,
        chars: r.read.chars,
        pages: r.read.pages ?? null,
        outcome: r.read.outcome,
        gaps: r.read.gaps,
        readMs: r.timing.readMs,
        detectMs: detect,
        redactMs: r.timing.redactMs,
        redactionMode: r.configs[first]?.redaction.mode ?? "none",
        totalMs:
          r.timing.readMs + (detect[first] ?? 0) + (r.timing.redactMs ?? 0),
        peakMb: r.memory.peakMb,
        deltaMb: r.memory.deltaMb,
        items: r.items.length,
        extracted: r.items.filter((i) => i.extracted).length,
        found: Object.fromEntries(
          configs.map((c) => [
            c,
            r.items.filter((i) => i.cfg[c]?.found).length,
          ]),
        ),
        falseAlarms: Object.fromEntries(
          configs.map((c) => [c, r.configs[c]?.falseAlarms ?? 0]),
        ),
      };
    })
    .sort((a, b) => a.type.localeCompare(b.type) || a.size - b.size);
  const fits: SweepFit[] = [...new Set(sweeps.map((s) => s.type))].map(
    (type) => {
      const all = sweeps.filter((s) => s.type === type);
      // A point the ref read only in part (2 MB text cap, entry cap) does not measure its size: left out of the fits.
      const pts = all.filter((s) => s.outcome === "checked");
      const first = configs[0]!;
      const total = powerFit(pts.map((s) => [s.size, s.totalMs]));
      const largest = pts[pts.length - 1] ?? all[all.length - 1]!;
      const w1 = sizeWithin(total, 1000, largest.size);
      const w5 = sizeWithin(total, 5000, largest.size);
      const memPts = pts
        .filter((s) => s.deltaMb !== null)
        .map((s) => [s.size, s.deltaMb!] as [number, number]);
      return {
        type,
        unit: largest.unit,
        read: powerFit(pts.map((s) => [s.size, s.readMs])),
        detect: powerFit(pts.map((s) => [s.size, s.detectMs[first] ?? 0])),
        total,
        memory: linearFit(memPts),
        msPerKChar: largest.chars
          ? (largest.totalMs * 1000) / largest.chars
          : null,
        sizeWithin1s: w1.size,
        sizeWithin5s: w5.size,
        within1sAtLeast: w1.atLeast,
        within5sAtLeast: w5.atLeast,
        capped: all.filter((s) => s.outcome !== "checked").map((s) => s.size),
      };
    },
  );
  const timing = [...new Set(suite.map((r) => r.spec.family))]
    .map((family) => {
      const rows = suite.filter(
        (r) => r.spec.family === family && r.read.outcome !== "unchecked",
      );
      const redacts = rows
        .map((r) => r.timing.redactMs)
        .filter((x): x is number => x !== null);
      return {
        family,
        cases: rows.length,
        readMsP50: p50(rows.map((r) => r.timing.readMs)),
        detectMsP50: p50(rows.map((r) => r.timing.detectMs[configs[0]!] ?? 0)),
        redactMsP50: redacts.length ? p50(redacts) : null,
      };
    })
    .filter((t) => t.cases > 0);
  return {
    ref: ref.ref,
    sha: ref.sha,
    overall: {
      positives: positives.length,
      items: all.items,
      extracted: all.extracted,
      extractionRecall: all.extractionRecall,
      configs: Object.fromEntries(
        configs.map((c) => [
          c,
          {
            recall: all.configs[c]!.recall,
            detectionRecall: all.configs[c]!.detectionRecall,
            precision: all.configs[c]!.precision,
            f1: all.configs[c]!.f1,
            leaked: all.configs[c]!.leaked,
            removed: all.configs[c]!.removed,
            redactedLeakFree: all.configs[c]!.redactedLeakFree,
          },
        ]),
      ),
      classification: {
        cases: classification.length,
        ok: classification.filter((c) => c.ok).length,
        accuracy: ratio(
          classification.filter((c) => c.ok).length,
          classification.length,
        ),
        silentClean: classification.filter((c) => c.silentClean).length,
      },
      failures: {
        cases: failures.length,
        ok: failures.filter((c) => c.ok).length,
        accuracy: ratio(failures.filter((c) => c.ok).length, failures.length),
        silentClean: failures.filter((c) => c.silentClean).length,
      },
      negatives: Object.fromEntries(
        configs.map((c) => [
          c,
          {
            falseAlarms: negatives.reduce(
              (n, x) => n + x.configs[c]!.falseAlarms,
              0,
            ),
            docs: negatives.length,
            docsWithFalseAlarm: negatives.filter(
              (x) => x.configs[c]!.falseAlarms > 0,
            ).length,
          },
        ]),
      ),
      pdfRedaction: pdfModes,
    },
    zones: zones.sort(
      (a, b) =>
        a.family.localeCompare(b.family) || a.zone.localeCompare(b.zone),
    ),
    families: families.sort((a, b) => a.family.localeCompare(b.family)),
    categories: [...cats.values()].sort((a, b) =>
      a.category.localeCompare(b.category),
    ),
    negatives,
    classification,
    sweeps,
    fits,
    timing,
  };
}

/** One CSV row per format x zone and configuration. */
export function docCsv(s: DocSummary): string {
  const head =
    "family,zone,config,cases,items,extracted,extraction_recall,detection_recall,recall,precision,f1,false_alarms,removed,leaked";
  const num = (v: number | null) => (v === null ? "" : v.toFixed(4));
  const rows = [...s.families, ...s.zones].flatMap((z) =>
    Object.entries(z.configs).map(([c, m]) =>
      [
        z.family,
        z.zone,
        c,
        z.cases,
        z.items,
        z.extracted,
        num(z.extractionRecall),
        num(m.detectionRecall),
        num(m.recall),
        num(m.precision),
        num(m.f1),
        m.falseAlarms,
        m.removed,
        m.leaked,
      ].join(","),
    ),
  );
  return [head, ...rows].join("\n") + "\n";
}
