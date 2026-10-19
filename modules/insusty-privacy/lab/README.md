# Prompt-engineering lab (insusty-privacy)

```bash
npm run lab -- --configs ref,shots-labelex --models smollm2-360m   # iter32 set by default
npm run lab -- --configs ref --models smollm2-360m --show-prompt --dry-run
```

`npm run lab` (this folder) is insusty-privacy's tool for fast iteration on everything the extension
could change beyond the user's own text: instruction wording and layout,
system vs user placement, few-shot demonstrations as prior chat turns, the
assistant prefill, token cap, repetition settings and JSON vs line output,
on the shipped SmolLM2-360M. Each named configuration in
`modules/insusty-privacy/lab/configs.ts` is the shipped `ref` configuration plus overrides. The
`ref` configuration renders byte-identical prompts to the extension engine
(checked against the ref's own requests by `npm run parity`, below). Lab
configurations are not grid rows: they render prompts themselves, outside the
module's `redact()`, so they live here with their own dashboard view (Lab).

- Runs on a small fixed dev set (`datasets/insusty-custom/sets/`), never on the test split.
- Renders prompts in the parent with the tokenizer only, and caches each
  generation by a hash of (model, dtype, rendered prompt, generation
  settings) in `results/jobs/lab/`.
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
  repetition penalty, P(NONE) and confidence recording, and JSON output mode.
  The rejected segment Yes/No classification (LOG S1-S4) and candidate
  classification (LOG E4) were deleted with the modules/datasets layout; the
  last commit that has their code is `f9dadd7` (LOG.md, "Restructure").
- Every run also prints a segment view: segment precision/recall against
  "the segment holds an expected passage", over-redaction (redacted
  characters outside expected passages), requests per prompt and p50/p95 per
  prompt (`segments.ts` cuts the prompt into sentences and clauses).
- While a worker runs, the run file is rewritten every ~30 s with the cases
  finished so far (`inProgress`), for the dashboard's Lab view.
- `--no-prefix-cache` runs every request whole.
- `npx tsx modules/insusty-privacy/lab/browser/run.ts --device webgpu --dtype q4 -- <lab args>`
  runs lab requests in a real Chrome (WebGPU or WASM) and stores them for
  `--backend webgpu|browserwasm` scoring.
- `datasets/insusty-custom/sets/heldout-test.json` lists the test split for one-shot
  evaluation only (`--allow-test`); never tune on it.
- Writes `modules/insusty-privacy/lab/experiments/runs/<name>.json`. The experiment log is
  `modules/insusty-privacy/lab/experiments/LOG.md`, and the current best configuration with its evidence
  is `modules/insusty-privacy/lab/experiments/REPORT.md`.

## Request parity

```bash
npm run parity -- --set tune96     # lab requests vs the ref's own reviewPrompt requests (no model, no network)
```

`modules/insusty-privacy/lab/request-parity.ts` runs the ref's own `reviewPrompt` with a
recording client and checks every per-label request against what the lab's
`shipped` configuration renders. Requests that differ only by the ref's
code-fence skip (PR #42, not modelled by the lab yet) are counted apart; any
other difference fails it (a CI gate of the Private AI track).

## Shipped baseline and ablations

```bash
npm run ablate -- --set tune96 --model smollm2-360m            # leave-one-out grid
npm run ablate -- --set tune96 --with <config>[,<config>]      # plus proposals on top
```

The `shipped` lab configuration (`modules/insusty-privacy/lab/shipped.ts`) renders the requests
the extension ships byte for byte, and each improvement recorded in
[`modules/insusty-privacy/shipped-improvements.md`](../shipped-improvements.md) has a switch:
`shipped-no-<switch>` is the baseline with that one improvement turned off.
`npm run ablate` runs the baseline, every switch and any `--with` proposals
(configurations added on top of `shipped` in `modules/insusty-privacy/lab/configs.ts`) through
the lab, and writes the deltas vs the baseline to
`modules/insusty-privacy/lab/experiments/ablations/<name>.md`. A switch whose "off" state can no longer
run (the `model` switch: SmolLM2-135M was removed) is listed as retired.
