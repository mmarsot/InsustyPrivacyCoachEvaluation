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

Next to it, a **deterministic redaction bench** (`npm run detbench`) measures
the extension's rule-based detector with no model: see
[below](#deterministic-redaction-bench). A **document bench**
(`npm run docbench`) measures how the extension checks attached files (Word,
Excel, PowerPoint, OpenDocument, PDF, text and zip): see
[below](#document-bench).

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
- `--models smollm2-135m,qwen2.5-0.5b`; hosted models by name only
  (`nova-micro-prefill`, `nova-micro-system`, [below](#hosted-models-amazon-bedrock)),
  with `--budget-usd 5`
- `--label-variants desc,desc_ex3` or `all` (alias `--labels`)
- `--instructions all`
- `--split test`
- `--profiles dev,hr`
- `--langs fr`
- `--ref <git ref>` (default `main`); refs with the per-label completion
  design are detected automatically (see `docs/approach.md`)
- `--set tune96` (the dev cases of a lab set in `experiments/sets/` instead
  of a tier)
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

## Deterministic redaction bench

```bash
npm run detbench -- --ref main                       # a few seconds, no model
npm run detbench -- --ref main --compare <branch>    # two refs + a comparison page
npm run detbench -- --validate                       # check dataset/detbench/
```

`npm run detbench` scores the extension's rule-based detector
(`detectSensitiveData`, `src/detector.ts`) from any ref, with the ref's default
configuration and with every category and address country on. The ref is
materialized read-only like the model bench, and the detector's npm packages
are installed at the versions its package-lock pins.

- **Dataset** (`dataset/detbench/`): 301 fictional EN/FR prompts with 522
  labelled items across `SECRET`, `EMAIL`, `PHONE`, `ADDRESS`, `FINANCIAL`,
  `NATIONAL_ID`, `DATE_OF_BIRTH`, `IP` and `COMPANY_ID` (the detector
  upgrade's names), plus 496 hard negatives (log timestamps, git SHAs and
  hashes, trace IDs, UUIDs, versions such as `1.2.3.4`, loopback addresses,
  ports, masked keys, public keys, `<password>` placeholders, algorithm
  names and acronyms in prose, base64 images, checksum-invalid IBAN and
  card look-alikes, ordinary dates next to dates of birth, bibliography references with
  DOIs, ISBNs, ISSNs, PMIDs, arXiv ids and DOI/JSTOR/Handle/HAL/Gallica ARK,
  Semantic Scholar and GitHub/GitLab commit links, spreadsheet rows with
  five-digit amounts next to short cells, GPU and driver identifiers in
  about:gpu dumps, environment listings and config files, plain prose). Many
  prompts mix several categories, and 58 are prose around a pasted
  snippet (stack traces, `.env`, docker-compose, SQL output, curl, JSON, git
  output) with values on both sides of the fence. Four are generated, scored
  apart, which measure a false-positive flood and the detector's runtime:
  spreadsheets of 1,000 and 2,000 rows and about:gpu-like reports of 360
  and 600 lines. Values are checksum-valid
  where a checksum exists (IBAN, card, NIR, SIREN/SIRET, VAT, NHS, NINO).
- **Perturbations**: seeded variants of every case (spacing, separators,
  alternative formats, case, line breaks inside values, punctuation, code
  fences, `.env` snippets, stripped accents, typos in context words), scored
  against the same base cases to show the drop per type.
- **Metrics**: precision, recall and F1 per category and language, exact and
  overlapping spans, wrong category, merged spans, leaked characters, flagged
  hard negatives, and prose vs inside code blocks. Categories a ref lacks are
  reported as "not supported by this ref", not as misses.

[docs/detbench.md](docs/detbench.md) has the dataset format, how to add
cases, the perturbations and the metric definitions.

Baseline on `main` @ `4d68779` (after the detector upgrade, PR #42, its gap
fixes, PRs #43 and #45, the reference-link fixes, PRs #72 and #73, and the
spreadsheet fix, PR #74;
[`runs/detbench/main-4d68779/report.html`](runs/detbench/main-4d68779/report.html)),
base cases, `default` config (FR addresses only, `IP` and `COMPANY_ID` off)
and `all` (every category; the ref does not export its address-country list,
so FR addresses only too). The four large generated cases are scored apart
(below):

| | `default` | `all` |
| --- | --- | --- |
| F1 / precision / recall (overlap) | 81% / 85% / 78% | 90% / 87% / 93% |
| F1, exact span | 80% | 89% |
| Items redacted, all categories | 78% | 93% |
| Items redacted in prose (376) / inside code blocks (136) | 77% / 81% | 91% / 97% |
| Negative prompts with a false positive | 17% (14 / 82) | 18% (15 / 82) |
| Hard negatives flagged | 69 / 496 | 70 / 496 |

- Every category is supported. In `default`, `IP` and `COMPANY_ID` are
  opt-in, so their 79 items count as misses: most of the recall gap to `all`.
- **Regression cases** from PRs #43 and #45 (`en-108`–`en-124`,
  `fr-101`–`fr-116`, see [docs/detbench.md](docs/detbench.md#dataset)):
  in `all`, `main` passes all of them, every item exact (in `default`, only
  their opt-in `IP` items are missed).
- **Bibliography references and reference links** (`en-125`–`en-140`,
  `fr-117`–`fr-126`, tag `reference_links`; the captain's report of a DOI
  hidden as `doi:10.[SECRET].001.0001`, then the review of
  [InsustyPromptCoach PR #72](https://github.com/mmarsot/InsustyPromptCoach/pull/72)):
  all pass since
  [PR #73](https://github.com/mmarsot/InsustyPromptCoach/pull/73), which
  stopped the SECRET rule "bounded high-entropy heuristic" from flagging
  Gallica ARK links and hex ids in Semantic Scholar and GitHub/GitLab link
  paths (20 decoys at `cf717aa`). The controls still pass: the `api_key=`,
  `access_token=`, Google key, `ghp_` URL credentials and webhook token next
  to such links are redacted, and the misspelled `ISNB 0-3064-6615-5` is
  redacted as PHONE by design (`en-140`, `fr-125`).
- **Spreadsheet and CSV pastes** (`en-141`–`en-149`, `fr-127`–`fr-134`, tag
  `table_paste`; the document-upload research, where a 60,000-row sheet
  extracted as TSV gave 29,999 false ADDRESS hits in ~11 s): since
  [PR #74](https://github.com/mmarsot/InsustyPromptCoach/pull/74) the TSV
  and CSV cases, both large tables included, have no false positive and every
  email, IBAN and French address in cells is still found (split-cell
  addresses too). Only the space-joined copies still fail: 5 false
  positives in `en-144` (ADDRESS on `35000 note 10000 ok`, a Luhn row as
  FINANCIAL, counts as PHONE) and 3 in `fr-133` (ADDRESS, PHONE). At
  `5540306` the large tables gave 1,998 and 854 false ADDRESS.
- **GPU reports, environment listings and config files** (`en-150`–`en-160`,
  `fr-135`–`fr-141`, tag `env_var_names`; the captain's about:gpu paste,
  where `main` redacted 32 spans in 1,275 lines, all SECRET from the
  "bounded high-entropy heuristic"): the target for the extension fix. Same
  result in both configs:
  - fail, every negative case (11 / 11) and 61 of 90 decoys: GL/EGL/Vulkan
    extension and format names with a mixed part (`GL_EXT_texture_sRGB_decode`,
    `…_s3tc_srgb`, `VK_FORMAT_A2B10G10R10_UNORM_PACK32`,
    `GL_COMPRESSED_RGBA_S3TC_DXT5_EXT`), ANGLE, Chrome and Vulkan feature
    names with digits inside a word (`emulateCopyTexImage2DFromRenderbuffers`,
    `limitMaxTextureBytesTo2MB`, `integerDotProduct4x8BitPackedSignedAccelerated`,
    `VaapiVideoDecoderAV1Main10Profile`), Dawn toggles and WebGPU features
    (`use_blit_for_depth16unorm_texture_to_buffer_copy`,
    `rg11b10ufloat-renderable`), pod and node names with a hash suffix
    (`render-worker-7f8c9d6b5-q4xzt`), laptop model strings and a GNOME
    terminal path holding a UUID with underscores. Uppercase environment
    names with plain values (`XDG_SESSION_TYPE : wayland`, `GDMSESSION=ubuntu`,
    `GPU0 : VENDOR= 0x10de, DEVICE=0x…`, `CONFIG_…=y`, versions, paths,
    booleans) already pass: the names are not the trigger, the token shape is.
  - large, scored apart: `en-160` (608 lines, 40 KB) gives 201 false SECRET
    and `fr-141` (368 lines, 24 KB) 121, in ~25 ms and ~15 ms.
  - pass, controls that a fix must keep (`en-157`–`en-160`,
    `fr-139`–`fr-141`, tag `secret_control`): all 21 secrets under
    environment names are redacted, exact: `API_KEY=` tokens, AWS keys,
    `DATABASE_URL` and `REDIS_URL` passwords, GitHub, GitLab, OpenAI,
    Stripe and Hugging Face tokens, session secrets. Three of them
    (`X_TELEMETRY_KEY=` in `en-157`, `TELEMETRIE_CLE_ENVOI :` in `fr-140`,
    `JETON_TELEMETRIE :` in `fr-141`) are caught only by the same
    high-entropy heuristic, so a fix that skips `NAME=value` or
    `NAME : value` lines would lose them.
- Still missed in `all`: US, UK and DE phones (15), US and UK addresses (9),
  passports (4), dates of birth under a table header (2), 2 French
  passwords, 3 SIRENs and a BIC.
- Hard negatives flagged in `all`: the 61 GPU and environment identifiers
  above, 5 in the space-joined spreadsheet copies, two SSN-shaped part
  numbers as NATIONAL_ID, a Luhn-invalid card look-alike and
  `net-snmp 5.9.4.2` as IP.
- **Perturbations** (`all`, F1 base→perturbed): a line break inside a value
  95%→80%, typos in context words 90%→81%, spacing 95%→88%, punctuation
  95%→90%, `.env` rewrites 95%→90%; the others move F1 by 4 points or less.

## Document bench

```bash
npm run docbench -- --ref main                       # suite + quick size sweeps, a few minutes, no model
npm run docbench -- --ref main --compare <branch>    # two refs + a comparison page
npm run docbench -- --ref main --tier full --ai smollm2-360m   # full sweeps + Private AI on documents
npm run bench -- --track docbench --ref main         # the same from npm run bench
```

`npm run docbench` runs a ref's own file check (`readFileForCheck`,
`readDocument` with PDFium and its Office part map, `detectSensitiveData`,
and its redacted version) on documents generated deterministically from
`dataset/detbench/` (nothing binary is committed): 156 cases, i.e. labelled
values in 55 format × zone pairs (Word footnotes, tracked deletions, hidden
and very hidden sheets, speaker notes, PDF form fields, wrapped and
hyphenated values, nested zips, metadata...), hard-negative documents
(bibliographies, diagnostic dumps, invoices, 10,000-row order sheets) and 23
files that must be reported as not or partly checked (encrypted, scanned,
signed, zip bombs, macros...). It scores extraction apart from detection,
false alarms per page and per 10,000 cells, the classification of each file,
and whether redacted values are really gone from the redacted file (read
back by an independent reader). Size sweeps per type (words, rows, slides,
pages, zip entries) give read, detection and redaction time and peak memory
with fitted scaling; `--ai <model>` adds Private AI review time and recall
against document length. Results are cached per ref commit; the dashboard's
Documents view shows them. [docs/docbench.md](docs/docbench.md) has the
cases, metrics and how to add cases.

Baseline on `main` @ `2aece81` (PR #76; tier `full`, seed 1;
[`runs/docbench/main-2aece81/report.html`](runs/docbench/main-2aece81/report.html)):

| | `default` | `all` |
| --- | --- | --- |
| Values placed / extracted by the ref | 718 / 98% | 718 / 98% |
| Recall / precision / F1 | 68% / 96% / 80% | 84% / 97% / 90% |
| Redacted values gone from the redacted file | 487 / 487 | 598 / 598 |
| Hard-negative documents with a false alarm | 2 / 15 (11) | 3 / 15 (12) |
| Failure files reported correctly / silent cleans | 23 / 23, 0 | 23 / 23, 0 |

- **Extraction** is complete in every Office, OpenDocument, text and zip
  zone, hidden sheets, tracked deletions, speaker notes, comments, metadata,
  embedded and nested files included. The misses are PDF-only: a value
  hyphenated over two lines is never read whole (0/12), and long values in
  narrow PDF table cells wrap (83% extracted there).
- **Detection** (`all`, share of placed values found) follows the detector's own profile (EMAIL 97%,
  FINANCIAL 94%, SECRET 90%, ADDRESS 53%, PHONE 59%), with document-specific
  drops: a value wrapped over two PDF lines is read but found 17% of the
  time, PDF form-field values 58%, CSV cells 42%, xlsx and pptx metadata
  50-60% (label/value pairs without sentence context).
- **False alarms**: base64 blobs in spreadsheet cells and narrow PDF table
  cells come out as SECRET fragments (8 + 3 in the two invoices, 9 in the PDF
  table zone); the 10,000- and 20,000-row order sheets and CSVs give none
  since PR #74.
- **Redaction**: every value redacted leak-free is gone from the attached
  file (independent reader incl. `pdftotext`). Office files go out as text
  copies by design. PDFs are redacted in place except when an email starting
  with `j` has text after it on its line: the ref's check finds "text still
  readable under a box" and the whole PDF falls back to its text copy (5 of
  110 findings in the suite; 7 of 75 dataset emails alone; also the 200- and
  500-page sweep PDFs).
- **Caps**: a spreadsheet whose text passes 2 MB (60,000 rows x 5 cells) is
  skipped whole, not truncated: 12 characters of the workbook are checked
  and the file is reported partly checked (xlsx and ods). Text files past
  2 MB keep their first 2 MB; a 4,000-entry zip drops 512 of its 4,000
  parts (past 2 MB of text, reported).
- **Speed** is linear in text size (fitted exponents 0.91-1.08, R² ≥ 0.98):
  about 0.5 ms per 1,000 characters for txt, docx, odt and csv, ~1-1.5 for
  xlsx and ods (XML parsing), ~2 for pptx, ~3 for PDF (PDFium reading plus
  in-place redaction, 2.7 s of the 5.1 s for 500 pages). Detection is about
  0.5 ms per 1,000 characters everywhere, so a 2 MB text costs ~1 s of rules
  and every type stays under 5 s up to its caps except a 500-page PDF
  (5.1 s). Peak memory stays under 500 MB per document (worker baseline
  ~140 MB).

- **Private AI on documents** (`--ai smollm2-135m --ai-tier smoke`, the
  extension's bundled default model; SmolLM2-360M was skipped by the memory
  guard while other lanes ran): review time grows linearly with document
  length, ~2.9 ms per character (fit `1.43 · chars^1.07`, R² 0.99): 2.5 s at
  1,000 characters, 51 s (median) to 76 s at 20,000 (the default
  `fileReviewLimit`), 141-192 s at 50,000; a 30 s budget holds ~11,000
  characters, 60 s ~21,000. It found none of the 3 expected passages at any
  length (it echoes label examples or the document's author property), so
  this run measures time only; rerun with `--ai smollm2-360m --ai-tier
  quick` when memory allows for recall against length.

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

It has seven views:

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
- **Lab.** Every `npm run lab` result (`experiments/runs/`), sortable by any
  metric and by language, with p95 latency and the segment view; tick two
  rows to compare their outputs case by case. Runs in progress appear with
  their partial results (refreshed every 15 s).
- **Documents.** Document-bench runs (`runs/docbench/`, and runs in
  progress): overview, extraction and detection per format and zone with a
  configuration switch, failure files, hard negatives, scaling charts and
  fits, Private AI curves, a document list with a drill-down (the extracted
  text with found and missed values), the full report and a comparison of
  two runs. The Live view also shows a document-bench run's progress.

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
- **Extension review preset.** For completion-design refs (per-label
  framing), each label also takes up to three examples, one per line, and the
  panel shows the plain-text request of each label. Runs the extension ref's own `reviewPrompt`
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

## Prompt-engineering lab

```bash
npm run lab -- --configs ref,shots-labelex --models smollm2-360m   # iter32 set by default
npm run lab -- --configs ref --models qwen2.5-0.5b --show-prompt --dry-run
```

`npm run lab` (`src/lab/`) is for fast iteration on everything the extension
could change beyond the user's own text: instruction wording and layout,
system vs user placement, few-shot demonstrations as prior chat turns, the
assistant prefill, token cap, repetition settings, JSON vs line output, and
candidate models (`models/candidates.json`). Each named configuration in
`src/lab/configs.ts` is the shipped `ref` configuration plus overrides. The
`ref` configuration renders byte-identical prompts to the extension engine
(checked with `src/lab/parity.ts`).

- Runs on a small fixed dev set (`experiments/sets/`), never on the test split.
- Renders prompts in the parent with the tokenizer only, and caches each
  generation by a hash of (model, dtype, rendered prompt, generation
  settings) in `cache/lab/`.
- One model process at a time: it waits until `MemAvailable` covers the
  model's peak RSS plus `--min-free-mb` (1500), and kills the worker above
  `--max-rss-mb` (3500) or when the system drops below 600 MB available.
- Parses with the ref's own `validateModelOutput` and scores with the bench
  scorer; `--by-lang` and `--cases` print more detail.
- Scoring-time options, applied to cached generations without recomputing:
  `--filter basic` (plausibility filter), `request`, `dedup`, `shape`,
  `cmin0.2` / `conf0.6` (answer-confidence thresholds, for configurations
  that record token probabilities), `--anchor relaxed`.
- Configuration features: per-label passes, completion framing (`raw`),
  language-matched demonstrations, iterative rounds (`iterations`), answer-only
  repetition penalty, P(NONE) and confidence recording, JSON output mode, and
  segment Yes/No classification (`segment`, `src/lab/segment.ts`): code cuts
  the prompt into sentences/clauses with exact offsets and the model answers
  Yes or No per (segment, label), either as the whole review (`seg-yn*`) or
  as a second stage on the shipped findings (`seg-verify*`). This proposal
  was rejected (experiments/LOG.md S1-S4).
- Every run also prints a segment view: segment precision/recall against
  "the segment holds an expected passage", over-redaction (redacted
  characters outside expected passages), requests per prompt and p50/p95 per
  prompt; Yes/No configurations add the unresolved-check rate and the ROC AUC
  of P(Yes). `--seg-diag` prints answer forms, P(Yes) histograms and AUC per
  language and label.
- While a worker runs, the run file is rewritten every ~30 s with the cases
  finished so far (`inProgress`), for the dashboard's Lab view.
- Candidate models run on onnxruntime-web 1.24.3 (`ort: "next"` in
  `models/candidates.json`); `--no-prefix-cache` runs every request whole.
- `npm run lab:classify` tests the candidate-classification approach, and
  `npx tsx src/lab/browser/run.ts --device webgpu --dtype q4 -- <lab args>`
  runs lab requests in a real Chrome (WebGPU or WASM) and stores them for
  `--backend webgpu|browserwasm` scoring.
- `experiments/sets/heldout-test.json` lists the test split for one-shot
  evaluation only (`--allow-test`); never tune on it.
- Writes `experiments/runs/<name>.json`. The experiment log is
  `experiments/LOG.md`, and the current best configuration with its evidence
  is `experiments/REPORT.md`.

### Hosted models (Amazon Bedrock, OpenAI-compatible servers)

```bash
npm run hosted:check -- --models nova-micro-prefill,glm47-flash-oai-native-v2   # one synthetic request each ("Test connection")
npm run bench -- --set tune96 --models nova-micro-prefill,smollm2-360m --dry-run   # plan + cost estimate
npm run bench -- --set tune96 --models nova-micro-prefill,nova-micro-system,smollm2-360m --name hosted-tune96
npm run bench -- --set connector-smoke --models <new model> --name connector-smoke   # 2 cases: a new adapter or endpoint end to end
npm run lab -- --configs shipped --models nova-micro-prefill --set tune96 --by-lang
npx tsx src/hosted/parity.ts --set tune96     # lab requests vs the ref's own reviewPrompt requests (no model, no network)
```

Bench runs with hosted models show in the dashboard like any other run:
Live while they run, and Results/Compare from `runs/<name>/` once they have
finished. Lab runs show in the Lab view. Results so far:
`runs/hosted-{tune96,confirm48,test}-1c377d7/`, `runs/connector-smoke-1c377d7/`
and [`experiments/REPORT.md`](experiments/REPORT.md) "Hosted models" (LOG B1-B7).

For the "connect a trusted hosted model" question, the bench and the lab can
send the extension's per-label requests to a hosted or self-hosted model
instead of a local one. In the bench, the ref's own `reviewPrompt` drives a
hosted model client in place of the engine: pagination, the code-fence skip,
parsing, anchoring, patterns and the confidence filter are the extension's.
The backend is provider-neutral (`src/hosted/`):

- `framing.ts` turns the ref's request (`{instructions, input,
  responsePrefill}`) into a neutral chat or completion request, in one of
  four framings (the model name's suffix):
  - `-prefill`: the completion text as the user turn, and the assistant turn
    prefilled with the cue `LABEL:`;
  - `-completion`: the completion text and cue as a raw completion prompt;
  - `-system`: the instruction line as the system prompt, and the
    demonstrations, text and cue as the user turn;
  - `-native*` (bench only): a chat-native request for the same label: a
    system prompt describing the task and the answer format
    (`NATIVE_SYSTEM` v1/v2), then the label's name, description and
    examples (`-noex`: none) and the prompt.
- Adapters send it and return the answer text, token usage, latency and,
  when the provider has them, token log probabilities: `bedrock.ts`
  (Converse, chat framings only) and `openai.ts` (any OpenAI-compatible
  server: chat to `/chat/completions`, completion to `/completions`).
- `client.ts` paces, retries (429, 5xx, network), cuts the answer at its
  first line like the extension's first-line stop, and turns log
  probabilities into the extension's answer confidence (the lowest
  answer-token probability), so the ref's confidence filter (0.2) applies.
- `models.ts` is the model table: provider, endpoint, framing, decoding,
  prices, pacing. A new framing, prompt wording, endpoint or decoding
  setting is a new entry and id (results are cached by model id), never an
  edit. Result cache files are named after the id's last segment, which must
  stay unique.

Decoding is temperature 0 (topK 1 on Bedrock) and a 48-token cap (128 for
native). Converse rejects `\n` as a stop sequence, so it gets only non-blank
ones (`nova-micro-prefill-stop`: `\nText:`); OpenAI-compatible entries send
`stop: ["\n"]` and ask for `logprobs`.

The `-trusted` entries (`nova-micro-trusted`, `glm47-flash-trusted`,
`glm47-flash-oai-trusted`, `ollama-*-completion-trusted`,
`ollama-*-native-v2-trusted`) send what the extension's Trusted AI redaction
sends since PR #48 (`src/hosted-framing.ts` @ 71e0c25): a `\nText:` stop for
answer-cue requests (prefill or completion), no stop for native chat, and
the extension's tolerant answer parser (`tolerantAnswer` in `framing.ts`:
repeated `LABEL:` cue stripped, split on `|`, empty and `NONE` parts
dropped) before the ref's parser. Known extension behaviours the bench does
not model: one retry with a minimal OpenAI body after an HTTP 400, topK and
GLM's thinking switch sent only to Nova and GLM (the bench always sends topK
1 on Converse), and confidence capped at 1.

- **Models:** `nova-micro-*`: Amazon Nova Micro through the EU inference
  profile `eu.amazon.nova-micro-v1:0`. `glm47-flash-*`: Z.ai GLM-4.7 Flash
  (`zai.glm-4.7-flash`, in-region only) with thinking disabled (a reply with
  reasoning stops the run); `glm47-flash-oai-native-v2` reaches it through
  Bedrock's OpenAI-compatible endpoint (chat only, no `/completions`; it
  returns log probabilities; Nova is not served there). All in `eu-north-1`.
  `ollama-smollm-360m-*` and `ollama-smollm2-360m-*`: a local Ollama
  (`OLLAMA_BASE_URL`, default `http://127.0.0.1:11434/v1`); the bench waits
  for their RSS plus the memory margin and unloads each after its run.
  Ollama's `/v1/completions` wraps the prompt in the model's chat template
  (not a raw completion) and returns no log probabilities; its chat endpoint
  returns them. Send only the benchmark's fictional dataset.
- **Auth:** Bedrock: a Bedrock API key in `AWS_BEARER_TOKEN_BEDROCK`, sent as
  a bearer token. OpenAI-compatible: the environment variable a model entry
  names (`apiKeyEnv`), else no key. Keys are read from the environment only
  and never logged.
- **Cache and cost:** results are cached like local ones: in the bench's
  result cache per ref commit, and in the lab by model id with framing,
  rendered prompt and generation settings (`cache/lab/<model>-api.jsonl`).
  Each request records its latency (network included, throttling retries
  excluded), the provider's server latency, token usage, cost and answer
  confidence, and `run.json` and the report give each hosted model's cost.
  Before sending anything, the bench and the lab print an estimate. They
  refuse to start when the hosted spend so far (every cached hosted request)
  plus the estimate would pass `--budget-usd` (default 5), and they stop
  mid-run at the budget. Per 1M input / output tokens in eu-north-1 (AWS
  price list): Nova Micro 0.038 / 0.152 USD, GLM-4.7 Flash 0.08 / 0.48 USD.
  A tune96 run (240 requests) costs about 0.003 USD on Micro.
- **Pacing:** requests are sent one at a time, so each measured latency is a
  single request's, and paced per model (`rpm`; `HOSTED_RPM`, or
  `BEDROCK_RPM` for Bedrock, overrides it). Nova Micro runs at 18 per minute
  and GLM-4.7 Flash at 90, because this test account allows them 20 and 100,
  so a tune96 pass takes about 13 minutes on Micro. Backoff on HTTP 429 is a
  safety net. A request that runs out of retries is not cached, and a rerun
  computes it.

### Shipped baseline and ablations

```bash
npm run ablate -- --set tune96 --model smollm2-360m            # leave-one-out grid
npm run ablate -- --set tune96 --with <config>[,<config>]      # plus proposals on top
```

The `shipped` lab configuration (`src/lab/shipped.ts`) renders the requests
the extension ships byte for byte, and each improvement recorded in
[`docs/shipped-improvements.md`](docs/shipped-improvements.md) has a switch:
`shipped-no-<switch>` is the baseline with that one improvement turned off.
`npm run ablate` runs the baseline, every switch and any `--with` proposals
(configurations added on top of `shipped` in `src/lab/configs.ts`) through
the lab, and writes the deltas vs the baseline to
`experiments/ablations/<name>.md`. The model switch reruns the baseline on
the previous default model in a second worker, after the first one exits.

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
- `npm run components -- <bench arguments>` scores a completed run of a ref
  with the answer-confidence filter and example patterns (PR #32 and later)
  with each part switched off, by replaying its cached answers (no model).
- `npm test` runs the scorer, dashboard data, playground, detbench and docbench unit
  tests (the playground ones use a fake model process, no weights).
- `npm run typecheck` runs the type checker.

## Repository layout

```
dataset/        profiles, cases, style guides; detbench/ for the rule-based detector
models/         bundled and candidate model metadata (sizes, dtypes, advertised languages + sources)
src/dataset/    schema, loader/validator
src/ext/        extension ref materialization and API surface
src/run/        jobs, tiers, cache, per-model worker, Node Transformers.js loader
src/score/      per-case scoring and aggregation
src/report/     HTML report, run comparison
src/dashboard/  local dashboard (read-only server + static page)
src/playground/ chat playground: request logic, model host process, its manager
src/lab/        prompt-engineering lab: configurations, shipped baseline + switches, ablation, renderer, worker, parity check
src/detbench/   deterministic redaction bench: dataset, perturbations, detector loading, scoring, report
src/docbench/   document bench: document writers, cases and sweeps, the ref's file check, scoring, report
experiments/    lab iteration sets, run summaries, ablation tables, LOG.md, REPORT.md, RESEARCH.md
src/cli/        validate, split, bench, report, compare, detbench, docbench
runs/           committed run outputs (runs/detbench/ for the rule-based detector, runs/docbench/ for documents)
cache/          (untracked) model weights, extracted refs, result cache
```
