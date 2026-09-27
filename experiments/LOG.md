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
