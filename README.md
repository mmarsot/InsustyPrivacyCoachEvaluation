# InsustyReviewBench

An offline, repeatable benchmark for the redaction of
[InsustyPromptCoach](https://github.com/mmarsot/InsustyPromptCoach): its
rule-based detection of secrets, e-mails, IBANs and other identifiers, its
check of attached documents, and its **local AI review**, the
browser-local small language model that scans a prompt for passages matching
the user's custom labels (unreleased product names, deal codenames, customer
IDs...) before it is sent to a chatbot.

It is a separate data-science project, not part of the extension. It is
organized around two kinds of folder:

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

## Quick start

```bash
npm install
# Point the bench at a local clone of the extension (read-only, never modified):
echo '{ "extRepo": "../InsustyPromptCoach" }' > bench.local.json   # untracked
npm run dashboard                      # http://127.0.0.1:4380/: Modules, Datasets, Grid (Run), Results
npm run validate -- --adapters         # every module's adapters against the dataset contracts (seconds)
npm run bench -- --config rules --dataset insusty-builtin                      # one grid cell: rules on our prompts (seconds)
npm run bench -- --config smollm2-360m --dataset insusty-custom --tier smoke   # the on-device model on custom labels (minutes)
npm run bench -- --module presidio --config default --dataset gretel --tier smoke --dry-run   # the plan only
npm run conformance -- --module insusty-privacy --ref main                     # the ref against the contract and its manifest
npm run suite -- --since <base ref> --ref main --dry-run   # which grid rows a change to the extension needs
```

Instead of `bench.local.json`, you can set `INSUSTY_EXT_REPO=<path>` or pass
`--ext-repo <path>`; relative paths resolve from this repository's root.
Model weights are downloaded from Hugging Face on first use into
`cache/models/`, and published datasets into `cache/datasets/` at a pinned
revision.

Run outputs stay on your machine: `results/` is git-ignored, because results
copy the full text of every case, so a fresh clone has no runs until you
produce them (the commands that read a stored run say so and print the
command that produces it). The docs quote the headline numbers of the runs
they cite. A machine that had runs before this layout keeps reading them
from `runs/` and the old cache folders ([engine/README.md](engine/README.md)).

## Where things are

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

## Repository layout

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

## Code checks

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
