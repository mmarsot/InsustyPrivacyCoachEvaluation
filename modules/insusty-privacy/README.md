# insusty-privacy: the extension's redaction module

The system under test: InsustyPromptCoach's redaction module at any git ref
of a local clone (`bench.local.json` `extRepo`, `INSUSTY_EXT_REPO` or
`--ext-repo`; `main` by default), read-only. Every runner scores it through
the redaction contract (`contract/`).

## What this folder holds

| Path | What it is |
| --- | --- |
| `manifest.json` | contract version, inputs, the labels it produces, its configurations (read without loading the module) |
| `module.ts` | the module adapter: materializes the ref and returns a `RedactionModule` |
| `dataset-adapters/<dataset>.json` | one per dataset it runs: its output → that dataset's labels, missing labels listed (`modules/README.md`) |
| `insusty.ts`, `documents.ts`, `labels.ts` | the contract adapter: the ref's rules, file check and Private AI behind `redact()`; ref category names → contract labels (`CATEGORY_ALIASES`) |
| `materialize.ts`, `ref.ts` | the one materializer (git archive → `cache/module/<sha>/`); ref resolution and the lab's view of the ref's Private AI internals |
| `runtime/transformers-loader.ts` | the Node WASM loader that mirrors the extension's `src/model-worker.ts` |
| `connected.ts` | the transport of the connected configuration: reply cache, cost, budget |
| `models.json` | descriptions of the local models (sizes, priors, advertised languages); the ref decides which exist |
| `changes.ts` | extension paths → the grid rows (tracks) a change needs |
| `tools/components.ts` | `npm run components`: replays cached answers with the confidence filter or patterns switched off (no model) |
| `lab/` | the prompt-engineering lab, the shipped baseline and its ablations, request parity ([lab/README.md](lab/README.md)) |
| `shipped-improvements.md` | the ledger of Local AI improvements that shipped because of this bench |

## Configurations

Local and connected models are configurations of this module, not modules:

| Configuration | What it runs |
| --- | --- |
| `rules` | the ref's rules with its default settings, Private AI off |
| `rules-all` | every built-in label on (and every address country the ref declares), Private AI off |
| `smollm2-360m` | the rules plus Private AI on the device: SmolLM2-360M, the model the extension ships (~1.9 GB peak while loading) |
| `glm47-flash-connected` | the rules plus Private AI on a connected model: GLM-4.7 Flash on Bedrock (paid; `AWS_BEARER_TOKEN_BEDROCK`; `--budget-usd`, default 5) |

A new local model is a new `device` configuration plus its `models.json`
entry (the Node loader must handle its architecture, and the extension must
ship it for the result to reflect the product). A new connection setting
(format, time limit, pace) is a new configuration id, never an edit: results
are cached by model id.

## Dataset adapters

| Dataset | Adapter | Runs with |
| --- | --- | --- |
| insusty-custom | `labels: "per-case"`: each profile's custom labels go to Private AI; option `labelVariants` | `smollm2-360m`, `glm47-flash-connected` |
| insusty-builtin | the 9 built-in labels, one to one | every configuration (Private AI ones repeat `rules`) |
| insusty-documents | the 9 built-in labels, plus per-case custom labels for its Private AI suite | every configuration |
| tab, gretel, nemotron | the label maps it was scored with before the modules/datasets layout (1 of 8, 16 of 29, 17 of 55 labels answered with built-in spans; names and organisations are custom targets, outside the headline) | `rules`, `rules-all` |

## Which grid rows a change reruns (the tracks)

`npm run suite` runs the tracks a change to the extension needs, from
`git diff --name-only <base>...<ref>` in the clone (read-only; the rules are
in `changes.ts`). A track is a slice of the grid: the deterministic track is
the `rules` and `rules-all` rows, the Private AI track the `smollm2-360m` row
(and `glm47-flash-connected` with `--connected`).

| Change in the extension                                                                                                                   | Tracks             |
| ----------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| deterministic rules (`src/detection/`)                                                                                                    | deterministic only |
| document reading or OCR (`src/files/readers/`, `src/files/ocr/`, the file check, the document worker), configuration, `package-lock.json` | both               |
| Private AI (`src/private-ai/`, the model worker, review and label learning)                                                               | Private AI only    |
| anything else (UI, capture, sync, docs, tests)                                                                                            | none               |

`--full` runs every track (release runs); `--tracks` picks them by hand.

- **Deterministic track**: contract conformance, detbench, docbench, and the
  literature adapters (with the Presidio baseline on `--full`).
- **Private AI track**: request parity with the lab's shipped baseline
  (`npm run parity`, no model, no network), the review suites on the ref's
  shipped on-device model (SmolLM2-360M), and Private AI on documents. The
  connected model (GLM-4.7 Flash, paid) runs only with `--connected`.
- **CI** (`--ci --since <base>`): the gates compare the head ref with the
  base on the same dataset and fail on a deterministic or document
  regression (`detbench --compare <base> --gate`,
  `docbench --tier smoke --compare <base> --gate`: half a point of F1,
  recall or precision, a new leak, a failure file no longer reported, more
  flagged hard negatives) and on contract conformance and request parity.
  The Private AI smoke tier runs on Private AI changes and never fails on
  score deltas.
- **Speed and memory** are recorded on every run with the machine profile
  (`machineProfile` in `run.json`; `BENCH_MACHINE_ID` names a declared
  reference machine, anything else is `adhoc`). Compare absolute numbers only
  within one profile; CI runners are not one.

## The contract adapter in short

The bench never modifies the extension clone. One materializer
(`modules/insusty-privacy/materialize.ts`) resolves the ref to a commit, runs `git
archive` from the clone's object store into `cache/module/<sha>/`, installs
the npm packages the ref's redaction path imports at the versions its
lockfile pins, and bundles every module of that path it finds (detection,
configuration, file reading and redaction, Private AI review, engine, model
list, connected-model client) into one `module.mjs`. `modules/insusty-privacy/insusty.ts`
adapts that bundle to the redaction contract, and every bench (review,
detbench, docbench, literature) scores the ref only through its
`redact()`:

- rules: the ref's `detectSensitiveData` with its `DEFAULT_CONFIG` and the
  contract configuration applied (built-in labels, address countries);
- documents: the ref's file check, document reader and redacted version;
- Private AI on the device: the ref's `reviewPrompt` and `SlmEngine` (prompt
  composition, framing, prefill, stop rules, generation budget, parsing,
  anchoring, patterns, confidence filter) on the bench's Node loader;
- Private AI on a connected model: the ref's own connected-model client;
- the final merge of rule and custom-label findings follows the extension's
  `reviewForRedaction`, which lives in its service worker: the one step
  mirrored rather than imported.

The default ref is `main`. Pass `--ref <branch or sha>` to benchmark any
other commit; refs from before the per-label design (PR #26) score only
the deterministic track. The model list comes from the ref
(`SLM_MODELS`, `DEFAULT_SLM_MODEL_ID`); `modules/insusty-privacy/models.json` only describes
models (priors, sizes, advertised languages).

Inference uses onnxruntime-web WASM in Node, which is the same runtime the
extension uses; the bench checks its versions against the ref's lockfile.
Each model runs in its own child process, one model at a time.
"How the bench runs the extension's code" below has the details and the
measurements behind these choices. For example, native onnxruntime-node changes the greedy
output, so the bench does not use it.

What still needs an extension-side change before a bench-side copy can go:

- the inference loader (`modules/insusty-privacy/runtime/transformers-loader.ts` mirrors the ref's
  browser-only `src/model-worker.ts` adapters): needs a Node-loadable
  runtime entry in the extension;
- the rule and custom-label merge (`reviewForRedaction` in
  `src/background/review.ts`): needs a pure, exported merge function;
- `SUPPORTED_ADDRESS_COUNTRIES` (`src/config/config.ts`) is not exported, so
  the `all` configuration stays FR-only instead of FR, US, CA and AU;
- the lab's `shipped` baseline and its switches re-render the extension's
  prompts (with no code-fence skip): they move next to the module, with exact
  parity, when the lab moves.

## The connected configuration

```bash
npm run bench -- --config glm47-flash-connected --dataset insusty-custom --tier smoke --dry-run   # plan + cost estimate
npm run bench -- --set tune96 --models glm47-flash-connected,smollm2-360m   # the review runner's own flags
npm run docbench -- --ref main --ai default,glm47-flash-connected --budget-usd 5
```

The Private AI track's connected model, GLM-4.7 Flash on Bedrock
(`glm47-flash-connected`, `modules/insusty-privacy/connected.ts`), runs through the
ref's **own** connected-model client (`createHostedModelClient`, the
`HOSTED_CONTEXT_BUDGET` and learned-example limits), configured as a user
would connect it (Trusted AI connection, `auto` format, the default 15 s
time limit). The ref builds every request, paces and retries it and parses
the answer; the bench supplies only the transport: a reply cache keyed by
the exact request (`results/jobs/connected/`), cost from the provider's token usage,
and the `--budget-usd` cap. Its results are marked connected, with their
cost. Smoke on `main` @ `95454ec` (16 prompts): F1 51.9% (P 41.2%, R
70.0%, 6 of 8 negatives flagged), 1.9 s per prompt (p50), 40 requests for
0.0011 USD (0.072 USD per 1,000 prompts); SmolLM2-360M on the device:
F1 33.3% (P 37.5%, R 30.0%), 3.7 s per prompt.

## How the bench runs the extension's code

### Goal: test exactly what ships

The bench never re-implements the review logic. For a chosen git ref of
InsustyPromptCoach it runs that ref's own:

- `composeReviewInstructions` (system prompt + fixed output schema + label list),
- `reviewPrompt` (chunking, `<text_to_scan>` framing, `Findings:` prefill,
  parsing of `LABEL: passage` lines, code-side anchoring, echo rejection, dedup),
- `SlmEngine` (chat-template framing, prepared instruction-prefix KV cache,
  line-protocol stop rule, the 30 s generation budget, deterministic decoding),
- `DEFAULT_SLM_PROMPT` and `SLM_MODELS`.

Only two things come from the bench: the Transformers.js loader for Node
(`modules/insusty-privacy/runtime/transformers-loader.ts`) and the scoring.

#### Two review designs

`loadExtApi` (`modules/insusty-privacy/ref.ts`) recognizes which design a ref ships and
exposes both through the same `runReview` / `preparedInstructions` calls:

- **chat** (PR #17 line protocol, the list above): one chat request per
  chunk with a system instruction (the bench's former `--instructions`
  axis; such refs no longer run Private AI through the contract).
- **completion** (refs exporting `composeLabelPrefix`, the design recommended
  in `modules/insusty-privacy/lab/experiments/REPORT.md`): one plain-text request per custom label, built
  from the label's description and `examples`, answered in one line; the
  engine pins its decoding settings, which the Node loader forwards like
  `model-worker.ts`. There is no system instruction, so the instruction axis
  is moot, and the bench fills each rule's `examples` from the profile
  (first three). Built-in labels are not sent to the model.

### Materializing a ref without touching the clone

`modules/insusty-privacy/materialize.ts` is the one materializer every bench uses:

1. `git -C <clone> rev-parse --verify <ref>^{commit}` gives the commit sha.
2. `git -C <clone> archive <sha> src package.json package-lock.json | tar -x -C cache/module/<sha>/`
   reads the files straight from the clone's object store. The clone's working
   tree, index and branches are never touched (no checkout, no worktree, no
   install, no build), so uncommitted edits there are irrelevant and safe.
3. An entry re-exports every module of the redaction path the ref has
   (detector, config, redaction, file check, document reader and model,
   Private AI review, engine, model list, generation, connected-model framing
   and client), each found by its area-folder path (since PR #82) or the flat
   one before.
4. The npm packages they import are installed at the ref's locked versions
   (`npm ci` on a lockfile subset; network only the first time), and esbuild
   bundles the entry into `cache/module/<sha>/module.mjs`, resolving packages
   only from that install, with `@huggingface/transformers` external (the
   bench supplies the runtime, below).
5. `modules/insusty-privacy/insusty.ts` adapts the bundle to the redaction contract
   (`contract/README.md`); the harness scores the ref only through it. The
   lab and the playground also read the bundle's Private AI internals
   (`loadExtApi` in `modules/insusty-privacy/ref.ts`).

It is cached per sha, so switching refs is instant after the first time.

The default ref is `main` (the line protocol of PR #17 is merged there); pass
`--ref <branch or sha>` or set `INSUSTY_EXT_REF` to benchmark another commit. Every result is
cached under the commit sha, and every report shows the ref, sha and commit
subject it measured.

The loader mirrors the adapters in the ref's `src/model-worker.ts` (that file is
a browser worker entry point and cannot be imported). If a future ref changes
how the worker drives Transformers.js (not the engine or review modules, which
are imported), update `modules/insusty-privacy/runtime/transformers-loader.ts` to match.

The runner warns when the `@huggingface/transformers` or `onnxruntime-web`
version the ref's lockfile pins differs from the one installed here
(`runtimeMismatches`; both agree today: 3.8.1 and 1.22.0-dev.20250409).

### Runtime: onnxruntime-web WASM in Node

The extension runs `q8` weights on WASM (its `auto` choice when WebGPU is not
used). The bench does the same, in Node: `package.json` aliases
`onnxruntime-node` to the exact `onnxruntime-web` build the extension pins, so
Transformers.js runs the same WASM kernels as the browser, with
`min(4, CPU count)` threads like `model-worker.ts`.

When this was set up (2026-09-26, same prompt, greedy decoding), the same q8
model gave different text with `graphOptimizationLevel: "basic"` or
`"disabled"`, and different, degraded text on native `onnxruntime-node` 1.21
CPU. Greedy decoding on q8 weights is sensitive to kernel and
graph-optimization differences, so only the unmodified WASM path is
representative of what users get. (That measurement was on a model since
removed from the bench, with its numbers.) SmolLM2-360M peaks around 1.9 GB
while loading (the model file is buffered in JS while the WASM heap is
filled). To keep this bounded, each
model runs in its own child process (the OS reclaims the whole WASM heap
before the next model loads, and models never load in parallel), and the
parent kills a worker whose RSS exceeds `--max-rss-mb` (default 3800).

### Latency

Per-case latency is measured around `reviewPrompt` after the instruction prefix
is prepared (the extension prepares it when settings change), so it covers
chunk prefill plus generation. Node WASM speed is close to, but not the same
as, a given user's browser: compare latencies between runs on the same
machine, not with field numbers.
