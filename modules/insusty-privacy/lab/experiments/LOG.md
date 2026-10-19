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
- 2026-10-17: the bench keeps only SmolLM2-360M (on device) and GLM-4.7 Flash
  (connected, through the extension's own client). Entries and runs about the
  other models (SmolLM2-135M, Qwen2.5-0.5B, LFM2/2.5, Gemma 3, Nova Micro,
  the bench-side hosted framings) were deleted to start fresh; git history
  keeps them.
- 2026-10-19 (Restructure): the bench moved to the modules/datasets layout.
  Paths in older entries are the old ones: `src/lab/` is now
  `modules/insusty-privacy/lab/`, `experiments/` is
  `modules/insusty-privacy/lab/experiments/` (sets:
  `datasets/insusty-custom/sets/`), `docs/shipped-improvements.md` is
  `modules/insusty-privacy/shipped-improvements.md`. The code of the
  rejected proposals was deleted: candidate classification (E4:
  `classify-cli.ts`, `classify-worker.ts`, `candidates.ts`,
  `candidates-coverage.ts`), segment Yes/No classification (S1-S4:
  `segment.ts` except its sentence splitter, now `segments.ts` for the
  segment view; the `seg-*` configurations; `BEFORE_PR32`), and the
  raw-output parity script of E0 (`parity.ts`, superseded by `npm run
  parity` and `shipped.test.ts`). The last commit that has them is `f9dadd7`.
  The bench's `--instructions` axis was removed too (refs since PR #26 take
  no system instruction); the lab keeps `@strict` and `@short`.

## 2026-09-26

### E0. Lab parity with the extension engine

Ran the ref's own `SlmEngine` + `reviewPrompt` and the lab's `ref`
configuration on 5 iter32 cases with the then-default model: 5/5 raw outputs identical
(`src/lab/parity.ts`). The lab reproduces the extension exactly, so every
other configuration differs from the shipped behaviour only by its overrides.

### E2c. Prefix KV reuse changes greedy outputs (numerics, not a bug)

Running the same requests without the prefix cache (`--no-prefix-cache`,
whole prompt in one forward pass) changed the raw output of 4/4 cases. q8 models quantize activations dynamically with
one scale per forward call, so prefilling the instructions separately from the
text changes the numbers slightly, and greedy decoding amplifies that. The
lab keeps prefix reuse on by default because that is what the extension does
(its engine prepares the instruction prefix once). Practical consequence:
single-case differences between configurations are noisy; only aggregate
metrics over many cases mean anything.

### E3b. Relaxed anchoring (parser-side, rescoring only)

`--anchor relaxed`: when a passage is not in the text, keep the longest run of
its words that is (at least 4 characters). Rescored the cached SmolLM2 runs
(`e3-relax-smol`): recall +0 to +3 points, but the false-positive rate on
negatives rises by 10 points in 3 of 8 rows. Not adopted for now; recheck on
stronger models.

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

Conclusion: a label description like "names of our agency's clients" gives a
sub-500M model nothing to decide on for an isolated candidate. Dropped; the
candidate generator stays available (it could still serve as a cheap
pre-filter or as a deterministic fallback).

### E6. Completion framing with per-label demonstrations (the first real gain)

`raw-pl`: no chat template. One request per custom label, rendered as plain
text: a one-line instruction with the label and its description, two
demonstrations built from the label's first two examples (one English, one
French carrier sentence), one clean-text demonstration answered `NONE`, then
`Text: <prompt>` and the answer cue `<LABEL>:`. Generation stops at the first
line break (48-token cap). The label is attached by code; each line is
anchored by the ref's parser. Runs `e6-raw-smol360`, `e6b-raw-smol360`,
`e6c-raw-smol360`.

| model | config | F1o | P | R | F1x | det | FPR | comp | p50s | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SmolLM2-360M | ref | 19 | 36 | 13 | 12 | 18 | 30 | 28 | 9.1 | | |
| SmolLM2-360M | **raw-pl** | **38** | 37 | 39 | 21 | 36 | 40 | 100 | 2.3 | 51 | 20 |
| SmolLM2-360M | raw-pl-negfirst (NONE demo first) | 29 | 24 | 37 | 19 | 45 | 100 | 100 | 2.8 | 33 | 24 |
| SmolLM2-360M | raw-pl-counter (+ counter-example NONE demo) | 14 | 20 | 11 | 8 | 14 | 30 | 100 | 2.4 | 17 | 9 |
| SmolLM2-360M | raw-pl-noex (no example demos) | 5 | 50 | 3 | 5 | 5 | 10 | 100 | 2.2 | 9 | 0 |
| SmolLM2-360M | raw-pl-name (cue `client name:`) | 31 | 30 | 32 | 20 | 32 | 50 | 100 | 2.2 | 42 | 14 |
| SmolLM2-360M | raw-pl-pair (two-passage demo `a \| b`) | 11 | 20 | 8 | 11 | 14 | 30 | 100 | 2.4 | 14 | 8 |
| SmolLM2-360M | raw-pl-noinstr (demos only) | 31 | 31 | 32 | 18 | 36 | 60 | 100 | 2.7 | 36 | 25 |
| SmolLM2-360M | raw-pl-delim (text in `"""`) | 22 | 27 | 18 | 13 | 27 | 60 | 100 | 2.6 | 33 | 8 |

Conclusions:

- Plain completion with in-context demonstrations is what the model can
  do: F1 x2, with 100% parseable output
  and 2-4x lower latency (one short line per label instead of a rambling list).
- Demonstrations derived from the label's own examples are essential (without
  them, F1 5): the extension would need users to give 1-3 examples per label.
- The last demonstration steers the default answer: ending on a positive demo
  makes the model always answer something (FPR 100%); a counter-example demo
  pushes it to answer NONE.
- French stays weak (F1 20 vs 51 in English).

### C1. Confirmation of raw-pl on the disjoint 48-case set (`c1-confirm48`)

`experiments/sets/confirm48.json` (32 positive, 16 negative, 24 EN / 24 FR,
disjoint from iter32).

| model | config | F1o | P | R | F1x | det | FPR | comp | p50s | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| SmolLM2-360M | ref | 30 | 58 | 20 | 28 | 22 | 19 | 27 | 10.5 | 36 | 20 |
| SmolLM2-360M | raw-pl | 32 | 42 | 25 | 23 | 38 | 44 | 100 | 3.5 | 37 | 23 |

- SmolLM2-360M: the F1 gain does **not** replicate (30 -> 32; on iter32 it
  was 19 -> 38). What replicates is format compliance (27% -> 100%), latency
  (10.5 s -> 3.5 s) and case detection (22% -> 38%), at the cost of the
  false-positive rate on negatives (19% -> 44%).
- Lesson: 32 cases is too few to rank configurations that are within ~15
  points. Next tuning runs use a larger dev set.

### Ops: lab runs that looked hung

Twice a lab run sat at 0% CPU with no worker (a model screen, first C1 run):
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

### D3. raw-pl-lang on confirm48 (`d3-smol360-confirm48`)

raw-pl-lang, q8 WASM, prefix cache on (filtered rescoring `d23-confirm48-basic`
for confirm48, `d1-tune96-basic` for tune96).

| set | model | F1o | P | R | F1x | det | FPR | p50s | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| tune96 | SmolLM2-360M | 33 | 37 | 30 | 26 | 46 | 48 | 3.1 | 35 | 31 |
| tune96 | SmolLM2-360M + basic | 32 | 42 | 26 | 29 | 41 | 36 | 3.1 | 33 | 31 |
| confirm48 | SmolLM2-360M | 30 | 37 | 25 | 28 | 38 | 50 | 3.1 | 27 | 35 |
| confirm48 | SmolLM2-360M + basic | 31 | 38 | 25 | 29 | 38 | 50 | 3.1 | 27 | 36 |

### V1. Parity of the extension implementation (fm/slm-completion-framing, d42c466)

`npm run bench -- --ext-repo <task copy of InsustyPromptCoach> --ref d42c466
--set tune96 --models smollm2-360m` (local run `ext-d42c466-tune96-smol360`, 2026-09-27: F1o 32.1, FPR 35.7),
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

### H1. Held-out test split, one shot (bench path; local runs `test-dc91f36-smol360`, `test-d42c466-smol360`, 2026-09-27)

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
| SmolLM2-360M default (SmolLM2-135M) | retired 2026-10-17 (the 135M model and its run were removed) | | | | | | | | |

The baseline reproduces the bench's d42c466 numbers (V1). Examples,
per-label requests and completion framing carry the F1 gain. NONE-last and the
plausibility filter are false-positive levers (off: F1 +5 / +1, FP +36 / +12).
The first-line stop is quality-neutral but bounds latency (off: 2 deadline
timeouts, p95 6.4 → 7.3 s). Pinned decoding is a no-op on SmolLM2. Ledger with the per-improvement evidence:
`docs/shipped-improvements.md`.

### S1-S4. Segment x label Yes/No classification (captain's spec v1.1): rejected

**Negative result.** The captain's "Sensitive text classification pipeline"
(spec v1.1, 2026-09-27) was implemented in the lab and screened on
SmolLM2-360M. The captain stopped it after the iter32 screen and a partial
tune96 run and rejected it as unsuccessful: confirm48 and the held-out split
were never run, and no second model was tried. The code stays in the lab,
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
(local run `ext-ebf077f-tune96-smol360`, 2026-09-27: F1o 38.2, FPR 21.4), then
once with `--tier full --split test` (local run `ext-ebf077f-test-smol360`,
2026-09-27: F1o 33.2, FPR 35.6; the configuration was fixed on
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
| SmolLM2-360M default (135M) | retired 2026-10-17 (the 135M model and its run were removed) | | | | | | | | |
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

