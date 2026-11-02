/**
 * The dashboard's Modules, Datasets and Grid views: the registry's grid
 * (`engine/registry.ts`, from the folders alone) plus the latest stored result
 * of each cell, read from the run folders every runner writes. Read-only.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { DatasetAdapterFile } from "../engine/adapter.ts";
import { RUNS_DIR } from "../engine/paths.ts";
import {
  buildGrid,
  readAdapter,
  readModuleManifest,
  resolveLiteratureDataset,
  resolveModuleId,
  type Grid,
} from "../engine/registry.ts";

/** The latest stored result of one cell. */
export interface CellResult {
  module: string;
  configuration: string;
  dataset: string;
  /** Run folder, relative to the runs directory. */
  run: string;
  metric: string;
  value: number | null;
  sha?: string;
  finishedAt: string;
}

const readJson = <T>(file: string): T | undefined => {
  try {
    return JSON.parse(readFileSync(file, "utf8")) as T;
  } catch {
    return undefined;
  }
};
const dirs = (dir: string) =>
  existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter((d) => d.isDirectory())
        .map((d) => d.name)
    : [];

/** A module configuration by its model id, else undefined. */
const configurationOfModel = (moduleId: string, model: string) =>
  readModuleManifest(moduleId).configurations.find((c) => c.model === model)
    ?.id;

/** A module configuration by its built-in setting (`default`/`all` in runner outputs) with Private AI off. */
function configurationOfBuiltins(moduleId: string, builtins: string) {
  const configurations = readModuleManifest(moduleId).configurations.filter(
    (c) => c.privateAi === "off",
  );
  return (
    configurations.find((c) => c.builtins === builtins) ??
    (configurations.length === 1 && builtins === "default"
      ? configurations[0]
      : undefined)
  )?.id;
}

const moduleOf = (name: string) => {
  try {
    return resolveModuleId(name);
  } catch {
    return undefined;
  }
};

/** Every stored result that maps to a grid cell, from the runners' run folders. */
export function storedResults(runsDir = RUNS_DIR): CellResult[] {
  const out: CellResult[] = [];
  const push = (
    r: Omit<CellResult, "configuration"> & { configuration?: string },
  ) => {
    if (r.configuration) out.push(r as CellResult);
  };
  // Review runs: results/runs/<name>/ with one metrics row per model × instruction × label variant.
  for (const name of dirs(runsDir)) {
    const run = readJson<{
      models?: Array<{ id: string }>;
      ext?: { sha: string };
      finishedAt?: string;
    }>(join(runsDir, name, "run.json"));
    const metrics = readJson<
      Array<{ config: string; overall: { overlap: { f1: number | null } } }>
    >(join(runsDir, name, "metrics.json"));
    if (!run?.models || !Array.isArray(metrics)) continue;
    for (const row of metrics) {
      const slug = row.config.split(" | ")[0];
      const model = run.models.find((m) => m.id.replace(/^.*\//, "") === slug);
      if (!model) continue;
      push({
        module: "insusty-privacy",
        configuration: configurationOfModel("insusty-privacy", model.id),
        dataset: "insusty-custom",
        run: name,
        metric: `F1 (${row.config.split(" | ")[2] ?? "desc"})`,
        value: row.overall.overlap.f1,
        sha: run.ext?.sha,
        finishedAt: run.finishedAt ?? "",
      });
    }
  }
  // detbench: results/runs/detbench/<name>/, one summary per configuration.
  for (const name of dirs(join(runsDir, "detbench"))) {
    const dir = join(runsDir, "detbench", name);
    const run = readJson<{
      ext?: { ref: string; sha: string };
      finishedAt?: string;
    }>(join(dir, "run.json"));
    const metrics = readJson<
      Array<{ config: string; overall: { overlap: { f1: number | null } } }>
    >(join(dir, "metrics.json"));
    if (!run || !Array.isArray(metrics)) continue;
    const moduleId = moduleOf(run.ext?.ref ?? "") ?? "insusty-privacy";
    for (const row of metrics)
      push({
        module: moduleId,
        configuration: configurationOfBuiltins(moduleId, row.config),
        dataset: "insusty-builtin",
        run: `detbench/${name}`,
        metric: "F1",
        value: row.overall.overlap.f1,
        sha: run.ext?.sha,
        finishedAt: run.finishedAt ?? "",
      });
  }
  // docbench: results/runs/docbench/<name>/, overall F1 per configuration.
  for (const name of dirs(join(runsDir, "docbench"))) {
    const dir = join(runsDir, "docbench", name);
    const run = readJson<{ finishedAt?: string }>(join(dir, "run.json"));
    const metrics = readJson<{
      sha?: string;
      overall?: {
        positives?: number;
        configs?: Record<string, { f1: number | null }>;
      };
    }>(join(dir, "metrics.json"));
    if (!run || !metrics?.overall?.configs) continue;
    // Private AI on documents (`--tracks ai`): recall over every size, per model.
    const ai = readJson<{
      summary?: Array<{
        model: string;
        bySize: Array<{ expected: number; found: number }>;
      }>;
    }>(join(dir, "ai.json"));
    for (const m of ai?.summary ?? []) {
      const expected = m.bySize.reduce((a, x) => a + x.expected, 0);
      push({
        module: "insusty-privacy",
        configuration: configurationOfModel("insusty-privacy", m.model),
        dataset: "insusty-documents",
        run: `docbench/${name}`,
        metric: "Recall (Private AI)",
        value: expected
          ? m.bySize.reduce((a, x) => a + x.found, 0) / expected
          : null,
        sha: metrics.sha,
        finishedAt: run.finishedAt ?? "",
      });
    }
    // A run without the document suite (Private AI only) has no rules result.
    if (!metrics.overall.positives) continue;
    for (const [config, m] of Object.entries(metrics.overall.configs))
      push({
        module: "insusty-privacy",
        configuration: configurationOfBuiltins("insusty-privacy", config),
        dataset: "insusty-documents",
        run: `docbench/${name}`,
        metric: "F1",
        value: m.f1,
        sha: metrics.sha,
        finishedAt: run.finishedAt ?? "",
      });
  }
  // Literature: results/runs/literature/<name>/, one result per system × dataset × configuration.
  for (const name of dirs(join(runsDir, "literature"))) {
    const dir = join(runsDir, "literature", name);
    const run = readJson<{ finishedAt?: string }>(join(dir, "run.json"));
    const results = readJson<
      Array<{
        system: { name: string; sha?: string; version: string };
        dataset: string;
        config: string;
        scores: { headline: { f1: number | null } };
      }>
    >(join(dir, "metrics.json"));
    if (!run || !Array.isArray(results)) continue;
    for (const r of results) {
      const moduleId = moduleOf(r.system.name);
      const dataset = resolveLiteratureDataset(r.dataset);
      if (!moduleId || !dataset) continue;
      push({
        module: moduleId,
        configuration: configurationOfBuiltins(moduleId, r.config),
        dataset,
        run: `literature/${name}`,
        metric: "F1",
        value: r.scores.headline.f1,
        sha: r.system.sha ?? r.system.version,
        finishedAt: run.finishedAt ?? "",
      });
    }
  }
  return out;
}

/** The latest stored result per cell. */
export function latestResults(results: CellResult[]): CellResult[] {
  const latest = new Map<string, CellResult>();
  for (const r of results) {
    const key = `${r.module}\u0000${r.configuration}\u0000${r.dataset}`;
    const seen = latest.get(key);
    if (!seen || r.finishedAt > seen.finishedAt) latest.set(key, r);
  }
  return [...latest.values()];
}

/** What the Modules, Datasets and Grid views show. */
export interface GridView extends Grid {
  /** Every module's dataset adapters, by module then dataset. */
  adapters: Record<string, Record<string, DatasetAdapterFile>>;
  results: CellResult[];
}

/** The grid, every adapter and the latest stored result per cell. */
export function gridView(runsDir = RUNS_DIR): GridView {
  const grid = buildGrid();
  const adapters: GridView["adapters"] = {};
  for (const m of grid.modules) {
    adapters[m.manifest.id] = {};
    for (const d of m.adapters)
      adapters[m.manifest.id]![d] = readAdapter(m.manifest.id, d)!;
  }
  return { ...grid, adapters, results: latestResults(storedResults(runsDir)) };
}
