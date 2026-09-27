# Shipped improvements: Local AI redaction

A durable record of every change to the extension's Local AI redaction that
shipped because this benchmark showed it helps. Each entry names the
extension PR and merge commit, the evidence that justified it, and the lab
switch that turns it off, so later proposals are measured against what
actually ships.

- **Baseline:** the `shipped` lab configuration (`src/lab/shipped.ts`),
  plus the shipped default model, SmolLM2-360M. It renders the extension's
  requests byte for byte: all 240 tune96 per-label requests equal
  `composeLabelPrefix` + `frameReviewInput` + `reviewAnswerCue` of extension
  `main` @ b2c4ca1, checked against the materialized ref when the switches
  were added. `tests/shipped.test.ts` pins one rendered request. The answers
  of the benched branch commit matched the lab byte for byte (LOG V1). The
  plausibility filter is the ref's own `isPlausiblePassage`.
- **Switches:** each entry below has a switch id. The lab configuration
  `shipped-no-<id>` is the baseline with that one improvement turned off. The
  `model` switch runs the baseline on the previous default model.
- **Ablation:** `npm run ablate -- --set tune96 --model smollm2-360m` runs the
  baseline and every switch and writes the deltas table to
  `experiments/ablations/`. A new proposal goes in `src/lab/configs.ts` as
  `add("shipped", "<id>", ...)`. Run `npm run ablate -- --with <id>` on tune96,
  confirm it on confirm48, and use the held-out split (`--set heldout-test
  --allow-test`) only for a one-shot check of a choice already made on dev.
- **Adding an entry** when an improvement ships: set it in `SHIPPED_CONFIG`
  and add a component to `SHIPPED_COMPONENTS` with a new id. Never change what
  an existing switch means, because results are cached by rendered prompt.
  Then add a section here and rerun the ablation.

Set sizes: tune96 (96 dev cases, tuning), confirm48 (48 disjoint dev cases),
iter32 (the first 32 of tune96), held-out test (242 cases, never tuned on).
With 96 cases, F1 differences under ~8 points are noise.

## Ledger

| # | improvement | switch | extension PR | merge | merged (UTC) |
|---|---|---|---|---|---|
| 1 | Completion framing instead of chat | `completion` | [#26](https://github.com/mmarsot/InsustyPromptCoach/pull/26) | 372c8ff | 2026-09-27 08:42 |
| 2 | One request per custom label | `perlabel` | [#26](https://github.com/mmarsot/InsustyPromptCoach/pull/26) | 372c8ff | 2026-09-27 08:42 |
| 3 | Label-example demonstrations | `examples` | [#26](https://github.com/mmarsot/InsustyPromptCoach/pull/26) | 372c8ff | 2026-09-27 08:42 |
| 4 | Language-matched demonstrations | `lang` | [#26](https://github.com/mmarsot/InsustyPromptCoach/pull/26) | 372c8ff | 2026-09-27 08:42 |
| 5 | NONE demonstration last | `nonelast` | [#26](https://github.com/mmarsot/InsustyPromptCoach/pull/26) | 372c8ff | 2026-09-27 08:42 |
| 6 | First-line stop with a 48-token cap | `firstline` | [#26](https://github.com/mmarsot/InsustyPromptCoach/pull/26) | 372c8ff | 2026-09-27 08:42 |
| 7 | Pinned greedy decoding, `repetition_penalty` 1 | `pinned` | [#26](https://github.com/mmarsot/InsustyPromptCoach/pull/26) | 372c8ff | 2026-09-27 08:42 |
| 8 | Basic plausibility filter | `plausible` | [#26](https://github.com/mmarsot/InsustyPromptCoach/pull/26) | 372c8ff | 2026-09-27 08:42 |
| 9 | SmolLM2-360M default, SmolLM2-135M removed | `model` | [#26](https://github.com/mmarsot/InsustyPromptCoach/pull/26) | 372c8ff | 2026-09-27 08:42 |
| – | Automatic model preparation (no quality change) | none | [#29](https://github.com/mmarsot/InsustyPromptCoach/pull/29) | b2c4ca1 | 2026-09-27 11:38 |

## Leave-one-out ablation (tune96, SmolLM2-360M)

`npm run ablate -- --set tune96 --model smollm2-360m`, 2026-09-27, extension
`main` @ b2c4ca1, q8 WASM. Full table with the "off" definitions:
[`experiments/ablations/ablate-tune96-smollm2-360m.md`](../experiments/ablations/ablate-tune96-smollm2-360m.md).
Runs: `experiments/runs/ablate-tune96-smollm2-360m.json` and
`ablate-tune96-smollm2-360m-no-model.json`. Deltas are in points vs the
baseline. Negative ΔF1 means the improvement helps F1, and positive ΔFP means
it lowers false positives.

| switched off | F1 | ΔF1 | precision | recall | FP rate | ΔFP | detection | EN / FR F1 | p50 |
|---|---|---|---|---|---|---|---|---|---|
| nothing (shipped baseline) | 32.1 | | 41.5 | 26.2 | 35.7 | | 40.7 | 32.9 / 31.5 | 2.37 s |
| `completion` | 16.7 | −15.4 | 37.9 | 10.7 | 14.3 | −21.4 | 20.4 | 23.0 / 11.3 | 2.29 s |
| `perlabel` | 9.0 | −23.1 | 20.0 | 5.8 | 33.3 | −2.4 | 9.3 | 9.4 / 8.6 | 2.14 s |
| `examples` | 1.9 | −30.2 | 100 | 1.0 | 0.0 | −35.7 | 1.9 | 4.2 / – | 1.78 s |
| `lang` | 27.2 | −4.9 | 34.8 | 22.3 | 42.9 | +7.2 | 37.0 | 32.9 / 22.2 | 2.42 s |
| `nonelast` | 36.8 | +4.7 | 32.3 | 42.7 | 71.4 | +35.7 | 57.4 | 41.5 / 32.5 | 2.79 s |
| `firstline` | 31.1 | −1.0 | 40.6 | 25.2 | 33.3 | −2.4 | 38.9 | 32.9 / 29.5 | 2.38 s |
| `pinned` | 32.1 | ±0.0 | 41.5 | 26.2 | 35.7 | ±0.0 | 40.7 | 32.9 / 31.5 | (3.08 s) |
| `plausible` | 33.0 | +0.9 | 36.6 | 30.1 | 47.6 | +11.9 | 46.3 | 34.9 / 31.3 | 2.37 s |
| `model` (SmolLM2-135M) | 23.1 | −9.0 | 28.6 | 19.4 | 47.6 | +11.9 | 31.5 | 26.6 / 19.3 | 1.19 s |

The baseline equals the extension's bench numbers at d42c466 (LOG V1: 32.1 /
41.5 / 26.2 / FP 35.7), so the lab baseline is the shipped behaviour.

What it says (tune96 only; differences under ~8 F1 points are noise):

- **Carrying most of the gain:** example demonstrations (−30 F1 without
  them), one request per label (−23; the all-labels request breaks the
  answer format on 25% of prompts, mostly by answering the prompt) and completion framing (−15).
  Without the framing, false positives drop, but only because recall
  collapses.
- **The language match** helps French only (FR F1 31.5 → 22.2 without it),
  and lowers the FP rate by 7 points.
- **Precision and false-positive levers, not F1 levers:** NONE last (without
  it, F1 is +4.7 but 71% of negatives get flagged) and the plausibility filter
  (−12 FP points for −0.9 F1). A proposal that trades FP for recall should be
  compared with these two.
- **Near-neutral on quality:** the first-line stop (−1 F1, within noise). It
  bounds latency (without it, 2 prompts hit the 30 s deadline and p95 rises
  6.4 s → 7.3 s) and keeps the answer format fixed. Pinned decoding changes
  nothing on SmolLM2, as expected: identical outputs. Its latency is in
  parentheses because that row came from a cached earlier run, so the timing
  is not comparable. It matters for Qwen2.5-0.5B.
- **The model switch:** the design on SmolLM2-135M loses 9 F1 points and
  flags 12 points more negatives, at half the latency.

The held-out split was not used for this ablation. Its one-shot numbers
for the whole design are in the PR #26 table below.

## Extension PR #26: per-label completion framing with label examples

https://github.com/mmarsot/InsustyPromptCoach/pull/26, merge commit
372c8ff (2026-09-27 08:42 UTC). This PR implements items 1-9 as one change: lab
configuration `raw-pl-lang` plus the `basic` filter, implemented and benched
as branch commit d42c466. The merge differs from d42c466 only in how prefixes
are prepared (sequentially, with a 16-entry cache) and in a `$`-pattern fix
when building demonstrations. The prompts are unchanged.

Evidence for the whole design, SmolLM2-360M, against the chat design it
replaced (extension dc91f36):

| set | design | F1 | precision | recall | detection | FP rate | format OK | timeouts | p50 |
|---|---|---|---|---|---|---|---|---|---|
| tune96 | chat design (dc91f36) | 17% | 42% | 11% | 17% | 14% | 29% | | 9.3 s |
| tune96 | completion design (d42c466, bench) | 32.1% | 41.5% | 26.2% | 40.7% | 35.7% | 100% | 0 | 2.75 s |
| confirm48 | chat design | 30% | 58% | 20% | 22% | 19% | 27% | | 10.5 s |
| confirm48 | completion design (lab) | 31% | 38% | 25% | 38% | 50% | 100% | 0 | 3.1 s |
| **held-out test** | chat design (dc91f36, bench) | 12.0% | 44.2% | 6.9% | 11.3% | 10.9% | 33% | 34 | 10.0 s |
| **held-out test** | completion design (d42c466, bench) | **27.4%** | 32.2% | **23.9%** | **41.8%** | 44.6% | **100%** | **0** | **2.4 s** |

Runs: `runs/ext-d42c466-tune96-smol360/`, `test-dc91f36-smol360`,
`test-d42c466-smol360`, `d3-smol360-confirm48`. See LOG T1, D1-D3, V1 and H1.
The cost is the false-positive rate: 45% of held-out negatives get a
finding, against 11% before. That is the main open problem (REPORT.md).

### 1. Completion framing instead of chat (`completion`)

- **What:** each request is plain text with no chat template. It is a
  one-line instruction, demonstrations written as `Text: …` / `LABEL: answer`,
  then `Text: <prompt>` and the cue `LABEL:`, which the model continues.
- **Evidence:** every chat-style variant tried on iter32 (instruction
  wording, system vs user placement, few-shot demonstrations as prior chat
  turns, format examples, JSON output, removing the repetition penalty) left
  the models reciting the label list, answering the prompt or looping: F1
  0-27% (LOG E1-E5). Few-shot as chat turns made SmolLM2-135M copy the last
  demonstration's reply ("always NONE", E2). Completion with demonstrations
  was the first framing all three bundled models followed. On iter32,
  SmolLM2-360M went 19 → 38, SmolLM2-135M 5 → 30 and Qwen2.5-0.5B 0 → 36, with
  100% parseable output and 2-4x lower latency (E6).
- **Off:** the same instruction as the system message, demonstrations as
  prior chat turns, and the model's chat template.

### 2. One request per custom label (`perlabel`)

- **What:** one request per custom label, each with its own reusable prefix
  that the extension prepares for EN and FR. The label is attached by code,
  not written by the model. Built-in labels stay with the deterministic
  detector, so no model request runs without custom labels.
- **Evidence:** it shipped as part of the E6 design and was never isolated
  before this ablation. Ablation (tune96): F1 32.1 → 9.0 without it (format
  compliance 100 → 75%). Per-label chat passes were the first chat variant
  that gave Qwen2.5-0.5B the right kind of output (F1 0 → 14, format 0 →
  100%, E5).
- **Off:** one request per prompt covering every custom label. The
  instruction lists every label, each label gets two example demonstrations
  answered `LABEL: passage`, and the NONE demonstration comes last. The
  answer may span several lines: the ref's line-protocol stop replaces the
  first-line stop, with a 48-token cap.

### 3. Label-example demonstrations (`examples`)

- **What:** labels take 1-3 user examples. The first two become
  demonstrations, each in a carrier sentence answered with the example.
- **Evidence:** without example demonstrations (description plus the NONE
  demonstration only), iter32 F1 fell from 38 to 5 (E6 `raw-pl-noex`). A third
  example demonstration made things worse (tune96 F1 32 → 28, FP +9, E8).
- **Off:** the NONE demonstration alone. This is what a label without
  examples gets in the extension.

### 4. Language-matched demonstrations (`lang`)

- **What:** carrier sentences and the NONE text follow the prompt's
  language. French vs English is guessed from stop words and accents (564 of
  567 dev cases right). The instruction line stays English.
- **Evidence:** on tune96, compared with fixed demonstrations (`raw-pl`), F1
  went 30 → 33, French F1 23 → 31 and exact F1 18 → 26, with the FP rate
  36 → 48% (T2). A French instruction line cut French F1 from 31 to 17 (E9).
- **Off:** English carrier sentences and English NONE text for every prompt.

### 5. NONE demonstration last (`nonelast`)

- **What:** the clean-text demonstration answered `NONE` is always the last
  demonstration.
- **Evidence:** putting the NONE demonstration first made the model answer
  something for every negative on iter32 (FP rate 100% vs 40%, F1 38 → 29, E6
  `raw-pl-negfirst`). Two NONE demonstrations in a row made it answer NONE
  too often (tune96 F1 16, T1).
- **Off:** the NONE demonstration first, then the example demonstrations.

### 6. First-line stop with a 48-token cap (`firstline`)

- **What:** the answer ends at the first line break after some output, with
  at most 48 new tokens. It replaces the chat design's line-protocol stop,
  which had no cap and ran until a 30 s deadline.
- **Evidence:** it is part of the E6 design's latency gain: tune96 p50 9.3 s →
  ~3 s, and held-out timeouts 34 → 0 with p50 10.0 s → 2.4 s (H1). Ablation
  (tune96): quality within noise without it (F1 −1), but 2 prompts hit the
  30 s deadline and p95 rises 6.4 → 7.3 s. Its value is bounded latency.
- **Off:** no cap. Generation runs until the ref's line-protocol stop (blank
  line, NONE or a repeated line), EOS or the 30 s deadline, and every answer
  line is parsed.

### 7. Pinned greedy decoding (`pinned`)

- **What:** every generation passes `do_sample: false`, `num_beams: 1`,
  `repetition_penalty: 1` and `no_repeat_ngram_size: 0` explicitly, instead
  of inheriting the model's `generation_config.json`. Qwen2.5 ships sampling
  and a 1.1 penalty.
- **Evidence:** this is a correctness pin rather than a quality lever. It
  makes the extension decode exactly like the bench, which is always greedy.
  SmolLM2 ships no penalty, so the pin changes nothing for the default model
  (E2 `rp1` = `ref`). Removing Qwen's 1.1 penalty alone did not rescue the
  chat design (E5).
- **Off:** penalties come from the model's `generation_config.json`. Greedy
  decoding is kept, because the lab never samples.

### 8. Basic plausibility filter (`plausible`)

- **What:** code drops answered passages under 3 characters, bare 1-2 digit
  numbers (or ranges), passages made only of stop words, and passages over
  8 words (`isPlausiblePassage`).
- **Evidence:** on tune96, `raw-pl-lang` went from F1 33 / precision 37 /
  FP 48% to 32 / 42 / 36% with the filter, and exact F1 26 → 29 (T4, D1). The
  filter is nearly free on F1 and cuts the FP rate by 12 points. On
  confirm48 it was neutral (30 → 31, D3).
- **Known deviation:** the extension's stop-word list still contains
  "simple" and "terms", copied from one overfit tune96 case. The lab
  recommends removing them (LOG "Fix: overfit words", no held-out effect).
  The baseline uses the extension's own list.
- **Off:** every anchored passage is kept.

### 9. SmolLM2-360M default, SmolLM2-135M removed (`model`)

- **What:** SmolLM2-360M is the default Local AI redaction model, and
  SmolLM2-135M is gone from the model list. Qwen2.5-0.5B stays in the list.
- **Evidence:** with the completion design, SmolLM2-135M reaches F1 ~30 but
  flags ~80% of negatives (iter32 30 / FP 80%, confirm48 29 / FP 81%; E6, C1).
  SmolLM2-360M gets F1 32 / FP 36% on tune96 and 31 / 50% on confirm48 at
  about 3 s. Under the chat design the 135M model scored F1 3-5 (E1, C1).
- **Off:** the baseline runs on SmolLM2-135M, the previous default.

## Extension PR #29: automatic model preparation (not a quality change)

https://github.com/mmarsot/InsustyPromptCoach/pull/29, merge commit
b2c4ca1 (2026-09-27 11:38 UTC). Turning Local AI redaction on, or picking
another model while it is on, now prepares (downloads and loads) the model
right away, and the "Prepare model" button is gone. Every review first makes
sure the selected model is prepared: the send waits for preparation, and
falls back to rule-based findings if preparation fails.

It changes no prompt, decoding or parsing. The review, engine and generation
modules are identical apart from an import path, `slm-models.ts` only gains
static download sizes, and the `shipped` baseline renders the same requests
at b2c4ca1. What it affects is latency, not quality. The first
review after enabling no longer waits for a manual step, and a review whose
model is not loaded now includes the preparation time. The bench and the lab
time generations on an already loaded model with prepared prefixes, so they
do not measure this. It has no switch.
