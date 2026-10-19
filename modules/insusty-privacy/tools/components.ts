/**
 * Per-component view of a bench run on a ref with the answer-confidence
 * filter and example-derived patterns (extension PR #32): replays the cached
 * model answers through the ref's own `reviewPrompt` with either part
 * switched off, then scores each variant. No model runs.
 *
 *   npm run components -- <the same bench arguments, e.g. --ref ebf077f --set tune96 --models smollm2-360m>
 *
 * - filter off: the recorded `answerProbability` is withheld from the replay;
 * - patterns off: findings whose reason is a pattern match are dropped (the
 *   ref keeps a model finding over a pattern match of the same span, so what
 *   remains is exactly the model's findings).
 * The "both on" replay must reproduce the cached findings; mismatches are counted.
 */
import { compileDataset } from "../../../datasets/insusty-custom/load.ts";
import {
  loadExtApi,
  materializeExtRef,
  resolveExtRefName,
  resolveExtRepo,
  type ModelClientLike,
} from "../ref.ts";
import { loadCache, type ResultRecord } from "../../../engine/jobs.ts";
import {
  benchRefArgs,
  parseBenchArgs,
  planJobs,
} from "../../../engine/plan.ts";
import { metrics } from "../../../engine/scorers/custom-passages/aggregate.ts";
import {
  scoreResult,
  type Scored,
} from "../../../engine/scorers/custom-passages/score.ts";

const PATTERN_REASON = "Matches the format of a label example.";
const refArgs = benchRefArgs(process.argv.slice(2));
const ext = await materializeExtRef(
  resolveExtRepo(refArgs.extRepo),
  resolveExtRefName(refArgs.ref),
);
const api = await loadExtApi(ext.bundle);
const options = parseBenchArgs(process.argv.slice(2), api);
const { dataset } = compileDataset({
  requireSplit: !options.allowMissingSplit,
  profiles: options.profiles,
});
if (!dataset) throw new Error("dataset is invalid: run `npm run validate`");
if (api.kind !== "completion")
  throw new Error(`${ext.ref} is not a completion-design ref`);
const { cases, jobsByModel } = planJobs(
  dataset,
  options,
  ext.sha,
  api.defaultPrompt,
  true,
);
const byId = new Map(cases.map((c) => [c.id, c]));
const profiles = new Map(dataset.profiles.map((p) => [p.id, p]));

type Finding = {
  category: string;
  start: number;
  end: number;
  value?: string;
  reason?: string;
};
/**
 * Replays a result's cached answers through the ref's `runReview`, in request
 * order; `filter: false` withholds the answer probabilities, turning the
 * confidence filter off.
 */
const replay = async (
  record: ResultRecord,
  text: string,
  rules: Parameters<typeof api.runReview>[3],
  filter: boolean,
) => {
  let next = 0;
  const client: ModelClientLike = {
    async review() {
      const chunk = record.chunks[next++];
      if (!chunk)
        throw new Error(`${record.caseId}: more requests than cached answers`);
      const runtime =
        chunk.runtime && !filter
          ? { ...chunk.runtime, answerProbability: undefined }
          : chunk.runtime;
      return { output: chunk.output, runtime };
    },
  };
  const { findings } = await api.runReview(
    text,
    "",
    client,
    rules,
    record.model,
    { backend: "wasm", quantization: "auto" },
  );
  if (next !== record.chunks.length)
    throw new Error(
      `${record.caseId}: ${next} requests for ${record.chunks.length} cached answers`,
    );
  return findings as Finding[];
};
const key = (f: Finding) => `${f.category}:${f.start}:${f.end}`;

const variants = [
  "filter + patterns",
  "patterns only",
  "filter only",
  "neither",
] as const;
for (const [model, jobs] of jobsByModel) {
  const cache = loadCache(ext.sha, model);
  const rows: Record<(typeof variants)[number], Scored[]> = {
    "filter + patterns": [],
    "patterns only": [],
    "filter only": [],
    neither: [],
  };
  let missing = 0;
  let mismatches = 0;
  for (const job of jobs) {
    const record = cache.get(job.key);
    if (!record) {
      missing++;
      continue;
    }
    const c = byId.get(job.caseId)!;
    const instructions = api.composeReviewInstructions(
      job.systemInstruction,
      job.rules,
    );
    const score = (findings: Finding[]) =>
      scoreResult(
        c,
        profiles.get(c.profile)!,
        {
          ...record,
          findings: findings.map(({ category, start, end, value }) => ({
            category,
            start,
            end,
            value,
          })),
        },
        [],
        instructions,
        true,
      );
    if (record.error) {
      for (const v of variants) rows[v].push(score([]));
      continue;
    }
    const withFilter = await replay(record, job.text, job.rules, true);
    const withoutFilter = await replay(record, job.text, job.rules, false);
    if (withFilter.map(key).join() !== record.findings.map(key).join())
      mismatches++;
    const modelOnly = (findings: Finding[]) =>
      findings.filter((f) => f.reason !== PATTERN_REASON);
    rows["filter + patterns"].push(score(withFilter));
    rows["patterns only"].push(score(withoutFilter));
    rows["filter only"].push(score(modelOnly(withFilter)));
    rows.neither.push(score(modelOnly(withoutFilter)));
  }
  const pct = (x: number | null | undefined) =>
    x === null || x === undefined ? "-" : (100 * x).toFixed(1);
  console.log(
    `\n${model} @ ${ext.sha.slice(0, 7)}: ${jobs.length - missing}/${jobs.length} cached cases, replay mismatches ${mismatches}`,
  );
  console.log(
    "| variant | F1o | P | R | F1x | det | FPR | EN F1 / FPR | FR F1 / FPR |\n|---|---|---|---|---|---|---|---|---|",
  );
  for (const v of variants) {
    const m = metrics(rows[v]);
    const lang = (l: string) => {
      const x = metrics(rows[v].filter((r) => r.lang === l));
      return `${pct(x.overlap.f1)} / ${pct(x.falsePositiveRate)}`;
    };
    console.log(
      `| ${v} | ${pct(m.overlap.f1)} | ${pct(m.overlap.precision)} | ${pct(m.overlap.recall)} | ${pct(m.exact.f1)} | ${pct(m.caseDetection)} | ${pct(m.falsePositiveRate)} | ${lang("en")} | ${lang("fr")} |`,
    );
  }
}
