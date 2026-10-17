/**
 * Literature benchmarks (deterministic track): published, permissively
 * licensed PII datasets scored through the redaction contract, with each
 * dataset's labels mapped by its adapter (src/adapters/).
 *
 *   npm run literature -- [--datasets tab,gretel,nemotron] [--systems insusty,presidio]
 *                         [--ref main] [--ext-repo <path>] [--split test] [--limit N]
 *                         [--configs default,all] [--name <run name>] [--dry-run]
 *
 * Dataset files are downloaded into cache/datasets/ at a pinned revision and
 * checked against their pinned SHA-256 (never committed). Outputs are cached
 * per system version, dataset revision, case and configuration
 * (cache/literature/); a rerun only rescores. Writes
 * runs/literature/<name>/ (report.html, metrics.json, run.json, spans.jsonl:
 * the redacted spans per case, without text).
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import {
  CONTRACT_VERSION,
  type ModuleConfig,
  type RedactionModule,
  type RedactionOutput,
} from "../../contract/types.ts";
import { ensureDataset, sampleIds } from "../adapters/download.ts";
import { ADAPTERS, findAdapter } from "../adapters/index.ts";
import { scoreAdapter, type AdapterScores } from "../adapters/score.ts";
import type { BenchmarkAdapter, GoldCase } from "../adapters/types.ts";
import {
  renderLiteratureReport,
  type LiteratureRun,
} from "../adapters/report.ts";
import { defangJson } from "../detbench/defang.ts";
import { machineProfile, peakRssMb } from "../module/machine.ts";
import { CACHE_DIR, RUNS_DIR } from "../paths.ts";
import { percentile } from "../score/aggregate.ts";
import { literatureJobKey, parseLiteratureArgs } from "../run/plan.ts";
import { loadSystem, SYSTEMS, type SystemName } from "../systems/index.ts";

export const LITERATURE_RUNS_DIR = join(RUNS_DIR, "literature");
const CACHE = join(CACHE_DIR, "literature");

type Cached = {
  key: string;
  caseId: string;
  spans: RedactionOutput["spans"];
  textLength: number;
  runtime: { totalMs: number; stages: RedactionOutput["runtime"]["stages"] };
};

const loadCache = (file: string) => {
  const out = new Map<string, Cached>();
  if (existsSync(file))
    for (const line of readFileSync(file, "utf8").split("\n"))
      if (line.trim())
        try {
          const r = JSON.parse(line) as Cached;
          out.set(r.key, r);
        } catch {
          // torn line
        }
  return out;
};

async function main() {
  const o = parseLiteratureArgs(process.argv.slice(2), {
    datasets: ADAPTERS.map((a) => a.id),
    systems: SYSTEMS,
  });
  const adapters = o.datasets.map((d) => findAdapter(d)!);
  const systems: RedactionModule[] = [];
  for (const s of o.systems)
    systems.push(
      await loadSystem(s as SystemName, { ref: o.ref, extRepo: o.extRepo }),
    );
  for (const m of systems)
    console.log(
      `System ${m.info.name} ${m.info.version} (contract ${m.contract}): built-ins ${m.capabilities.builtins.join(", ")}`,
    );
  const loaded: Array<{
    adapter: BenchmarkAdapter;
    split: string;
    cases: GoldCase[];
    total: number;
    limit: number;
  }> = [];
  for (const a of adapters) {
    const split = o.split ?? a.defaultSplit;
    const dir = await ensureDataset(a, split);
    const all = await a.load(dir, split);
    const limit = o.limit ?? a.defaultLimit ?? 0;
    const keep = sampleIds(
      all.map((c) => c.id),
      limit,
      `${a.id}:${a.revision}:${split}`,
    );
    const cases = all.filter((c) => keep.has(c.id));
    loaded.push({ adapter: a, split, cases, total: all.length, limit });
    console.log(
      `Dataset ${a.id} @ ${a.revision.slice(0, 10)} (${a.license.spdx}), ${split}: ${cases.length}${cases.length < all.length ? ` of ${all.length} (seeded sample)` : ""} cases, ${cases.reduce((n, c) => n + c.text.length, 0).toLocaleString("en")} chars`,
    );
  }
  if (o.dryRun) return;
  mkdirSync(CACHE, { recursive: true });
  const startedAt = new Date().toISOString();
  const results: LiteratureRun["results"] = [];
  const spanLines: string[] = [];
  for (const m of systems) {
    const systemKey = {
      name: m.info.name,
      version: m.info.sha ?? m.info.version,
    };
    for (const { adapter, split, cases } of loaded) {
      const configs = adapter.configs(m);
      const cacheFile = join(
        CACHE,
        `${m.info.name}-${systemKey.version.slice(0, 12)}-${adapter.id}.jsonl`,
      );
      const cache = loadCache(cacheFile);
      for (const name of o.configs) {
        const config: ModuleConfig = configs[name]!;
        const outputs = new Map<string, RedactionOutput>();
        const times: number[] = [];
        let computed = 0;
        let rulesMs = 0;
        // Warm up: a module's first call (bundle, lazy tables) is not part of any case's time.
        await m.redact(
          { kind: "text", text: "warm up jo@example.org 06 12 34 56 78" },
          config,
        );
        for (const c of cases) {
          const key = literatureJobKey(systemKey, adapter, c.id, config);
          let hit = cache.get(key);
          if (!hit) {
            const out = await m.redact(
              { kind: "text", text: c.text, language: c.language },
              config,
            );
            hit = {
              key,
              caseId: c.id,
              spans: out.spans,
              textLength: out.text.length,
              runtime: {
                totalMs: out.runtime.totalMs,
                stages: out.runtime.stages,
              },
            };
            cache.set(key, hit);
            appendFileSync(cacheFile, defangJson(JSON.stringify(hit)) + "\n");
            computed++;
          }
          times.push(hit.runtime.totalMs);
          rulesMs +=
            hit.runtime.stages.find((s) => s.stage === "rules")?.ms ??
            hit.runtime.totalMs;
          outputs.set(c.id, {
            contract: CONTRACT_VERSION,
            module: m.info,
            text: c.text,
            spans: hit.spans,
            redaction: { mode: "none", leakChecked: false },
            coverage: { checked: "full", gaps: [], ocrPages: 0 },
            runtime: {
              stages: hit.runtime.stages,
              totalMs: hit.runtime.totalMs,
            },
          });
          spanLines.push(
            JSON.stringify({
              system: m.info.name,
              dataset: adapter.id,
              config: name,
              caseId: c.id,
              spans: hit.spans
                .filter((s) => s.redacted)
                .map((s) => [s.start, s.end, s.label]),
            }),
          );
        }
        const scores: AdapterScores = scoreAdapter(
          cases,
          outputs,
          adapter.labelMap,
        );
        const masked = new Map(
          [...outputs].map(([id, out]) => [
            id,
            out.spans.filter((s) => s.redacted),
          ]),
        );
        const native = adapter.native?.(cases, masked, adapter.labelMap);
        const chars = scores.chars;
        const totalMs = times.reduce((a, b) => a + b, 0);
        results.push({
          system: { ...m.info, contract: m.contract },
          dataset: adapter.id,
          split,
          config: name,
          scores,
          ...(native ? { native } : {}),
          efficiency: {
            cases: times.length,
            computed,
            totalMs,
            p50Ms: percentile(times, 50),
            p95Ms: percentile(times, 95),
            charsPerSecond: totalMs ? (chars / totalMs) * 1000 : null,
            rulesMs,
          },
        });
        const h = scores.headline;
        const pc = (v: number | null) =>
          v === null ? "–" : `${(100 * v).toFixed(1)}%`;
        console.log(
          `[${m.info.name} ${adapter.id} ${name}] in scope: recall ${pc(h.recall)} (typed ${pc(h.recallTyped)}, exact ${pc(h.recallExact)}) of ${h.gold} · precision ${pc(h.precision)} · F1 ${pc(h.f1)} · over-redaction ${h.overRedactionPer1k?.toFixed(2) ?? "–"}/1k chars | custom-label gold masked ${pc(scores.custom.recall)} of ${scores.custom.gold} · out of scope ${pc(scores.outOfScope.recall)} of ${scores.outOfScope.gold} · native total ${pc(scores.nativeTotal.recall)}${
            native
              ? ` · ${Object.entries(native)
                  .map(([k, v]) => `${k} ${pc(v)}`)
                  .join(" ")}`
              : ""
          } · ${computed} computed, ${(totalMs / 1000).toFixed(1)} s`,
        );
      }
    }
    await m.dispose?.();
  }
  const name =
    o.name ??
    `${startedAt.slice(0, 10)}-${o.systems.join("+")}-${systems.find((m) => m.info.sha)?.info.sha?.slice(0, 7) ?? "baselines"}`;
  const run: LiteratureRun = {
    name,
    argv: process.argv.slice(2),
    contract: CONTRACT_VERSION,
    datasets: loaded.map(({ adapter, split, cases, total, limit }) => ({
      id: adapter.id,
      title: adapter.title,
      revision: adapter.revision,
      split,
      cases: cases.length,
      total,
      sample:
        cases.length < total
          ? { limit, seed: `${adapter.id}:${adapter.revision}:${split}` }
          : null,
      files: adapter
        .files(split)
        .map((f) => ({ name: f.name, url: f.url, sha256: f.sha256 })),
      license: adapter.license,
      homepage: adapter.homepage,
      citation: adapter.citation,
      labelMap: adapter.labelMap,
    })),
    results,
    machine: machineProfile(),
    peakRssMb: peakRssMb(),
    startedAt,
    finishedAt: new Date().toISOString(),
  };
  const dir = join(LITERATURE_RUNS_DIR, name);
  mkdirSync(dir, { recursive: true });
  writeFileSync(
    join(dir, "run.json"),
    JSON.stringify({ ...run, results: undefined }, null, 2) + "\n",
  );
  writeFileSync(
    join(dir, "metrics.json"),
    defangJson(JSON.stringify(results, null, 1)) + "\n",
  );
  writeFileSync(join(dir, "spans.jsonl"), spanLines.join("\n") + "\n");
  writeFileSync(join(dir, "report.html"), renderLiteratureReport(run));
  console.log(`wrote ${join(dir, "report.html")}`);
}

await main();
