/**
 * Materializes one git ref of the extension so the bench runs exactly the
 * code that ships, without touching the extension clone's working tree:
 *
 *   1. `git rev-parse <ref>^{commit}` resolves the ref to a commit sha.
 *   2. `git archive <sha> src package.json | tar -x` copies that commit's
 *      sources out of the clone's object store into `cache/ext/<sha>/`.
 *   3. esbuild bundles the review modules (prompt building, output parsing,
 *      generation engine) into `cache/ext/<sha>/bench-ext.mjs`, leaving
 *      `@huggingface/transformers` external so the bench supplies it.
 *
 * Nothing is ever written to the extension repo: no checkout, no worktree,
 * no install, no build.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { isAbsolute, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { build } from "esbuild";
import { EXT_CACHE_DIR, LOCAL_CONFIG_FILE, ROOT } from "../paths.ts";

/** Default extension ref: `main`, which ships the line protocol since PR #17. */
export const DEFAULT_EXT_REF = "main";

/** Modules the bench imports from the ref, by export name. The first four are required. */
const MODULES: ReadonlyArray<{ name: string; file: string; required: boolean }> = [
  { name: "review", file: "src/slm-review.ts", required: true },
  { name: "engine", file: "src/slm-engine.ts", required: true },
  { name: "config", file: "src/config.ts", required: true },
  { name: "models", file: "src/slm-models.ts", required: true },
  { name: "generation", file: "src/slm-generation.ts", required: false },
];

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

const git = (repo: string, args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();

/** Resolves a ref to its commit, read-only. */
export function resolveCommit(repo: string, ref: string): { sha: string; subject: string; committedAt: string } {
  const sha = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return { sha, subject: git(repo, ["log", "-1", "--format=%s", sha]), committedAt: git(repo, ["log", "-1", "--format=%cI", sha]) };
}

/** Extracts `paths` of a commit into `dir` with `git archive` (the clone is never touched). Missing paths are skipped. */
export function archiveCommit(repo: string, sha: string, paths: string[], dir: string): void {
  const present = paths.filter((p) => {
    try {
      git(repo, ["cat-file", "-e", `${sha}:${p}`]);
      return true;
    } catch {
      return false;
    }
  });
  const tar = execFileSync("git", ["-C", repo, "archive", "--format=tar", sha, ...present], { maxBuffer: 256 * 1024 * 1024 });
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
}

export interface ExtRef {
  ref: string;
  sha: string;
  subject: string;
  committedAt: string;
  dir: string;
  bundle: string;
  /** `@huggingface/transformers` range declared by the ref's package.json. */
  transformersRange?: string;
}

/** Resolves and materializes a ref; cached per commit sha. */
export async function materializeExtRef(repo: string, ref: string): Promise<ExtRef> {
  const { sha, subject, committedAt } = resolveCommit(repo, ref);
  const dir = join(EXT_CACHE_DIR, sha);
  const bundle = join(dir, "bench-ext.mjs");
  if (!existsSync(bundle)) {
    const staging = `${dir}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    archiveCommit(repo, sha, ["src", "package.json"], staging);
    const present = MODULES.filter((m) => existsSync(join(staging, m.file)));
    const missing = MODULES.filter((m) => m.required && !present.includes(m));
    if (missing.length)
      throw new Error(`Ref ${ref} (${sha.slice(0, 8)}) lacks ${missing.map((m) => m.file).join(", ")}; the bench cannot drive it.`);
    writeFileSync(
      join(staging, "bench-entry.ts"),
      present.map((m) => `export * as ${m.name} from "./${m.file}";`).join("\n") + "\n",
    );
    await build({
      entryPoints: [join(staging, "bench-entry.ts")],
      outfile: join(staging, "bench-ext.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      external: ["@huggingface/transformers"],
      logLevel: "error",
    });
    rmSync(dir, { recursive: true, force: true });
    renameSync(staging, dir);
  }
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
  };
  return {
    ref,
    sha,
    subject,
    committedAt,
    dir,
    bundle,
    transformersRange: pkg.dependencies?.["@huggingface/transformers"],
  };
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
    SlmEngine: need(mod.engine?.SlmEngine, "SlmEngine") as ExtApi["SlmEngine"],
  };
  type Fn = (...args: unknown[]) => unknown;
  if (typeof review.composeLabelPrefix === "function") {
    const sets = need(review.reviewInstructionSets, "reviewInstructionSets") as (rules: Rule[]) => string[];
    const reviewPrompt = need(review.reviewPrompt, "reviewPrompt") as Fn;
    const withExamples = (rules: Rule[]) => rules.map((r) => ({ ...r, examples: r.examples ?? [] }));
    return {
      ...common,
      kind: "completion",
      defaultPrompt: "",
      composeReviewInstructions: (_s, rules) => sets(withExamples(rules)).join("\n\n"),
      preparedInstructions: (_s, rules) => sets(withExamples(rules)),
      reviewCategories: () => [],
      runReview: (text, _s, client, rules, model, selection) =>
        reviewPrompt(text, client, withExamples(rules), model, selection) as Promise<{ findings: FindingLike[] }>,
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
