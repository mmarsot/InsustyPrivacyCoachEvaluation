# InsustyReviewBench

**How well does Insusty Privacy Coach keep your secrets out of AI chatbots?**
This repository measures it, openly and repeatably.

[Insusty Privacy Coach](https://github.com/mmarsot/InsustyPromptCoach) is a
Chrome extension that checks what you send to ChatGPT, Claude and Gemini and
removes secrets and personal details before they leave your browser. The
checks run on your own computer. This benchmark is a separate project that
puts those checks to the test, with test data where every name, number and
key is made up.

## What it measures

When you paste something into a chatbot, two things can go wrong. A **miss**
means a password, an IBAN or a client's name leaks to the chatbot. A **false
alarm** means harmless text gets hidden and gets in your way. A miss is the
worse of the two, so the benchmark reports first how much the extension
finds (**recall**), then how often what it hides really needed hiding
(**precision**), and **F1**, the balance of the two.

It tests the extension's three layers of protection:

1. **Rule-based detection** of the things that have a recognisable shape: API
   keys and other secrets, card and bank numbers, national IDs, dates of
   birth, phone numbers, e-mail and postal addresses, IP addresses, company
   registration numbers. It is scored on 316 realistic English and French
   prompts we wrote (chat messages, logs, config files, e-mails), on 3,381
   variants of them with typos and odd formatting, on 502 decoys that only
   look sensitive, and on three published datasets (Nemotron-PII, Gretel,
   TAB).
2. **Attached files**: Word, Excel, PowerPoint, OpenDocument, PDF, text and
   zip files with values hidden in footnotes, comments, hidden sheets, speaker
   notes and metadata. Does the extension read every value, find it, and
   really remove it from the copy it sends? Does it warn about files it
   cannot check instead of passing them as clean?
3. **Private AI**: an AI model that runs on your device (GLiNER2-PII by
   default) and finds what no rule can: your own **custom labels**, such as
   client names, project codenames or unreleased products, described in a
   sentence and a few examples. It is scored on 809 prompts from eight kinds
   of jobs (sales, legal, HR, finance, research...), including prompts that
   contain nothing to hide.

Everything runs offline on a laptop, the same way the extension runs in the
browser: the bench installs the extension's own redaction code at an exact
commit and scores it through a fixed interface, so the numbers describe what
users get. [Microsoft Presidio](https://github.com/microsoft/presidio), a
widely used open-source PII detector, runs on the same data as a baseline.

## Results

Measured on 2026-11-02 on the extension's `main` branch at
[`b12b381`](https://github.com/mmarsot/InsustyPromptCoach/commit/b12b38170e4991a4573cf34bdb04361370e70735)
(version 0.1.0 plus the detection coverage update of
[PR #183](https://github.com/mmarsot/InsustyPromptCoach/pull/183): labelled
account, routing, PIN, customer, member, medical record, health plan and tax
numbers, phone numbers after a phone word, US street lines), on an
8-thread, 7 GB laptop. Insusty runs with every built-in label on (IP
addresses, company IDs and the US, Canadian and Australian address formats
are opt-in in the extension), and with Private AI for custom labels.
Presidio 2.2.364 runs with its default recognizers, every text analysed as
English, as it ships.

**Rule-based detection and files**

| Test                                           | Insusty, every label on | Presidio 2.2.364             |
| ---------------------------------------------- | ----------------------- | ---------------------------- |
| Our prompts: items redacted                    | **97.1%**               | 66.7% (no secrets: 0 of 117) |
| Our prompts: F1 (precision)                    | **96.2%** (95.6%)       | 62.8% (51.9%)                |
| Decoys wrongly hidden (of 502)                 | **19**                  | 110                          |
| Secrets and API keys found (of 117)            | **115**                 | not supported                |
| Documents: values found / precision            | **90% / 98%**           | reads text only              |
| Documents: redacted values really gone         | **659 of 659**          | –                            |
| Files that cannot be checked, reported as such | **23 of 23**            | –                            |
| Nemotron-PII sample: recall / F1               | **81.9% / 89.7%**       | 79.2% / 86.6%                |
| Gretel finance (EN+FR): recall / F1            | 48.5% / **52.0%**       | **61.8%** / 32.7%            |

**Private AI on custom labels** (on-device model; held-out test prompts the
model's settings were never tuned on)

| Held-out test, 242 prompts (141 with something to hide)        | Insusty, GLiNER2-PII | Presidio      |
| -------------------------------------------------------------- | -------------------- | ------------- |
| Items found (recall)                                           | **42.6%**            | not supported |
| Findings that were right (precision)                           | **53.1%**            | –             |
| F1                                                             | **47.2%**            | –             |
| Prompts with nothing to hide that got a false finding (of 101) | 44.6%                | –             |
| Median time per prompt                                         | 0.8 s                | –             |

GLiNER2-PII reads English and French alike (F1 44.8% in English, 49.7% in
French). On the development prompts (96 cases) it scores recall 42.7%,
precision 55.0%, F1 48.1%.

What these numbers say, and what they do not:

- On realistic prompts the extension finds and hides almost everything
  (97%), with few false alarms, and it is the only one of the two that
  catches secrets: 115 of 117 API keys, tokens and passwords. Presidio has
  no secret detector and flags 110 of the 502 decoys.
- In files, every value the extension decides to redact is gone from the
  copy it sends, and no file it cannot read is passed off as checked.
- On Nemotron-PII, mostly US-style data, the extension now finds more than
  Presidio (81.9% against 79.2%; 83.6% on the labels both can produce) with
  higher precision (99.2% against 95.6%). On Gretel, Presidio still finds
  more (61.8% against 48.5%), mainly street addresses, national IDs and
  dates of birth, but three in four of its findings there count as wrong
  (precision 22.2%, against 56.0%; Gretel leaves many real-looking values
  unlabelled, so precision is understated for both). Card numbers that fail the checksum the
  extension requires, and many routing numbers, are still missed.
- TAB (court judgements) is outside the extension's scope: its identifiers
  are case numbers and people's names, which rules do not target (names
  are a Private AI label). The extension finds 2.5% there, Presidio 3.3%.
- Private AI finds about four in ten of the custom-label items in prompts
  it has never seen, and it adds to the rules, never replaces them. Presidio has
  no custom labels you can describe in words: a new type takes code or
  configuration (patterns, word lists, or an extra model). Private AI's
  false findings are the price of its recall: 45% of prompts with nothing
  to hide get at least one. With the default "Ask me each time",
  the extension shows what it found in a review dialog before the prompt is
  sent, so a false finding costs a click, not a leak.
- Private AI results come from one machine and one run of each test set. The
  connected-model option was not re-measured. On documents the bench
  measured speed only (about 2 s per 1,000 characters, so a
  20,000-character file takes about 40 s); its document sample (2 files)
  is too small to quote a recall.

## What each tool supports

The extension at `b12b381`, against Presidio's analyzer as installed (2.2.364,
default recognizers, English). Sources: the extension's
[rule-based detection](https://github.com/mmarsot/InsustyPromptCoach/blob/b12b38170e4991a4573cf34bdb04361370e70735/docs/detection-and-review/rule-based-detection.md),
[OCR](https://github.com/mmarsot/InsustyPromptCoach/blob/b12b38170e4991a4573cf34bdb04361370e70735/docs/attachments/ocr.md)
and [span model](https://github.com/mmarsot/InsustyPromptCoach/blob/b12b38170e4991a4573cf34bdb04361370e70735/docs/private-ai/on-device/span-models.md)
docs at `b12b381`; for Presidio, the recognizers its 2.2.364 registry loads
for English (listed from the bench's own environment), its
[supported entities](https://github.com/microsoft/presidio/blob/main/docs/supported_entities.md),
[adding recognizers](https://github.com/microsoft/presidio/blob/main/docs/analyzer/adding_recognizers.md)
and [languages](https://github.com/microsoft/presidio/blob/main/docs/analyzer/languages.md)
pages. How each maps onto the benchmark's labels is in its module's dataset
adapters ([`modules/`](modules/README.md)).

|                                      | Insusty Privacy Coach                                                                                                                                                                                                                             | Presidio 2.2.364                                                                                                                                                                                                   |
| ------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Secrets, API keys, passwords         | About 385 provider key rules (from [Betterleaks](https://github.com/betterleaks/betterleaks)), JWTs, private keys, credentials in URLs and connection strings, passwords and tokens after a keyword, random-looking values, your own key patterns | No recognizer                                                                                                                                                                                                      |
| E-mail addresses                     | Yes                                                                                                                                                                                                                                               | Yes                                                                                                                                                                                                                |
| Phone numbers                        | Valid numbers for the countries you set (France by default), and US, UK and German numbers after a word such as `Phone:` or `call me at`                                                                                                          | Valid numbers for US, UK, Germany, France, Israel, India, Canada and Brazil (its `PhoneRecognizer` defaults)                                                                                                       |
| Bank and card details                | IBANs (mod-97 checked), BICs, cards (Luhn checked); after their label: card security codes and expiry dates, bank account numbers, US routing numbers (ABA check digit), PINs                                                                     | Cards (Luhn checked), IBANs, US bank account numbers, Bitcoin addresses                                                                                                                                            |
| National and personal IDs            | French social security numbers, US SSNs, UK National Insurance numbers; after their label: NHS, passport, driver's licence, ID card, tax, customer, member, health plan and medical record numbers (English and French labels)                    | US SSN, ITIN, passport and driver's licence, UK NHS, medical licence numbers. Other countries' packs (UK NINO, Spain, Italy, India, Australia, Germany...) are off by default or registered for their own language |
| Company IDs                          | French SIREN, SIRET and VAT numbers (opt-in)                                                                                                                                                                                                      | None for English by default (other countries' company numbers are opt-in or registered for their own language)                                                                                                     |
| Dates of birth                       | A date after a birth word (`born`, `DOB`, `date de naissance`...)                                                                                                                                                                                 | No birth-date type: it flags every date and time                                                                                                                                                                   |
| Postal addresses                     | French addresses by default; US, Canadian and Australian ones and US street lines when you turn them on                                                                                                                                           | No street-address recognizer; place names (cities, countries) come from the language model's LOCATION                                                                                                              |
| IP and MAC addresses                 | Yes (opt-in)                                                                                                                                                                                                                                      | Yes                                                                                                                                                                                                                |
| People's names                       | Not by rules; Private AI's Name label, which a new install has                                                                                                                                                                                    | Yes (PERSON, from the language model)                                                                                                                                                                              |
| Places, organisations, nationalities | As custom labels you add                                                                                                                                                                                                                          | Places and nationality, religious or political groups; organisations are ignored by default (too many false positives)                                                                                             |
| Custom labels                        | Described in plain words with a few examples (client names, project codenames...), found by the on-device model or a connected model you choose, and learned from your review choices                                                             | Written as code or configuration: patterns and word lists (Python, YAML, or per request), or an extra model (GLiNER, Hugging Face, or an LLM through LangExtract) installed separately                             |
| Documents                            | Word, Excel, PowerPoint, OpenDocument, PDF, text and zip files, including hidden sheets, notes, comments and metadata; sends a redacted copy                                                                                                      | The analyzer reads text only; separate packages handle images (`presidio-image-redactor`) and tables or JSON (`presidio-structured`); no Office or PDF reader                                                      |
| OCR                                  | Opt-in: images and scanned PDF pages, read on the device with Tesseract (English and French language data). Not measured here                                                                                                                     | Through `presidio-image-redactor` (Tesseract, or Azure Document Intelligence). Not measured here                                                                                                                   |
| AI model                             | GLiNER2-PII by default (GLiNER2 Multi or SmolLM2-360M can be chosen), in the browser, or a connected model you trust                                                                                                                              | spaCy's `en_core_web_sm` here; other spaCy, Stanza or transformers models can be configured                                                                                                                        |
| Where it runs                        | In Chrome, on ChatGPT, Claude and Gemini, before the prompt is sent; nothing leaves the device unless you connect a model                                                                                                                         | A Python library or a service you host                                                                                                                                                                             |
| Languages                            | English and French (keywords, address formats, OCR data and the default model)                                                                                                                                                                    | English by default; another language needs its own language model and recognizers                                                                                                                                  |

Every number above comes from a run you can reproduce with the commands
below and inspect case by case in the dashboard (`npm run dashboard`). The
per-dataset READMEs ([datasets/](datasets/README.md)) have the details: the
extension's default settings, every label, and the earlier versions'
results.

## Licence

- **Code** (every source file, including the dataset generators and the
  dashboard): [PolyForm Noncommercial 1.0.0](LICENSE). Free to use, change
  and share for any non-commercial purpose: personal use, research,
  teaching, evaluation, non-profit organisations. Commercial use needs a
  separate licence from Insusty.
- **Datasets and documentation written by Insusty** (the insusty-custom,
  insusty-builtin and insusty-documents data, the profiles, sets and style
  guides, the lab's recorded experiments, and the Markdown documentation):
  [CC BY-NC 4.0](LICENSES/CC-BY-NC-4.0.txt). Free to share and adapt for
  non-commercial purposes, with attribution to Insusty.
- **Third-party datasets** keep their own licences and are not part of this
  repository: the bench downloads them at a pinned revision into the
  untracked `cache/`. TAB is MIT, Gretel synthetic PII finance multilingual
  is Apache-2.0, Nemotron-PII is CC BY 4.0 (NVIDIA). ai4privacy is listed but
  not used, because its licence is unclear
  ([datasets/README.md](datasets/README.md)).
- The models the bench downloads keep their own licences too (GLiNER2-PII:
  Apache-2.0; SmolLM2-360M: Apache-2.0), as do Presidio and the npm
  dependencies.

## For developers

InsustyReviewBench is a separate data-science project, not part of the
extension. It is organised around two kinds of folder:

- **Modules** (`modules/`): what gets scored. A module comes with its
  module adapter, which implements the versioned **redaction contract**
  (`contract/`), and one **dataset adapter** per dataset it runs: how its
  output answers that dataset's labels, with the labels it cannot produce
  listed. Today: **insusty-privacy** (the extension's module at any git ref;
  its local and connected models are configurations) and **presidio** (a
  baseline).
- **Datasets** (`datasets/`): what modules are scored on. A dataset comes
  with its data and its **expected output contract** (the labels it scores).
  Today: three of ours (custom-label prompts, built-in-label prompts,
  generated documents) and three published ones (TAB, Gretel, Nemotron-PII).

A module configuration × a dataset is a cell of the dashboard's **Grid**. A
cell runs when the module has both adapters: runnable (every expected label
mapped), partial (missing labels stay out of the headline), or not (no
adapter, custom labels with Private AI off...). The **engine** (`engine/`)
routes a cell to its runner, scores it and writes the run; the **dashboard**
(`dashboard/`) goes Modules → Datasets → Grid (Run) → Results.

### Quick start

```bash
npm install
# Point the bench at a local clone of the extension (read-only, never modified):
echo '{ "extRepo": "../InsustyPromptCoach" }' > bench.local.json   # untracked
npm run dashboard                      # http://127.0.0.1:4380/: Modules, Datasets, Grid (Run), Results
npm run validate -- --adapters         # every module's adapters against the dataset contracts (seconds)
npm run bench -- --config rules --dataset insusty-builtin                      # one grid cell: rules on our prompts (seconds)
npm run bench -- --config gliner2-pii --dataset insusty-custom --tier smoke    # the default on-device model on custom labels (minutes)
npm run bench -- --module presidio --config default --dataset gretel --tier smoke --dry-run   # the plan only
npm run conformance -- --module insusty-privacy --ref main                     # the ref against the contract and its manifest
npm run suite -- --since <base ref> --ref main --dry-run   # which grid rows a change to the extension needs
```

Instead of `bench.local.json`, you can set `INSUSTY_EXT_REPO=<path>` or pass
`--ext-repo <path>`; relative paths resolve from this repository's root.
Each extension ref is installed once, from GitHub, as the
`insusty-prompt-coach/redaction` package at its commit, into `cache/module/`
(while the extension's repository is private, git needs credentials for
github.com, such as
`gh auth setup-git`). Model weights are downloaded from Hugging Face on first
use into `cache/models/`, and published datasets into `cache/datasets/` at a
pinned revision.

Run outputs stay on your machine: `results/` is git-ignored, because results
copy the full text of every case, so a fresh clone has no runs until you
produce them (the commands that read a stored run say so and print the
command that produces it). The docs quote the headline numbers of the runs
they cite. A machine that had runs before this layout keeps reading them
from `runs/` and the old cache folders ([engine/README.md](engine/README.md)).

### Where things are

| To...                                                                        | Read                                                                                                                                                       |
| ---------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| understand what a module is, add one, or write a dataset adapter             | [modules/README.md](modules/README.md)                                                                                                                     |
| see how the extension is run (materializer, runtime, configurations, tracks) | [modules/insusty-privacy/README.md](modules/insusty-privacy/README.md)                                                                                     |
| iterate on Private AI prompts, the shipped baseline and ablations            | [modules/insusty-privacy/lab/README.md](modules/insusty-privacy/lab/README.md), [shipped-improvements.md](modules/insusty-privacy/shipped-improvements.md) |
| see the Presidio baseline                                                    | [modules/presidio/README.md](modules/presidio/README.md)                                                                                                   |
| understand what a dataset is, add one, or see the published datasets' scores | [datasets/README.md](datasets/README.md)                                                                                                                   |
| write custom-label cases, or run and read the review bench                   | [datasets/insusty-custom/README.md](datasets/insusty-custom/README.md)                                                                                     |
| add a built-in-label case or a regression case (detbench)                    | [datasets/insusty-builtin/README.md](datasets/insusty-builtin/README.md)                                                                                   |
| add a document case (docbench)                                               | [datasets/insusty-documents/README.md](datasets/insusty-documents/README.md)                                                                               |
| know what a module takes and returns                                         | [contract/README.md](contract/README.md)                                                                                                                   |
| run a cell, find results, or use the other commands                          | [engine/README.md](engine/README.md)                                                                                                                       |
| use the dashboard and the chat playground                                    | [dashboard/README.md](dashboard/README.md)                                                                                                                 |

### Repository layout

```
contract/            the redaction contract every module adapter implements: types, JSON Schema, conformance, reference module
modules/             what gets scored: one folder per module
  insusty-privacy/   the extension at any git ref: manifest, module adapter, dataset-adapters/, materializer,
                     runtime, connected transport, change rules (tracks), lab/ (with experiments/), the ledger
  presidio/          Microsoft Presidio baseline (Python, local, no network)
datasets/            what modules are scored on: one folder per dataset (manifest, contract, data or loader)
  insusty-custom/    809 custom-label prompts, 8 client profiles, lab sets
  insusty-builtin/   316 built-in-label prompts, hard negatives, perturbations, its regression gate (detbench)
  insusty-documents/ generated documents, size sweeps, the Private AI suite, its regression gate (docbench)
  tab/ gretel/ nemotron/   published datasets, pinned and licence-checked; ai4privacy/ listed, blocked on its licence
engine/              registry (the grid), router, planner, workers, memory guards, scorers, gates, CLIs
dashboard/           Modules, Datasets, Grid (Run), Live, Results, Compare, Documents, Literature, Lab, Playground
results/             local, git-ignored: run folders and the costly job caches
cache/               local, git-ignored, cheap to rebuild: module builds, model weights, dataset downloads, scratch
```

Tests sit next to the code they test (`*.test.ts`).

### Code checks

`npm run check` runs every check that needs no model and no network, and
changes nothing: `typecheck` (strict TypeScript), `lint` (TypeScript-aware
ESLint), `format:check` (Prettier), `knip` (unused files, exports and
dependencies) and `npm test`. Run it before every commit. The tooling and its
settings follow the extension's (InsustyPromptCoach):

- `npm run format` applies Prettier (default options). It covers only the
  globs in `package.json` (code, module and dataset manifests, contracts and
  adapters, `README.md`, `AGENTS.md`, root JSON); never run it on Markdown
  docs, data files (`datasets/*/cases/`, `sets/`, `profiles/`),
  `lab/experiments/` or `results/`, where it would reflow tables and data.
- A lint rule that does not fit the bench is turned off in `eslint.config.js`
  with its reason, never with scattered inline disables.
- Knip's entries are the CLIs, the spawned workers, the module and dataset
  entries found by discovery (`modules/*/module.ts`, `datasets/*/loader.ts`)
  and the standalone scripts (`knip.json`); a new `npx tsx` script or
  child-process entry goes there. An export kept on purpose without a caller
  (contract API, documented vocabulary) carries `@public`.
- JSDoc/TSDoc beside each exported symbol, and beside internals whose intent
  the code does not show, is the documentation's source of truth: say why,
  the invariants and the units, not what the code already says.
