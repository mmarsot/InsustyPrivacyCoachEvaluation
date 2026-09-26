# Experiment log: local SLM review

Iterating on how the extension's custom-label scan prompts and drives its
small local models. Tool: `npm run lab` (src/lab/), which renders each request
exactly like the extension ref (parity-checked) and varies one thing at a time
(src/lab/configs.ts). Scoring: the ref's own parser and anchoring, then the
bench scorer (overlap P/R/F1 at passage level, case detection, false-positive
rate on negatives, format compliance, failure modes).

- Iteration set: `experiments/sets/iter32.json` (32 dev cases, 22 positive, 10
  negative, 16 EN / 16 FR). The held-out test split is never used.
- Extension ref: `main` @ dc91f36 (line protocol, PR #17) unless noted.
- Runtime: onnxruntime-web WASM, 4 threads, greedy, one model process at a time.
- Columns: F1o/P/R = overlap F1, precision, recall (%), F1x = exact F1, det =
  positive cases detected, FPR = negatives with a false finding, comp = format
  compliance, p50s = median latency (s), tok = mean generated tokens.
- Per-case outputs of every run: `experiments/runs/<name>.json`.

## 2026-09-26

### E0. Lab parity with the extension engine

Ran the ref's own `SlmEngine` + `reviewPrompt` and the lab's `ref`
configuration on 5 iter32 cases with SmolLM2-135M: 5/5 raw outputs identical
(`src/lab/parity.ts`). The lab reproduces the extension exactly, so every
other configuration differs from the shipped behaviour only by its overrides.

### E1. Baseline, SmolLM2-135M (extension default model)

| config | F1o | P | R | F1x | det | FPR | comp | p50s | tok | failures |
|---|---|---|---|---|---|---|---|---|---|---|
| ref | 5 | 33 | 3 | 0 | 5 | 10 | 34 | 5.6 | 123 | timeout 2, echo 3, echo_instructions 22, answered 5 |

The shipped default model mostly recites the label list back (22/32) instead
of scanning. Run: `smol135-ref`.

### E2. First hypotheses on SmolLM2-135M

One change at a time from `ref` (definitions in `src/lab/configs.ts`). Run `e2-smol135`.

| config | F1o | P | R | F1x | det | FPR | comp | p50s | tok | failures |
|---|---|---|---|---|---|---|---|---|---|---|
| ref | 5 | 33 | 3 | 0 | 5 | 10 | 34 | 5.6 | 123 | timeout 2, echo 3, echoI 22, answered 5 |
| rp1 | 5 | 33 | 3 | 0 | 5 | 10 | 34 | 5.9 | 122 | same as ref (SmolLM2 has no default penalty) |
| strict | 0 | 0 | 0 | 0 | 0 | 10 | 13 | 5.4 | 125 | echoI 15, answered 9 |
| nobuiltin | 5 | 100 | 3 | 0 | 5 | 0 | 22 | 3.4 | 145 | timeout 5, echoI 10, answered 10 |
| shots-generic | - | - | 0 | - | 0 | 0 | 72 | 1.0 | 32 | halluc 16 (copies the demo email) |
| shots-labelex | - | - | 0 | - | 0 | 0 | 97 | 0.5 | 2 | always "NONE" (copies the last demo answer) |
| lbl-means | 27 | 50 | 18 | 23 | 23 | 0 | 16 | 5.7 | 120 | echoI 14, answered 7, unkL 3 |
| lbl-quoted | - | - | 0 | - | 0 | 0 | 0 | 5.9 | 133 | echoI 24 |
| order-lis | - | - | 0 | - | 0 | 0 | 0 | 2.5 | 63 | echo 14, answered 16 |
| user-instr | 9 | 40 | 5 | 9 | 9 | 0 | 53 | 6.3 | 116 | echoI 21, answered 8 |
| v4 | 5 | 100 | 3 | 5 | 5 | 0 | 28 | 4.6 | 94 | echo 7, echoI 14, answered 10 |

Conclusions:

- SmolLM2-135M cannot do the task with any prompt tried: it recites the label
  list, invents labels, or copies demonstrations verbatim (the last
  few-shot answer, or the demo email). Its best score (lbl-means, 4 of 22
  positives) is within noise at n=32.
- Few-shot as prior chat turns is harmful for this model: it parrots the last
  demo reply instead of reading the text.
- The label list's `- LABEL: description` layout is the line shape the model
  is asked to produce, and it gets recited; changing it (`lbl-means`) was the
  only change that moved recall. Worth retesting on stronger models.
- Next: screen the other bundled models and the candidates
  (experiments/RESEARCH.md) on a few configurations, instead of tuning the
  135M further.

### E2b. Candidate models need a newer runtime

- All four candidate exports (LFM2.5-350M, LFM2-350M-Extract, Gemma 3 270M,
  Granite 4.0 H 350M) fail to create a session on the onnxruntime-web build
  the extension pins (1.22.0-dev.20250409, via Transformers.js 3.8.1): a raw
  WASM exception number, no message. They are IR 10 / opset 21 exports with
  `com.microsoft` ops and external `.onnx_data` weights.
- onnxruntime-web 1.24.3 loads them. The lab runs candidates on it through a
  module-resolution hook in the worker only (`src/lab/ort-next-hooks.mjs`,
  package alias `onnxruntime-web-next`); bundled models stay on the pinned build.
- Two more gaps in Transformers.js 3.8.1 for these exports, patched in the lab:
  in Node it never hands external data to onnxruntime-web (the loader now
  reads the `.onnx_data` file and passes `session_options.externalData`, as
  the browser build does), and the newer exports take a `num_logits_to_keep`
  input that only Transformers.js v4 feeds (the lab worker feeds 1).
- **Consequence for the extension:** adopting any candidate model means
  upgrading onnxruntime-web (Transformers.js v4.3 ships 1.31.0-dev) or
  re-exporting the model for the old runtime.
- LFM2.5-350M q8 peaks at about 2.1 GB RSS, far below Qwen2.5-0.5B (3.45 GB).

### E2c. Prefix KV reuse changes greedy outputs (numerics, not a bug)

Running the same requests without the prefix cache (`--no-prefix-cache`,
whole prompt in one forward pass) changed the raw output of 4/4 cases on both
SmolLM2-135M and LFM2.5-350M. q8 models quantize activations dynamically with
one scale per forward call, so prefilling the instructions separately from the
text changes the numbers slightly, and greedy decoding amplifies that. The
lab keeps prefix reuse on by default because that is what the extension does
(its engine prepares the instruction prefix once). Practical consequence:
single-case differences between configurations are noisy; only aggregate
metrics over many cases mean anything.

### E3. Model screen (6 configurations per model)

Configurations: `ref`, `lbl-means`, `v4`, `user-instr`, `fmt-example` (schema
plus an example reply with made-up labels), `json-extract` (LFM2-Extract's
native JSON protocol, converted to lines). Runs `e3-<model>`.

SmolLM2-360M:

| config | F1o | P | R | F1x | det | FPR | comp | p50s | tok | failures |
|---|---|---|---|---|---|---|---|---|---|---|
| ref | 19 | 36 | 13 | 12 | 18 | 30 | 28 | 9.1 | 127 | timeout 6, echo 3, echoI 7, answered 9, unkL 2, halluc 3 |
| lbl-means | 18 | 67 | 11 | 9 | 14 | 10 | 16 | 4.3 | 65 | timeout 2, echo 7, answered 17 |
| v4 | 19 | 33 | 13 | 8 | 14 | 20 | 41 | 8.8 | 99 | echoI 13, answered 6 |
| user-instr | 14 | 60 | 8 | 14 | 9 | 10 | 78 | 12.0 | 102 | echoI 23 |
| fmt-example | 0 | - | 0 | - | 0 | 0 | 9 | 5.4 | 73 | answered 16, unkL 5 |
| json-extract | 0 | 0 | 0 | 0 | 0 | 10 | 0 | 12.5 | 116 | answered 22 |

- The 360M does better than the 135M at baseline (F1 19 vs 5) but no prompt
  change helps it; the example reply in `fmt-example` is imitated as prose.
- Typical errors: recites the label list, lists topics of the text ("Tone:
  Witty"), puts the same passage under every label, and completes names that
  are not in the text ("Kofi Owusu" for "Kofi"), which anchoring drops.

### E3b. Relaxed anchoring (parser-side, rescoring only)

`--anchor relaxed`: when a passage is not in the text, keep the longest run of
its words that is (at least 4 characters). Rescored the cached SmolLM2 runs
(`e3-relax-smol`): recall +0 to +3 points, but the false-positive rate on
negatives rises by 10 points in 3 of 8 rows. Not adopted for now; recheck on
stronger models.

LFM2.5-350M (partial, stopped after 54 of 192 generations to free the model
slot): under `ref` it scored F1 13 (P 33, R 8), mostly listing bare passages
without labels (answered 23/32), p50 17 s for about 28 tokens. Its natural
style is a bare list of passages, which suits the per-label passage-only
format better (see E5).

### E4. Classification instead of generation (negative result)

Idea: code proposes candidate spans and the model only answers yes/no per
(candidate, label), read from the next-token probabilities; no free text, so
no echo, no answering, no invented passages, no loops.
(`npm run lab:classify`, `src/lab/candidates.ts`, `src/lab/classify-*.ts`).

- Candidate generator (identifier-like tokens, capitalized sequences, figures,
  quoted strings, ALL-CAPS words), model-free check on the whole dev split
  (`src/lab/candidates-coverage.ts`): covers 93% of expected passages (98% of
  clear positives, 78% of subtle ones) with 9.5 candidates per case.
- The models cannot discriminate. ROC AUC of P(yes) over all 594 questions of
  iter32 (76 positive):

| model | question variant | AUC | best F1o | note |
|---|---|---|---|---|
| SmolLM2-360M | q1 ("is X one of these: description?") | 0.47 | 18 (t=0.5, P 13) | answers yes/no (92% of the mass) at random |
| LFM2.5-350M | q1 | 0.50 | 22 (P 14) | says yes to nearly everything; FPR 100% |
| LFM2.5-350M | q1-ex3 (description + 3 examples) | 0.42 | 22 | |
| LFM2.5-350M | q2 (label name + description) | 0.51 | 22 | |
| LFM2.5-350M | q3 (category + examples, contrast question) | 0.56 | 25 | |

Conclusion: a label description like "names of our agency's clients" gives a
sub-500M model nothing to decide on for an isolated candidate. Dropped; the
candidate generator stays available (it could still serve as a cheap
pre-filter or as a deterministic fallback).

### E5a. Qwen2.5-0.5B memory: garbage-collect after load

The first Qwen2.5-0.5B lab run was killed by the lab's 3.5 GB RSS guard right
after loading (3.27 GB after load, 3.57 GB at the first prefill). Measured in
a standalone process: RSS 3337 MB after load with 1.47 GB of live JS
ArrayBuffers; after a forced `gc()`, RSS 2361 MB and 0.49 GB of ArrayBuffers.
The load high-water mark is unchanged, but about 1 GB of stale JS copies of
the weights would otherwise stay resident. `loadPretrained` now calls `gc()`
when available, and every model worker (bench, lab, playground host) is
spawned with `--expose-gc`. Relaunched run: RSS 3.03 GB after load, 2.65 GB
while generating.

### E5. Qwen2.5-0.5B with chat-style prompts (run `e5-qwen`)

| config | F1o | P | R | F1x | det | FPR | comp | p50s | tok | failures |
|---|---|---|---|---|---|---|---|---|---|---|
| ref | 0 | - | 0 | - | 0 | 0 | 0 | 8.0 | 76 | timeout 3, echo 6, answered 23 |
| rp1 | 0 | - | 0 | - | 0 | 0 | 3 | 7.0 | 56 | echo 10, answered 20 |
| lbl-means | 0 | - | 0 | - | 0 | 0 | 0 | 9.0 | 74 | answered 29 |
| v4 | 0 | - | 0 | - | 0 | 0 | 0 | 7.7 | 62 | echo 14, answered 17 |
| pl-passages | 14 | 16 | 13 | 0 | 18 | 20 | 100 | 10.6 | 75 | halluc 26 |

- As shipped, Qwen2.5-0.5B finds nothing: the `Findings:` prefill makes it
  write analysis bullets about the text ("The text mentions...", "No labels
  present"), or it answers the request inside the text.
- Removing the inherited repetition penalty (`rp1`) does not change that.
- Per-label passes produce the right kind of output but Qwen rewrites the
  text (fixes typos, capitalizes, translates), so most passages fail anchoring.

### E6. Completion framing with per-label demonstrations (the first real gain)

`raw-pl`: no chat template. One request per custom label, rendered as plain
text: a one-line instruction with the label and its description, two
demonstrations built from the label's first two examples (one English, one
French carrier sentence), one clean-text demonstration answered `NONE`, then
`Text: <prompt>` and the answer cue `<LABEL>:`. Generation stops at the first
line break (48-token cap). The label is attached by code; each line is
anchored by the ref's parser. Runs `e6-raw-smol360`, `e6-raw-others`,
`e6b-raw-smol360`, `e6c-raw-smol360`.

| model | config | F1o | P | R | F1x | det | FPR | comp | p50s | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SmolLM2-135M | ref | 5 | 33 | 3 | 0 | 5 | 10 | 34 | 5.6 | | |
| SmolLM2-135M | **raw-pl** | **30** | 30 | 29 | 23 | 41 | 80 | 100 | 1.6 | 39 | 14 |
| SmolLM2-360M | ref | 19 | 36 | 13 | 12 | 18 | 30 | 28 | 9.1 | | |
| SmolLM2-360M | **raw-pl** | **38** | 37 | 39 | 21 | 36 | 40 | 100 | 2.3 | 51 | 20 |
| SmolLM2-360M | raw-pl-negfirst (NONE demo first) | 29 | 24 | 37 | 19 | 45 | 100 | 100 | 2.8 | 33 | 24 |
| SmolLM2-360M | raw-pl-counter (+ counter-example NONE demo) | 14 | 20 | 11 | 8 | 14 | 30 | 100 | 2.4 | 17 | 9 |
| SmolLM2-360M | raw-pl-noex (no example demos) | 5 | 50 | 3 | 5 | 5 | 10 | 100 | 2.2 | 9 | 0 |
| SmolLM2-360M | raw-pl-name (cue `client name:`) | 31 | 30 | 32 | 20 | 32 | 50 | 100 | 2.2 | 42 | 14 |
| SmolLM2-360M | raw-pl-pair (two-passage demo `a \| b`) | 11 | 20 | 8 | 11 | 14 | 30 | 100 | 2.4 | 14 | 8 |
| SmolLM2-360M | raw-pl-noinstr (demos only) | 31 | 31 | 32 | 18 | 36 | 60 | 100 | 2.7 | 36 | 25 |
| SmolLM2-360M | raw-pl-delim (text in `"""`) | 22 | 27 | 18 | 13 | 27 | 60 | 100 | 2.6 | 33 | 8 |
| Qwen2.5-0.5B | ref | 0 | - | 0 | - | 0 | 0 | 0 | 8.0 | | |
| Qwen2.5-0.5B | **raw-pl** | **36** | 42 | 32 | 28 | 36 | 30 | 100 | 4.4 | 55 | 14 |

Conclusions:

- Plain completion with in-context demonstrations is what these models can
  do: F1 x2 (360M), x6 (135M), 0 -> 36 (Qwen), with 100% parseable output
  and 2-4x lower latency (one short line per label instead of a rambling list).
- Demonstrations derived from the label's own examples are essential (without
  them, F1 5): the extension would need users to give 1-3 examples per label.
- The last demonstration steers the default answer: ending on a positive demo
  makes the model always answer something (FPR 100%); a counter-example demo
  pushes it to answer NONE.
- French stays weak (F1 14-20 vs 39-55 in English) for all three models.
- Qwen still paraphrases, capitalizes or translates some passages, and the
  upper-case label cue sometimes leaks into its answer (`KEYCLOAK_CORP_QMK_...`).

### C1. Confirmation of raw-pl on the disjoint 48-case set (`c1-confirm48`)

`experiments/sets/confirm48.json` (32 positive, 16 negative, 24 EN / 24 FR,
disjoint from iter32). Qwen2.5-0.5B was skipped: only about 3 GB of RAM was
available (other processes on the machine), below its 3.45 GB peak plus margin.

| model | config | F1o | P | R | F1x | det | FPR | comp | p50s | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SmolLM2-135M | ref | 3 | 33 | 2 | 3 | 3 | 6 | 21 | 4.4 | | 8 |
| SmolLM2-135M | raw-pl | **29** | 31 | 27 | 24 | 44 | 81 | 100 | 1.7 | 34 | 22 |
| SmolLM2-360M | ref | 30 | 58 | 20 | 28 | 22 | 19 | 27 | 10.5 | 36 | 20 |
| SmolLM2-360M | raw-pl | 32 | 42 | 25 | 23 | 38 | 44 | 100 | 3.5 | 37 | 23 |

- SmolLM2-135M: the gain replicates (F1 3 -> 29).
- SmolLM2-360M: the F1 gain does **not** replicate (30 -> 32; on iter32 it
  was 19 -> 38). What replicates is format compliance (27% -> 100%), latency
  (10.5 s -> 3.5 s) and case detection (22% -> 38%), at the cost of the
  false-positive rate on negatives (19% -> 44%).
- Lesson: 32 cases is too few to rank configurations that are within ~15
  points. Next tuning runs use a larger dev set.

### Ops: lab runs that looked hung

Twice a lab run sat at 0% CPU with no worker (LFM2.5 screen, first C1 run):
the parent was in `waitForMemory`, polling every 30 s for up to 10 min with a
single log line. Fixed in `src/lab/runtime.ts`: a heartbeat line on every
15 s poll, a 180 s default limit (`LAB_MEM_WAIT_S`) ending in an explicit
`SKIPPED` line, and worker watchdogs (spawn error resolves at once; no
`loaded` event after 300 s or no event for 120 s kills the worker).

### T1. raw-pl variants on the 96-case tuning set, SmolLM2-360M (`t1-smol360`)

`experiments/sets/tune96.json`: iter32 plus 64 dev cases disjoint from
confirm48 (54 positive, 42 negative, half EN half FR).

| config | F1o | P | R | F1x | det | FPR | comp | p50s | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| ref | 17 | 42 | 11 | 12 | 17 | 14 | 29 | 9.3 | 20 | 14 |
| **raw-pl** | **30** | 32 | 29 | 18 | 39 | 36 | 100 | 2.8 | 38 | 23 |
| raw-pl-mix (counter-example demo between positives) | 19 | 32 | 14 | 16 | 24 | 17 | 100 | 2.6 | 15 | 22 |
| raw-pl-negfr (ends on a French NONE demo) | 33 | 33 | 33 | 22 | 46 | 52 | 100 | 2.8 | 41 | 22 |
| raw-pl-neg2 (EN then FR NONE demos) | 16 | 23 | 13 | 11 | 19 | 33 | 100 | 2.5 | 19 | 13 |
| raw-pl-noinstr | 28 | 29 | 27 | 18 | 37 | 43 | 100 | 2.6 | 40 | 18 |

- The raw-pl gain over ref holds on 96 cases (+13 F1, recall x2.6, format
  100%, latency /3), with a higher false-positive rate (36% vs 14%).
- Every demo-order tweak trades recall against false positives; none moves
  F1 beyond noise except downwards. Two NONE demos in a row make the model
  answer NONE too often.
