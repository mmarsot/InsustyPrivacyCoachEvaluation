/**
 * Classification approach to the local review, as an alternative to free
 * generation: code proposes candidate passages (src/lab/candidates.ts) and
 * the model answers one yes/no question per (candidate, custom label), read
 * from the next-token distribution. A candidate becomes a finding for the
 * label with the highest P(yes) when it reaches the threshold.
 *
 *   npm run lab:classify -- --variants q1 [--models smollm2-360m] [--set iter32]
 *                           [--thresholds 0.5,0.6,0.7,0.8,0.9] [--name label] [--dry-run]
 *
 * Results are cached per question in cache/lab/cls-<model>.jsonl and the
 * summary (one row per variant and threshold) goes to experiments/runs/<name>.json,
 * in the same shape as `npm run lab`, so the dashboard Lab view shows it.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { AutoTokenizer, env } from "@huggingface/transformers";
import { compileDataset } from "../dataset/load.ts";
import type { CompiledCase, Profile } from "../dataset/schema.ts";
import {
  loadExtApi,
  materializeExtRef,
  resolveExtRefName,
  resolveExtRepo,
} from "../ext/ref.ts";
import { CACHE_DIR, MODEL_CACHE_DIR, ROOT } from "../paths.ts";
import type { ResultRecord } from "../run/jobs.ts";
import { metrics, type Metrics } from "../score/aggregate.ts";
import { scoreResult } from "../score/score.ts";
import { composeLabelDescription, type LabelVariantId } from "../variants.ts";
import { generateCandidates, type Candidate } from "./candidates.ts";
import { findLabModel, type LabModel } from "./models.ts";
import { runGuardedWorker, waitForMemory } from "./runtime.ts";
import type { ClsGroup, ClsRecord, ClsWorkerSpec } from "./classify-worker.ts";

env.cacheDir = MODEL_CACHE_DIR;
env.allowLocalModels = false;

/**
 * One way to ask the yes/no question: the request templates, the
 * label-description variant and the answer tokens read as yes or no.
 */
export interface ClsVariant {
  id: string;
  note: string;
  /** System message; null = none. */
  system: string | null;
  /** User turn: {text} and {question}; the question and what follows are the per-question part. */
  user: string;
  /** Per (candidate, label): {candidate}, {label}, {description}. */
  question: string;
  prefill: string;
  labelVariant: LabelVariantId;
  yes: string[];
  no: string[];
}

const YES = ["yes", "Yes", "YES", " yes", " Yes", "oui", "Oui"];
const NO = ["no", "No", "NO", " no", " No", "non", "Non"];
const MARK = "\u0000QUESTION\u0000";

/**
 * The question variants `--variants` picks from; results are cached by rendered
 * question, so add a variant rather than edit one.
 */
export const CLS_VARIANTS: ClsVariant[] = [
  {
    id: "q1",
    note: "Text in the user turn, then 'is \"X\" one of these: <description>? yes or no'",
    system: "You answer questions about a text with yes or no.",
    user: 'Text:\n"""\n{text}\n"""\n\n{question}',
    question:
      'Question: in this text, is "{candidate}" one of these: {description} Answer yes or no.',
    prefill: "",
    labelVariant: "desc",
    yes: YES,
    no: NO,
  },
];
const extra = (
  base: string,
  id: string,
  note: string,
  o: Partial<ClsVariant>,
) => {
  const from = CLS_VARIANTS.find((v) => v.id === base)!;
  CLS_VARIANTS.push({ ...from, ...o, id, note });
};
extra("q1", "q1-ex3", "q1 with label descriptions + 3 examples", {
  labelVariant: "desc_ex3",
});
extra(
  "q1",
  "q3",
  "Contrast question: examples of the label, then yes/no on the candidate",
  {
    labelVariant: "desc_ex3",
    question:
      'Category {label}: {description}\nQuestion: is "{candidate}" in this text an item of category {label}? Answer yes or no.',
  },
);
extra("q1", "q2", "Question names the label and its description", {
  question:
    'Question: the label {label} means: {description}\nDoes "{candidate}" in this text fit the label {label}? Answer yes or no.',
});

// ------------------------------------------------------------------ args
const args = process.argv.slice(2);
const opt = (name: string) =>
  args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined;
const list = (v: string | undefined) =>
  (v ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
const fail = (m: string): never => {
  console.error(m);
  process.exit(2);
};
const variants = list(opt("variants") ?? "q1").map(
  (id) =>
    CLS_VARIANTS.find((v) => v.id === id) ?? fail(`unknown variant ${id}`),
);
const models = list(opt("models") ?? "smollm2-360m").map(
  (m) => findLabModel(m) ?? fail(`unknown model ${m}`),
);
const thresholds = list(opt("thresholds") ?? "0.5,0.6,0.7,0.8,0.9").map(Number);
const minFreeMb = Number(opt("min-free-mb") ?? 1500);
const maxRssMb = Number(opt("max-rss-mb") ?? 3500);
const dryRun = args.includes("--dry-run");

const { dataset } = compileDataset({ requireSplit: true });
if (!dataset) fail("dataset is invalid");
const setName = opt("set") ?? "iter32";
const caseIds = (
  JSON.parse(
    readFileSync(join(ROOT, "experiments", "sets", `${setName}.json`), "utf8"),
  ) as { cases: string[] }
).cases;
const cases = caseIds.map(
  (id) => dataset!.cases.find((c) => c.id === id) ?? fail(`unknown case ${id}`),
);
if (cases.some((c) => c.split === "test"))
  fail("never run the held-out test split in the lab");
const profiles = new Map(dataset!.profiles.map((p) => [p.id, p]));
const ext = await materializeExtRef(resolveExtRepo(), resolveExtRefName());
const api = await loadExtApi(ext.bundle);
const builtinLabels = api.reviewCategories([]);

// ------------------------------------------------------------------ plan
interface Question {
  key: string;
  candidate: Candidate;
  label: string;
}
interface CasePlan {
  variant: ClsVariant;
  c: CompiledCase;
  profile: Profile;
  group: ClsGroup;
  questions: Question[];
}

const fill = (t: string, vars: Record<string, string>) =>
  t.replace(/\{(\w+)\}/g, (m, k: string) => (k in vars ? vars[k]! : m));
const hash = (v: unknown) =>
  createHash("sha256").update(JSON.stringify(v)).digest("hex").slice(0, 32);
const cacheFile = (m: LabModel) =>
  join(CACHE_DIR, "lab", `cls-${m.id.replace(/^.*\//, "")}-${m.dtype}.jsonl`);

/**
 * Renders every (variant, case) prefix and its questions with the model's own
 * chat template, so the worker only runs forward passes.
 */
async function plan(model: LabModel): Promise<CasePlan[]> {
  const tokenizer = await AutoTokenizer.from_pretrained(model.id);
  const out: CasePlan[] = [];
  for (const variant of variants)
    for (const c of cases) {
      const profile = profiles.get(c.profile)!;
      const messages = [
        ...(variant.system === null
          ? []
          : [{ role: "system", content: variant.system }]),
        {
          role: "user",
          content: fill(variant.user, { text: c.text, question: MARK }),
        },
      ];
      const rendered = String(
        tokenizer.apply_chat_template(
          messages as never,
          { tokenize: false, add_generation_prompt: true } as never,
        ),
      );
      const at = rendered.indexOf(MARK);
      if (at < 0) fail(`${model.short}: template dropped the question marker`);
      const prefix = rendered.slice(0, at);
      const tail = rendered.slice(at + MARK.length) + variant.prefill;
      const groupKey = hash({
        model: model.id,
        dtype: model.dtype,
        prefix,
        kind: "prefix",
      });
      const questions: Question[] = [];
      const jobs = [];
      for (const candidate of generateCandidates(c.text))
        for (const spec of profile.labels) {
          const suffix =
            fill(variant.question, {
              candidate: candidate.text,
              label: spec.label,
              description: composeLabelDescription(spec, variant.labelVariant),
            }) + tail;
          const key = hash({
            model: model.id,
            dtype: model.dtype,
            prefix,
            suffix,
            yes: variant.yes,
            no: variant.no,
          });
          questions.push({ key, candidate, label: spec.label });
          jobs.push({ key, suffix });
        }
      out.push({
        variant,
        c,
        profile,
        group: { key: groupKey, caseId: c.id, prefix, jobs },
        questions,
      });
    }
  return out;
}

const loadCache = (file: string) => {
  const map = new Map<string, ClsRecord>();
  if (existsSync(file))
    for (const l of readFileSync(file, "utf8").split("\n"))
      if (l.trim())
        map.set((JSON.parse(l) as ClsRecord).key, JSON.parse(l) as ClsRecord);
  return map;
};

// ------------------------------------------------------------------ run + score
const pct = (v: number | null) =>
  v === null ? "  - " : `${Math.round(v * 100)}`.padStart(4);
const summary: Array<{
  model: string;
  dtype: string;
  config: string;
  note: string;
  overall: Metrics;
  en: Metrics;
  fr: Metrics;
}> = [];
const caseRows: unknown[] = [];

for (const model of models) {
  const plans = await plan(model);
  const file = cacheFile(model);
  mkdirSync(join(CACHE_DIR, "lab"), { recursive: true });
  let cache = loadCache(file);
  const pendingGroups = new Map<string, ClsGroup>();
  for (const p of plans) {
    const jobs = p.group.jobs.filter((j) => !cache.has(j.key));
    if (!jobs.length && cache.has(p.group.key)) continue;
    const g = pendingGroups.get(p.group.key) ?? { ...p.group, jobs: [] };
    for (const j of jobs)
      if (!g.jobs.some((x) => x.key === j.key)) g.jobs.push(j);
    pendingGroups.set(p.group.key, g);
  }
  const questions = [...pendingGroups.values()].reduce(
    (a, g) => a + g.jobs.length,
    0,
  );
  console.log(
    `[${model.short}] ${plans.length} case plans, ${pendingGroups.size} prefixes and ${questions} questions to compute`,
  );
  if (
    !dryRun &&
    pendingGroups.size &&
    (await waitForMemory(model, minFreeMb))
  ) {
    const spec: ClsWorkerSpec = {
      model: model.id,
      dtype: model.dtype,
      resultFile: file,
      groups: [...pendingGroups.values()],
      yes: variants[0]!.yes,
      no: variants[0]!.no,
    };
    const specFile = join(
      CACHE_DIR,
      "tmp",
      `cls-${process.pid}-${model.short}.json`,
    );
    mkdirSync(join(CACHE_DIR, "tmp"), { recursive: true });
    writeFileSync(specFile, JSON.stringify(spec));
    const t0 = performance.now();
    let last = 0;
    const peak = await runGuardedWorker(
      "src/lab/classify-worker.ts",
      specFile,
      {},
      model.short,
      maxRssMb,
      (e, rss) => {
        if (e.type === "loaded")
          console.log(
            `[${model.short}] loaded in ${Number(e.loadMs) / 1000} s, rss ${rss} MB`,
          );
        else if (
          e.type === "case" &&
          (performance.now() - last > 20_000 || e.done === e.total)
        ) {
          last = performance.now();
          console.log(
            `[${model.short}] ${e.done}/${e.total} ${e.caseId} ${e.ms} ms · ${Math.round((performance.now() - t0) / 1000)} s`,
          );
        } else if (e.type === "fatal")
          console.error(`[${model.short}] worker failed: ${e.error}`);
      },
    );
    console.log(`[${model.short}] peak RSS ${peak} MB`);
    cache = loadCache(file);
  }

  // Threshold-free diagnostic: ROC AUC of P(yes) over every question, where a
  // question is positive when its candidate overlaps an expected passage of that label.
  for (const variant of variants) {
    const scored: Array<[number, boolean]> = [];
    for (const p of plans.filter((x) => x.variant === variant))
      for (const q of p.questions) {
        const r = cache.get(q.key);
        if (!r) continue;
        const pos = p.c.spans.some(
          (s) =>
            s.label === q.label &&
            q.candidate.start < s.end &&
            s.start < q.candidate.end,
        );
        scored.push([r.pYes ?? 0, pos]);
      }
    const pos = scored.filter((x) => x[1]).map((x) => x[0]);
    const neg = scored.filter((x) => !x[1]).map((x) => x[0]);
    let wins = 0;
    for (const a of pos)
      for (const b of neg) wins += a > b ? 1 : a === b ? 0.5 : 0;
    const answered = scored.length
      ? [
          ...plans
            .filter((x) => x.variant === variant)
            .flatMap((p) =>
              p.questions.map((q) => cache.get(q.key)?.pAnswer ?? 0),
            ),
        ].reduce((a, b) => a + b, 0) / scored.length
      : 0;
    if (scored.length)
      console.log(
        `[${model.short}] ${variant.id}: AUC ${(wins / Math.max(1, pos.length * neg.length)).toFixed(3)} over ${pos.length} positive / ${neg.length} negative questions; mean P(yes or no) ${answered.toFixed(2)}`,
      );
  }

  for (const variant of variants)
    for (const t of thresholds) {
      const rows = [];
      for (const p of plans.filter((x) => x.variant === variant)) {
        const prefix = cache.get(p.group.key);
        if (!prefix || p.questions.some((q) => !cache.has(q.key))) continue;
        // Best label per candidate, kept when P(yes) reaches the threshold.
        const best = new Map<Candidate, { label: string; p: number }>();
        for (const q of p.questions) {
          const r = cache.get(q.key)!;
          const cur = best.get(q.candidate);
          if ((r.pYes ?? 0) >= t && (!cur || (r.pYes ?? 0) > cur.p))
            best.set(q.candidate, { label: q.label, p: r.pYes ?? 0 });
        }
        const findings = [...best].map(([k, v]) => ({
          category: v.label,
          start: k.start,
          end: k.end,
          value: k.text,
        }));
        const output = findings.length
          ? findings.map((f) => `${f.category}: ${f.value}`).join("\n")
          : "NONE";
        const ms =
          prefix.ms + p.questions.reduce((a, q) => a + cache.get(q.key)!.ms, 0);
        const record: ResultRecord = {
          key: p.group.key,
          extSha: ext.sha,
          model: model.id,
          instruction: `cls-${variant.id}@${t}`,
          labelVariant: variant.labelVariant,
          caseId: p.c.id,
          findings,
          chunks: [
            {
              output,
              ms,
              runtime: {
                backend: "wasm",
                quantization: model.dtype,
                promptTokens: prefix.tokens,
                generatedTokens: 0,
                finishReason: "eos",
              },
            },
          ],
          reviewMs: ms,
          at: prefix.at,
        };
        const scored = scoreResult(p.c, p.profile, record, builtinLabels);
        rows.push(scored);
        if (t === thresholds[Math.floor(thresholds.length / 2)])
          caseRows.push({
            model: model.short,
            config: `cls-${variant.id}@${t}`,
            caseId: p.c.id,
            failure: scored.failure,
            found: scored.expected.filter((e) => e.overlap).length,
            expected: scored.expected.length,
            predicted: scored.predicted.map(
              (x) => `${x.overlap ? "+" : "-"}${x.label}: ${x.value}`,
            ),
            ms,
            output: p.questions
              .map(
                (q) =>
                  `${q.label} ${JSON.stringify(q.candidate.text)} ${(cache.get(q.key)!.pYes ?? 0).toFixed(2)}`,
              )
              .join("\n")
              .slice(0, 1500),
          });
      }
      if (!rows.length) continue;
      summary.push({
        model: model.short,
        dtype: model.dtype,
        config: `cls-${variant.id}@${t}`,
        note: variant.note,
        overall: metrics(rows),
        en: metrics(rows.filter((r) => r.lang === "en")),
        fr: metrics(rows.filter((r) => r.lang === "fr")),
      });
    }
}

console.log(`\nset ${setName} (${cases.length} cases)`);
console.log(
  `${"model/config".padEnd(34)}  F1o    P    R  F1x  det  FPR  p50s  en-F1 fr-F1`,
);
for (const s of summary)
  console.log(
    `${`${s.model}/${s.config}`.padEnd(34)} ${pct(s.overall.overlap.f1)} ${pct(s.overall.overlap.precision)} ${pct(s.overall.overlap.recall)} ${pct(s.overall.exact.f1)} ${pct(s.overall.caseDetection)} ${pct(s.overall.falsePositiveRate)} ${String(Math.round((s.overall.latencyP50 ?? 0) / 100) / 10).padStart(5)}  ${pct(s.en.overlap.f1)}  ${pct(s.fr.overlap.f1)}`,
  );

if (!dryRun && summary.length) {
  const name =
    opt("name") ??
    `cls-${new Date().toISOString().slice(0, 16).replace(/[:T]/g, "-")}`;
  const r = (v: number | null) =>
    v === null ? null : Math.round(v * 1000) / 1000;
  const compact = (m: Metrics) => ({
    cases: m.cases,
    f1: r(m.overlap.f1),
    precision: r(m.overlap.precision),
    recall: r(m.overlap.recall),
    exactF1: r(m.exact.f1),
    detection: r(m.caseDetection),
    fpr: r(m.falsePositiveRate),
    compliance: r(m.compliance),
    p50ms: m.latencyP50,
    p95ms: m.latencyP95,
    tokens: 0,
    failures: Object.fromEntries(
      Object.entries(m.failures).filter(([, v]) => v),
    ),
  });
  mkdirSync(join(ROOT, "experiments", "runs"), { recursive: true });
  const file = join(ROOT, "experiments", "runs", `${name}.json`);
  writeFileSync(
    file,
    JSON.stringify(
      {
        name,
        set: setName,
        ext: { ref: ext.ref, sha: ext.sha },
        at: new Date().toISOString(),
        summary: summary.map((s) => ({
          model: s.model,
          dtype: s.dtype,
          config: s.config,
          note: s.note,
          overall: compact(s.overall),
          en: compact(s.en),
          fr: compact(s.fr),
        })),
        cases: caseRows,
      },
      null,
      1,
    ) + "\n",
  );
  console.log(`\nwrote ${file.replace(ROOT, "")}`);
}
