/**
 * Private AI redaction on documents: custom-label cases of the review
 * dataset (`datasets/insusty-custom/cases/`, dev split only) embedded in Word documents of
 * growing length, read by the module (`redact()` with Private AI off), then
 * reviewed by a model through the model runner (`engine/workers/model.ts`, one
 * model at a time, under the memory guards). Results land in the shared
 * result cache (`results/jobs/review/<sha>/<model>.jsonl`) like any bench job.
 *
 * What it measures: recall of the expected passages and review time against
 * document length, which is the evidence for where the extension's Private
 * AI size threshold for files (`localAi.fileReviewLimit`, 5,000 to 100,000
 * characters, 20,000 by default) should sit.
 */
import type {
  CompiledCase,
  CompiledDataset,
} from "../insusty-custom/schema.ts";
import { rulesFor, jobKey, type Job } from "../../engine/jobs.ts";
import type { ResultRecord } from "../../engine/jobs.ts";
import type { RefReview } from "../../modules/insusty-privacy/ref.ts";
import {
  scoreResult,
  type Scored,
} from "../../engine/scorers/custom-passages/score.ts";
import { fillerParagraphs, rngFor } from "./content.ts";
import type { RedactionModule } from "../../contract/types.ts";
import type { DocTier } from "../../engine/plan.ts";
import { writeDocx } from "./writers/ooxml.ts";

/**
 * One Private AI document: a review case embedded in a Word document of a
 * target length.
 */
export interface AiDocSpec {
  id: string;
  caseId: string;
  profile: string;
  lang: string;
  /** Target length of the document's text, in characters. */
  size: number;
}

/** Profiles of the smoke tier. */
const SMOKE_PROFILES = ["dev", "finance"];

/** Cases per tier: dev split; per profile and language, the first clear positive (and, in `full`, the first look-alike negative). */
export function aiCases(
  dataset: CompiledDataset,
  tier: DocTier,
): CompiledCase[] {
  const out: CompiledCase[] = [];
  const profiles = [...new Set(dataset.cases.map((c) => c.profile))].sort();
  for (const profile of tier === "smoke" ? SMOKE_PROFILES : profiles)
    for (const lang of tier === "smoke" ? ["en"] : ["en", "fr"])
      for (const type of tier === "full"
        ? ["clear_positive", "lookalike_negative"]
        : ["clear_positive"]) {
        const c = dataset.cases
          .filter(
            (x) =>
              x.profile === profile &&
              x.lang === lang &&
              x.type === type &&
              x.split === "dev",
          )
          .sort((a, b) => a.id.localeCompare(b.id))[0];
        if (c) out.push(c);
      }
  return out;
}

/** One document per case and size. */
export const aiSpecs = (cases: CompiledCase[], sizes: number[]): AiDocSpec[] =>
  cases.flatMap((c) =>
    sizes.map((size) => ({
      id: `doc:${c.id}:${size}`,
      caseId: c.id,
      profile: c.profile,
      lang: c.lang,
      size,
    })),
  );

/** A Word document of about `size` characters with the case's text in the middle. */
export function aiDocument(
  spec: AiDocSpec,
  c: CompiledCase,
  seed: number,
): Uint8Array {
  const rng = rngFor(`docbench-ai:${seed}:${spec.id}`);
  const fillerChars = Math.max(0, spec.size - c.text.length);
  const paras = fillerParagraphs(
    c.lang as "en" | "fr",
    Math.round(fillerChars / 6.2),
    rng,
  );
  const middle = Math.floor(paras.length / 2);
  return writeDocx({
    title: c.lang === "en" ? "Working notes" : "Notes de travail",
    body: [...paras.slice(0, middle), c.text, ...paras.slice(middle)].map(
      (text) => ({ type: "p" as const, text }),
    ),
  });
}

/** A Private AI document after the module read it. */
export interface AiDoc {
  spec: AiDocSpec;
  case: CompiledCase;
  /** The case as found in the document's extracted text: same expected passages, offsets moved. */
  inDoc: CompiledCase;
  chars: number;
  readMs: number;
}

/** Builds and reads every AI document with the module. */
export async function readAiDocs(
  specs: AiDocSpec[],
  dataset: CompiledDataset,
  module: RedactionModule,
  seed: number,
): Promise<AiDoc[]> {
  const config = {
    ...module.defaultConfig(),
    privateAi: { runsOn: "off" as const },
  };
  const byId = new Map(dataset.cases.map((c) => [c.id, c]));
  const out: AiDoc[] = [];
  for (const spec of specs) {
    const c = byId.get(spec.caseId)!;
    const checked = await module.redact(
      {
        kind: "document",
        name: "notes.docx",
        bytes: aiDocument(spec, c, seed),
      },
      config,
    );
    const read = {
      text: checked.text,
      readMs: checked.runtime.stages.find((s) => s.stage === "read")?.ms ?? 0,
    };
    const at = read.text.indexOf(c.text);
    if (at < 0)
      throw new Error(
        `${spec.id}: the case text is not in the extracted document text`,
      );
    out.push({
      spec,
      case: c,
      inDoc: {
        ...c,
        id: spec.id,
        text: read.text,
        spans: c.spans.map((s) => ({
          ...s,
          start: s.start + at,
          end: s.end + at,
        })),
      },
      chars: read.text.length,
      readMs: read.readMs,
    });
  }
  return out;
}

/**
 * Bench jobs for the model worker: the `desc` label descriptions with their
 * examples, and no system instruction (package refs have none; job keys keep
 * it empty).
 */
export function aiJobs(
  docs: AiDoc[],
  dataset: CompiledDataset,
  ext: { sha: string },
  model: string,
): Job[] {
  const profiles = new Map(dataset.profiles.map((p) => [p.id, p]));
  return docs.map((d) => {
    const rules = rulesFor(profiles.get(d.case.profile)!, "desc", true);
    return {
      key: jobKey({
        extSha: ext.sha,
        model,
        systemInstruction: "",
        rules,
        caseId: d.spec.id,
        text: d.inDoc.text,
      }),
      caseId: d.spec.id,
      model,
      instruction: "current",
      labelVariant: "desc",
      systemInstruction: "",
      rules,
      text: d.inDoc.text,
    };
  });
}

/**
 * One reviewed document: passages found against expected, false positives,
 * review time in milliseconds.
 */
export interface AiPoint {
  id: string;
  model: string;
  caseId: string;
  profile: string;
  lang: string;
  size: number;
  chars: number;
  expected: number;
  found: number;
  falsePositives: number;
  reviewMs: number;
  requests: number;
  failure: string;
  /** Hosted models: what the review cost (cached usage). */
  usd?: number;
  inputTokens?: number;
  error?: string;
}

/**
 * Scores each document's cached review with the bench's scorer, echoes
 * checked against the instructions the ref prepares; documents without a
 * cached result are left out.
 */
export async function scoreAi(
  docs: AiDoc[],
  jobs: Job[],
  records: Map<string, ResultRecord>,
  dataset: CompiledDataset,
  review: Pick<RefReview, "instructions">,
): Promise<AiPoint[]> {
  const profiles = new Map(dataset.profiles.map((p) => [p.id, p]));
  const out: AiPoint[] = [];
  for (const [i, d] of docs.entries()) {
    const job = jobs[i]!;
    const record = records.get(job.key);
    if (!record) continue;
    const s: Scored = scoreResult(
      d.inDoc,
      profiles.get(d.case.profile)!,
      record,
      [],
      await review.instructions(job.rules),
      true,
    );
    out.push({
      id: d.spec.id,
      model: job.model,
      caseId: d.case.id,
      profile: d.case.profile,
      lang: d.case.lang,
      size: d.spec.size,
      chars: d.chars,
      expected: s.expected.length,
      found: s.expected.filter((e) => e.overlap).length,
      falsePositives: s.predicted.filter((p) => !p.overlap).length,
      reviewMs: record.reviewMs,
      requests: record.chunks.length,
      failure: s.failure,
      ...(record.chunks.some((c) => c.usage)
        ? {
            usd:
              Math.round(
                record.chunks.reduce((a, c) => a + (c.usage?.costUsd ?? 0), 0) *
                  1e6,
              ) / 1e6,
            inputTokens: record.chunks.reduce(
              (a, c) => a + (c.usage?.inputTokens ?? 0),
              0,
            ),
          }
        : {}),
      ...(record.error ? { error: record.error } : {}),
    });
  }
  return out;
}

/** One model's Private AI results by document size, with a time fit. */
export interface AiSummary {
  model: string;
  /** Per size: recall of expected passages, false positives, median and max review time, timeouts. */
  bySize: Array<{
    size: number;
    chars: number;
    cases: number;
    expected: number;
    found: number;
    recall: number | null;
    falsePositives: number;
    reviewMsP50: number;
    reviewMsMax: number;
    requestsP50: number;
    errors: number;
    usd?: number;
  }>;
  /** Hosted models: USD of all its reviews here, and per document. */
  usd?: number;
  /** Review time = a * chars^b. */
  fit: { a: number; b: number; r2: number } | null;
  /**
   * Largest document (characters) whose median review stays within 30 s, 60 s and 120 s, by the fit;
   * never past the largest document measured (`atLeast`: the budget was not reached there).
   */
  within: Record<string, { chars: number; atLeast: boolean } | null>;
}

const p50 = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? s[Math.floor((s.length - 1) / 2)]! : 0;
};

/**
 * Summarizes points per model; `fit` is the power-law fitter `aggregate.ts`
 * uses.
 */
export function summarizeAi(
  points: AiPoint[],
  fit: (
    pts: Array<[number, number]>,
  ) => { a: number; b: number; r2: number } | null,
): AiSummary[] {
  return [...new Set(points.map((p) => p.model))].map((model) => {
    const mine = points.filter((p) => p.model === model);
    const sizes = [...new Set(mine.map((p) => p.size))].sort((a, b) => a - b);
    const bySize = sizes.map((size) => {
      const at = mine.filter((p) => p.size === size);
      const expected = at.reduce((n, p) => n + p.expected, 0);
      const found = at.reduce((n, p) => n + p.found, 0);
      return {
        size,
        chars: Math.round(at.reduce((n, p) => n + p.chars, 0) / at.length),
        cases: at.length,
        expected,
        found,
        recall: expected ? found / expected : null,
        falsePositives: at.reduce((n, p) => n + p.falsePositives, 0),
        reviewMsP50: p50(at.map((p) => p.reviewMs)),
        reviewMsMax: Math.max(...at.map((p) => p.reviewMs)),
        requestsP50: p50(at.map((p) => p.requests)),
        errors: at.filter((p) => p.error).length,
        ...(at.some((p) => p.usd !== undefined)
          ? {
              usd:
                Math.round(at.reduce((n, p) => n + (p.usd ?? 0), 0) * 1e6) /
                1e6,
            }
          : {}),
      };
    });
    const f = fit(bySize.map((b) => [b.chars, b.reviewMsP50]));
    const largest = Math.max(...bySize.map((b) => b.chars));
    const within = Object.fromEntries(
      [30, 60, 120].map((s) => {
        if (!f || f.b <= 0) return [`${s}s`, null];
        const chars = ((s * 1000) / f.a) ** (1 / f.b);
        return [
          `${s}s`,
          !Number.isFinite(chars) || chars >= largest
            ? { chars: largest, atLeast: true }
            : { chars: Math.round(chars), atLeast: false },
        ];
      }),
    );
    const hosted = mine.some((p) => p.usd !== undefined);
    return {
      model,
      bySize,
      fit: f,
      within,
      ...(hosted
        ? {
            usd:
              Math.round(mine.reduce((n, p) => n + (p.usd ?? 0), 0) * 1e6) /
              1e6,
          }
        : {}),
    };
  });
}
