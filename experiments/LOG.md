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

### T2. Confidence gate and language-matched demonstrations, SmolLM2-360M, tune96 (`t2-smol360`)

Note: the extension's `main` moved to ec11443 during this run (review-dialog
UI only, no change to the SLM modules), so results stay comparable.

| config | F1o | P | R | F1x | det | FPR | p50s | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|
| raw-pl (= gate off) | 30 | 32 | 29 | 18 | 39 | 36 | 2.6 | 38 | 23 |
| raw-pl-gate0.3 | 30 | 32 | 29 | 18 | 39 | 36 | 2.6 | | |
| raw-pl-gate0.2 | 23 | 25 | 20 | 12 | 30 | 31 | 2.6 | | |
| raw-pl-gate0.1 | 18 | 25 | 14 | 8 | 20 | 26 | 2.6 | | |
| raw-pl-gate0.05 | 10 | 17 | 7 | 5 | 9 | 21 | 2.6 | | |
| **raw-pl-lang** | **33** | 37 | 30 | 26 | 46 | 48 | 3.1 | 35 | **31** |
| raw-pl + relaxed anchoring | 29 | 28 | 31 | 16 | 41 | 50 | | | |
| raw-pl-lang + relaxed anchoring | 31 | 33 | 30 | 25 | 46 | 60 | | | |

- Confidence gate (drop a label's answer when P(first token = NONE) >= t):
  anti-informative. Lower thresholds remove true positives faster than false
  ones, so precision falls too. The model's NONE probability does not track
  correctness. Dropped.
- Demonstrations in the scanned text's language (`raw-pl-lang`, language
  guessed from stop words, 564/567 correct on dev): French F1 23 -> 31,
  exact-match F1 18 -> 26, English about flat. New best.
- Relaxed anchoring confirmed harmful (FPR +12-14 points).

### T3. Label-description variants inside the raw-pl-lang instruction (`t3-smol360`)

| config | F1o | P | R | F1x | det | FPR | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|
| raw-pl-lang (description) | 33 | 37 | 30 | 26 | 46 | 48 | 35 | 31 |
| raw-pl-lang-dx3 (description + 3 examples) | 31 | 40 | 25 | 24 | 37 | 43 | 31 | 31 |
| raw-pl-lang-xc (examples + counter-examples) | 29 | 35 | 24 | 20 | 35 | 38 | 25 | 32 |

Within noise; the plain description stays (the examples are already in the
demonstrations).

### T4. Code-side post-filters (rescoring only, `t4-filter-*`)

`--filter basic` drops answer passages that cannot be a sensitive item on
their own: under 3 characters, a bare 1-2 digit number, only stop words, or
more than 8 words (a copied sentence or instruction). `dedup` drops a passage
claimed by two or more labels. SmolLM2-360M, tune96:

| config | F1o | P | R | F1x | det | FPR |
|---|---|---|---|---|---|---|
| raw-pl | 30 | 32 | 29 | 18 | 39 | 36 |
| raw-pl + basic | 29 | 35 | 24 | 19 | 37 | 24 |
| raw-pl + basic + dedup | 27 | 41 | 20 | 19 | 31 | **14** |
| raw-pl-lang | 33 | 37 | 30 | 26 | 46 | 48 |
| **raw-pl-lang + basic** | 32 | 42 | 26 | **29** | 41 | 36 |
| raw-pl-lang + basic + dedup | 30 | 45 | 22 | 26 | 37 | 29 |

The basic filter is nearly free (F1 -1) and cuts the FP rate by 12 points;
`raw-pl + basic + dedup` matches the shipped false-positive rate (14%) with
F1 27 instead of 17. These filters are cheap for the extension to adopt.

### E7a. Correction: prefix KV reuse is broken for LFM2 (E2c was wrong for it)

In raw-pl mode LFM2.5-350M answered with an immediate end-of-sequence, or
with garbage (`$$$$...`, `portportport...`) when EOS was forbidden. Run
without prefix reuse, the same requests give correct answers ("Thibault
Ferrand", "Norvik Dynamics", "Halvard Cycles"). So for LFM2 the difference
seen in E2c was a Transformers.js 3.8.1 cache bug (its conv state does not
survive a prompt prefilled in two parts), not numerics. SmolLM2 and Gemma 3
give sensible (and, for Gemma, identical) outputs with reuse.

- Invalidated: LFM2.5 rows of E3 (`ref` F1 13) and E4 (classifier AUC).
- `models/candidates.json` now carries `prefixCache: false` for the LFM2
  family; the lab and classifier workers then run each request whole.
- The extension's engine always prefills the instruction prefix separately,
  so shipping an LFM2 model would need that path disabled (or Transformers.js
  v4) as well as the newer onnxruntime-web.
- Granite 4.0 H 350M is not runnable on Transformers.js 3.8.1: its Mamba
  state inputs (`past_conv.*`, `past_ssm.*`) are never initialized. Dropped.

## 2026-09-27

### G1. Reaching the NVIDIA GPU from WebGPU on this laptop

Hardware: Intel UHD 620 (iGPU) + NVIDIA GeForce GTX 1050 Max-Q (Pascal,
4 GB, driver 580.178.04, PRIME on-demand), Chrome 153 on a Wayland session.
Probe: a page calling `navigator.gpu.requestAdapter()` with
`powerPreference` high-performance / low-power / default and printing
`adapter.info` (script kept out of the repo; commands below).

| launch | adapters exposed |
|---|---|
| headless Chrome, default flags | SwiftShader only (CPU fallback) |
| headless + `--enable-features=Vulkan` (with or without `--use-angle=vulkan`, PRIME env) | GPU process crashes (exit 139) or `vkCreateInstance() failed: -7` (no surface extensions without a display); SwiftShader or nothing |
| headless + `--use-angle=gl-egl` | `requestAdapter` never resolves |
| headful Chrome, default flags | SwiftShader only |
| **headful Chrome + `--enable-features=Vulkan`** | **high-performance and default: NVIDIA Pascal; low-power: Intel gen-9 (with shader-f16)** |
| Node + Dawn (`webgpu` npm), `backend=vulkan` | high-performance: NVIDIA Pascal (no shader-f16); low-power: Intel |

- What works: a normal (headful) Chrome started with
  `--enable-features=Vulkan`; nothing else is needed (no PRIME variables, no
  ANGLE flag, `--enable-unsafe-webgpu` not required). Chrome warns that the
  Wayland ozone platform is "not compatible with Vulkan" but WebGPU compute
  still gets the adapter.
- What does not: any headless Chrome (no Vulkan instance), and Chrome
  without the Vulkan feature (WebGPU falls back to SwiftShader on Linux).
- The GTX 1050 has no `shader-f16`, so fp16/q4f16 WebGPU kernels are not
  available on it; the Intel iGPU has f16.
- The extension probes `requestAdapter()` with no power preference and uses
  q4 weights on WebGPU; with the Vulkan feature the default adapter is the
  NVIDIA GPU here.

### L1. LFM2.5-350M on raw-pl-lang, tune96, without prefix reuse (`l1-lfm-tune96`)

Captain's priority. onnxruntime-web 1.24.3, q8, every request prefilled whole
(the prefix-cache bug of E7a worked around).

| config | F1o | P | R | F1x | det | FPR | comp | p50s | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| raw-pl-lang | 13 | 18 | 11 | 11 | 19 | 40 | 95 | 21.4 | 15 | 12 |
| raw-pl-lang + basic filter | 13 | 18 | 10 | 11 | 17 | 36 | 95 | 21.4 | 13 | 12 |

(SmolLM2-360M on the same set: 33 / 32 with the filter, p50 3.1 s.)

Most answers start correctly and then degenerate into repeating a character
or syllable: `sshportportport...`, `flashaaaa...`, `keycloecoooo...`,
`££££...`; 66 of 96 cases have a passage that fails anchoring for that reason.
Short answers survive ("Thibault Ferrand", "Halvard Cycles", "J. Lindqvist").
This looks like the same Transformers.js 3.8.1 conv-state problem as E7a, now
in step-by-step decoding (the export targets Transformers.js v4), not like a
property of the model. Latency is also poor (p50 21 s) because nothing can be
cached. As measured, LFM2.5-350M is not usable with the extension's current
runtime.

### L2. LFM2.5-350M on confirm48 (`l2-lfm-confirm48`), and a Transformers.js v4 cross-check

| config | F1o | P | R | F1x | det | FPR | comp | p50s | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| raw-pl-lang | 18 | 23 | 15 | 16 | 28 | 63 | 96 | 17.8 | 16 | 21 |
| raw-pl-lang + basic filter | 18 | 23 | 15 | 16 | 28 | 63 | 96 | 17.8 | | |

Cross-check: the first 20 iter32 requests re-run with Transformers.js 4.3.0
and the onnxruntime-web 1.31.0-dev build it pins (WASM, aliased the same way
as the bench; `cache/tmp/tf4/check.mjs`, not committed). Outputs are
**identical** to Transformers.js 3.8.1 + onnxruntime-web 1.24.3 without prefix
reuse, degenerate ones included (`sshportport...`, `keycloecoooo...`). So:

- the step-by-step degeneration is not a 3.8.1 decoding bug; it is how the q8
  LFM2.5 export behaves with greedy plain-text continuation;
- the prefix-reuse failure of E7a remains a 3.8.1 problem (v4 was not tested
  with a split prefix);
- v4 in Node also needed the external-data bytes passed by hand.

### L3-L4. LFM2.5-350M: repetition penalties and chat framing (iter32)

| config | F1o | P | R | F1x | det | FPR | p50s | note |
|---|---|---|---|---|---|---|---|---|
| raw-pl-lang | 23 | 29 | 18 | 19 | 27 | 30 | 19.5 | reference |
| raw-pl-lang-rp105 (card's `repetition_penalty: 1.05`, whole sequence) | 20 | 27 | 16 | 17 | 23 | 40 | 17.1 | loops persist |
| pl-passages (chat framing, one pass per label) | 21 | 33 | 16 | 14 | 9 | 20 | 9.6 | French F1 0 |
| raw-pl-lang-arp1.3 (penalty on the answer's own tokens only) | 22 | 28 | 18 | 19 | 27 | 40 | 19.2 | loops become word salad |
| raw-pl-lang-arp1.6 | 22 | 28 | 18 | 19 | 27 | 40 | 16.4 | same |

The LFM2.5 card's repetition penalty (1.05) is not in the ONNX repo's
`generation_config.json`, so it was off; turning it on does not help, since
Transformers.js applies it to the scanned text too. A new lab option,
`answerRepetitionPenalty` (a logits processor that penalizes only tokens of
the answer being generated, so copying from the text stays free), replaces
`portportport` with `portfndeffortforwardshift...`: the model loses the thread
after a few tokens whatever the constraint.

### E7b. Gemma 3 270M-it (onnxruntime-web 1.24.3, prefix reuse OK), iter32 (`e7-candidates`)

| model | config | F1o | P | R | F1x | det | FPR | p50s | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| Gemma 3 270M | raw-pl | 33 | 30 | 37 | 29 | 50 | 100 | 6.6 | 43 | 21 |
| Gemma 3 270M | **raw-pl-lang** | **39** | 34 | 45 | 29 | 55 | 100 | 8.4 | 45 | 30 |
| Gemma 3 270M | raw-pl-lang + basic | 36 | 35 | 37 | 31 | 50 | 80 | 8.4 | | |
| Gemma 3 270M | raw-pl-lang + basic + dedup | 31 | 45 | 24 | 28 | 27 | 40 | 8.4 | | |
| SmolLM2-360M | raw-pl-lang | 38 | 43 | 34 | 30 | 50 | 60 | 2.9 | 42 | 33 |

Gemma has the highest recall of all models so far but flags every negative:
its false positives are look-alike entities (public companies and tools such
as "Fellbeck Tooling", "Apec", "Parcelio", "Temporal"), often under two labels
at once. Peak RSS 2.48 GB; 3x slower than SmolLM2-360M.

### G2. WebGPU on the GTX 1050 vs WASM, in real Chrome (`src/lab/browser/`)

Browser bench: the lab exports its rendered requests, a local page runs them
with the Transformers.js 3.8.1 web bundle in a headful Chrome started with
`--enable-features=Vulkan` (read over the DevTools protocol), and the outputs
are scored by the lab like any run (`--backend webgpu|browserwasm`). The page
prefills each request whole (no prefix cache). SmolLM2-360M, raw-pl-lang,
iter32 (80 requests):

| runtime | weights | F1o | P | R | per-request p50 | per-case p50 |
|---|---|---|---|---|---|---|
| Node WASM, prefix cache (lab reference) | q8 | 38 | 43 | 34 | ~1.2 s | 2.9 s |
| Chrome WASM (4 threads) | q8 | 36 | 38 | 34 | 3.3 s | 8.9 s |
| Chrome WASM | q4 | 21 | 25 | 18 | 5.1 s | 13.2 s |
| **Chrome WebGPU (NVIDIA Pascal)** | q4 | 15 | 25 | 11 | **2.0 s** | 5.5 s |
| Chrome WebGPU | q8 | stopped | | | ~28 s | |

- The GPU is reached (`adapter: nvidia pascal`) and is ~1.6x faster than
  in-browser WASM per request with q4 weights.
- **q4 halves the quality** whatever the device: WASM q4 and WebGPU q4 give
  the same answers in 64 of 80 requests, and both score far below q8. The
  extension uses q4 whenever it runs on WebGPU, so its WebGPU path would
  lose most of the gain of the new framing.
- q8 on WebGPU is unusable (~28 s per request): onnxruntime-web has no WebGPU
  kernels for the q8 operators, so they fall back to the CPU. The GTX 1050
  has no `shader-f16`, so fp16/q4f16 are out too.
- Prefix KV reuse matters more than the GPU here: Node WASM with the cached
  instruction prefix (2.9 s per case) beats WebGPU without it (5.5 s). The
  extension's engine does not keep the prefix on WebGPU.

### G3. fp32 weights on WebGPU keep the quality (SmolLM2-135M, raw-pl-lang, iter32)

| runtime | weights | F1o | P | R | per-request p50 | per-case p50 |
|---|---|---|---|---|---|---|
| Node WASM, prefix cache | q8 | 21 | 25 | 18 | | 1.6 s |
| Chrome WebGPU (NVIDIA), whole prompt | fp32 | 21 | 20 | 24 | 0.66 s | 1.9 s |

With fp32 weights (540 MB for the 135M) the GPU matches q8 quality and is as
fast without a prefix cache as WASM is with one. The GTX 1050 cannot run
fp16, and q4 costs half the F1 (G2), so fp32 is the only good WebGPU option
on this GPU; for the 360M that is a 1.45 GB download and upload.
(For the 135M, `raw-pl-lang` scores below `raw-pl`, 21 vs 30 on iter32.)

### D1-D3. Keep Qwen2.5-0.5B? (captain's criterion: F1 within ~5 points of SmolLM2-360M or clearly better in French, FP rate no worse)

raw-pl-lang, q8 WASM, prefix cache on (runs `d1-qwen-tune96`, `d2-qwen-confirm48`,
`d3-smol360-confirm48`, filtered rescoring `d1-tune96-basic`, `d23-confirm48-basic`).
Qwen2.5-0.5B loaded with a 600 MB margin (its peak is now ~3.1 GB with the GC
fix; ~3.8 GB was available): RSS 2.27 GB after load, never below 1.9 GB free.

| set | model | F1o | P | R | F1x | det | FPR | p50s | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| tune96 | SmolLM2-360M | 33 | 37 | 30 | 26 | 46 | 48 | 3.1 | 35 | 31 |
| tune96 | SmolLM2-360M + basic | 32 | 42 | 26 | 29 | 41 | 36 | 3.1 | 33 | 31 |
| tune96 | Qwen2.5-0.5B | 25 | 29 | 21 | 20 | 33 | 55 | 5.4 | 23 | 26 |
| tune96 | Qwen2.5-0.5B + basic | 24 | 31 | 19 | 22 | 33 | 45 | 5.4 | 21 | 27 |
| confirm48 | SmolLM2-360M | 30 | 37 | 25 | 28 | 38 | 50 | 3.1 | 27 | 35 |
| confirm48 | SmolLM2-360M + basic | 31 | 38 | 25 | 29 | 38 | 50 | 3.1 | 27 | 36 |
| confirm48 | Qwen2.5-0.5B | 24 | 32 | 19 | 16 | 28 | 56 | 6.3 | 24 | 23 |
| confirm48 | Qwen2.5-0.5B + basic | 24 | 32 | 19 | 16 | 28 | 56 | 6.3 | 24 | 23 |

With raw-pl-lang, Qwen2.5-0.5B is 6-8 F1 points below SmolLM2-360M on both
sets, worse in French, with a higher FP rate and twice the latency; many of
its passages fail anchoring because it paraphrases or re-cases them. Its
English-demo framing (`raw-pl`, best on iter32) is being checked on both sets
before the verdict.

### D4-D5. Add Gemma 3 270M? (raw-pl-lang, onnxruntime-web 1.24.3)

| set | model | F1o | P | R | F1x | det | FPR | p50s | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| tune96 | Gemma 3 270M | 33 | 29 | 38 | 26 | 59 | 83 | 9.5 | 34 | 33 |
| tune96 | Gemma 3 270M + basic | 33 | 32 | 35 | 28 | 57 | 76 | 9.5 | | |
| tune96 | Gemma 3 270M + basic + dedup | 27 | 37 | 21 | 22 | 31 | 52 | 9.5 | | |
| tune96 | SmolLM2-360M + basic | 32 | 42 | 26 | 29 | 41 | 36 | 3.1 | 33 | 31 |
| confirm48 | Gemma 3 270M | 35 | 34 | 37 | 24 | 56 | 81 | 7.2 | 38 | 33 |
| confirm48 | Gemma 3 270M + basic | 37 | 36 | 37 | 25 | 56 | 75 | 7.2 | | |
| confirm48 | Gemma 3 270M + basic + dedup | 26 | 35 | 20 | 13 | 31 | 69 | 7.2 | | |
| confirm48 | SmolLM2-360M + basic | 31 | 38 | 25 | 29 | 38 | 50 | 3.1 | 27 | 36 |

Gemma matches or beats SmolLM2-360M on F1 (+1 and +6) through higher recall
(35-37% vs 25-26%), but flags three negatives out of four (FP rate 75-76%
vs 36-50%), is 2-3x slower, peaks at 2.5 GB RSS and needs the
onnxruntime-web upgrade. It fails the "FP rate no worse" criterion.

### V1. Parity of the extension implementation (fm/slm-completion-framing, d42c466)

`npm run bench -- --ext-repo <task copy of InsustyPromptCoach> --ref d42c466
--set tune96 --models smollm2-360m` (run `runs/ext-d42c466-tune96-smol360/`),
read-only through `git archive`. The bench now recognizes completion-design
refs (`src/ext/ref.ts`), fills each rule's new `examples` field from the
profile, and forwards the engine's pinned decoding settings in the Node loader.

| | F1o | P | R | F1x | det | FPR | EN F1 / FPR | FR F1 / FPR | p50 | p95 |
|---|---|---|---|---|---|---|---|---|---|---|
| extension d42c466 (bench) | 32.1 | 41.5 | 26.2 | 28.6 | 40.7 | 35.7 | 32.9 / 33 | 31.5 / 38 | 2.75 s | 9.2 s |
| lab raw-pl-lang + basic filter | 32 | 42 | 26 | 29 | 41 | 36 | 33 / 33 | 31 / 38 | 3.1 s | |

- Verdict: **parity.** 239 of 240 per-label answers are byte-identical to the
  lab's (the one mismatch is the lab summary's 300-character truncation), and
  the extension's `isPlausiblePassage` equals the lab's basic filter.
- Format compliance 100%; failure modes ok 79, hallucinated 16,
  echo_instructions 1 (after fixing the bench's analysis of completion
  answers, which first read them as chat-protocol lines).
- Latency: p50 2.75 s per prompt; p95 9.2 s (long texts run one request per
  label and chunk).
- No gap found in the implementation. Bench-side gaps fixed on the way: new
  review API signature, `examples` in rules, pinned `settings` forwarded to
  `generate`, completion answers analyzed with their `LABEL:` cue.

### D6-D7. Qwen2.5-0.5B with English-only demonstrations (raw-pl): not completed

Both runs were killed by the lab's guard (system MemAvailable below 600 MB)
while Qwen2.5-0.5B loaded or ran: other processes on the machine had grown,
and Qwen's load peak is ~3.1-3.3 GB. Only cached cases got scored (33/96 and
a handful of 48); the lab now prints `INCOMPLETE` for such rows instead of a
silently partial summary. Not retried. On the complete iter32 run, raw-pl gave
Qwen EN F1 55 but FR 14, so it cannot meet the "clearly better in French"
branch of the criterion either; the D1-D3 verdict (drop Qwen2.5-0.5B) stands.

### H1. Held-out test split, one shot (bench path; runs `test-dc91f36-smol360`, `test-d42c466-smol360`)

All 242 test cases (never used for any tuning), SmolLM2-360M, q8 WASM,
through `npm run bench -- --tier full --split test`.

| design | F1o | P | R | F1x | det | FPR | comp | timeouts | p50 | p95 | EN F1 / FPR | FR F1 / FPR |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| shipped chat design (dc91f36) | 12.0 | 44.2 | 6.9 | 8.4 | 11.3 | 10.9 | 33 | 34 | 10.0 s | 30.1 s | 13.1 / 3.8 | 11.0 / 18.4 |
| completion design (extension d42c466) | **27.4** | 32.2 | **23.9** | 20.5 | **41.8** | 44.6 | **100** | **0** | **2.4 s** | 8.8 s | 25.8 / 51.9 | 29.0 / 36.7 |

By case type (detection / FP rate), completion design: clear positives 42.5%
detected, subtle 29.4%, hard 55.6% (FP 60%), look-alike negatives FP 45.3%,
clean negatives FP 40.6%. Shipped design: clear 13.8%, subtle 11.8%, hard
3.7%, look-alike FP 17.2%, clean FP 0%.

The tuning-set gain holds on unseen data (F1 x2.3, recall x3.5, detection
x3.7, no timeouts, latency /4), slightly lower in absolute terms than on the
dev sets (27 vs 31-32). The cost is the false-positive rate (45% vs 11%),
including 41% of clean texts: the model answers a passage for some label in
most prompts. That is the main thing left to fix.

### T5. More code-side filters against false positives (rescoring, SmolLM2-360M raw-pl-lang)

Remaining false positives on tune96 negatives after the basic filter fall
into three groups: fragments of the user's request ("Rédige en anglais",
"peux-tu simplifier le langage ? ..."), one passage under two labels
("Jane Smith", "Hyundai", "journald"), and look-alike public entities
("Fellbeck Tooling", "eLife", "Draxon Systems") that need context.

- `request`: drop passages containing "?" or starting with a request verb
  (EN/FR list: can you, rewrite, rédige, peux-tu, ...).
- `shape`: when several labels claim a passage, keep the label whose examples
  have the most similar shape (digits, capital, separators, currency, word
  count, all-caps); drop on a tie.

| filters | tune96 F1 | P | R | FPR | confirm48 F1 | P | R | FPR |
|---|---|---|---|---|---|---|---|---|
| basic | 32 | 42 | 26 | 36 | 31 | 38 | 25 | 50 |
| basic + request | **33** | 43 | 26 | **33** | 31 | 38 | 25 | 50 |
| basic + shape | 29 | 40 | 22 | 36 | 28 | 43 | 20 | 50 |
| basic + request + shape | 29 | 42 | 22 | 33 | 28 | 43 | 20 | 50 |
| basic + request + dedup | 30 | 47 | 22 | 26 | 24 | 43 | 17 | 38 |

The request filter is a small free gain on tune96 and neutral on confirm48;
shape-based label resolution loses more true positives than it removes false
ones. Dedup remains the only strong FP lever, at a recall cost.

### C2-C3. Answer-confidence filter (SmolLM2-360M raw-pl-lang, runs `c2-conf-tune96`, `c3-conf-confirm48`)

The lab worker now records the probability of each greedy token
(`recordConfidence`, a pass-through logits processor). Scoring-time filters:
`conf<t>` drops a label's answer when the mean token probability is below
t; `cmin<t>` when the lowest one is. Thresholds swept on tune96, then applied
unchanged to confirm48.

| filters | tune96 F1 | P | R | FPR | confirm48 F1 | P | R | FPR |
|---|---|---|---|---|---|---|---|---|
| basic | 32 | 42 | 26 | 36 | 31 | 38 | 25 | 50 |
| basic + conf0.6 | 30 | 44 | 23 | 31 | | | | |
| basic + conf0.7 | 29 | 43 | 21 | 29 | | | | |
| **basic + cmin0.2** | 30 | 48 | 21 | 21 | **33** | 45 | 25 | 44 |
| **basic + cmin0.3** | 29 | 57 | 19 | **14** | 31 | 50 | 22 | 38 |
| basic + cmin0.4 | 20 | 54 | 13 | 7 | | | | |

Unlike P(NONE) at the first token (T2, anti-informative), the weakest token
of the answer tracks correctness: `cmin` raises precision and lowers the FP
rate on both sets, F1 within 3 points or better. It is a natural "sensitivity"
setting for the extension (the engine would return the lowest token
probability of the answer; `reviewPrompt` drops answers below the threshold).

### H2. Confidence filter on the held-out test split (one shot, `h2-conf-heldout`)

Thresholds fixed on the dev sets (C2-C3), evaluated once on the 242 test
cases (`experiments/sets/heldout-test.json`, evaluation only):

| filters | F1o | P | R | F1x | det | FPR | EN F1 / FPR | FR F1 / FPR |
|---|---|---|---|---|---|---|---|---|
| basic (= extension d42c466; bench gave 27.4 / 44.6) | 27 | 32 | 24 | 20 | 42 | 45 | 26 / 52 | 29 / 37 |
| basic + cmin0.2 | 26 | 36 | 20 | 20 | 36 | 34 | 25 / 33 | 27 / 35 |
| basic + cmin0.3 | 23 | 37 | 17 | 18 | 30 | 25 | 22 / 19 | 24 / 31 |

The filter generalizes as a precision/false-positive knob: at 0.2 the FP
rate falls by 11 points for 1 point of F1; at 0.3 by 20 points for 4.

### I1-I2, H3. Iterative follow-up per label (raw-pl-lang-iter3)

20-27% of expected passages share their label with another passage in the
same prompt, which one answer line per label cannot reach. `iterations: 3`:
after an anchored answer, the same label is asked again on the text with the
found passages masked as "[…]", until NONE, nothing new, or 3 rounds (first
round shared with raw-pl-lang-conf). Extra requests only for labels that
found something (tune96: +66 then +26 requests over 240).

| set | filters | F1o | P | R | F1x | FPR | p50 |
|---|---|---|---|---|---|---|---|
| tune96 | basic, 1 round | 32 | 42 | 26 | 29 | 36 | 2.5 s |
| tune96 | basic, 3 rounds | 34 | 36 | 33 | 30 | 36 | 3.3 s |
| tune96 | basic + cmin0.2, 3 rounds | 32 | 44 | 25 | 27 | 26 | 3.3 s |
| confirm48 | basic, 1 round | 31 | 38 | 25 | 29 | 50 | 2.4 s |
| confirm48 | basic, 3 rounds | 34 | 33 | 34 | 32 | 50 | 3.4 s |
| confirm48 | basic + cmin0.2, 3 rounds | 36 | 43 | 31 | 34 | 44 | 3.4 s |
| held-out test | basic, 1 round | 27 | 32 | 24 | 20 | 45 | 2.4 s |
| held-out test | basic, 3 rounds | 28 | 27 | 29 | 20 | 46 | 3.5 s |
| held-out test | basic + cmin0.2, 1 round | 26 | 36 | 20 | 20 | 34 | 2.4 s |
| held-out test | basic + cmin0.2, 3 rounds | 27 | 32 | 23 | 20 | 37 | 3.5 s |

Recall rises on every set (+5 to +9 points), but later rounds also add
non-verbatim or wrong passages, so precision falls; F1 gains +2 to +3 on the
dev sets and only +1 on the held-out split, for about 1 s more per prompt.
A recall option, not a clear default.

### E8. Three example demonstrations instead of two (tune96, `e8-ex3-tune96`)

| config | filters | F1o | P | R | F1x | FPR |
|---|---|---|---|---|---|---|
| raw-pl-lang (2 example demos) | basic | 32 | 42 | 26 | 29 | 36 |
| raw-pl-lang-ex3 (3 example demos) | basic | 28 | 31 | 25 | 22 | 45 |
| raw-pl-lang | basic + cmin0.2 | 30 | 48 | 21 | 26 | 21 |
| raw-pl-lang-ex3 | basic + cmin0.2 | 28 | 36 | 23 | 22 | 33 |

A third positive demonstration makes the model answer more often (FP +9)
without finding more. Two example demos plus the NONE demo stay.

### Fix: overfit words in the plausibility filter's stop-word list

The basic filter's stop-word list contained "simple" and "terms", taken from
one tune96 false positive ("simple terms" in legal-en-040). The extension
copied the list (`PASSAGE_STOP_WORDS`, d42c466). Removed from the lab; effect:
tune96 FP rate 36 -> 38% (that one case), confirm48 and held-out unchanged
(held-out F1 27, FP 45%). Recommended: drop both words in the extension too.
Earlier rows that say "basic" were scored with the old list.

### E9. French instruction line for French prompts (tune96, `e9-frinstr-tune96`)

| config | filters | F1o | P | R | FPR | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|
| raw-pl-lang (English instruction, language-matched demos) | basic | 32 | 41 | 26 | 38 | 33 | 31 |
| raw-pl-lang-frinstr (French instruction for French prompts) | basic | 25 | 34 | 19 | 33 | 33 | **17** |

The English-first SmolLM2 needs the English instruction; only the
demonstrations should follow the prompt's language.

### E10-E11. uint8 weights instead of q8 (SmolLM2-360M, raw-pl-lang)

The model repo ships `model_uint8.onnx` (same size, different quantization)
next to `model_quantized.onnx` (q8, byte-identical to `model_int8.onnx`).

| set | weights | filters | F1o | P | R | F1x | FPR |
|---|---|---|---|---|---|---|---|
| tune96 | q8 | basic | 32 | 41 | 26 | 28 | 38 |
| tune96 | uint8 | basic | 36 | 38 | 34 | 24 | 50 |
| tune96 | q8 | basic + cmin0.2 | 30 | 48 | 21 | 26 | 21 |
| tune96 | uint8 | basic + cmin0.2 | 35 | 43 | 30 | 24 | 38 |
| confirm48 | q8 | basic | 31 | 38 | 25 | 29 | 50 |
| confirm48 | uint8 | basic | 35 | 38 | 32 | 26 | 75 |
| confirm48 | q8 | basic + cmin0.2 | 33 | 45 | 25 | 30 | 44 |
| confirm48 | uint8 | basic + cmin0.2 | 33 | 38 | 29 | 23 | 75 |

uint8 answers more often: higher recall, much higher FP rate and lower
exact-match F1. Once the confidence filter is applied, q8 matches its F1 with
far fewer false positives. Keep q8.

### E12. Agreement between two demonstration variants (tune96, `e12-alt-tune96`)

`raw-pl-lang-alt` uses other carrier sentences and another clean NONE text
(a grammar-fix request); `raw-pl-lang-agree` keeps only findings both
variants make (two requests per label).

| config | filters | F1o | P | R | F1x | FPR |
|---|---|---|---|---|---|---|
| raw-pl-lang | basic | 32 | 41 | 26 | 28 | 38 |
| raw-pl-lang-alt | basic | 27 | 41 | 20 | 23 | 17 |
| raw-pl-lang-agree | basic | 22 | 52 | 14 | 20 | 10 |
| raw-pl-lang | basic + cmin0.2 | 30 | 48 | 21 | 26 | 21 |
| raw-pl-lang-alt | basic + cmin0.2 | 28 | 51 | 19 | 25 | 17 |
| raw-pl-lang-agree | basic + cmin0.2 | 21 | 57 | 13 | 19 | 10 |

Agreement cuts false positives but halves recall: worse than the confidence
filter at a similar FP rate, for twice the requests. The alternate prompt on
its own answers NONE more often (FP 17%); E13 isolates which part does it.

### E13. Which part of the alternate prompt lowers the FP rate? (tune96)

| config | filters | F1o | P | R | F1x | FPR |
|---|---|---|---|---|---|---|
| raw-pl-lang (original carriers + original NONE text) | basic | 32 | 41 | 26 | 28 | 38 |
| altneg (original carriers + alternate NONE text) | basic | 26 | 34 | 20 | 19 | 33 |
| altpos (alternate carriers + original NONE text) | basic | 27 | 39 | 21 | 25 | 33 |
| alt (both alternates) | basic | 27 | 41 | 20 | 23 | 17 |

Neither part alone explains it; only the combination answers NONE much more
often. This is prompt-wording sensitivity at the noise level of a 96-case
set, not a transferable lesson. Demo wording tuning stops here; the original
prompt (the one the extension implements) stays.

### G7-G8. Does the confidence filter rescue Gemma 3 270M's false positives?

| set | model | filters | F1o | P | R | FPR | p50 |
|---|---|---|---|---|---|---|---|
| tune96 | Gemma 3 270M | basic | 33 | 32 | 35 | 76 | 7.7 s |
| tune96 | Gemma 3 270M | basic + cmin0.2 | 34 | 34 | 34 | 67 | |
| tune96 | Gemma 3 270M | basic + cmin0.4 | 33 | 36 | 30 | 50 | |
| tune96 | SmolLM2-360M | basic + cmin0.2 | 30 | 48 | 21 | 21 | 2.5 s |
| confirm48 | Gemma 3 270M | basic | 37 | 36 | 37 | 75 | 7.3 s |
| confirm48 | Gemma 3 270M | basic + cmin0.2 | 35 | 36 | 34 | 69 | |
| confirm48 | Gemma 3 270M | basic + cmin0.4 | 34 | 38 | 31 | 63 | |
| confirm48 | SmolLM2-360M | basic + cmin0.2 | 33 | 45 | 25 | 44 | 2.4 s |

Gemma's token confidence separates its false positives much less than
SmolLM2's: even at 0.4 its FP rate stays at 50-63%. Its extra recall does not
turn into a better operating point; the D4-D5 verdict stands.

### Qwen3-0.6B: not run (memory rule)

`onnx-community/Qwen3-0.6B-ONNX` q8 is a single 618 MB file (vs 512 MB for
Qwen2.5-0.5B, whose load peak is ~3.1-3.3 GB even with the GC fix). Its load
peak would exceed the ~3.5 GB limit for this 7 GB machine, so it was not
loaded. It remains the most promising untested model (IFEval ~64, 119
languages); worth measuring on a machine with more headroom.

### P1. Example-derived patterns next to the model (rescoring only; `h4-patterns-*`)

On the held-out split, identifier-like labels were nearly missed by the model
(internal hosts 8% recall, account refs 7%, customer ids 17%, compensation
5%, internal services 0%) while names did well (50-67%). `src/lab/patterns.ts`
turns each label example that contains an identifier-like token into a
regular expression (literal prefix/separators/domain suffix, generalized digit
and code runs; plain names give none), e.g. `acct-00918-BZ` ->
`acct-\p{N}{3,8}-[\p{L}\p{N}]{1,6}`, `db-replica-07.int.quillmark.net` ->
`[\p{L}\p{N}_-]+\.int\.quillmark\.net`, `ticket #558120` -> also `#\p{N}{4,9}`.
Matches are added to the model's findings. Unit tests: `tests/patterns.test.ts`.

| set | filters | F1o | P | R | F1x | det | FPR |
|---|---|---|---|---|---|---|---|
| tune96 | basic | 32 | 41 | 26 | 28 | 41 | 38 |
| tune96 | patterns only | 16 | 100 | 9 | 16 | 13 | 0 |
| tune96 | basic + patterns | **40** | 47 | 34 | 36 | 48 | 38 |
| tune96 | basic + cmin0.2 + patterns | 38 | 56 | 29 | 34 | 39 | 21 |
| confirm48 | basic | 31 | 38 | 25 | 29 | 38 | 50 |
| confirm48 | patterns only | 21 | 90 | 12 | 14 | 13 | 6 |
| confirm48 | basic + patterns | **41** | 48 | 36 | 34 | 44 | 56 |
| confirm48 | basic + cmin0.2 + patterns | 43 | 55 | 36 | 36 | 44 | 50 |
| held-out | basic | 27 | 32 | 24 | 20 | 42 | 45 |
| held-out | patterns only | 13 | 85 | 7 | 11 | 11 | 4 |
| held-out | **basic + patterns** | **34** | 38 | 30 | 27 | 50 | 46 |
| held-out | basic + cmin0.2 | 26 | 36 | 20 | 20 | 36 | 34 |
| held-out | **basic + cmin0.2 + patterns** | **33** | 43 | 27 | 27 | 44 | 36 |

The patterns are precise (85-100%) and complementary to the model: +7 to +10
F1 on every set at no model cost and almost no FP cost. Caveat: the fictional
dataset's identifiers follow each company's formats consistently, as real
ones usually do; users whose examples do not share a format with their real
identifiers will gain less.

With the patterns, the iterative recall mode no longer helps on the held-out
split (basic + patterns: F1 34 with or without iterations; with cmin0.2: 33
both), though it still adds 2-4 points on the dev sets. Dropped from the
recommendations.

### P2. Standalone money/percent patterns (dev only, `--filter figs`)

Letting figure tokens of figure-type examples (`41.7%`, `£1.284bn`, `€87k`)
match on their own: tune96 F1 40 -> 41 (FP 38 -> 38), with cmin0.2 38 -> 40
(FP 21 -> 26); confirm48 41 -> 42, 43 -> 45 (FP unchanged). Within noise and
it matches public figures too; not recommended, not run on held-out.

### E14. LFM2-350M-Extract in its native JSON protocol (iter32, `e14-extract-iter32`)

onnxruntime-web 1.24.3, no prefix reuse (LFM2 cache bug), schema in the
system prompt as its card describes, JSON reply converted to lines.

| model | config | F1o | P | R | F1x | det | FPR | p50 |
|---|---|---|---|---|---|---|---|---|
| LFM2-350M-Extract | json-extract | 25 | 26 | 24 | 19 | 36 | 60 | 13.6 s |
| SmolLM2-360M | raw-pl-lang | 38 | 43 | 34 | 30 | 50 | 60 | 2.9 s |

It invents its own keys ("tagline_1", "client", "campaign_code"), fills every
key with something (copying whole sentences), and is 4-5x slower. (The
"answered" failure count and 0% format compliance are the line-protocol
analysis reading JSON; the F1 uses the converted lines.) Not competitive.

### A1. Leave-one-out ablation of the shipped design (tune96, SmolLM2-360M, `ablate-tune96-smollm2-360m`)

Extension PR #26 (merge 372c8ff) shipped the `raw-pl-lang` + basic-filter
design. The lab now has it as the `shipped` configuration (`src/lab/shipped.ts`;
240/240 tune96 requests byte-identical to extension `main` @ b2c4ca1, filter =
the ref's own `isPlausiblePassage`), with one `shipped-no-<switch>` per
improvement. `npm run ablate -- --set tune96 --model smollm2-360m`:

| switched off | F1o | ΔF1 | P | R | FPR | ΔFPR | det | EN / FR F1 | p50 |
|---|---|---|---|---|---|---|---|---|---|
| nothing (shipped) | 32.1 | | 41.5 | 26.2 | 35.7 | | 40.7 | 32.9 / 31.5 | 2.37 s |
| completion framing (chat template instead) | 16.7 | −15.4 | 37.9 | 10.7 | 14.3 | −21.4 | 20.4 | 23.0 / 11.3 | 2.29 s |
| one request per label (one request for all labels) | 9.0 | −23.1 | 20.0 | 5.8 | 33.3 | −2.4 | 9.3 | 9.4 / 8.6 | 2.14 s |
| label-example demos (NONE demo only) | 1.9 | −30.2 | 100 | 1.0 | 0.0 | −35.7 | 1.9 | 4.2 / – | 1.78 s |
| language-matched demos (English only) | 27.2 | −4.9 | 34.8 | 22.3 | 42.9 | +7.2 | 37.0 | 32.9 / 22.2 | 2.42 s |
| NONE demo last (NONE first) | 36.8 | +4.7 | 32.3 | 42.7 | 71.4 | +35.7 | 57.4 | 41.5 / 32.5 | 2.79 s |
| first-line stop + 48 cap (ref line stop, no cap) | 31.1 | −1.0 | 40.6 | 25.2 | 33.3 | −2.4 | 38.9 | 32.9 / 29.5 | 2.38 s |
| pinned decoding (generation_config) | 32.1 | ±0 | 41.5 | 26.2 | 35.7 | ±0 | 40.7 | 32.9 / 31.5 | (cached) |
| plausibility filter | 33.0 | +0.9 | 36.6 | 30.1 | 47.6 | +11.9 | 46.3 | 34.9 / 31.3 | 2.37 s |
| SmolLM2-360M default (SmolLM2-135M) | 23.1 | −9.0 | 28.6 | 19.4 | 47.6 | +11.9 | 31.5 | 26.6 / 19.3 | 1.19 s |

The baseline reproduces the bench's d42c466 numbers (V1). Examples,
per-label requests and completion framing carry the F1 gain. NONE-last and the
plausibility filter are false-positive levers (off: F1 +5 / +1, FP +36 / +12).
The first-line stop is quality-neutral but bounds latency (off: 2 deadline
timeouts, p95 6.4 → 7.3 s). Pinned decoding is a no-op on SmolLM2 (it matters
for Qwen2.5's shipped 1.1 penalty). Ledger with the per-improvement evidence:
`docs/shipped-improvements.md`.

### S1-S4. Segment x label Yes/No classification (captain's spec v1.1): rejected

**Negative result.** The captain's "Sensitive text classification pipeline"
(spec v1.1, 2026-09-27) was implemented in the lab and screened on
SmolLM2-360M. The captain stopped it after the iter32 screen and a partial
tune96 run and rejected it as unsuccessful: confirm48 and the held-out split
were never run, and no second model was tried (Qwen2.5-0.5B needs ~4.6 GB
free with the margin; this machine had ~3 GB). The code stays in the lab,
off unless a `seg-*` configuration is selected. Reasons, in short (details
in S2-S4):

1. **The spec's chat-template prompt makes SmolLM2-360M answer Yes to
   everything**: Yes on 83% of the checks whose segment holds nothing of the
   label, P(Yes) identical on positive and negative checks (ROC AUC 0.48),
   every negative prompt flagged.
2. **The shipped completion framing fixes the format but not the
   judgment**: 98% bare Yes/No answers, but ROC AUC 0.62-0.63, and F1 24-25
   against 34-38 for the shipped design on the same cases. No P(Yes)
   threshold helps (AUC is threshold-free); fewer demonstrations or less
   context make it worse.
3. **Cost**: 8.8-9 requests per prompt (segments x labels), each re-reading
   the whole prompt: p50 6.7 s vs 2.5 s (2.7x) and p95 44-56 s vs 5-5.4 s
   (8-10x).
4. **Over-redaction**: whole-segment redaction puts 83-94% of the redacted
   characters outside the expected passages (shipped: 48-56%), even when the
   flag is right.
5. **As a second-stage verifier of shipped findings it is no better than
   what exists**: P(Yes) barely separates correct from wrong shipped findings
   (AUC 0.60); the best threshold trades 7 F1 points for 13 FP points, where
   the answer-confidence filter (C2-C3) trades ~2 F1 points for ~15 FP
   points at no extra request.

This repeats E4 (yes/no over code-proposed candidates, AUC 0.42-0.56) with
sentence targets, BEFORE/AFTER context, a policy with exclusions and
matching/non-matching demonstrations: a sub-500M model cannot make the
policy decision from a description and a few examples, whatever the target
granularity.

#### S1. Implementation

Proposal: application code cuts the prompt into sentences / clear clauses
with exact offsets; for each (segment, custom label) the model gets the
label's policy, a few demonstrations and the segment as TARGET between its
BEFORE and AFTER text, and answers exactly Yes or No; anything else is
unresolved (never No); a segment is redacted whole when any label says Yes.
Lab: `src/lab/segment.ts` (model-free part, `tests/segment.test.ts`), the
`segment` field of a lab configuration, planning/scoring in `src/lab/cli.ts`,
configurations `seg-yn*` / `seg-verify*` in `src/lab/configs.ts` (added on
top of `shipped`, so `npm run ablate -- --with <id>` works).

- **Segmentation** (spec §1): every line is a boundary (paragraphs, list
  items, table/CSV rows, code lines), then sentences within a line: after
  `.` `!` `?` `…` runs followed by whitespace, except after abbreviations
  (Mr., vs., etc., e.g., p.m. ...), initials (K. Anand, M. Lhomme) and a
  leading list number; decimals and URLs have no whitespace after their dots.
  `;` + whitespace outside quotes splits clauses. Commas never split.
  Segments longer than 1000 characters would split at the comma nearest
  their middle (never triggered: the longest dev/test segment is 290). Whole
  dataset: 3,605 segments for 809 prompts (median 3, p90 9, max 36), every
  non-whitespace character covered, and no expected passage crosses a
  segment boundary. `Intl.Segmenter` was tried first and rejected: it splits
  after "Mr." / "K." / "M." and inside URLs, and never after a lower-case
  start ("ok cool. next one?").
- **Request** (spec §2-4): the spec's six instruction lines; `POLICY:` with
  `LABEL: description`, `Covered, for example:` the label's examples and
  `Not covered:` its counter-examples (the dataset has no aliases; the
  counter-examples are the exclusions); `EXAMPLES:` then `CURRENT INPUT:` with
  `Before:` / `Target:` / `After:` lines (empty sections left out, as in the
  spec's pattern) and `Answer:`. Texts are JSON string literals (quotes,
  backslashes and line breaks escaped: the spec's "quoted or escaped data").
  Context = the whole prompt. It always fits: over all 8,995 dev+test checks
  the largest request is 1,069 tokens (prefix at most 398, input 191 on
  average), under the 2,048-token budget set per check; over budget would
  fall back to the neighboring segments, and still over budget would be an
  unresolved check without a request.
- **Demonstrations** (from each profile, language-matched like the shipped
  design, carrier sentences reused from it): Yes on a carrier sentence with
  the label's first example; No on one with another label's first example
  (the task allowed counter-examples or other labels; several
  counter-examples are descriptions such as "figures from last year's
  published annual report" that do not fit in a carrier sentence, so they
  stay in the policy as exclusions); Yes with the second example; No on a
  harmless target ("Please make this shorter and friendlier.") after a
  sensitive BEFORE sentence with the third example (the spec's
  "sensitive context alone is not sufficient" demonstration). They
  alternate and end on No (the shipped NONE-last lesson).
- **Framing** (spec §4 asks for the chat template): `chat` = the instruction
  as the system message and the rest as the user turn, generation after the
  assistant header. The captain's addendum allowed the shipped completion
  framing, so `completion` renders the same text plainly (no template),
  ending on `Answer:`.
- **Decoding and answers** (spec §5): greedy, 4-token cap, stop at the first
  line break; the new tokens only are parsed; Yes/No accepted after trimming
  whitespace and end markers, any case, one trailing period; everything else
  (empty, explanations, `Answer: No`, echoed `Target: "…`) is unresolved.
  The worker also records P(Yes) and P(No) at the first answer token (sum over
  the single-token variants `Yes`/` Yes`/`yes`/` yes` and the same for No),
  which gives two more decisions from the same cached requests: `-logit`
  (constrained decoding: Yes when P(Yes) > P(No)) and `-p<t>` (Yes when
  P(Yes)/(P(Yes)+P(No)) >= t).
- **Combining** (spec §6): each Yes is a finding (label, whole segment);
  labels are independent, so a segment keeps every label that said Yes;
  unresolved checks add nothing and are counted. Redaction merges overlapping
  ranges and ranges separated only by whitespace (`redact`, unit-tested on
  the spec's §7 example).
- **Prefix reuse / latency**: the instruction, policy and demonstrations are
  the reusable prefix, per label and language (like the shipped per-label
  prefixes, not timed); each check prefills its BEFORE/TARGET/AFTER input and
  decodes 1-2 tokens. Latency per prompt = sum of its checks, sequential.
- **Scoring**: (a) the bench's passage metrics with each flagged segment as a
  finding with its label (overlap precision counts a segment as correct when
  it overlaps an expected passage of that label, however much else it
  covers); (b) a segment view, printed for every configuration including
  `shipped`: segment precision/recall against "the segment overlaps an
  expected passage" (any label), over-redaction = share of redacted
  non-whitespace characters outside every expected passage, requests per
  prompt; for Yes/No checks the unresolved rate, cases with an unresolved
  check, check-level precision/recall, the Yes rate on negative checks and
  the ROC AUC of P(Yes) (a check is positive when its segment holds a passage
  of its label, the E4 diagnostic).
- **Hybrid** (`seg-verify*`, the captain's second-stage idea): the shipped
  per-label requests as they are, then each shipped finding is kept only when
  a segment it overlaps is not a No for its label (an unresolved check keeps
  it). Only the checks of segments with a finding count as requests and
  latency (the lab computes all checks once, shared with `seg-yn*`).
  `vAUC` = ROC AUC of P(Yes) between correct and wrong shipped findings.

#### S2. Screen on iter32: chat template (spec) vs completion framing (`s1-seg-iter32`)

SmolLM2-360M, 32 cases, 288 checks per configuration (9.0 per prompt, 36
positive). `-logit` / `-p<t>` rows reuse the same requests.

| config | F1 | P | R | det | FPR | segP | segR | over-red. | unresolved | req/prompt | p50 s | p95 s | AUC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| shipped | 34 | 42 | 29 | 46 | 60 | 52 | 36 | 56 | – | 2.5 | 2.5 | 5.4 | – |
| seg-yn (chat, spec) | 22 | 13 | 87 | 86 | 100 | 28 | 100 | 91 | 12 | 9.0 | 5.7 | 54.7 | 0.48 |
| seg-yn-logit | 22 | 12 | 95 | 96 | 100 | 27 | 100 | 91 | 0 | 9.0 | 5.7 | 54.7 | 0.48 |
| seg-yn-p0.8 | 17 | 15 | 18 | 27 | 50 | 32 | 42 | 90 | 0 | 9.0 | 5.7 | 54.7 | 0.48 |
| seg-yn-raw (completion) | 25 | 20 | 32 | 32 | 40 | 41 | 52 | 86 | 2 | 9.0 | 6.7 | 55.8 | 0.62 |
| seg-yn-raw-logit | 23 | 18 | 32 | 32 | 50 | 38 | 52 | 87 | 0 | 9.0 | 6.7 | 55.8 | 0.62 |

- **Chat template (the spec as written): always Yes.** The greedy answer is
  "Yes" on 240 of 288 checks and on 83% of the checks whose segment holds
  nothing of the label; mean P(Yes)/(P(Yes)+P(No)) is 0.69 on positive and
  0.69 on negative checks (AUC 0.48). Every negative prompt gets a finding
  (FP 100%). The 12% unresolved answers continue the demonstration format
  (`Target: "Please…`) or write `Answer: No` (a No buried in text is
  unresolved, as the spec says).
- **Completion framing (captain's addendum): formats well, discriminates
  weakly.** 98% of answers are a bare Yes/No, mostly No (233/288: the
  demonstrations end on No), AUC 0.62 (mean normalized P(Yes) 0.42 on
  positive vs 0.37 on negative checks). F1 25 vs 34 shipped.
- **Latency:** 9 requests per prompt, each re-reading the whole prompt: p50
  2.7x and p95 10x the shipped design (the CSV prompt `dev-en-047` takes
  65 s: 9 segments x 3 labels, ~2.4 s per check).
- **Over-redaction:** 86-91% of the characters the segment designs redact
  are outside the expected passages (shipped: 56%). Even a correct flag
  hides the whole sentence around a two-word name.

#### S3. The spec's variants on iter32: context size and demonstrations (`s3-seg-variants-iter32`)

Completion framing (the better one in S2), one change each.

| config | F1 | P | R | det | FPR | segP | segR | over-red. | unresolved | req/prompt | p50 s | p95 s | AUC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| seg-yn-raw (whole prompt, 4 demos) | 25 | 20 | 32 | 32 | 40 | 41 | 52 | 86 | 2 | 9.0 | 6.7 | 55.8 | 0.62 |
| seg-yn-raw-nb (neighbor segments only) | 20 | 15 | 32 | 32 | 50 | 40 | 61 | 87 | 1 | 9.0 | 6.4 | 16.0 | 0.56 |
| seg-yn-raw-d2 (2 demos: Yes, context No) | 6 | 7 | 5 | 9 | 30 | 15 | 13 | 94 | 2 | 9.0 | 5.5 | 48.4 | 0.59 |
| seg-yn-raw-d0 (no demos) | 10 | 10 | 11 | 18 | 80 | 14 | 16 | 92 | 39 | 9.0 | 6.6 | 45.9 | 0.54 |
| seg-yn-raw-d0-logit | 21 | 16 | 34 | 50 | 60 | 28 | 58 | 90 | 0 | 9.0 | 6.6 | 45.9 | 0.54 |

- Neighbor-only context cuts p95 from 56 to 16 s but lowers AUC (0.56),
  French most (0.62 -> 0.47).
- Fewer demonstrations lower AUC; without any, 39% of answers are not Yes/No
  (`A:`, `Output:`, empty, lower-case forms), so the demonstrations are what
  holds the format. Constrained decoding (`-logit`) removes the unresolved
  answers but cannot add discrimination.
- Per-label AUCs are scattered (0.2 to 1.0 on 1-4 positive checks each):
  no label family is reliably separated.
- Kept for tuning: whole-prompt context, 4 demonstrations, completion
  framing (`seg-yn-raw`), with the decision (greedy, logit, P(Yes)
  threshold) and the hybrid to be tuned on tune96.

#### S4. Partial tune96: thresholds and the verifier hybrid (`s4-seg-tune96`, `s4-seg-tune96-45`)

The tune96 run of `seg-yn-raw` (517 new checks) was killed by the lab's
memory guard at 121/517 (system MemAvailable below 600 MB with other lanes
running), then the captain stopped the experiment. 45 of the 96 cases have
all their checks: the 32 iter32 cases plus 13 agency/dev cases (24 EN / 21
FR). `s4-seg-tune96-45` rescores the cached requests on exactly those 45
cases, `shipped` included (nothing computed). From S4 on, the lab used
extension `main` @ 70263e4 (main advanced during the session; the lab's
prompts do not depend on it, and `shipped` on all 96 tune96 cases still
gives 32 / 42 / 26 / FP 36, as in A1). The AUC column of the `seg-verify`
rows is the verifier AUC (P(Yes) of correct vs wrong shipped findings, 33
findings).

| config (45 cases) | F1 | P | R | det | FPR | segP | segR | over-red. | unresolved | req/prompt | p50 s | p95 s | AUC |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| shipped | 38 | 46 | 32 | 45 | 44 | 59 | 41 | 48 | – | 2.5 | 2.5 | 5.1 | – |
| seg-yn-raw (greedy text) | 24 | 19 | 32 | 31 | 31 | 38 | 51 | 87 | 1 | 8.8 | 6.7 | 43.6 | 0.63 |
| seg-yn-raw-logit (constrained) | 23 | 18 | 32 | 31 | 38 | 35 | 51 | 87 | 0 | 8.8 | 6.7 | 43.6 | 0.63 |
| seg-yn-raw-p0.3 | 22 | 13 | 75 | 83 | 88 | 25 | 90 | 91 | 0 | 8.8 | 6.7 | 43.6 | 0.63 |
| seg-yn-raw-p0.4 | 24 | 15 | 55 | 55 | 75 | 30 | 74 | 89 | 0 | 8.8 | 6.7 | 43.6 | 0.63 |
| seg-yn-raw-p0.6 | 17 | 24 | 13 | 17 | 6 | 46 | 26 | 83 | 0 | 8.8 | 6.7 | 43.6 | 0.63 |
| seg-verify-raw (greedy) | 18 | 56 | 11 | 14 | 13 | 67 | 15 | 55 | 0 | 3.2 | 3.3 | 6.9 | 0.60 |
| seg-verify-raw-p0.3 | 31 | 46 | 23 | 35 | 31 | 62 | 33 | 55 | 0 | 3.2 | 3.3 | 6.9 | 0.60 |
| seg-verify-raw-p0.4 | 25 | 50 | 17 | 24 | 19 | 63 | 26 | 54 | 0 | 3.2 | 3.3 | 6.9 | 0.60 |

(`-p0.5` equals `-logit`.) Check level for `seg-yn-raw` (398 checks, 45
positive): greedy Yes on 29% of positive and 16% of negative checks (11% in
negative prompts, 18% in the other segments of positive prompts), check
precision 19%. Sweeping the P(Yes) threshold only moves along the same weak
curve: recall rises with the FP rate (p0.3: 75% recall, FP 88%) and F1 stays
at 17-24, below the shipped 38.

The verifier keeps the shipped design's passage-level findings and adds only
~0.7 requests per prompt (the checks of segments with a finding), but its
decisions are close to random on those findings (AUC 0.60). At p0.3 it trades
7 F1 points for 13 FP points; the greedy decision keeps precision at 56% but
recall falls to 11%. On the full tune96 set, the answer-confidence filter
`cmin0.2` gave F1 32 -> 30 for FP 36 -> 21 (C2), with no extra request.

Not done (experiment stopped): the confirm48 and held-out checks, and a
second model. Runs: `experiments/runs/s1-seg-iter32.json`,
`s3-seg-variants-iter32.json`, `s4-seg-tune96.json` (cut run: `shipped` on
96 cases, the `seg-*` rows on 45), `s4-seg-tune96-45.json`.

### V2. Parity of the patterns + confidence-filter implementation (extension PR #32, fm/slm-patterns-confidence-filter, ebf077f)

`npm run bench -- --ref ebf077f --models smollm2-360m` with `--set tune96`
(run `runs/ext-ebf077f-tune96-smol360/`), then once with `--tier full --split
test` (run `runs/ext-ebf077f-test-smol360/`; the configuration was fixed on
the dev sets before, P1). The bench's Node loader now honours the ref's
optional `SlmGenerateOptions.onTokenProbability` with a pass-through logits
processor equivalent to the extension's `TokenProbabilityRecorder` (refs that
do not pass it decode exactly as before), so the bench measures the ref's own
confidence filter (`SLM_MIN_ANSWER_PROBABILITY` 0.2 on
`answerProbability`), patterns (`src/slm-patterns.ts`) and stop-word list.
Components: `npm run components` (same arguments) replays the cached answers
through the ref's `reviewPrompt` with the filter and/or the patterns off; the
"both on" replay reproduces all cached findings.

| set | variant | F1o | P | R | F1x | det | FPR | EN F1 / FPR | FR F1 / FPR | lab (F1o / P / R / F1x / det / FPR) |
|---|---|---|---|---|---|---|---|---|---|---|
| tune96 | **filter + patterns (shipped by the PR)** | 38.2 | 55.6 | 29.1 | 34.4 | 38.9 | 21.4 | 44.2 / 19.0 | 32.5 / 23.8 | 38 / 56 / 29 / 34 / 39 / 21 |
| tune96 | patterns only | 39.5 | 47.3 | 34.0 | 36.2 | 48.1 | 38.1 | 44.2 / 38.1 | 35.2 / 38.1 | 40 / 47 / 34 / 36 / 48 / 38 |
| tune96 | filter only | 29.5 | 47.8 | 21.4 | 25.5 | 31.5 | 21.4 | 31.0 / 19.0 | 28.2 / 23.8 | 30 / 48 / 21 / 26 / – / 21 (C2, old stop words) |
| tune96 | neither | 32.0 | 40.9 | 26.2 | 28.4 | 40.7 | 38.1 | 32.5 / 38.1 | 31.5 / 38.1 | 32 / 41 / 26 / 28 / 41 / 38 |
| held-out | **filter + patterns** | 33.2 | 43.3 | 27.0 | 26.6 | 44.0 | 35.6 | 31.8 / 34.6 | 34.5 / 36.7 | 33 / 43 / 27 / 27 / 44 / 36 |
| held-out | patterns only | 34.0 | 38.4 | 30.4 | 26.5 | 49.6 | 45.5 | 31.9 / 51.9 | 35.9 / 38.8 | 34 / 38 / 30 / 27 / 50 / 46 |
| held-out | filter only | 26.1 | 36.2 | 20.4 | 20.0 | 36.2 | 33.7 | 25.0 / 32.7 | 27.0 / 34.7 | 26 / 36 / 20 / 20 / 36 / 34 |
| held-out | neither | 27.4 | 32.2 | 23.9 | 20.5 | 41.8 | 44.6 | 25.8 / 51.9 | 29.0 / 36.7 | 27 / 32 / 24 / 20 / 42 / 45 (H1) |

- Verdict: **parity, no gap.** Every lab number is reproduced to the rounding;
  on the held-out split the predicted findings of all 242 cases equal the
  lab's `h4-patterns-basic-cmin0.2-patterns` run case by case.
- The model answers are unchanged by the PR: all 96 tune96 raw outputs are
  byte-identical to d42c466's (the recorder is pass-through). All 240 tune96
  requests carried an `answerProbability`; 59 were below 0.2 and dropped.
- Latency: held-out p50 2.6 s, p95 9.3 s (d42c466: 2.4 / 8.8 s), 16 min for
  242 cases, peak RSS 2.2 GB. The run shared the machine with other lanes;
  one softmax over the vocabulary per generated token (~15 tokens per
  answer) is a small part of it.
- As in P1: the patterns carry the F1 gain (+6.6 held-out) and the filter the
  FP drop (−9.9 held-out with patterns) for −0.8 F1.

### A2. Leave-one-out ablation after PR #32 (tune96, SmolLM2-360M, `ablate-tune96-smollm2-360m`)

Extension PR #32 merged as b4f96b1 (sources equal to the benched ebf077f).
The lab's `shipped` baseline now records answer probabilities and applies
the confidence filter (`minAnswerProbability: 0.2`) and the example
patterns (`examplePatterns`), with the extension's own stop-word list (the
ref's `isPlausiblePassage` at `main`). New switches: `patterns`,
`confidence`, `stopwords` (`extraStopWords` restores "simple"/"terms").
The segment configurations of S1-S4 keep the PR #26 baseline
(`BEFORE_PR32`). `npm run ablate -- --set tune96 --model smollm2-360m`,
extension `main` @ 71a29e3 (#33 only changes WebGPU probing); two reruns
were needed because the memory guard killed the worker while other lanes
held RAM (cached requests are kept).

| switched off | F1o | ΔF1 | P | R | FPR | ΔFPR | det | EN / FR F1 | p50 |
|---|---|---|---|---|---|---|---|---|---|
| nothing (shipped) | 38.2 | | 55.6 | 29.1 | 21.4 | | 38.9 | 44.2 / 32.5 | 2.56 s |
| completion framing | 27.1 | −11.1 | 60.0 | 17.5 | 9.5 | −11.9 | 29.6 | 39.4 / 14.9 | 2.67 s |
| one request per label | 21.2 | −17.0 | 48.1 | 13.6 | 21.4 | ±0 | 20.4 | 29.2 / 14.3 | 3.20 s |
| label-example demos | 17.7 | −20.5 | 100 | 9.7 | 0.0 | −21.4 | 14.8 | 29.1 / 6.9 | 2.27 s |
| language-matched demos | 35.2 | −3.0 | 50.0 | 27.2 | 26.2 | +4.8 | 38.9 | 44.2 / 26.8 | 2.55 s |
| NONE demo last | 39.4 | +1.2 | 42.2 | 36.9 | 47.6 | +26.2 | 53.7 | 48.9 / 31.1 | 3.17 s |
| first-line stop + 48 cap | 38.2 | ±0 | 55.6 | 29.1 | 19.0 | −2.4 | 38.9 | 44.2 / 32.5 | 2.64 s |
| pinned decoding | 38.2 | ±0 | 55.6 | 29.1 | 21.4 | ±0 | 38.9 | 44.2 / 32.5 | 2.53 s |
| plausibility filter | 39.5 | +1.3 | 49.3 | 33.0 | 33.3 | +11.9 | 44.4 | 46.5 / 32.6 | 2.56 s |
| SmolLM2-360M default (135M) | 26.9 | −11.3 | 43.9 | 19.4 | 31.0 | +9.6 | 27.8 | 32.9 / 20.0 | 1.43 s |
| example patterns | 29.5 | −8.7 | 47.8 | 21.4 | 21.4 | ±0 | 31.5 | 31.0 / 28.2 | 2.56 s |
| confidence filter 0.2 | 39.5 | +1.3 | 47.3 | 34.0 | 38.1 | +16.7 | 48.1 | 44.2 / 35.2 | 2.37 s |
| stop-word fix | 38.2 | ±0 | 55.6 | 29.1 | 21.4 | ±0 | 38.9 | 44.2 / 32.5 | 2.56 s |

The baseline equals the bench's ebf077f numbers (V2) to the decimal. The
patterns now carry part of the gain on their own (−8.7 F1 without them, no
FP change) and soften every model-side switch (examples −20 vs −30 in A1,
per-label −17 vs −23, completion −11 vs −15). The confidence filter is the
largest FP lever after NONE-last (−16.7 FP points for −1.3 F1). The
stop-word fix is ±0: its one tune96 case ("simple terms" in legal-en-040) is
now dropped by the confidence filter. Ledger: `docs/shipped-improvements.md`.

## 2026-09-29

### B1-B2. Amazon Nova Micro on Bedrock with the shipped request, two chat framings (lab, `b1-nova-tune96`, `b2-nova-confirm48`)

Question (captain): for a future "connect your own trusted hosted model"
option, how does a small hosted chat model do on the same benchmark and
prompts as the bundled SmolLM2-360M? Backend: `src/hosted/bedrock.ts`
(README "Hosted models"), Amazon Nova Micro through the EU inference
profile `eu.amazon.nova-micro-v1:0` called in eu-north-1, Converse API,
temperature 0 and topK 1, 48-token cap, answer cut at its first line in
code (Converse rejects `\n` as a stop sequence). The request is the
`shipped` configuration's, byte for byte the extension's
(`src/hosted/parity.ts`: every tune96, confirm48 and held-out per-label
request equals what the ref's own `reviewPrompt` hands its model client at
`main` @ c1407a4, except the 10 / 4 / 17 requests of prompts with fenced
code, which the ref has skipped since PR #42, see below). Two framings:

- `nova-micro-prefill`: the completion text (instruction line,
  demonstrations, `Text: …`) as the user turn, and the assistant turn
  prefilled with the cue `LABEL:` (Converse accepts assistant prefill for
  Nova);
- `nova-micro-system`: the instruction line as the system prompt, and the
  demonstrations, text and cue as the user turn, with no prefill.

Parsing, plausibility filter, patterns and scoring are the lab's `shipped`
ones. **The answer-confidence filter (0.2) cannot apply:** the Converse
response has no token probabilities (API reference: `output`, `stopReason`,
`usage`, `metrics`, `trace`), and we found no documented logprobs option for
Nova. Every hosted answer is kept. A "connect a trusted model" feature has
to replace that precision lever by something else, or accept that it is
missing.

Parser fix found on the way: the system framing often answers
`CLIENT_NAME: NONE`. The lab's `passagesToLines` checked NONE before
stripping a repeated cue, so it kept "NONE" as a passage. The ref's
`labelAnswerLines` strips the cue first. The lab now does the same
(`tests/hosted.test.ts`). SmolLM2 never repeats the cue after the prefill,
and its `shipped` numbers are unchanged.

SmolLM2-360M baseline: lab `shipped` on tune96 (`b0-smol360-tune96`). On
confirm48 the cached baseline is `shipped-no-pinned`
(`b0-smol360-confirm48`). Pinned decoding is a no-op on SmolLM2 (identical
outputs, A2; `shipped` and `shipped-no-pinned` are equal on tune96), so it
is the same answers, but it is not a `shipped` run (the captain asked not
to rerun it). SmolLM2 has the confidence filter; Nova cannot have it.

| set | model / framing | F1o | P | R | F1x | Px | Rx | det | FPR | EN F1 / FPR | FR F1 / FPR | p50 | p95 | USD / 1k prompts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| tune96 | SmolLM2-360M `shipped` (local) | 38.2 | 55.6 | 29.1 | 34.4 | 50.0 | 26.2 | 38.9 | 21.4 | 44.2 / 19.0 | 32.5 / 23.8 | 2.56 s | 6.32 s | 0 |
| tune96 | Nova Micro, prefill | **61.0** | 71.1 | **53.4** | **53.6** | 63.2 | 46.6 | **72.2** | **14.3** | 63.4 / 14.3 | **58.4** / 14.3 | 0.97 s | 1.63 s | 0.032 |
| tune96 | Nova Micro, system | 55.0 | **74.1** | 43.7 | 46.0 | 63.8 | 35.9 | 57.4 | **14.3** | 61.6 / 19.0 | 48.0 / 9.5 | 0.81 s | 2.08 s | 0.027 |
| confirm48 | SmolLM2-360M `shipped-no-pinned` (local) | 43.1 | 54.8 | 35.6 | 35.6 | 42.9 | 30.5 | 43.8 | 50.0 | 44.4 / 75.0 | 41.0 / 25.0 | 2.37 s | 6.50 s | 0 |
| confirm48 | Nova Micro, prefill | 67.1 | 74.5 | 61.0 | 56.4 | 60.8 | 52.5 | 71.9 | 43.8 | 58.9 / 50.0 | 76.6 / 37.5 | 0.82 s | 1.21 s | 0.031 |
| confirm48 | Nova Micro, system | **68.3** | **83.7** | 57.6 | 52.9 | 62.8 | 45.8 | 71.9 | **25.0** | 66.9 / 25.0 | 69.8 / 25.0 | 0.83 s | 1.11 s | 0.027 |

(Latency is per prompt: the sum of its 2-3 per-label requests, sent one at
a time, network included and throttling retries excluded. Per request: p50
0.3-0.4 s, p95 0.5-0.7 s, of which Bedrock reports ~0.25 s. confirm48 has
16 negatives, so one false positive is 6 FP points.)

- **Both framings beat SmolLM2 by a wide margin** on both sets: +17 to +25
  F1, with higher precision and recall, a lower or equal FP rate, 3x lower
  latency, and French as good as English.
- **Prefill vs system:** prefill finds more (recall +10 on tune96, +3 on
  confirm48). The system framing is more precise and flags fewer negatives on
  confirm48 (25% vs 44%), with F1 tied there. Prefill wins tune96 by 6 F1
  at the same FP rate.
- **Errors:** half of prefill's wrong findings on tune96 (11 of 22; system
  6 of 15) are the right passage under a second label of the same profile
  (the client name also reported as CAMPAIGN_CODENAME, a host also as
  INTERNAL_SERVICE). Each per-label request cannot see the other labels.
  For redaction the passage is still hidden, so the strict label metric
  understates Nova here. Hallucinated answers (dropped by anchoring) are
  mostly a label example copied from the demonstrations ("Q3 revenue of
  £1.284bn", "€87k base").
- **Prefill run-on:** in 145 of 360 prefill answers Nova keeps writing a new
  `Text:` demonstration until the 48-token cap. The first-line cut makes
  this harmless for quality, but it doubles output tokens (26 vs 13 per
  request) and adds latency. A `\nText:` stop sequence (non-blank, so
  Converse accepts it) would remove it.
- **Throttling:** about two in three calls got HTTP 429 (retried with
  backoff). The cause is this test account's limit of 20 requests per
  minute for Nova Micro (B3), not the model.

### B3-B5. Hosted models through the bench: Nova Micro and GLM-4.7 Flash, three framings (runs `hosted-tune96-1c377d7`, `hosted-confirm48-1c377d7`)

After B1-B2, the hosted backend moved into the bench (captain: every
experiment must be runnable and viewable in the dashboard). The worker's
hosted client receives the ref's own requests from `reviewPrompt`, so the
ref's pagination, code-fence skip (PR #42), parser (`labelAnswerLines`),
anchoring, plausibility filter and patterns apply exactly as in the
extension. The ref is pinned at `main` @ 1c377d7 (PR #44 changes the popup
only; results are cached per commit). SmolLM2-360M context comes from the
committed bench run `ext-ebf077f-tune96-smol360` (PR #32, same review code
apart from the code-fence skip) and, for confirm48, the lab
`b0-smol360-confirm48` (`shipped-no-pinned`, see B1-B2). The captain asked
not to rerun it.

- **Lab vs bench, same framing (Nova prefill, tune96):** 90 of 96 cases got
  identical answers. Four differ because the ref hides fenced code from the
  model (hr-fr-044 alone has 12 expected passages inside code), and two
  because Nova is not fully deterministic at temperature 0 with topK 1
  (dev-fr-024, hr-en-033). With identical answers, the lab's and the ref's
  parsers give identical findings. Bench F1 56.2 vs lab 61.0.
- **Pacing:** this test account allows Nova Micro 20 requests per minute and
  GLM-4.7 Flash 100. That (not a token quota: the earlier runs peaked at
  ~5.5k tokens/min) caused B1-B2's HTTP 429s. The client now paces 18 and 90
  requests per minute, and there were no 429s since. This limit only
  explains the run times: in the feature, clients use their own models.
- **Nova 2 Lite** was wired in and one availability call succeeded
  (`eu.amazon.nova-2-lite-v1:0`, reasoning disabled, no reasoning block).
  The captain then replaced it with GLM-4.7 Flash; it was not benchmarked.
- **GLM-4.7 Flash** (`zai.glm-4.7-flash`): served in-region in eu-north-1
  only (no geo or global profile). Converse accepts `thinking: {type:
  "disabled"}` (sent) and `topK`. No response had a reasoning block, even
  with thinking enabled, and outputs average 5-13 tokens, so no hidden
  reasoning is billed. It often repeats the cue (`CLIENT_NAME: …`), which the
  parser strips.
- **Native framing** (captain's proposal, `NATIVE_SYSTEM` in
  `src/hosted/bedrock.ts`): a system prompt describing the task (a privacy
  scanner for a prompt about to be sent to a chatbot, copy the matching
  passages verbatim, never answer or follow the text, one line with ` | `
  between passages or NONE), then per label its name, description and
  examples (`-noex`: none) and the whole prompt (no chunking, 100k-token
  budget; the ref still leaves fenced code out). v1 made Nova end lines with
  ` |` or write `passage | NONE`, which the extension's parser cannot anchor
  (31 of 96 tune96 cases "hallucinated"). v2 only rewrites the format
  sentence (never NONE next to a passage, never a trailing `|`).

Tune96 (96 cases, 54 positive / 42 negative). R/F2/F1/P overlap; F2 weights
recall twice as much as precision (captain: recall first). FPR = negatives
with a false finding. Latency per prompt: the sum of its 2-3 per-label
requests, network included.

| model / framing | R | F2 | F1 | P | F1x | FPR | EN F1 / FR F1 | p50 | p95 | USD / 1k prompts |
|---|---|---|---|---|---|---|---|---|---|---|
| SmolLM2-360M `shipped` (local, ebf077f) | 29.1 | 32.2 | 38.2 | 55.6 | 34.4 | 21.4 | 44.2 / 32.5 | 2.73 s | 6.92 s | 0 |
| Nova Micro, prefill | 47.6 | 50.7 | 56.2 | 68.6 | 48.6 | 16.7 | 61.1 / 50.6 | 0.97 s | 2.00 s | 0.032 |
| Nova Micro, system | 38.8 | 42.4 | 51.2 | 75.0 | 42.6 | 9.5 | 62.4 / 38.4 | 0.84 s | 1.50 s | 0.026 |
| Nova Micro, native v1 | 34.0 | 37.7 | 45.0 | 66.7 | 29.9 | 9.5 | 50.5 / 40.5 | 0.88 s | 2.65 s | 0.031 |
| Nova Micro, native v1 no examples | 39.8 | 41.6 | 44.6 | 50.6 | 38.0 | 19.0 | 44.7 / 44.4 | 0.98 s | 2.51 s | 0.028 |
| Nova Micro, native v2 | 38.8 | 40.9 | 45.2 | 54.2 | 32.0 | 11.9 | 50.1 / 40.9 | 1.06 s | 2.77 s | 0.034 |
| Nova Micro, native v2 no examples | 35.9 | 37.3 | 39.6 | 44.2 | 28.6 | 26.2 | 41.5 / 38.0 | 0.85 s | 1.40 s | 0.031 |
| GLM-4.7 Flash, prefill | 50.5 | 52.6 | 57.1 | 65.8 | 41.3 | 35.7 | 61.6 / 53.3 | 0.75 s | 2.22 s | 0.059 |
| GLM-4.7 Flash, system | 51.5 | 51.8 | 52.8 | 54.3 | 40.6 | 52.4 | 59.0 / 46.5 | 0.67 s | 1.29 s | 0.058 |
| GLM-4.7 Flash, native v2 | **68.0** | **66.4** | **64.6** | 61.5 | 47.2 | 33.3 | 67.3 / 61.8 | 0.65 s | 1.73 s | 0.072 |
| GLM-4.7 Flash, native v2 no examples | 68.0 | 58.7 | 51.1 | 41.0 | 35.7 | 47.6 | 52.2 / 50.0 | 0.61 s | 1.81 s | 0.069 |

Confirm48 (48 cases, 16 negatives: one false positive is 6 FP points), the
best two framings of each model plus native v2:

| model / framing | R | F2 | F1 | P | F1x | FPR | EN F1 / FR F1 | p50 | p95 | USD / 1k prompts |
|---|---|---|---|---|---|---|---|---|---|---|
| SmolLM2-360M `shipped-no-pinned` (lab) | 35.6 | 37.0 | 43.1 | 54.8 | 35.6 | 50.0 | 44.4 / 41.0 | 2.37 s | 6.50 s | 0 |
| Nova Micro, prefill | 57.6 | 60.0 | 64.0 | 72.0 | 53.2 | 50.0 | 53.0 / 76.6 | 0.92 s | 1.39 s | 0.031 |
| Nova Micro, system | 52.5 | 56.7 | 64.2 | 82.5 | 50.5 | 25.0 | 59.5 / 69.8 | 0.88 s | 1.33 s | 0.026 |
| Nova Micro, native v2 | 28.8 | 31.8 | 37.7 | 54.5 | 26.1 | 31.2 | 49.5 / 17.6 | 0.88 s | 1.49 s | 0.034 |
| GLM-4.7 Flash, prefill | **62.7** | **64.1** | **66.2** | 70.2 | 53.4 | 37.5 | 57.4 / 76.2 | 0.69 s | 3.34 s | 0.057 |
| GLM-4.7 Flash, system | 55.9 | 56.7 | 57.9 | 60.0 | 40.3 | 56.2 | 49.4 / 67.5 | 0.73 s | 1.18 s | 0.060 |
| GLM-4.7 Flash, native v2 | 57.6 | 57.1 | 56.3 | 55.1 | 45.3 | 56.2 | 58.7 / 53.1 | 0.64 s | 1.22 s | 0.073 |

Pooled dev (tune96 + confirm48, 144 cases):

| model / framing | R | F2 | F1 | P | FPR |
|---|---|---|---|---|---|
| GLM-4.7 Flash, native v2 | **64.2** | **63.1** | **61.5** | 59.0 | 39.7 |
| GLM-4.7 Flash, prefill | 54.9 | 57.1 | 60.6 | 67.7 | 36.2 |
| GLM-4.7 Flash, system | 53.1 | 53.7 | 54.7 | 56.5 | 53.4 |
| Nova Micro, prefill | 51.2 | 54.1 | 59.2 | 70.0 | 25.9 |
| Nova Micro, system | 43.8 | 48.1 | 56.2 | 78.3 | 13.8 |
| Nova Micro, native v2 | 35.2 | 37.8 | 42.7 | 54.3 | 17.2 |

- **Every hosted framing but Micro-native beats SmolLM2** on recall, F1
  and latency (0.6-1.1 s vs 2.4-2.7 s per prompt).
- **Nova Micro:** prefill finds the most (pooled recall 51), system is the
  most precise and flags the fewest negatives (FPR 14% vs 26%). The native
  framing does not suit Micro (pooled recall 35; French F1 18 on
  confirm48): it needs the demonstrations.
- **GLM-4.7 Flash** is the better hosted model and the one that benefits
  from the native task description: native v2 has the best recall and F2 of
  all (pooled 64 / 63), at the cost of more flagged negatives (40%). Its
  lead comes from tune96: on confirm48 alone its prefill framing found more
  (63 vs 58). The label examples matter for precision: without them GLM
  keeps its recall but flags 48% of tune96 negatives.
- **Choice for the one-shot held-out run** (recall first, F2 and F1
  alongside, precision and FPR as context): GLM-4.7 Flash native v2, which
  beats Micro on every recall metric, and Micro's best, prefill.
- **Tokens and cost:** a per-label request is ~220-340 input tokens. Answers
  average 5-13 output tokens, except Micro prefill (26: it keeps writing a
  new `Text:` demonstration until the 48-token cap, which the first-line cut
  discards). Per 1,000 prompts: Micro 0.026-0.034 USD, GLM 0.058-0.073 USD.
- **Latency per request** (network included): Micro p50 0.30-0.38 s (Bedrock
  server time ~0.25 s), GLM p50 0.23-0.26 s (~0.18 s).

**False positives, by kind** (tune96, label-strict findings that overlap no
expected passage; captain: false alarms are not a veto, some are an
information gap):

| kind | GLM native v2 | Micro prefill |
|---|---|---|
| right passage, extra or wrong label (the text is still hidden) | 13 | 12 |
| defensible: matches the label's kind and nothing in the text says otherwise (a second deal amount, a competitor where a prospect could be, a product code, a person's name in a ticket) | 6 | 1 |
| right kind, but the text itself says it is public (announced deal, published annual report, public guidance, market cap) | 8 | 5 |
| clearly wrong: generic, textbook or placeholder (tenant_id, host.docker.internal, macro statistics, "Jane Smith", "customer", `[NOM DE L'ÉTUDE]`) | 15 | 4 |
| total | 42 | 22 |

So about half of each model's false positives are harmless or defensible
(GLM 19 of 42, Micro 13 of 22). The "public" group is the information gap
the captain describes: the model sees a deal, a figure or a product, and the
label description asks it to judge whether it is public, which the text
often states but a small model does not weigh. GLM's clearly wrong group
(15) is what its extra recall costs.

### B6. Held-out test split, one shot (run `hosted-test-1c377d7`)

The two framings chosen on dev (B3-B5: GLM-4.7 Flash native v2 by recall,
and Nova Micro's best, prefill), on the 242 test cases, once, through the
bench at 1c377d7. SmolLM2-360M context: the committed bench run
`ext-ebf077f-test-smol360` (extension PR #32, the shipped design; its review
code differs only by the later code-fence skip).

| model / framing | R | F2 | F1 | P | F1x | det | FPR | EN F1 / FPR | FR F1 / FPR | p50 | p95 | USD / 1k prompts |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| SmolLM2-360M `shipped` (local) | 27.0 | 29.2 | 33.2 | 43.3 | 26.6 | 44.0 | 35.6 | 31.8 / 34.6 | 34.5 / 36.7 | 2.61 s | 9.25 s | 0 |
| Nova Micro, prefill | 45.3 | 49.0 | 55.8 | **72.6** | **41.9** | **72.3** | **23.8** | 57.8 / 26.9 | 53.9 / 20.4 | 1.00 s | 1.56 s | 0.032 |
| GLM-4.7 Flash, native v2 | **64.7** | **62.2** | **58.7** | 53.7 | 41.4 | 71.6 | 32.7 | 56.0 / 38.5 | **61.1** / 26.5 | **0.61 s** | **0.97 s** | 0.076 |

(101 negatives. Recall regardless of label: SmolLM2 28.7, Micro 47.4, GLM
66.8. Right passage under another label: 17 of Micro's 49 wrong findings,
43 of GLM's 157.)

- **The dev ranking holds.** GLM-4.7 Flash native v2 finds 2.4x as many
  sensitive passages as the shipped SmolLM2 (recall 65 vs 27), and Nova
  Micro 1.7x (45), with fewer flagged negatives than SmolLM2 (33% and 24%
  vs 36%). Latency per prompt drops from 2.6 s (p95 9.3 s) to 0.6-1.0 s
  (p95 1.0-1.6 s), network included.
- **Micro vs GLM:** a precision / recall trade. Micro is the most precise
  (73%) and flags the fewest negatives. GLM finds 19 recall points more, at
  54% precision. By the captain's recall-first rule GLM-4.7 Flash with the
  native framing is the best hosted option measured.
- **Cost:** 0.03 USD (Micro) and 0.08 USD (GLM) per 1,000 prompts, at ~2.5
  per-label requests per prompt.
- **Whole evaluation spend:** 0.092 USD (every hosted request, lab and
  bench, including development calls), against the 5 USD cap.

### B7. Provider-neutral hosted backend: Bedrock and OpenAI-compatible adapters (connector smoke, run `connector-smoke-1c377d7`)

T7 of the "Trusted AI redaction" design, narrowed by the captain to the
connectors: the quality measurements (the OpenAI-compatible `auto`
default, all labels in one request, fenced code, JSON output vs the
tolerant parser, learning from feedback, and any Ollama quality run) are
parked. What changed (`src/hosted/`, README "Hosted models"):

- One provider-neutral client (`client.ts`: pacing, retries, first-line
  cut, answer confidence) over a neutral chat-or-completion request
  (`framing.ts`), with two adapters: Bedrock Converse (`bedrock.ts`, chat
  framings only) and OpenAI-compatible (`openai.ts`: `/chat/completions`
  and `/completions`, optional API key from the env variable a model
  entry names, optional `logprobs`). The model table is `models.ts`.
- When a reply has token log probabilities, the client computes the
  extension's answer confidence (lowest answer-token probability, the
  token that ended the line left out) and passes it as
  `runtime.answerProbability`, so the ref's own confidence filter (0.2)
  applies to hosted answers.
- Every earlier Bedrock model keeps its id and byte-identical request
  (tests), so the cached B1-B6 results stay valid: a dry run of tune96 has
  nothing to compute, and the lab rescoring of `nova-micro-prefill` gives
  B1's numbers.
- New entries: `nova-micro-prefill-stop` (the design's `\nText:` stop
  sequence; Converse rejects a bare `\n`), `glm47-flash-oai-native-v2`
  (GLM-4.7 Flash through Bedrock's OpenAI-compatible endpoint, same API
  key), and `ollama-smollm{,2}-360m-{completion,native-v2}` (local Ollama).
- `npm run hosted:check` sends one synthetic request per model, like the
  extension's "Test connection". Unit tests use a fake OpenAI-compatible
  server and a mocked Converse `fetch`: bodies, auth header, logprob
  shapes, confidence, first-line cut, 429/5xx retry, 401 not retried,
  reasoning output refused.

Findings from the probes (a handful of requests each):

- **Ollama's `/v1/completions` is not a raw completion.** Ollama 0.34.4
  wraps the prompt in the model's chat template (smollm2: its default
  system prompt too; "Hello" is 31 prompt tokens, vs 1 with
  `/api/generate` and `raw: true`). The extension's completion text then
  arrives as a user message, and both SmolLM models answered like a
  chatbot ("Here's how you can implement this:"). The design's
  "`/completions` = exactly the extension's framing" holds for servers that
  do raw completion (vLLM, llama.cpp), not for Ollama.
- **Log probabilities:** Ollama returns them on `/v1/chat/completions`
  only (`/v1/completions` ignores `logprobs`). Bedrock's OpenAI-compatible
  endpoint (`https://bedrock-runtime.<region>.amazonaws.com/openai/v1`)
  returns them for GLM-4.7 Flash, so a hosted model can have the
  confidence filter. That endpoint serves chat only (`/completions`:
  UnknownOperationException), and does not serve Nova Micro
  (`model_not_found`). It accepts `stop` and GLM's `thinking` switch.
- **Connector smoke through the bench** (2 tune96 cases, 5 per-label
  requests per model, ref 1c377d7; not a quality measurement): GLM-4.7
  Flash over the OpenAI endpoint found all of hr-fr-004 and the
  finance-en-005 margins, with answer confidences 0.25-0.99, 0.26-0.55 s per
  request. `nova-micro-prefill-stop` averaged 15 output tokens (B1-B2
  prefill without the stop: 26); one answer still ran to 45 tokens, so the
  stop does not catch every run-on. smollm:360m through Ollama found
  nothing with either framing: chat-style answers, confidences 0.08-0.24
  (native) and none (completion). Hosted spend 0.0002 USD (total 0.092).

Remaining T7 work (parked by the captain): the `auto` default per provider
(raw completion vs native v2, now including Ollama's templated
`/completions` and GLM through the OpenAI endpoint with the confidence
filter), all labels in one request, whether a connected model reads fenced
code, structured JSON output vs the tolerant parser, and learning from
feedback (learned examples as demonstrations or pattern sources, false
alarms as NONE demonstrations, quality vs number of corrections, with a
subset that fits SmolLM2's 2,048-token budget).
