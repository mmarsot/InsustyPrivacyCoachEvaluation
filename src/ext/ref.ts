/**
 * The extension ref the bench drives, and the lab's view of the ref's Private
 * AI internals (`loadExtApi`). Materialization is the one materializer of
 * `src/module/materialize.ts` (one bundle per commit, read-only on the
 * clone); the harness scores refs through the redaction contract
 * (`src/module/insusty.ts`). `ExtApi` stays for the prompt lab, the
 * playground and diagnostics that need the ref's prompt composition.
 */
import { existsSync, readFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { materializeModule, runtimeMismatches } from "../module/materialize.ts";
import { LOCAL_CONFIG_FILE, ROOT } from "../paths.ts";
export { archiveCommit, resolveCommit } from "../module/materialize.ts";

/** Default extension ref: `main`, which ships the line protocol since PR #17. */
export const DEFAULT_EXT_REF = "main";

interface LocalConfig {
  extRepo?: string;
  extRef?: string;
}

const readLocalConfig = (): LocalConfig => {
  if (!existsSync(LOCAL_CONFIG_FILE)) return {};
  return JSON.parse(readFileSync(LOCAL_CONFIG_FILE, "utf8")) as LocalConfig;
};

/**
 * Where the extension clone lives: `--ext-repo`, then `INSUSTY_EXT_REPO`, then
 * `extRepo` in the untracked `bench.local.json`, then a sibling
 * `../InsustyPromptCoach` checkout. Relative paths resolve from the bench root.
 */
export function resolveExtRepo(cli?: string): string {
  const configured = cli ?? process.env.INSUSTY_EXT_REPO ?? readLocalConfig().extRepo ?? "../InsustyPromptCoach";
  const path = isAbsolute(configured) ? configured : resolve(ROOT, configured);
  if (!existsSync(join(path, ".git")))
    throw new Error(
      `Extension clone not found at ${path}. Pass --ext-repo <path>, set INSUSTY_EXT_REPO, or add {"extRepo": "<path>"} to bench.local.json.`,
    );
  return path;
}

export function resolveExtRefName(cli?: string): string {
  return cli ?? process.env.INSUSTY_EXT_REF ?? readLocalConfig().extRef ?? DEFAULT_EXT_REF;
}

export interface ExtRef {
  ref: string;
  sha: string;
  subject: string;
  committedAt: string;
  dir: string;
  bundle: string;
  /** Inference runtime packages whose bench version differs from the ref's lockfile (empty when they agree). */
  runtimeMismatches: string[];
}

/** Resolves and materializes a ref; cached per commit sha. */
export async function materializeExtRef(repo: string, ref: string, log?: (line: string) => void): Promise<ExtRef> {
  const m = await materializeModule(repo, ref, log);
  return { ref, sha: m.sha, subject: m.subject, committedAt: m.committedAt, dir: m.dir, bundle: m.bundle, runtimeMismatches: runtimeMismatches(m) };
}

/**
 * The subset of the ref's exports the bench relies on, normalized over the two
 * review designs the extension has shipped:
 *   - `chat` (PR #17 line protocol): one chat request per chunk with a system
 *     instruction, the fixed output schema and the label list;
 *   - `completion` (per-label completion framing with label examples): one
 *     plain-text request per custom label, no system instruction.
 * `runReview` and `preparedInstructions` hide the difference from callers.
 */
export interface ExtApi {
  kind: "chat" | "completion";
  /** The ref's default system instruction; "" for completion refs (they have none). */
  defaultPrompt: string;
  generationBudgetMs: number;
  modelIds: string[];
  /** The model a new user gets (`DEFAULT_SLM_MODEL_ID`, else the first bundled model). */
  defaultModelId: string;
  /** The instruction text as one string (for display and echo detection). */
  composeReviewInstructions(systemInstruction: string, rules: Rule[]): string;
  /** The prefixes the engine should prepare for these settings. */
  preparedInstructions(systemInstruction: string, rules: Rule[]): string[];
  /** Built-in labels the model may return (none for completion refs). */
  reviewCategories(rules: Rule[]): string[];
  runReview(
    text: string,
    systemInstruction: string,
    client: ModelClientLike,
    rules: Rule[],
    model: string,
    selection: RuntimeSelection,
    /** Completion refs: the ref's context budget in tokens (chunk size); default the ref's own. */
    contextBudget?: number,
  ): Promise<{ findings: FindingLike[] }>;
  // SlmEngine constructor from src/slm-engine.ts.
  SlmEngine: new (loader: unknown) => EngineLike;
  /** Chat refs only (PR #17+): data framing and reply prefill. */
  frameReviewChunk?: (text: string) => string;
  replyPrefill?: string;
  outputSchema?: string;
}

export interface Rule {
  label: string;
  prompt: string;
  /** Completion refs: up to three example passages (demonstrations use the first two). */
  examples?: string[];
}
export interface RuntimeSelection {
  backend: "wasm";
  quantization: "auto" | "q8" | "q4";
}
export interface ReviewRequestLike {
  instructions: string;
  input: string;
  responsePrefill?: string;
}
export interface RuntimeReportLike {
  backend: string;
  quantization: string;
  promptTokens: number;
  generatedTokens: number;
  finishReason: string;
  prefixReused?: boolean;
  fallbackReason?: string;
  /** Answer confidence (lowest answer-token probability); the ref's confidence filter drops a less confident answer. */
  answerProbability?: number;
}
export interface ModelClientLike {
  review(request: ReviewRequestLike, model?: string, selection?: RuntimeSelection): Promise<{ output: unknown; runtime?: RuntimeReportLike }>;
}
export interface FindingLike {
  category: string;
  start: number;
  end: number;
  value?: string;
}
export interface EngineLike {
  prepare(model: string, selection: RuntimeSelection, instructions: readonly string[]): Promise<unknown>;
  review(
    model: string,
    selection: RuntimeSelection,
    request: ReviewRequestLike,
    budgetMs: number,
  ): Promise<{ output: string; runtime: RuntimeReportLike }>;
}

/** Imports a materialized bundle and checks the exports the bench needs. */
export async function loadExtApi(bundle: string): Promise<ExtApi> {
  const mod = (await import(pathToFileURL(bundle).href)) as Record<string, Record<string, unknown>>;
  const review = mod.review ?? {};
  const need = (value: unknown, what: string) => {
    if (value === undefined) throw new Error(`The extension ref does not export ${what}.`);
    return value;
  };
  const models = need(mod.models?.SLM_MODELS, "SLM_MODELS") as ReadonlyArray<{ id: string }>;
  const common = {
    generationBudgetMs: (review.SLM_GENERATION_BUDGET_MS as number | undefined) ?? 30_000,
    modelIds: models.map((m) => m.id),
    defaultModelId: (mod.models?.DEFAULT_SLM_MODEL_ID as string | undefined) ?? models[0]!.id,
    SlmEngine: need(mod.engine?.SlmEngine, "SlmEngine") as ExtApi["SlmEngine"],
  };
  type Fn = (...args: unknown[]) => unknown;
  if (typeof review.composeLabelPrefix === "function") {
    const sets = need(review.reviewInstructionSets, "reviewInstructionSets") as (rules: Rule[]) => string[];
    const reviewPrompt = need(review.reviewPrompt, "reviewPrompt") as Fn;
    // Since PR #52 a rule also carries what the label learned from reviews (`learned`); the bench runs a new
    // user's labels, which have learned nothing. Older refs ignore the extra field.
    const withExamples = (rules: Rule[]) => rules.map((r) => ({ ...r, examples: r.examples ?? [], learned: { examples: [], falseAlarms: [] } }));
    return {
      ...common,
      kind: "completion",
      defaultPrompt: "",
      composeReviewInstructions: (_s, rules) => sets(withExamples(rules)).join("\n\n"),
      preparedInstructions: (_s, rules) => sets(withExamples(rules)),
      reviewCategories: () => [],
      runReview: (text, _s, client, rules, model, selection, contextBudget) =>
        reviewPrompt(text, client, withExamples(rules), model, selection, ...(contextBudget === undefined ? [] : [contextBudget])) as Promise<{ findings: FindingLike[] }>,
    };
  }
  const compose = need(review.composeReviewInstructions, "composeReviewInstructions") as ExtApi["composeReviewInstructions"];
  const reviewPrompt = need(review.reviewPrompt, "reviewPrompt") as Fn;
  return {
    ...common,
    kind: "chat",
    defaultPrompt: need(mod.config?.DEFAULT_SLM_PROMPT, "DEFAULT_SLM_PROMPT") as string,
    composeReviewInstructions: compose,
    preparedInstructions: (s, rules) => [compose(s, rules)],
    reviewCategories: need(review.reviewCategories, "reviewCategories") as ExtApi["reviewCategories"],
    runReview: (text, s, client, rules, model, selection) =>
      reviewPrompt(text, [], s, client, undefined, undefined, rules, model, selection) as Promise<{ findings: FindingLike[] }>,
    frameReviewChunk: review.frameReviewChunk as ExtApi["frameReviewChunk"],
    replyPrefill: review.SLM_REPLY_PREFILL as string | undefined,
    outputSchema: review.SLM_OUTPUT_SCHEMA as string | undefined,
  };
}
