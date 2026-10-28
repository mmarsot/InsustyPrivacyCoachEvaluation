# insusty-privacy: the extension's redaction module

The system under test: InsustyPromptCoach's redaction module at any git ref
that ships it as a package (`insusty-prompt-coach/redaction`, extension PR
#132 and later; `main` by default). The bench installs the package from
GitHub at the ref's commit and scores it only through the redaction contract
(`contract/`), which the package itself implements. A local clone
(`bench.local.json` `extRepo`, `INSUSTY_EXT_REPO` or `--ext-repo`) resolves
ref names and diffs, read-only.

## What this folder holds

| Path | What it is |
| --- | --- |
| `manifest.json` | contract version, inputs, the labels it produces, its configurations (read without loading the module) |
| `module.ts` | the module adapter: installs the ref's package and returns its `RedactionModule` |
| `dataset-adapters/<dataset>.json` | one per dataset it runs: its output → that dataset's labels, missing labels listed (`modules/README.md`) |
| `insusty.ts` | the module adapter on the bench side: the package's `createContractModule` with what the bench injects (on-device runtime, connected transport, PDFium, measurements) |
| `materialize.ts`, `ref.ts` | the one materializer (the package at the ref's commit → `cache/module/<sha>/`); ref resolution and `refReview` (the ref's models and the instructions its review prepares, read through the package) |
| `runtime/transformers-loader.ts` | the Node WASM loader that mirrors the extension's `src/model-worker.ts` |
| `runtime/scripted.ts` | a scripted on-device runtime (no weights) that records the ref's prompts and replays answers, and a traced runtime that reports each generation |
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

## The module adapter in short

The bench never modifies the extension clone and never imports extension
internals. The one materializer (`modules/insusty-privacy/materialize.ts`)
resolves the ref to a commit in the clone, refuses a commit whose
`package.json` does not export `./redaction` (it predates the package,
extension PR #132: score a later ref), and installs
`github:mmarsot/InsustyPromptCoach#<sha>` into `cache/module/<sha>/` with
npm, whose `prepare` builds the package there (a commit GitHub does not
have, such as an unpushed branch, is installed from the clone instead,
`git+file://<clone>#<sha>`, which npm only reads). That install also holds the
`@embedpdf/pdfium` version the commit's lockfile pins. Each commit gets its
own install, so refs score side by side and the bench's own lockfile never
changes; the extension repository is private, so git needs credentials for
github.com (`gh auth setup-git`).

`modules/insusty-privacy/insusty.ts` imports the package and returns
`createContractModule(...)`: rules, documents (file check, reader, redacted
version), the Private AI review on the device and on a connected model, the
merge of rule and custom-label findings and the redaction are all the ref's
own. The bench injects only what the package takes from its host:

- the on-device runtime: the Node WASM loader (below), started on first use;
- the connected transport (`connected.ts`: reply cache, cost, budget);
- PDFium, loaded from the ref's install;
- what a run measures around each call (peak memory, the machine profile).

Every bench (review, detbench, docbench, literature, conformance) scores the
ref only through its `redact()`.

Where the bench needs more of the ref's Private AI than `redact()` reports,
it asks the package with a scripted on-device runtime
(`runtime/scripted.ts`): a tokenizer that decodes back to the exact text and
a model that answers from a script. The ref's review, engine and parsing run
as shipped and the runtime records what reaches the model. `refReview` (in
`ref.ts`) uses it to read the instructions the ref prepares for a label set
(the scorer checks echoed answers against them; cost estimates measure
them), `npm run parity` to compare the ref's requests and readings with the
lab's, and `npm run components` to replay cached answers.

Refs from before the package cannot be scored (their recorded numbers stay
as text in the docs). The model list comes from the package's capabilities;
`modules/insusty-privacy/models.json` only describes models (priors, sizes,
advertised languages).

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
- the lab's `shipped` baseline and its switches re-render the extension's
  prompts (with no code-fence skip), and the lab reads answers with its copy
  of the ref's line protocol (`lab/protocol.ts`): the package exports
  neither, and `npm run parity` checks both against the ref.

## The connected configuration

```bash
npm run bench -- --config glm47-flash-connected --dataset insusty-custom --tier smoke --dry-run   # plan + cost estimate
npm run bench -- --set tune96 --models glm47-flash-connected,smollm2-360m   # the review runner's own flags
npm run docbench -- --ref main --ai default,glm47-flash-connected --budget-usd 5
```

The Private AI track's connected model, GLM-4.7 Flash on Bedrock
(`glm47-flash-connected`, `modules/insusty-privacy/connected.ts`), runs through the
ref's **own** connected-model client (the package's connected engine, with
its context budget, learned-example limits, pacing and time limit),
configured as a user would connect it (Trusted AI connection, `auto`
format, the default 15 s time limit). The ref builds every request, paces
and retries it and parses the answer; the bench supplies only the transport
(a `ConnectedTarget`): a reply cache keyed by the exact request
(`results/jobs/connected/`), cost from the provider's token usage, and the
`--budget-usd` cap. Its results are marked connected, with their
cost. Smoke on `main` @ `95454ec` (16 prompts): F1 51.9% (P 41.2%, R
70.0%, 6 of 8 negatives flagged), 1.9 s per prompt (p50), 40 requests for
0.0011 USD (0.072 USD per 1,000 prompts); SmolLM2-360M on the device:
F1 33.3% (P 37.5%, R 30.0%), 3.7 s per prompt.

## How the bench runs the extension's code

### Goal: test exactly what ships

The bench never re-implements the redaction. For a chosen git ref of
InsustyPromptCoach it runs that ref's own package: its rules, its file
check, and its Private AI review, one plain-text completion request per
custom label (instruction, demonstrations from the label's examples, the
`Text: …` input and `LABEL:` answer cue), its engine (prepared prefix KV
cache, first-line stop, token cap, pinned greedy decoding, the 30 s
generation budget), its parsing, anchoring, plausibility filter, confidence
filter and example-derived patterns, and its merge and redaction.

Only three things come from the bench: the Transformers.js loader for Node
(`modules/insusty-privacy/runtime/transformers-loader.ts`), the connected
transport and the scoring.

### Installing a ref without touching the clone

`modules/insusty-privacy/materialize.ts` is the one materializer every bench uses:

1. `git -C <clone> rev-parse --verify <ref>^{commit}` gives the commit sha,
   and `git -C <clone> show <sha>:package.json` must export `./redaction`;
   the clone's working tree, index and branches are never touched.
2. `npm install` in `cache/module/<sha>/` installs
   `github:mmarsot/InsustyPromptCoach#<sha>` (npm clones that commit,
   installs its dev dependencies in its own cache and runs `prepare`, which
   builds `lib/redaction/`) and `@embedpdf/pdfium` at the version the ref's
   lockfile pins. The first install of a ref takes about 30 s and the
   network; it is cached per sha, so switching refs is instant after that.
3. `modules/insusty-privacy/insusty.ts` imports the package from that
   install and returns its contract module; the harness scores the ref only
   through it.

The default ref is `main`; pass `--ref <branch or sha>` or set
`INSUSTY_EXT_REF` to benchmark another commit (from GitHub, or from the
clone when it is not pushed). Every result is cached under the commit sha,
and every report shows the ref, sha and commit subject it measured.

The loader mirrors the adapters in the ref's `src/model-worker.ts` (that file is
a browser worker entry point and is not in the package). If a future ref changes
how the worker drives Transformers.js (not the engine or review, which run
from the package), update `modules/insusty-privacy/runtime/transformers-loader.ts` to match.

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

Per-case latency is the model stage of `redact()` after the instruction
prefixes are prepared (`prepare()`, as the extension prepares them when
settings change), so it covers chunk prefill plus generation. Node WASM speed is close to, but not the same
as, a given user's browser: compare latencies between runs on the same
machine, not with field numbers.
