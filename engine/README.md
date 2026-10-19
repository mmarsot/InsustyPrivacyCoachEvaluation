# Engine: plan, run, score, report

The engine finds modules and datasets from their folders, routes a grid cell
to its runner, scores the outputs and writes the run. It reads module and
dataset facts from their manifests, contracts and adapters.

## Running a cell

```bash
npm run bench -- --module <id> --config <id> --dataset <id> [--tier <tier>] [--ref main] [--dry-run]
```

`engine/cli/bench.ts` asks `route.ts` which runner the cell needs (by the
dataset contract's scorer) and runs it as a child process with the arguments
its own command takes, so plans, cache keys and outputs are the same either
way. A cell that cannot run exits 2 with the reason (no adapter, custom labels
with Private AI off, a configuration that would repeat the rules row...).
Without `--module`, `--config` or `--dataset`, `npm run bench` is the review
runner as before (its own flags: `--tier`, `--models`, `--set`...).

| Dataset scorer | Runner | Modules | Its own command |
| --- | --- | --- | --- |
| `custom-passages` (insusty-custom) | `cli/review.ts` | insusty-privacy (Private AI configurations: `--models`) | `npm run bench -- [--tier] [--models] [--set]` |
| `builtin-spans` (insusty-builtin) | `cli/detbench.ts` | any module with an adapter (`--module`) | `npm run detbench` |
| `documents` (insusty-documents) | `cli/docbench.ts` | insusty-privacy (rules: suite and sweeps; Private AI: its `ai` suite) | `npm run docbench` |
| `literature` (tab, gretel, nemotron) | `cli/literature.ts` | any module with an adapter (`--systems`) | `npm run literature` |

The detbench, docbench and literature command names, and their flags, are
kept: the extension's agent skills cite `npm run detbench -- --ref main
--compare <branch>`.

## What is where

| Path | What it is |
| --- | --- |
| `registry.ts` | finds `modules/*/manifest.json`, their `dataset-adapters/`, and `datasets/*/manifest.json` and `contract.json`; loads a module by folder name or alias; computes each grid cell's state from the files alone (`cellState`) |
| `module.ts`, `dataset.ts`, `adapter.ts` | the module manifest and adapter, the dataset manifest, contract and loader, and the dataset-adapter format with its parsing, validation and the scaffold's draft (`draftAdapter`) |
| `route.ts`, `cli/bench.ts` | a grid cell → its runner and arguments |
| `plan.ts`, `jobs.ts`, `meta.ts`, `outputs.ts` | the one planner (bench, docbench, literature; the dashboard rebuilds plans with it), job keys and the review result cache, run metadata and outputs |
| `workers/model.ts`, `workers/document.ts` | child processes: one model at a time (it drives insusty-privacy's Private AI), and documents with a per-job memory peak |
| `memory.ts` | memory waits and guards for every model process (this machine has ~7 GB shared with other lanes) |
| `scorers/custom-passages/` | passage-level scoring of custom labels, failure modes, the review report |
| `scorers/builtin-spans/` | span scoring with hard negatives, leak-free, merged spans, prose vs code, per tag; the module wrapper detbench uses (`detector.ts`) |
| `scorers/documents/` | extraction, detection, classification (silent cleans), the independent reader that checks redacted files, the docbench report |
| `scorers/literature/` | headline, custom-label, missing and native rows from each module's adapter; the literature report |
| `gates.ts` | shared pieces of the regression gates (each dataset's `gate.ts` says what counts) |
| `suite.ts`, `cli/suite.ts` | the commands a track runs; which tracks a change needs is insusty-privacy's `changes.ts` |
| `compare.ts`, `machine.ts`, `paths.ts`, `download.ts`, `parquet.ts` | run comparison, the machine profile and memory readings, every path, pinned downloads |
| `cli/` | `bench`, `review`, `detbench`, `docbench`, `literature`, `suite`, `conformance`, `validate`, `adapter`, `compare`, `report` |

The four scorers stay separate: built-in spans with decoys, documents and
literature measure different things, and merging them would shift numbers.

## Where results go

| Folder | Holds | Cost of deleting it |
| --- | --- | --- |
| `results/runs/` | run folders: `report.html`, `results.jsonl`, `metrics.json`, `metrics.csv`, `run.json` (per runner: `detbench/`, `docbench/`, `literature/`) | the reports (rerunning only rescores while the job caches remain) |
| `results/jobs/` | the job caches: `review/<sha>/<model>.jsonl`, `connected/` (paid replies), `documents/`, `literature/`, `lab/` | hours of model runs and money |
| `cache/` | module builds (`module/<sha>/`), model weights, dataset downloads, scratch files, `active-runs/` | a few downloads |

Both `results/` and `cache/` are git-ignored: run outputs copy the full text
of every case, so they stay on the machine that wrote them, and the docs
quote their headline numbers. A machine that still has the folders of the
earlier layout (`runs/`, `cache/results/`, `cache/hosted/`,
`cache/docbench/results/`, `cache/literature/`, `cache/lab/`) keeps using
them (`paths.ts` `kept`), so nothing it computed reruns or disappears; move
them under `results/` whenever convenient. `BENCH_RUNS_DIR=<dir>` writes run
folders elsewhere (CI and scratch runs).

Every result is cached by content: a job's key covers everything that can
change its output (the module's commit or version, the model, the rendered
request or configuration, the case), so a rerun computes only what changed
and otherwise rescores.

## Other commands

- `npm run compare -- results/runs/A results/runs/B` writes an HTML diff of
  two review runs, computed on the configurations and cases they share.
- `npm run report -- results/runs/A` re-renders a review run's report from
  its `results.jsonl`.
- `npm run validate -- --module <id> | --dataset <id> | --adapters` checks
  adapters against dataset contracts, or a dataset's data against its
  contract (no module runs).
- `npm run adapter -- --module <id> --dataset <id>` drafts a dataset adapter
  ([`modules/README.md`](../modules/README.md)).
- `npm run suite -- --since <base>` runs the tracks a change to the
  extension needs (`modules/insusty-privacy/README.md`); `--ci` adds the
  regression gates.
- Speed and memory are recorded on every run with the machine profile
  (`machineProfile` in `run.json`; `BENCH_MACHINE_ID` names a declared
  reference machine, anything else is `adhoc`). Compare absolute numbers only
  within one profile; CI runners are not one.
