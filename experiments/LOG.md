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
