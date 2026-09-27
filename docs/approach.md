# How the bench runs the extension's code

## Goal: test exactly what ships

The bench never re-implements the review logic. For a chosen git ref of
InsustyPromptCoach it runs that ref's own:

- `composeReviewInstructions` (system prompt + fixed output schema + label list),
- `reviewPrompt` (chunking, `<text_to_scan>` framing, `Findings:` prefill,
  parsing of `LABEL: passage` lines, code-side anchoring, echo rejection, dedup),
- `SlmEngine` (chat-template framing, prepared instruction-prefix KV cache,
  line-protocol stop rule, the 30 s generation budget, deterministic decoding),
- `DEFAULT_SLM_PROMPT` and `SLM_MODELS`.

Only two things come from the bench: the Transformers.js loader for Node
(`src/run/transformers-loader.ts`) and the scoring.

### Two review designs

`loadExtApi` (`src/ext/ref.ts`) recognizes which design a ref ships and
exposes both through the same `runReview` / `preparedInstructions` calls:

- **chat** (PR #17 line protocol, the list above): one chat request per
  chunk; the instruction variants (`--instructions`) apply.
- **completion** (refs exporting `composeLabelPrefix`, the design recommended
  in `experiments/REPORT.md`): one plain-text request per custom label, built
  from the label's description and `examples`, answered in one line; the
  engine pins its decoding settings, which the Node loader forwards like
  `model-worker.ts`. There is no system instruction, so the instruction axis
  is moot, and the bench fills each rule's `examples` from the profile
  (first three). Built-in labels are not sent to the model.

## Materializing a ref without touching the clone

`src/ext/ref.ts`:

1. `git -C <clone> rev-parse --verify <ref>^{commit}` gives the commit sha.
2. `git -C <clone> archive <sha> src package.json | tar -x -C cache/ext/<sha>/`
   reads the files straight from the clone's object store. The clone's working
   tree, index and branches are never touched (no checkout, no worktree, no
   install, no build), so uncommitted edits there are irrelevant and safe.
3. esbuild bundles a tiny entry (`export * as review from "./src/slm-review.ts"`,
   same for `slm-engine`, `config`, `slm-models`, `slm-generation`) into
   `cache/ext/<sha>/bench-ext.mjs`, with `@huggingface/transformers` external.
4. The runner imports that bundle. It is cached per sha, so switching refs is
   instant after the first time.

The default ref is `main` (the line protocol of PR #17 is merged there); pass
`--ref <branch or sha>` or set `INSUSTY_EXT_REF` to benchmark another commit. Every result is
cached under the commit sha, and every report shows the ref, sha and commit
subject it measured.

The loader mirrors the adapters in the ref's `src/model-worker.ts` (that file is
a browser worker entry point and cannot be imported). If a future ref changes
how the worker drives Transformers.js (not the engine or review modules, which
are imported), update `src/run/transformers-loader.ts` to match.

The runner warns if the ref's `@huggingface/transformers` range differs from the
version installed here (currently both 3.8.1).

## Runtime: onnxruntime-web WASM in Node

The extension runs `q8` weights on WASM (its `auto` choice when WebGPU is not
used). The bench does the same, in Node: `package.json` aliases
`onnxruntime-node` to the exact `onnxruntime-web` build the extension pins, so
Transformers.js runs the same WASM kernels as the browser, with
`min(4, CPU count)` threads like `model-worker.ts`. Findings from setting this up
(2026-09-26, same prompt, greedy decoding):

| Runtime | Qwen2.5-0.5B output | Peak RSS | Speed |
| --- | --- | --- | --- |
| onnxruntime-web WASM, default session options (**used**) | coherent | 3.0-3.45 GB during load, ~2.4 GB steady | 4-5 tok/s |
| same, `graphOptimizationLevel: "basic"` or `"disabled"` | different text | ~2.7-3.0 GB | same or 3x slower |
| native `onnxruntime-node` 1.21 CPU | **different, degraded text** | 2.1 GB | 7 tok/s |

Greedy decoding on these q8 models is sensitive to kernel and graph-optimization
differences, so only the unmodified WASM path is representative of what users
get. SmolLM2-135M peaks around 1.1 GB. Qwen2.5-0.5B's transient load peak
(model file buffered in JS while the WASM heap is filled) exceeds 3 GB for a
few seconds; the browser showed a similar +2.2 GB. To keep this bounded, each
model runs in its own child process (the OS reclaims the whole WASM heap
before the next model loads, and models never load in parallel), and the
parent kills a worker whose RSS exceeds `--max-rss-mb` (default 3800).

## Latency

Per-case latency is measured around `reviewPrompt` after the instruction prefix
is prepared (the extension prepares it when settings change), so it covers
chunk prefill plus generation. Node WASM speed is close to, but not the same
as, a given user's browser: compare latencies between runs on the same
machine, not with field numbers.
