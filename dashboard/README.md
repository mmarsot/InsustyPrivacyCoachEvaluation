# Dashboard

```bash
npm run dashboard            # http://127.0.0.1:4380/  (--port, --ref, --ext-repo)
```

The dashboard is a small local server: plain `node:http` and one static page
(`page.html`), no framework, about 200 MB of RAM. It writes no results: it
reads the module and dataset folders (through `engine/registry.ts`), the
result caches and the run folders (`results/runs/`, or `runs/` on a machine
that had runs before the modules/datasets layout), so it is safe to leave open
during a bench run. Two things start processes, one at a time each: the
Grid's **Run** button (one bench process, `launcher.ts`) and the Playground
(one model process, `playground/`). It finds runs in progress automatically. Each bench
process registers in `cache/active-runs/`, and on Linux the dashboard also
scans `/proc`. It then rebuilds the run's exact plan from its arguments and
compares it with the cache.

The flow for a module: **Modules** → **Datasets** (its dataset adapters) →
**Grid** (Run a cell) → **Results** / **Compare**. It has ten views:

- **Modules.** One card per folder under `modules/`: contract version (a
  module whose major differs from `contract/` is greyed out), source, inputs,
  the labels it produces, how many datasets it has adapters for, its
  configurations (paid ones marked) and notes; plus the steps to add a module.
- **Datasets.** Every folder under `datasets/` (ours, published, and listed
  but blocked ones such as ai4privacy) with its source, licence, size and
  contract, and the selected module's dataset adapter for it: mapped N of M
  labels with the missing ones, or "no adapter" with the reason. Click a row
  for the mapping (dataset label, its meaning, what in the module's output
  answers it).
- **Grid.** Every module configuration × every dataset (`engine/registry.ts`
  `cellState`): runnable, partial (mapped N of M; missing labels stay out of
  the headline), no adapter, n/a (custom labels need Private AI), = rules
  (only Private AI changes and the dataset has nothing for it), blocked. Each
  cell shows the latest stored result (`grid.ts`). **Run** opens a panel with
  the tier, the ref, **Show plan** (`npm run bench -- ... --dry-run`: the plan,
  the time estimate and, for a connected model, the cost estimate and the
  `--budget-usd` cap) and **Start run**. A start is refused while another
  bench process is active; a paid configuration needs its confirmation box.
  The run's command and the end of its log stay on the page; the Live view
  follows it, and its result lands in the cell.

- **Live.** One card per review or document bench run in progress (started
  from a terminal or from the Grid), refreshed every 5 s. It shows overall
  done/total and ETA. For each model it shows status (running/pending/done),
  throughput, median time per case and ETA. For each model × label
  description it shows progress, timeouts, errors and failure-mode counts so
  far. It also lists the latest results.
- **Results.** Pick a finished review run from `results/runs/`, or a LIVE run whose results are scored as
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
- **Compare.** Any two runs, finished or live, on their shared (configuration,
  case) results, overall and by language.
- **Playground.** Talk to one of insusty-privacy's models to see its limits (below).
- **Lab.** Every `npm run lab` result (`modules/insusty-privacy/lab/experiments/runs/`), sortable by any
  metric and by language, with p95 latency and the segment view; tick two
  rows to compare their outputs case by case. Runs in progress appear with
  their partial results (refreshed every 15 s).
- **Documents.** Document-bench runs (`results/runs/docbench/`, and runs in
  progress): overview, extraction and detection per format and zone with a
  configuration switch, failure files, hard negatives, scaling charts and
  fits, Private AI curves, a document list with a drill-down (the extracted
  text with found and missed values), the full report and a comparison of
  two runs. The Live view also shows a document-bench run's progress.
- **Literature.** Literature runs (`results/runs/literature/`): the headline, custom-label,
  out-of-scope and native-total rows per dataset, module and configuration,
  and the full report.

The Experiments view of the earlier layout (the planned matrix of models ×
instructions × label descriptions) is replaced by the Grid: the instruction
axis was removed, and label descriptions are an option of insusty-privacy's
adapter for insusty-custom.

### Chat playground

The Playground view (`#playground`) loads **one** bundled model at a time,
q8 on WASM like the bench, in its own child process (`dashboard/playground/host.ts`).
Loading another model or pressing _Unload_ kills that process, so the
operating system gets all of its memory back. The header shows load time,
current and peak RSS (from `/proc`), context length and WASM threads. It
handles one request at a time; a second one gets HTTP 409 while it is busy.
Rough RSS on this laptop: SmolLM2-360M about 1.9 GB at its peak, so do not
load it while a bench run is going.

- **Free chat.** Editable system message, user message and optional assistant
  prefill, max new tokens, greedy or sampling (temperature, top-p, not seeded)
  and a wall-clock deadline. The whole history is re-sent each turn. For every
  turn it shows the exact text the model continues (chat template with role
  markers, plus the prefill), prompt and generated token counts, the raw
  completion with special tokens, latency, first-token time and the finish
  reason (`eos`, `max_new_tokens`, `deadline`, `context`).
- **Extension review preset.** Each label also takes up to three examples,
  one per line, and the panel shows the plain-text request of each label.
  Runs the extension ref's own review through its package on the loaded
  weights (a traced runtime records each request): the per-label
  instructions and demonstrations, the `Text: …` input and `LABEL:` cue,
  pagination, the stop rule, the generation budget, parsing, anchoring and
  patterns. Custom labels and
  descriptions are editable, under the extension's constraints. You can load
  them from a dataset profile in any description variant, and pick dev-split
  example texts (the test split stays out). Each engine request shows the
  rendered prompt, its token count, the raw completion and the runtime report.
  The accepted findings are highlighted in the text, next to the dataset's
  ground truth when the text is an unedited example.

The playground calls the model only when you click; it writes no files.
