# insusty-custom: custom-label prompts (the review dataset)

The dataset tests one thing: given a fictional client's custom labels, does the
extension's local AI review find the passages that client considers sensitive,
and only those? Everything in it is invented: companies, people, codenames,
figures. No real personal data, no text copied from the web.

## Layout

```
dataset/
  profiles/<profile>.json        one fictional client: persona + 1-3 custom labels
  cases/<profile>.<lang>.jsonl   one case per line, lang = en | fr
  style-guides/<profile>.md      how people in that job really write (sources + traits)
```

Profiles: `sales`, `dev`, `hr`, `legal`, `finance`, `support`, `agency`, `research`.

## Profile file

```json
{
  "id": "sales",
  "name": "Sales rep with an unannounced product",
  "persona": "Who they are and what they paste into chatbots.",
  "labels": [
    {
      "label": "UNRELEASED_PRODUCT",
      "description": "Names or internal codenames of our products that are not announced publicly yet.",
      "examples": ["Project Ostrava", "the Veltrano K9 dock", "Lumen Relay 2"],
      "counterExamples": ["HubSpot", "the Veltrano K7 (already on sale)", "Zoom"]
    }
  ]
}
```

Labels follow the extension's own rule constraints (`/^[A-Z][A-Z0-9_]{0,31}$/`,
description at most 1000 characters). The runner builds five description
variants from each label (`datasets/insusty-custom/variants.ts`): description only, description +
1 example, description + 3 examples, examples only, examples + counter-examples.

**Examples and counter-examples must never appear in a case text** (whole-word,
case-insensitive). Otherwise a description variant would hand the model the
answer. The validator rejects such leaks.

## Case line

```json
{"id":"sales-en-001","profile":"sales","lang":"en","type":"clear_positive","difficulty":"easy",
 "style":{"register":"email","errors":"none"},"tags":[],
 "text":"Hi Dana, quick one before the Hadley call...",
 "expected":[{"label":"PROSPECT_NAME","passage":"Hadley"}],
 "note":"why this case exists"}
```

| Field | Values |
| --- | --- |
| `id` | `<profile>-<lang>-<nnn>`, never renumbered once committed |
| `type` | `clear_positive`, `subtle_positive`, `lookalike_negative`, `clean_negative`, `hard` |
| `difficulty` | `easy`, `medium`, `hard` |
| `style.register` | `email`, `chat`, `notes`, `log`, `code`, `list`, `doc`, `ticket`, `request`, `social` |
| `style.errors` | `none`, `light`, `heavy` (spelling/grammar, in either language) |
| `mixed` | `true` when the text mixes languages (French text with English codenames or code) |
| `tags` | free strings; known ones in `schema.ts` (`abbreviation`, `lowercase`, `possessive`, `buried`, `public_codename`, `multi_label`, `long`, `code_block`, `injection`, `request`...) |
| `expected` | `{label, passage}` pairs, `[]` for negatives |
| `split` | `dev` or `test`, assigned once by `npm run split`; leave it out when adding cases |
| `note` | optional, never sent to the model |

### Ground truth rules

- `passage` is an **exact, case-sensitive substring** of `text`. Every
  occurrence counts; list a passage once even if it repeats. The validator
  computes the offsets and rejects anything not found verbatim.
- Mark the **shortest passage that identifies the secret**: `Hadley Freight`,
  not `the Hadley Freight renewal`; `€87k base` is fine for a salary. Keep
  passages on word boundaries (the extension's anchoring requires it).
- If the same secret appears in two spellings (`Ostrava` and `ostrava`, `K9`
  and `the K9`), list each spelling that should be caught.
- Only the profile's custom labels are ground truth. Avoid emails, phone
  numbers, postal addresses and API keys: deterministic rules handle those. The
  rule-based detector has its own dataset and bench (`datasets/insusty-builtin/cases/`,
  [detbench.md](../insusty-builtin/README.md)).
- Negatives (`lookalike_negative`, `clean_negative`) have `expected: []`.
  `hard` cases may be positive or negative.

### Type mix per profile and language (about 50 cases each)

| Type | Share | What it looks like |
| --- | --- | --- |
| `clear_positive` | ~35% | The secret is plain, correctly cased, in a normal sentence |
| `subtle_positive` | ~15% | Abbreviation, lowercase, possessive (`Ostrava's`), typo, buried mid-paragraph |
| `lookalike_negative` | ~25% | Looks sensitive but is not: public codenames (Apple's Project Titan), competitor named in a public context, released products, generic product words, public figures |
| `clean_negative` | ~10% | Ordinary work text with nothing sensitive |
| `hard` | ~15% | Multi-label, long text (> 1000 chars), code blocks, lists/tables, "ignore your instructions" injections, prompts that are themselves requests to the model |

French files also include **mixed-language** cases (`"mixed": true`): French
text with English codenames, English code/logs, franglais.

### Realistic style

Prompts must not all read like polished AI text. Vary register (formal email,
terse chat message, rushed notes, pasted log/code, bullet lists) and error
level (none / light / heavy: typos, missing accents, SMS-style French,
franglais, lowercase everything). Each profile's `style-guides/<profile>.md`
records how people in that job actually write, with the public sources
consulted. Imitate style only: never copy real text or reuse real names.

## Adding cases

1. Append lines to `datasets/insusty-custom/cases/<profile>.<lang>.jsonl` with the next free id.
2. `npm run validate -- --allow-missing-split --profile <profile>` until clean.
3. `npm run split` (assigns `dev`/`test` to new cases only; existing splits never change).
4. `npm run validate`.

The **test split** (~30%, stratified by profile, language and type) is held
out: never read it while tuning prompts or label descriptions. Tune on `dev`
only, then confirm on `test`.

## Running it

Custom labels need Private AI, so this dataset runs on insusty-privacy's
Private AI configurations (its adapter, `modules/insusty-privacy/dataset-adapters/insusty-custom.json`,
passes each profile's labels through; `labelVariants` picks how they are
described). The runner is the review bench (`engine/cli/review.ts`):

```bash
npm run bench -- --config smollm2-360m --dataset insusty-custom --tier quick   # one grid cell
npm run bench -- --tier smoke                                                  # the review bench's own flags (default: the ref's shipped model)
npm run bench -- --set tune96 --models smollm2-360m --label-variants desc,desc_ex3
```

## What a run measures

Each job runs one configuration on one case. A job has three axes:

| Axis               | Values                                                                                                                                                         |
| ------------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Model              | the ref's shipped model (`DEFAULT_SLM_MODEL_ID`), or every model it ships (`--models all`, `SLM_MODELS`), q8 on WASM; `modules/insusty-privacy/models.json` only describes them |
| Label description  | `desc`, `desc_ex1`, `desc_ex3`, `ex3` (examples only), `ex_counter` (examples and counter-examples), all built from `datasets/insusty-custom/profiles/*.json`                  |
| Cases              | profile, language, type, difficulty, length, writing style                                                                                                     |

Every case runs with its profile's custom labels, using the chosen description
variant. Decoding is deterministic (greedy). The system instruction was an
axis too (`--instructions`); refs since PR #26 take none, so it was removed
(jobs still record `current`, so cache keys and stored runs are unchanged).

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
the ref's own parser and anchoring (its package's `redact()`). Language results are shown
next to each model's advertised language support (SmolLM2 is English-first).

## Tiers and runtime

| Tier              | Cases                                                                                                 | Use                                        |
| ----------------- | ----------------------------------------------------------------------------------------------------- | ------------------------------------------ |
| `smoke`           | 16 (one positive and one look-alike negative per profile)                                             | Check that the pipeline works              |
| `quick` (default) | 32: 2 dev cases per profile and language, stratified by type across the run (`--cases-per-profile N`) | Fast iteration on prompts and descriptions |
| `full`            | all 809 (both splits)                                                                                 | Overnight runs                             |

The defaults are the `quick` tier, the ref's shipped model and one
label-description variant (`desc`); `--label-variants desc,desc_ex3` or `all`
adds the others.

The runner prints its plan and a time estimate before it starts
(`--dry-run` stops there). The estimate uses the mean of cached timings on
this machine, or the priors in `modules/insusty-privacy/models.json`. Estimates on the 8-vCPU,
7 GB laptop this was built on:

- **Default quick run** (32 cases × SmolLM2-360M, the model `main` ships, × 1
  variant): about 3 min from cached timings.
- **Quick with 3 cases per profile:** about 45 min.
- **Quick with 10 cases per profile and 2 variants:** about 3 h.
- **Full tier, 1 variant:** about 12 h.
- **Full tier, all 5 variants:** about 60 h.

Cached jobs are never recomputed. A job is keyed by the extension commit,
model, the ref's default prompt, rule texts, case id and case text. Rerunning the same
command after a change computes only what changed. With nothing new to
compute, a rerun just rescores and rewrites the report. `--cached-only`
computes nothing: it reports whatever is cached for that plan and marks the
run incomplete when jobs are missing.

Useful flags:

- `--cases-per-profile 3` (quick tier volume)
- `--models shipped` (default), `all` (every model the ref ships), or names such
  as `smollm2-360m` (any model `modules/insusty-privacy/models.json` describes); the
  connected model by name only (`glm47-flash-connected`, the insusty-privacy
  configuration of the same name), with `--budget-usd 5`
- `--label-variants desc,desc_ex3` or `all` (alias `--labels`)
- `--split test`
- `--profiles dev,hr`
- `--langs fr`
- `--ref <git ref>` (default `main`); the bench runs refs with the
  per-label completion design (PR #26 and later) through the contract
- `--set tune96` (the dev cases of a lab set in `datasets/insusty-custom/sets/` instead
  of a tier)
- `--name my-run`
- `--max-rss-mb 3800`
- `--dry-run`
- `--cached-only`

## Results so far

The bench keeps two models: SmolLM2-360M on the device (the model the
extension ships) and GLM-4.7 Flash connected. Older models and their runs
were deleted on 2026-10-17 to start fresh. SmolLM2-360M runs, all on
2026-09-27 and kept locally (passage-level overlap F1 / precision / recall,
share of negatives with a false finding):

| Run                          | Ref                     | Cases              | F1    | P     | R     | FP rate |
| ---------------------------- | ----------------------- | ------------------ | ----- | ----- | ----- | ------- |
| `ext-ebf077f-tune96-smol360` | `ebf077f` (PR #32)      | tune96             | 38.2% | 55.6% | 29.1% | 21.4%   |
| `ext-ebf077f-test-smol360`   | `ebf077f` (PR #32)      | held-out test, 242 | 33.2% | 43.3% | 27.0% | 35.6%   |
| `ext-d42c466-tune96-smol360` | `d42c466` (PR #26)      | tune96             | 32.1% | 41.5% | 26.2% | 35.7%   |
| `test-d42c466-smol360`       | `d42c466` (PR #26)      | held-out test, 242 | 27.4% | 32.2% | 23.9% | 44.6%   |
| `test-dc91f36-smol360`       | `dc91f36` (chat design) | held-out test, 242 | 12.0% | 44.2% | 6.9%  | 10.9%   |

The smoke tier on `main` and the connected model are in
[insusty-privacy's README](../../modules/insusty-privacy/README.md#the-connected-configuration)
(smoke on `main` @ `95454ec`: GLM-4.7 Flash F1 51.9%, SmolLM2-360M F1 33.3%).
