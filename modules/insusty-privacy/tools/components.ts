/**
 * Per-component view of a bench run on a ref with the answer-confidence
 * filter and example-derived patterns (extension PR #32): replays the cached
 * model answers through the ref's own package, on a scripted on-device
 * runtime (`runtime/scripted.ts`) that answers each request with the cached
 * answer, with either part switched off, then scores each variant. No model
 * runs.
 *
 *   npm run components -- <the same bench arguments, e.g. --ref main --set tune96 --models smollm2-360m>
 *
 * - filter off: the recorded answer confidence is withheld from the replay;
 * - patterns off: spans the ref found with a pattern are dropped (the ref
 *   keeps a model finding over a pattern match of the same span, so what
 *   remains is exactly the model's findings).
 * The "both on" replay must reproduce the cached findings; mismatches are counted.
 */
import { compileDataset } from "../../../datasets/insusty-custom/load.ts";
import { loadInsustyModule } from "../insusty.ts";
import { materializeModule } from "../materialize.ts";
import { refReview, resolveExtRefName, resolveExtRepo } from "../ref.ts";
import { scriptedRuntime } from "../runtime/scripted.ts";
import {
  loadCache,
  type ResultRecord,
  type Rule,
} from "../../../engine/jobs.ts";
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

const refArgs = benchRefArgs(process.argv.slice(2));
const ext = await materializeModule(
  resolveExtRepo(refArgs.extRepo),
  resolveExtRefName(refArgs.ref),
);
const review = await refReview(ext);
const options = parseBenchArgs(process.argv.slice(2), review);
const { dataset } = compileDataset({
  requireSplit: !options.allowMissingSplit,
  profiles: options.profiles,
});
if (!dataset) throw new Error("dataset is invalid: run `npm run validate`");
const { cases, jobsByModel } = planJobs(dataset, options, ext.sha, "", true);
const byId = new Map(cases.map((c) => [c.id, c]));
const profiles = new Map(dataset.profiles.map((p) => [p.id, p]));

type Finding = {
  category: string;
  start: number;
  end: number;
  value?: string;
  source: string;
};
/**
 * Replays a result's cached answers through the ref's package, in request
 * order; `filter: false` withholds the answer confidences, turning the
 * confidence filter off.
 */
const replay = async (
  record: ResultRecord,
  text: string,
  rules: readonly Rule[],
  filter: boolean,
): Promise<Finding[]> => {
  let next = 0;
  const scripted = scriptedRuntime(() => {
    const chunk = record.chunks[next++];
    if (!chunk)
      throw new Error(`${record.caseId}: more requests than cached answers`);
    const probability = chunk.runtime?.answerProbability;
    return {
      output: chunk.output,
      ...(filter && probability !== undefined ? { probability } : {}),
    };
  });
  const module = await loadInsustyModule(ext, {
    device: () => Promise.resolve(scripted.runtime),
  });
  const out = await module.redact(
    { kind: "text", text },
    {
      ...module.defaultConfig(),
      customLabels: rules.map((r) => ({
        label: r.label,
        description: r.prompt,
        examples: [...(r.examples ?? [])],
      })),
      privateAi: { runsOn: "device", model: record.model },
    },
  );
  await module.dispose?.();
  if (next !== record.chunks.length)
    throw new Error(
      `${record.caseId}: ${next} requests for ${record.chunks.length} cached answers`,
    );
  return out.spans
    .filter((s) => s.kind === "custom")
    .map((s) => ({
      category: s.label,
      start: s.start,
      end: s.end,
      value: text.slice(s.start, s.end),
      source: s.source,
    }));
};
const key = (f: Pick<Finding, "category" | "start" | "end">) =>
  `${f.category}:${f.start}:${f.end}`;

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
    const instructions = await review.instructions(job.rules);
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
      findings.filter((f) => f.source !== "pattern");
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
