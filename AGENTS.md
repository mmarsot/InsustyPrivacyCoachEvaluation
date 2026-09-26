# Project agent memory

This file is the project's committed home for project-intrinsic agent knowledge: build, test, release, architecture, and sharp-edge notes that should travel with the code.

- Purpose, commands and layout: `README.md`. Dataset schema and how to add cases: `docs/dataset.md`. How refs are materialized and why the runtime is what it is: `docs/approach.md`.
- The default extension ref is `main` (`DEFAULT_EXT_REF` in `src/ext/ref.ts`); results are cached per commit sha, so a new `main` commit means a fresh run.
- Never modify the extension clone: refs are read with `git archive` into `cache/ext/<sha>/` (`src/ext/ref.ts`). The clone path comes from the untracked `bench.local.json`, `INSUSTY_EXT_REPO` or `--ext-repo`; never commit an absolute path.
- Inference must stay on onnxruntime-web WASM with default session options (`onnxruntime-node` is aliased in `package.json`). Native ORT and other graph-optimization levels change greedy outputs on the q8 models, so results would not reflect the extension.
- Models run one at a time, each in its own child process (`src/run/worker.ts`); Qwen2.5-0.5B peaks above 3 GB RSS while loading on a 7 GB machine, so never run two workers in parallel.
- `src/run/transformers-loader.ts` mirrors the extension's `src/model-worker.ts` adapters; when a ref changes that worker, update the loader.
- `npm run dashboard` (`src/dashboard/`) must stay read-only: it watches runs in progress through `cache/active-runs/`, `/proc` and the result cache, and rebuilds plans with `src/run/plan.ts`, the same planner `npm run bench` uses. Keep planning logic there, not in the CLI. Its Playground view is the only part that runs a model: one at a time, in a child process killed on unload/switch (`src/playground/`); never let it hold two models.
- The `test` split is held out: never tune instructions or label descriptions on it. `npm run split` only fills missing splits.
- Results are cached by content hash in `cache/results/`; rerunning a bench command with nothing new only rescores. Do not edit files imported by `src/run/worker.ts` while a run is in progress (each model's worker is spawned later and would load the edited code).

## Maintaining this file

Keep this file for knowledge useful to almost every future agent session in this project.
Do not repeat what the codebase already shows; point to the authoritative file or command instead.
Prefer rewriting or pruning existing entries over appending new ones.
When updating this file, preserve this bar for all agents and keep entries concise.
