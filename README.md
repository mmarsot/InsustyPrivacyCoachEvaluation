# InsustyReviewBench

An offline, repeatable benchmark for the **local AI review** of
[InsustyPromptCoach](https://github.com/mmarsot/InsustyPromptCoach): the
browser-local small language model that scans a prompt for passages matching
the user's custom labels (unreleased product names, deal codenames, customer
IDs...) before it is sent to a chatbot.

It is a separate data-science project, not part of the extension. It has three
parts:

- **Dataset**: 809 fictional prompts written like real people write them, in
  English and French. They cover 8 client profiles, and each prompt has
  `{label, passage}` ground truth.
- **Runner**: runs the extension's own review code from any git ref, on each
  bundled model. It caches every result.
- **Report**: produces a static HTML report and CSV/JSONL results, and can
  compare two runs.

## Quick start

```bash
npm install
# Point the bench at a local clone of the extension (read-only, never modified):
echo '{ "extRepo": "../InsustyPromptCoach" }' > bench.local.json   # untracked
npm run validate                       # check the dataset
npm run bench -- --tier smoke          # 8 cases per model, a few minutes
npm run bench -- --dry-run             # print the plan and the time estimate only
npm run bench                          # quick tier: 32 cases x 3 models, ~30 min
open runs/<run-name>/report.html
```

Instead of `bench.local.json`, you can set `INSUSTY_EXT_REPO=<path>` or pass
`--ext-repo <path>`. Relative paths resolve from this repository's root. Model
weights (133 to 512 MB each) are downloaded from Hugging Face on first use into
`cache/models/`.

## What it measures

Each job runs one configuration on one case. A configuration has four parts:

| Axis | Values |
| --- | --- |
| Model | the 3 bundled models, q8 on WASM (`models/models.json`) |
| System instruction | `current` (the ref's `DEFAULT_SLM_PROMPT`), `strict` ("privacy scanner, not an assistant"), `short` (`src/variants.ts`) |
| Label description | `desc`, `desc_ex1`, `desc_ex3`, `ex3` (examples only), `ex_counter` (examples and counter-examples), all built from `dataset/profiles/*.json` |
| Cases | profile, language, type, difficulty, length, writing style |

Every case runs with its profile's custom labels, using the chosen description
variant. Decoding is deterministic (greedy).

Metrics are reported overall, per label, and per language, profile, type,
difficulty, length bucket, register and error level:

- **Passage level:**
  - Precision, recall and F1, in two variants. **Overlap**: a finding with the
    right label overlaps an expected passage. **Exact**: the accepted text
    equals the expected passage.
  - Recall regardless of label.
- **Case level:**
  - Detection: positive cases where at least one expected passage was found.
  - False-positive rate: negative cases with any custom-label finding.
- **Format compliance:** the output is only `LABEL: passage` lines or `NONE`.
- **Failure modes:**
  - `timeout`: hit the ref's 30 s generation budget.
  - `echo`: copied the prompt back.
  - `echo_instructions`: recited the label list.
  - `answered`: answered the prompt instead of scanning it.
  - `unknown_label`: used a label that is not configured.
  - `hallucinated`: gave a passage that is not in the text, so anchoring dropped it.
- **Latency and output length:** latency p50 and p95, and generated tokens.

Findings are scored as the extension would accept them: they are the output of
the ref's own `reviewPrompt` parser and anchoring. Language results are shown
next to each model's advertised language support. For example, SmolLM2 is
English-first, while Qwen2.5 lists French.

## Tiers and runtime

| Tier | Cases | Use |
| --- | --- | --- |
| `smoke` | 16 (one positive and one look-alike negative per profile) | Check that the pipeline works |
| `quick` (default) | 32: 2 dev cases per profile and language, stratified by type across the run (`--cases-per-profile N`) | Fast iteration on prompts and descriptions |
| `full` | all 809 (both splits) | Overnight runs |

The defaults are the `quick` tier, all 3 models, the `current` instruction and
one label-description variant (`desc`). Other axes are opt-in:
`--label-variants desc,desc_ex3` or `all`, and `--instructions all`.

The runner prints its plan and a time estimate before it starts
(`--dry-run` stops there). The estimate uses the mean of cached timings on
this machine, or the priors in `models/models.json`. Estimates on the 8-vCPU,
7 GB laptop this was built on:

- **Default quick run** (32 cases × 3 models × 1 variant): about 30 min. This is
  conservative. The SmolLM2-135M timing comes from runs before `main`'s
  repeated-line stop, which should cut its many 30 s timeouts.
- **Quick with 3 cases per profile:** about 45 min.
- **Quick with 10 cases per profile and 2 variants:** about 3 h.
- **Full tier, 1 variant:** about 12 h.
- **Full tier, all axes** (3 instructions × 5 variants): about 190 h.

Cached jobs are never recomputed. A job is keyed by the extension commit,
model, instruction text, rule texts, case id and case text. Rerunning the same
command after a change computes only what changed. With nothing new to
compute, a rerun just rescores and rewrites the report. `--cached-only`
computes nothing: it reports whatever is cached for that plan and marks the
run incomplete when jobs are missing.

Useful flags:

- `--cases-per-profile 3` (quick tier volume)
- `--models smollm2-135m,qwen2.5-0.5b`
- `--label-variants desc,desc_ex3` or `all` (alias `--labels`)
- `--instructions all`
- `--split test`
- `--profiles dev,hr`
- `--langs fr`
- `--ref <git ref>` (default `main`)
- `--name my-run`
- `--max-rss-mb 3800`
- `--dry-run`
- `--cached-only`

## Results so far

[`runs/quick-partial-81fb9b5/report.html`](runs/quick-partial-81fb9b5/report.html)
is a **partial** run. It covers the PR #17 branch commit `81fb9b5` (before its
squash-merge into `main`), with the older 10-cases-per-profile quick tier and
the `desc` and `desc_ex3` variants. It was stopped on request after 291 of 960
jobs:

- SmolLM2-135M, `desc`: all 160 cases.
- SmolLM2-135M, `desc_ex3`: 125 cases.
- Qwen2.5-0.5B, `desc_ex3`: 6 smoke cases only.

What it shows for SmolLM2-135M, the extension's default model:

- **Outcome:** it found 1 expected passage across 285 cases, and had no false
  positives on negatives.
- **Format:** only 11-16% of outputs follow the line protocol.
- **Timeouts:** 66% of cases hit the 30 s budget, almost all in repeated-line
  loops (167 of the 187 timeouts repeat a line).
- **Other failures:** it recited the label list back (`echo_instructions`, 16%),
  echoed the prompt (10%), or answered it (6%).

`main` has since added a stop on repeated lines, so the next run on `main`
should show far fewer timeouts. The other two models still need a run.

## Dashboard

```bash
npm run dashboard            # http://127.0.0.1:4380/  (--port, --ref, --ext-repo)
```

The dashboard is a small read-only local server: plain `node:http` and one
static page, no framework, about 200 MB of RAM (plus one model process while
the Playground has a model loaded). It reads the dataset, the
result cache and `runs/`, and it never writes, so it is safe to leave open
during a bench run. It finds runs in progress automatically. Each bench
process registers in `cache/active-runs/`, and on Linux the dashboard also
scans `/proc`. It then rebuilds the run's exact plan from its arguments and
compares it with the cache.

It has five views:

- **Live.** One card per bench run in progress, refreshed every 5 s. It shows
  overall done/total and ETA. For each model it shows status
  (running/pending/done), throughput, median time per case and ETA. For each
  model × instruction × label description it shows progress, timeouts, errors
  and failure-mode counts so far. It also lists the latest results.
- **Experiments.** The full planned matrix for the quick and full tiers, on all
  axes (3 models × 3 instructions × 5 label descriptions). Each cell shows
  done/total, a status (done, running, partial or pending) and the estimated
  remaining time.
- **Results.** Pick a committed run, or a LIVE run whose results are scored as
  they arrive. Group by one or two dimensions: model, language, profile, label
  description, case type, error level, register, failure mode, and more.
  - Filters on every dimension.
  - A bar chart of any metric, plus the full metrics table.
  - Grouping by model × language adds each model's advertised language support.
  - A case list with TP/FN/FP/TN verdicts. Click a case for the drill-down: the
    prompt with found, missed and false-positive passages highlighted, the
    system instruction, the label descriptions of the variant used, the ground
    truth, the parsed findings with their verdicts, the raw model output,
    latency, tokens and finish reason.
- **Compare.** Any two runs, committed or live, on their shared (configuration,
  case) results, overall and by language.
- **Playground.** Talk to one bundled model to see its limits (below).

### Chat playground

The Playground view (`#playground`) loads **one** bundled model at a time,
q8 on WASM like the bench, in its own child process (`src/playground/host.ts`).
Loading another model or pressing *Unload* kills that process, so the
operating system gets all of its memory back. The header shows load time,
current and peak RSS (from `/proc`), context length and WASM threads. It
handles one request at a time; a second one gets HTTP 409 while it is busy.
Rough RSS on this laptop: SmolLM2-135M about 1 GB. Qwen2.5-0.5B can peak above
3 GB while loading, so do not load it while a bench run is going.

- **Free chat.** Editable system message, user message and optional assistant
  prefill, max new tokens, greedy or sampling (temperature, top-p, not seeded)
  and a wall-clock deadline. The whole history is re-sent each turn. For every
  turn it shows the exact text the model continues (chat template with role
  markers, plus the prefill), prompt and generated token counts, the raw
  completion with special tokens, latency, first-token time and the finish
  reason (`eos`, `max_new_tokens`, `deadline`, `context`).
- **Extension review preset.** Runs the extension ref's own `reviewPrompt`
  through its own `SlmEngine`: `composeReviewInstructions`,
  `frameReviewChunk` framing, the `SLM_REPLY_PREFILL` prefill, pagination, the
  stop rule, the generation budget, parsing and anchoring. Custom labels and
  descriptions are editable, under the extension's constraints. You can load
  them from a dataset profile in any description variant, and pick dev-split
  example texts (the test split stays out). Each engine request shows the
  rendered prompt, its token count, the raw completion and the runtime report.
  The accepted findings are highlighted in the text, next to the dataset's
  ground truth when the text is an unedited example.

The playground calls the model only when you click; it writes no files.

## How it runs the extension's code

The runner never modifies the extension clone. It resolves the ref to a commit
and runs `git archive` from the clone's object store into `cache/ext/<sha>/`.
It then bundles that commit's `slm-review`, `slm-engine`, `config` and
`slm-models` modules with esbuild and imports them.

The benchmark therefore runs the shipped code for:

- prompt composition
- `<text_to_scan>` framing
- the `Findings:` prefill
- the line-protocol stop rule
- the generation budget
- parsing and code-side anchoring

The default ref is `main`, which ships the line protocol since PR #17. Pass
`--ref <branch or sha>` to benchmark any other commit.

Inference uses onnxruntime-web WASM in Node, which is the same runtime the
extension uses. Each model runs in its own child process, one model at a time.
[docs/approach.md](docs/approach.md) has the details and the measurements
behind these choices. For example, native onnxruntime-node changes the greedy
output, so the bench does not use it.

## Dataset

- **`dataset/profiles/`** holds 8 fictional clients, each with 1-3 custom labels:
  1. sales rep with an unannounced product
  2. developer on sensitive code
  3. HR recruiting from a competitor
  4. legal / M&A
  5. finance before earnings
  6. customer support
  7. agency with NDA clients
  8. researcher
- **`dataset/cases/<profile>.<lang>.jsonl`** holds about 50 cases per profile
  and language. The type mix is:
  - clear positives: 35%
  - subtle positives: 15%
  - look-alike negatives: 25%
  - clean negatives: 10%
  - hard cases (multi-label, long, code, lists, injection, prompt-as-request): 15%

  French files also include mixed-language cases. Every case records its
  register (email, chat, notes, log, code...) and its error level (none, light,
  heavy).
- **`dataset/style-guides/`** has, for each profile, notes on how people in
  that job really write, with the public sources consulted. Only the style was
  imitated; nothing was copied.
- **Splits:** 30% of cases are a held-out `test` split. It is stratified and
  fixed once assigned. Tune prompts on `dev` only.

Everything is invented: companies, people, codenames and figures.
[docs/dataset.md](docs/dataset.md) has the schema, the ground-truth rules and
**how to add cases**. In short:

1. Append JSONL lines.
2. Run `npm run validate -- --allow-missing-split --profile <p>`.
3. Run `npm run split`.
4. Run `npm run validate`.

The validator rejects passages that are not verbatim substrings of the text,
label examples that leak into case texts, and schema errors.

## Outputs

Each run writes `runs/<name>/`:

- `report.html`: static report, which works offline.
- `results.jsonl`: one scored row per job, with the raw model output.
- `metrics.csv`: long format (config, dimension, value, metric, number).
- `metrics.json`: the same data as nested JSON.
- `run.json`: ref, sha, dataset hash, axes, machine, peak RSS per model and timings.

Other commands:

- `npm run compare -- runs/A runs/B` writes an HTML diff of two runs, computed
  on the configurations and cases they share.
- `npm run report -- runs/A` re-renders the report from `results.jsonl`.
- `npm test` runs the scorer, dashboard data and playground unit tests (the
  playground ones use a fake model process, no weights).
- `npm run typecheck` runs the type checker.

## Repository layout

```
dataset/        profiles, cases, style guides
models/         bundled model metadata (sizes, dtypes, advertised languages + sources)
src/dataset/    schema, loader/validator
src/ext/        extension ref materialization and API surface
src/run/        jobs, tiers, cache, per-model worker, Node Transformers.js loader
src/score/      per-case scoring and aggregation
src/report/     HTML report, run comparison
src/dashboard/  local dashboard (read-only server + static page)
src/playground/ chat playground: request logic, model host process, its manager
src/cli/        validate, split, bench, report, compare
runs/           committed run outputs
cache/          (untracked) model weights, extracted refs, result cache
```
