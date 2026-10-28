/**
 * The dashboard's Documents view (read-only): finished document-bench runs
 * under `results/runs/docbench/` (git-ignored, local), and runs in progress, whose plan is rebuilt from
 * their arguments with `planDocbench` (`engine/plan.ts`, the planner the
 * CLI uses) and compared with the ref's result cache.
 */
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  summarizeDocs,
  type DocSummary,
} from "../engine/scorers/documents/aggregate.ts";
import type { AiSummary } from "../datasets/insusty-documents/ai.ts";
import {
  DOCBENCH_RUNS_DIR,
  loadDocCache,
} from "../engine/scorers/documents/cache.ts";
import {
  logChart,
  renderDocCompare,
  renderDocReport,
  type DocRunMeta,
} from "../engine/scorers/documents/report.ts";
import type { DocJobResult } from "../datasets/insusty-documents/types.ts";
import { resolveCommit } from "../modules/insusty-privacy/materialize.ts";
import {
  resolveExtRefName,
  resolveExtRepo,
} from "../modules/insusty-privacy/ref.ts";
import {
  parseDocbenchArgs,
  planDocbench,
  type DocbenchOptions,
  type DocPlan,
} from "../engine/plan.ts";
import type { ActiveRun } from "./data.ts";

/**
 * Whether an active run's arguments are a docbench run (`npm run bench --
 * --track docbench`).
 */
export const isDocbenchArgv = (argv: readonly string[]) => {
  const at = argv.indexOf("--track");
  return at >= 0 && argv[at + 1] === "docbench";
};
/** Arguments of a docbench run without the `--track docbench` pair. */
export const docbenchArgs = (argv: readonly string[]) => {
  const at = argv.indexOf("--track");
  return at >= 0 ? argv.filter((_, i) => i !== at && i !== at + 1) : [...argv];
};

interface LiveDoc {
  id: string;
  run: ActiveRun;
  options?: DocbenchOptions;
  sha?: string;
  plan?: DocPlan;
  error?: string;
}

/** A docbench run as the Documents view lists it, committed or in progress. */
export interface DocRunListing {
  id: string;
  name: string;
  kind: "committed" | "live";
  ref?: string;
  sha?: string;
  at?: string;
}

const readJson = <T>(file: string): T =>
  JSON.parse(readFileSync(file, "utf8")) as T;

/**
 * The Documents view's data: finished docbench runs, and live ones whose plan
 * is rebuilt from their arguments. Read-only.
 */
export class DocDashboard {
  private live = new Map<string, LiveDoc>();

  constructor(
    private readonly options: { extRepo?: string; ref?: string } = {},
  ) {}

  liveRuns(active: ActiveRun[]): LiveDoc[] {
    return active
      .filter((r) => isDocbenchArgv(r.argv))
      .map((run) => {
        const id = `live:${run.pid}`;
        const memo = this.live.get(id);
        if (memo && memo.run.argv.join(" ") === run.argv.join(" ")) return memo;
        const live: LiveDoc = { id, run };
        try {
          live.options = parseDocbenchArgs(docbenchArgs(run.argv));
          const repo = resolveExtRepo(
            live.options.extRepo ?? this.options.extRepo,
          );
          live.sha = resolveCommit(
            repo,
            live.options.ref ?? resolveExtRefName(this.options.ref),
          ).sha;
          live.plan = planDocbench(live.options, live.sha);
        } catch (error) {
          live.error = (error as Error).message;
        }
        this.live.set(id, live);
        return live;
      });
  }

  progress(active: ActiveRun[]) {
    return this.liveRuns(active).map((l) => {
      const base = {
        id: l.id,
        pid: l.run.pid,
        name: l.run.name,
        argv: l.run.argv,
        startedAt: l.run.startedAt,
      };
      if (!l.plan || !l.sha) return { ...base, error: l.error ?? "no plan" };
      const cache = loadDocCache(l.sha);
      const part = (jobs: DocPlan["suite"]) => {
        const done = jobs.filter((j) => cache.has(j.key));
        const recent = done
          .map((j) => cache.get(j.key)!)
          .sort((a, b) => b.at.localeCompare(a.at));
        return {
          total: jobs.length,
          done: done.length,
          last: recent[0]
            ? {
                id: recent[0].jobId,
                at: recent[0].at,
                outcome: recent[0].read.outcome,
                ms: recent[0].timing.readMs,
              }
            : null,
        };
      };
      return {
        ...base,
        sha: l.sha,
        tier: l.options!.tier,
        suite: part(l.plan.suite),
        sweeps: part(l.plan.sweeps),
        ai: l.options!.tracks.includes("ai")
          ? l.options!.aiModels.length
            ? l.options!.aiModels.map((m) => m.short)
            : ["the ref's default model"]
          : [],
      };
    });
  }

  runs(active: ActiveRun[]): DocRunListing[] {
    const committed: DocRunListing[] = existsSync(DOCBENCH_RUNS_DIR)
      ? readdirSync(DOCBENCH_RUNS_DIR)
          .filter((d) => existsSync(join(DOCBENCH_RUNS_DIR, d, "run.json")))
          .map((d) => {
            const meta = readJson<DocRunMeta>(
              join(DOCBENCH_RUNS_DIR, d, "run.json"),
            );
            return {
              id: `run:${d}`,
              name: d,
              kind: "committed" as const,
              ref: meta.ext.ref,
              sha: meta.ext.sha,
              at: meta.finishedAt,
            };
          })
          .sort((a, b) => (b.at ?? "").localeCompare(a.at ?? ""))
      : [];
    const live = this.liveRuns(active)
      .filter((l) => l.plan)
      .map((l) => ({
        id: l.id,
        name: `LIVE ${l.run.name ?? docbenchArgs(l.run.argv).join(" ")}`,
        kind: "live" as const,
        ref: l.options?.ref,
        sha: l.sha,
      }));
    return [...live, ...committed];
  }

  private rowsOf(
    id: string,
    active: ActiveRun[],
  ): {
    meta?: DocRunMeta;
    rows: DocJobResult[];
    summary: DocSummary;
    ai?: AiSummary[];
  } {
    if (id.startsWith("run:")) {
      const dir = join(DOCBENCH_RUNS_DIR, id.slice(4).replace(/[^\w.-]/g, ""));
      const meta = readJson<DocRunMeta>(join(dir, "run.json"));
      const rows = readFileSync(join(dir, "results.jsonl"), "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => JSON.parse(l) as DocJobResult);
      const aiFile = join(dir, "ai.json");
      return {
        meta,
        rows,
        summary: readJson<DocSummary>(join(dir, "metrics.json")),
        ...(existsSync(aiFile)
          ? { ai: readJson<{ summary: AiSummary[] }>(aiFile).summary }
          : {}),
      };
    }
    const live = this.liveRuns(active).find((l) => l.id === id);
    if (!live?.plan || !live.sha) throw new Error("run not found");
    const cache = loadDocCache(live.sha);
    const rows = [...live.plan.suite, ...live.plan.sweeps]
      .map((j) => cache.get(j.key))
      .filter((r): r is DocJobResult => !!r);
    return {
      rows: rows.filter((r) => r.track === "suite"),
      summary: summarizeDocs(rows, live.options!.configs, {
        ref: live.options!.ref ?? "main",
        sha: live.sha,
      }),
    };
  }

  run(id: string, active: ActiveRun[]) {
    const { meta, summary, ai } = this.rowsOf(id, active);
    const configs =
      meta?.configs ??
      (Object.keys(summary.overall.configs) as Array<"default" | "all">);
    const types = [...new Set(summary.sweeps.map((p) => p.type))];
    const ms = (v: number) => (v >= 1000 ? `${v / 1000}s` : `${v}ms`);
    const charts = summary.sweeps.length
      ? {
          time: logChart(
            types.map((t) => ({
              name: t,
              points: summary.sweeps
                .filter((p) => p.type === t && p.outcome === "checked")
                .map((p) => [p.chars, p.totalMs] as [number, number]),
            })),
            {
              xLabel: "characters of extracted text",
              yLabel: "check time",
              yFormat: ms,
              hLines: [
                { y: 1000, label: "1 s" },
                { y: 5000, label: "5 s" },
              ],
            },
          ),
          memory: logChart(
            types.map((t) => ({
              name: t,
              points: summary.sweeps
                .filter(
                  (p) => p.type === t && p.outcome === "checked" && p.deltaMb,
                )
                .map(
                  (p) => [p.chars, Math.max(1, p.deltaMb!)] as [number, number],
                ),
            })),
            {
              xLabel: "characters of extracted text",
              yLabel: "peak MB over baseline",
            },
          ),
          perType: Object.fromEntries(
            types.map((t) => {
              const pts = summary.sweeps.filter((p) => p.type === t);
              const fit = summary.fits.find((f) => f.type === t);
              return [
                t,
                logChart(
                  [
                    {
                      name: "total",
                      points: pts.map(
                        (p) => [p.size, p.totalMs] as [number, number],
                      ),
                      fit: fit?.total,
                    },
                    {
                      name: "read",
                      points: pts.map(
                        (p) => [p.size, p.readMs] as [number, number],
                      ),
                    },
                    {
                      name: `detect (${configs[0]})`,
                      points: pts.map(
                        (p) =>
                          [p.size, p.detectMs[configs[0]!] ?? 0] as [
                            number,
                            number,
                          ],
                      ),
                    },
                    {
                      name: "redact",
                      points: pts
                        .filter((p) => p.redactMs)
                        .map((p) => [p.size, p.redactMs!] as [number, number]),
                    },
                  ],
                  {
                    xLabel: pts[0]!.unit,
                    yLabel: "ms",
                    yFormat: ms,
                    width: 380,
                    height: 220,
                  },
                ),
              ];
            }),
          ),
        }
      : null;
    const aiCharts = (ai ?? []).map((m) => ({
      model: m.model,
      chart: logChart(
        [
          {
            name: "review p50",
            points: m.bySize.map(
              (b) => [b.chars, b.reviewMsP50] as [number, number],
            ),
            fit: m.fit ? { ...m.fit, points: m.bySize.length } : null,
          },
        ],
        {
          xLabel: "characters of document text",
          yLabel: "review time",
          yFormat: ms,
          vLines: (meta?.fileReviewLimits ?? []).map((l) => ({
            x: l,
            label: `${l / 1000}k`,
          })),
        },
      ),
    }));
    return {
      meta: meta ?? null,
      configs,
      summary,
      ai: ai ?? null,
      charts,
      aiCharts,
    };
  }

  cases(id: string, active: ActiveRun[]) {
    const { rows } = this.rowsOf(id, active);
    return rows.map((r) => ({
      id: r.jobId,
      kind: r.spec.kind,
      family: r.spec.family,
      zone: r.spec.zone,
      lang: r.spec.lang,
      got: r.classification.got,
      ok: r.classification.ok,
      silentClean: r.classification.silentClean,
      items: r.items.length,
      extracted: r.items.filter((i) => i.extracted).length,
      found: Object.fromEntries(
        Object.keys(r.configs).map((c) => [
          c,
          r.items.filter((i) => i.cfg[c as "default" | "all"]?.found).length,
        ]),
      ),
      falseAlarms: Object.fromEntries(
        Object.entries(r.configs).map(([c, v]) => [c, v.falseAlarms]),
      ),
      redaction: Object.fromEntries(
        Object.entries(r.configs).map(([c, v]) => [c, v.redaction.mode]),
      ),
      readMs: r.timing.readMs,
    }));
  }

  caseDetail(id: string, caseId: string, active: ActiveRun[]) {
    const row = this.rowsOf(id, active).rows.find((r) => r.jobId === caseId);
    if (!row) return { notFound: `No result for ${caseId} in this run.` };
    return row;
  }

  /** The full static report of a committed run, or of a live run's results so far. */
  reportHtml(id: string, active: ActiveRun[]): string {
    if (id.startsWith("run:")) {
      const file = join(
        DOCBENCH_RUNS_DIR,
        id.slice(4).replace(/[^\w.-]/g, ""),
        "report.html",
      );
      if (existsSync(file)) return readFileSync(file, "utf8");
    }
    const { meta, rows, summary, ai } = this.rowsOf(id, active);
    const m: DocRunMeta = meta ?? {
      name: id,
      argv: [],
      ext: {
        ref: summary.ref,
        sha: summary.sha,
        subject: "(run in progress)",
        committedAt: "",
      },
      modules: [],
      packages: {},
      limits: {},
      fileReviewLimit: null,
      fileReviewLimits: null,
      tier: "?",
      seed: 0,
      configs: Object.keys(summary.overall.configs) as Array<"default" | "all">,
      configNote: {},
      reps: 0,
      datasetHash: "",
      suiteCases: rows.length,
      sweepPoints: summary.sweeps.length,
      missing: 0,
      verifier: { pdftotext: false },
      node: process.versions.node,
      machine: "",
      startedAt: "",
      finishedAt: "",
    };
    return renderDocReport(m, summary, rows, ai);
  }

  compareHtml(a: string, b: string, active: ActiveRun[]): string {
    const side = (id: string) => {
      const r = this.rowsOf(id, active);
      if (!r.meta) throw new Error("compare needs committed runs");
      return {
        meta: r.meta,
        summary: r.summary,
        ...(r.ai ? { ai: r.ai } : {}),
      };
    };
    return renderDocCompare(side(a), side(b));
  }
}
