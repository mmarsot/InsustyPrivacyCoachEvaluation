/**
 * The README's headline chart: Insusty against Presidio on rule-based
 * detection, drawn as one SVG per GitHub theme (`docs/assets/headline-*.svg`,
 * shown through a `<picture>` element, because an SVG in an `<img>` cannot see
 * GitHub's theme setting).
 *
 *   npm run readme:chart            # writes the two SVGs
 *
 * The numbers are the ones the README's Results table quotes from the runs it
 * cites (`results/` is git-ignored, so a fresh clone has no runs to read):
 * after a new measurement, update `HEADLINE` and the README together.
 * `readme-chart.test.ts` checks that the README quotes every value here and
 * that the committed SVGs are what this script writes. Plain SVG only: GitHub
 * serves it as an image, so no script, no external font, no CSS beyond
 * attributes.
 */
import { writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** One tool's result on a row: the bar's share of full scale and its label. */
interface Score {
  /** 0..1 of the axis; `null` draws no bar (the tool cannot do it). */
  share: number | null;
  /** The value as the README writes it. */
  text: string;
}

interface Row {
  label: string;
  insusty: Score;
  presidio: Score;
}

const pct = (text: string): Score => ({
  share: Number(text.replace("%", "")) / 100,
  text,
});

/** Higher is better on every row (decoys wrongly hidden stay in the table). */
export const HEADLINE: readonly Row[] = [
  {
    label: "Our prompts: items redacted",
    insusty: pct("97.1%"),
    presidio: pct("66.7%"),
  },
  {
    label: "Our prompts: F1",
    insusty: pct("96.2%"),
    presidio: pct("62.8%"),
  },
  {
    label: "Our prompts: precision",
    insusty: pct("95.6%"),
    presidio: pct("51.9%"),
  },
  {
    label: "Secrets and API keys found",
    insusty: { share: 115 / 117, text: "115 of 117" },
    presidio: { share: null, text: "not supported" },
  },
  {
    label: "Nemotron-PII sample: recall",
    insusty: pct("81.9%"),
    presidio: pct("79.2%"),
  },
  {
    label: "Nemotron-PII sample: F1",
    insusty: pct("89.7%"),
    presidio: pct("86.6%"),
  },
  {
    label: "Gretel finance (EN+FR): recall",
    insusty: pct("48.5%"),
    presidio: pct("61.8%"),
  },
  {
    label: "Gretel finance (EN+FR): F1",
    insusty: pct("52.0%"),
    presidio: pct("32.7%"),
  },
];

/** The run the numbers come from, as the README's Results section says. */
const SOURCE =
  "Measured 2026-11-02 · extension main @ b12b381 · Presidio 2.2.364";

export type Theme = "light" | "dark";

/** Insusty brand kit, "Sunset" direction; Presidio gets a muted neutral. */
const PALETTE: Record<
  Theme,
  {
    card: string;
    border: string;
    title: string;
    text: string;
    soft: string;
    grid: string;
    insusty: string;
    presidio: string;
  }
> = {
  light: {
    card: "#FFF3EA", // peach
    border: "#F0DDD0", // line
    title: "#4A1F42", // plum
    text: "#3D2420", // ink
    soft: "#7A5A50", // ink soft
    grid: "#F0DDD0",
    insusty: "#FF6B4A", // coral
    presidio: "#C9B3A8",
  },
  dark: {
    card: "#3A1834", // plum deep
    border: "#4A1F42", // plum
    title: "#FFFFFF",
    text: "#FFE3D6", // peach deep
    soft: "#C9A9A0",
    grid: "#4A1F42",
    insusty: "#FF6B4A",
    presidio: "#8A6F84",
  },
};

const FONT =
  "-apple-system, BlinkMacSystemFont, 'Segoe UI', 'Noto Sans', Helvetica, Arial, sans-serif";

const WIDTH = 860;
const LABEL_X = 28;
const BAR_X = 272;
const BAR_W = 460;
const BAR_H = 13;
const BAR_GAP = 4;
const ROW_H = 2 * BAR_H + BAR_GAP + 16;
const TOP = 104;

const escape = (text: string) =>
  text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

const round = (n: number) => Number(n.toFixed(1));

/** The chart for one theme, as SVG source. Deterministic: same input, same bytes. */
export function renderChart(theme: Theme): string {
  const c = PALETTE[theme];
  const height = TOP + HEADLINE.length * ROW_H + 24;
  const out: string[] = [];
  out.push(
    `<svg xmlns="http://www.w3.org/2000/svg" width="${WIDTH}" height="${height}" viewBox="0 0 ${WIDTH} ${height}" role="img" aria-labelledby="t d" font-family="${FONT}">`,
    `<title id="t">Insusty Privacy Coach against Presidio, rule-based detection</title>`,
    `<desc id="d">${escape(
      HEADLINE.map(
        (r) =>
          `${r.label}: Insusty ${r.insusty.text}, Presidio ${r.presidio.text}`,
      ).join("; "),
    )}. ${escape(SOURCE)}.</desc>`,
    `<rect x="1" y="1" width="${WIDTH - 2}" height="${height - 2}" rx="18" fill="${c.card}" stroke="${c.border}" stroke-width="2"/>`,
    `<text x="${LABEL_X}" y="42" font-size="20" font-weight="700" fill="${c.title}">Rule-based detection: Insusty vs Presidio</text>`,
    `<text x="${LABEL_X}" y="66" font-size="13" fill="${c.soft}">Higher is better · ${escape(SOURCE)}</text>`,
  );
  // Legend, top right.
  const legend = [
    ["Insusty, every label on", c.insusty],
    ["Presidio 2.2.364", c.presidio],
  ] as const;
  let lx = BAR_X;
  for (const [name, colour] of legend) {
    out.push(
      `<rect x="${lx}" y="80" width="12" height="12" rx="3" fill="${colour}"/>`,
      `<text x="${lx + 18}" y="90.5" font-size="13" fill="${c.text}">${escape(name)}</text>`,
    );
    lx += 18 + name.length * 7.4 + 22;
  }
  // Grid lines at 0, 50 and 100%.
  const gridBottom = TOP + HEADLINE.length * ROW_H - 8;
  for (const share of [0, 0.5, 1]) {
    const x = round(BAR_X + share * BAR_W);
    out.push(
      `<line x1="${x}" y1="${TOP - 6}" x2="${x}" y2="${gridBottom}" stroke="${c.grid}" stroke-width="1"/>`,
      `<text x="${x}" y="${gridBottom + 16}" font-size="11" fill="${c.soft}" text-anchor="middle">${share * 100}%</text>`,
    );
  }
  HEADLINE.forEach((row, i) => {
    const y = TOP + i * ROW_H;
    out.push(
      `<text x="${LABEL_X}" y="${y + BAR_H + 6}" font-size="13.5" fill="${c.text}">${escape(row.label)}</text>`,
    );
    // Bold marks the row's winner, as in the README table.
    const a = row.insusty.share ?? -1;
    const b = row.presidio.share ?? -1;
    const bars = [
      [row.insusty, c.insusty, a >= b],
      [row.presidio, c.presidio, b >= a],
    ] as const;
    bars.forEach(([score, colour, bold], j) => {
      const by = y + j * (BAR_H + BAR_GAP);
      const w = round((score.share ?? 0) * BAR_W);
      if (score.share !== null)
        out.push(
          `<rect x="${BAR_X}" y="${by}" width="${w}" height="${BAR_H}" rx="3" fill="${colour}"/>`,
        );
      out.push(
        `<text x="${round(BAR_X + w + 8)}" y="${by + BAR_H - 2}" font-size="12"${bold ? ' font-weight="700"' : ""} fill="${score.share === null ? c.soft : c.text}"${score.share === null ? ' font-style="italic"' : ""}>${escape(score.text)}</text>`,
      );
    });
  });
  out.push("</svg>");
  return out.join("\n") + "\n";
}

/** Where each theme's chart is committed, relative to the repository root. */
export const chartPath = (theme: Theme) => `docs/assets/headline-${theme}.svg`;

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  for (const theme of ["light", "dark"] as const) {
    writeFileSync(chartPath(theme), renderChart(theme));
    console.log(`wrote ${chartPath(theme)}`);
  }
}
