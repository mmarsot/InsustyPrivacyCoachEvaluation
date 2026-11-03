import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { chartPath, HEADLINE, renderChart } from "./readme-chart.ts";

const readme = readFileSync("README.md", "utf8");

test("the committed headline charts are what readme-chart.ts writes", () => {
  for (const theme of ["light", "dark"] as const) {
    assert.equal(
      readFileSync(chartPath(theme), "utf8"),
      renderChart(theme),
      `${chartPath(theme)} is stale: run npm run readme:chart`,
    );
    assert.ok(readme.includes(chartPath(theme)), `README shows ${theme}`);
  }
});

test("the README quotes every percentage the chart draws", () => {
  for (const row of HEADLINE)
    for (const { text } of [row.insusty, row.presidio])
      if (/^\d+(\.\d+)?%$/.test(text))
        assert.ok(readme.includes(text), `${row.label}: ${text}`);
});
