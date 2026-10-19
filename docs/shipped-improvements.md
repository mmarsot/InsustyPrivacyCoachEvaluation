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
  plausibility filter is the ref's own `isPlausiblePassage`. Since PR #32 the
  baseline also applies the answer-confidence filter and the example-derived
  patterns; the bench run of that PR reproduced the lab's findings case by
  case (LOG V2).
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
- **Rejected proposals** (end of this page) were measured against this
  baseline and did not ship. Check them before proposing something similar.

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
| 9 | SmolLM2-360M default, SmolLM2-135M removed | `model` (retired) | [#26](https://github.com/mmarsot/InsustyPromptCoach/pull/26) | 372c8ff | 2026-09-27 08:42 |
| – | Automatic model preparation (no quality change) | none | [#29](https://github.com/mmarsot/InsustyPromptCoach/pull/29) | b2c4ca1 | 2026-09-27 11:38 |
| 10 | Example-derived patterns next to the model | `patterns` | [#32](https://github.com/mmarsot/InsustyPromptCoach/pull/32) | b4f96b1 | 2026-09-27 16:13 |
| 11 | Answer-confidence filter, minimum token probability 0.2 | `confidence` | [#32](https://github.com/mmarsot/InsustyPromptCoach/pull/32) | b4f96b1 | 2026-09-27 16:13 |
| 12 | Overfit stop words "simple" and "terms" removed | `stopwords` | [#32](https://github.com/mmarsot/InsustyPromptCoach/pull/32) | b4f96b1 | 2026-09-27 16:13 |
| – | WebGPU loads full precision instead of q4; WASM q8 is the default backend (no request change) | none | [#38](https://github.com/mmarsot/InsustyPromptCoach/pull/38) | aabbf99 | 2026-09-28 11:31 |
| – | Trusted AI redaction on a connected model: bench framings, tolerant parser, confidence filter (connected-model feature, not the in-browser baseline) | none | [#48](https://github.com/mmarsot/InsustyPromptCoach/pull/48) | 71e0c25 | 2026-09-29 21:25 |
| – | Review-dialog learning: learned examples and false alarms as extra demonstrations (per-user state; a fresh install has none, so not in the baseline) | none | [#52](https://github.com/mmarsot/InsustyPromptCoach/pull/52) | b40b5a2 | 2026-09-30 09:55 |

## Leave-one-out ablation (tune96, SmolLM2-360M)

`npm run ablate -- --set tune96 --model smollm2-360m`, 2026-09-27, extension
`main` @ 71a29e3 (PR #32 merge b4f96b1 plus #33, which only changes WebGPU
probing in the browser worker), q8 WASM. Full table with the "off"
definitions:
[`experiments/ablations/ablate-tune96-smollm2-360m.md`](../experiments/ablations/ablate-tune96-smollm2-360m.md).
Run: `experiments/runs/ablate-tune96-smollm2-360m.json` (the 2026-09-27
`ablate-tune96-smollm2-360m-no-model.json` run of the `model` switch was
deleted with SmolLM2-135M on 2026-10-17). Deltas are in points vs the
baseline. Negative ΔF1 means the improvement helps F1, and positive ΔFP means
it lowers false positives. The PR #26-baseline run of this ablation is LOG
A1.

| switched off | F1 | ΔF1 | precision | recall | FP rate | ΔFP | detection | EN / FR F1 | p50 |
|---|---|---|---|---|---|---|---|---|---|
| nothing (shipped baseline) | 38.2 | | 55.6 | 29.1 | 21.4 | | 38.9 | 44.2 / 32.5 | 2.56 s |
| `completion` | 27.1 | −11.1 | 60.0 | 17.5 | 9.5 | −11.9 | 29.6 | 39.4 / 14.9 | 2.67 s |
| `perlabel` | 21.2 | −17.0 | 48.1 | 13.6 | 21.4 | ±0.0 | 20.4 | 29.2 / 14.3 | 3.20 s |
| `examples` | 17.7 | −20.5 | 100 | 9.7 | 0.0 | −21.4 | 14.8 | 29.1 / 6.9 | 2.27 s |
| `lang` | 35.2 | −3.0 | 50.0 | 27.2 | 26.2 | +4.8 | 38.9 | 44.2 / 26.8 | 2.55 s |
| `nonelast` | 39.4 | +1.2 | 42.2 | 36.9 | 47.6 | +26.2 | 53.7 | 48.9 / 31.1 | 3.17 s |
| `firstline` | 38.2 | ±0.0 | 55.6 | 29.1 | 19.0 | −2.4 | 38.9 | 44.2 / 32.5 | 2.64 s |
| `pinned` | 38.2 | ±0.0 | 55.6 | 29.1 | 21.4 | ±0.0 | 38.9 | 44.2 / 32.5 | 2.53 s |
| `plausible` | 39.5 | +1.3 | 49.3 | 33.0 | 33.3 | +11.9 | 44.4 | 46.5 / 32.6 | 2.56 s |
| `model` (SmolLM2-135M) | retired | | | | | | | | |
| `patterns` | 29.5 | −8.7 | 47.8 | 21.4 | 21.4 | ±0.0 | 31.5 | 31.0 / 28.2 | 2.56 s |
| `confidence` | 39.5 | +1.3 | 47.3 | 34.0 | 38.1 | +16.7 | 48.1 | 44.2 / 35.2 | 2.37 s |
| `stopwords` | 38.2 | ±0.0 | 55.6 | 29.1 | 21.4 | ±0.0 | 38.9 | 44.2 / 32.5 | 2.56 s |

The baseline equals the extension's bench numbers at ebf077f (LOG V2: 38.2 /
55.6 / 29.1 / FP 21.4), so the lab baseline is the shipped behaviour.

What it says (tune96 only; differences under ~8 F1 points are noise):

- **Carrying most of the gain:** example demonstrations (−20 F1 without
  them), one request per label (−17; the all-labels request breaks the
  answer format on some prompts, mostly by answering the prompt), completion
  framing (−11) and the example patterns (−9, all through recall: the
  patterns find identifiers the model misses and add no false positive).
  Without the framing, false positives drop, but only because recall
  collapses. The patterns soften every model-side switch (the PR #26 run
  had −30, −23 and −15 for the first three), because they keep finding
  identifiers whatever the prompt.
- **The language match** helps French only (FR F1 32.5 → 26.8 without it),
  and lowers the FP rate by 5 points.
- **Precision and false-positive levers, not F1 levers:** NONE last (without
  it, F1 is +1 but 48% of negatives get flagged), the confidence filter (−17
  FP points for −1.3 F1) and the plausibility filter (−12 FP points for −1.3
  F1). A proposal that trades FP for recall should be compared with these
  three.
- **Near-neutral on quality:** the first-line stop (F1 ±0, FP −2.4 without
  it: within noise). It bounds latency and keeps the answer format fixed.
  Pinned decoding changes nothing on SmolLM2, as expected: identical outputs.
  The stop-word fix is ±0 here: the one tune96
  case it affected (legal-en-040, LOG "Fix: overfit words") is now dropped by
  the confidence filter anyway; it is a correctness fix against tuning-set
  overfitting, not a quality lever.
- **The model switch** is retired: SmolLM2-135M was removed from the bench
  on 2026-10-17, so its "off" state no longer runs and its evidence run was
  deleted.

The held-out split was not used for this ablation. Its one-shot numbers
for the whole design are in the PR #26 and PR #32 tables below.

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

Bench runs (kept locally, not in git; overlap F1 / precision / recall / FP
rate, SmolLM2-360M, all 2026-09-27):

- tune96 on d42c466: 32.1% / 41.5% / 26.2% / 35.7% (run `ext-d42c466-tune96-smol360`).
- held-out test (242) on dc91f36: 12.0% / 44.2% / 6.9% / 10.9% (run `test-dc91f36-smol360`).
- held-out test (242) on d42c466: 27.4% / 32.2% / 23.9% / 44.6% (run `test-d42c466-smol360`).

The confirm48 rows are the lab run `d3-smol360-confirm48`. See LOG T1, D3, V1
and H1.
The cost is the false-positive rate: 45% of held-out negatives get a
finding, against 11% before. That is the main open problem (REPORT.md).

### 1. Completion framing instead of chat (`completion`)

- **What:** each request is plain text with no chat template. It is a
  one-line instruction, demonstrations written as `Text: …` / `LABEL: answer`,
  then `Text: <prompt>` and the cue `LABEL:`, which the model continues.
- **Evidence:** every chat-style variant tried on iter32 (instruction
  wording, system vs user placement, few-shot demonstrations as prior chat
  turns, format examples, JSON output, removing the repetition penalty) left
  the models reciting the label list, answering the prompt or looping (those
  screens ran on models since removed; their runs are retired). Completion
  with demonstrations was the first framing the models followed. On iter32,
  SmolLM2-360M went 19 → 38, with 100% parseable output and 2-4x lower
  latency (E6).
- **Off:** the same instruction as the system message, demonstrations as
  prior chat turns, and the model's chat template.

### 2. One request per custom label (`perlabel`)

- **What:** one request per custom label, each with its own reusable prefix
  that the extension prepares for EN and FR. The label is attached by code,
  not written by the model. Built-in labels stay with the deterministic
  detector, so no model request runs without custom labels.
- **Evidence:** it shipped as part of the E6 design and was never isolated
  before this ablation. Ablation (tune96): F1 32.1 → 9.0 without it (format
  compliance 100 → 75%).
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
  of inheriting the model's `generation_config.json`.
- **Evidence:** this is a correctness pin rather than a quality lever. It
  makes the extension decode exactly like the bench, which is always greedy.
  SmolLM2 ships no penalty, so the pin changes nothing for the default model
  (E2 `rp1` = `ref`).
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
- **Stop words:** the list first contained "simple" and "terms", copied
  from one overfit tune96 case; PR #32 removed them (item 12). The baseline
  uses the extension's own list.
- **Off:** every anchored passage is kept.

### 9. SmolLM2-360M default, SmolLM2-135M removed (`model`)

- **What:** SmolLM2-360M is the default Local AI redaction model, and
  SmolLM2-135M is gone from the model list.
- **Evidence:** SmolLM2-360M gets F1 32 / FP 36% on tune96 and 31 / 50% on
  confirm48 at about 3 s. The SmolLM2-135M comparison runs were deleted
  with the older models on 2026-10-17: that evidence is retired.
- **Off:** the baseline on SmolLM2-135M, the previous default. The switch is
  retired: the bench no longer has that model.

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

## Extension PR #32: example-derived patterns and an answer-confidence filter

https://github.com/mmarsot/InsustyPromptCoach/pull/32, merge commit
b4f96b1 (2026-09-27 16:13 UTC). Items 10-12 as one change: lab `raw-pl-lang`
+ `basic` + `cmin0.2` + `patterns` (LOG C2-C3, H2, P1), benched as branch
commit ebf077f, whose sources equal the merge's. The requests are unchanged;
the engine now reports each completion answer's confidence
(`SlmReviewRuntime.answerProbability`, recorded by a pass-through logits
processor, so decoding is unaffected).

Evidence, SmolLM2-360M, bench on ebf077f, 2026-09-27 (LOG V2; local runs
`ext-ebf077f-tune96-smol360`: F1 38.2%, FP rate 21.4% on tune96, and
`ext-ebf077f-test-smol360`: F1 33.2%, FP rate 35.6% on the held-out test), each
part switched off by replaying the cached answers (`npm run components`):

| set | variant | F1 | precision | recall | detection | FP rate | EN / FR F1 |
|---|---|---|---|---|---|---|---|
| tune96 | before (PR #26 design) | 32.0% | 40.9% | 26.2% | 40.7% | 38.1% | 32.5 / 31.5 |
| tune96 | patterns only | 39.5% | 47.3% | 34.0% | 48.1% | 38.1% | 44.2 / 35.2 |
| tune96 | confidence filter only | 29.5% | 47.8% | 21.4% | 31.5% | 21.4% | 31.0 / 28.2 |
| tune96 | **PR #32 (both)** | **38.2%** | **55.6%** | 29.1% | 38.9% | **21.4%** | 44.2 / 32.5 |
| **held-out test** | before (PR #26 design) | 27.4% | 32.2% | 23.9% | 41.8% | 44.6% | 25.8 / 29.0 |
| **held-out test** | patterns only | 34.0% | 38.4% | 30.4% | 49.6% | 45.5% | 31.9 / 35.9 |
| **held-out test** | confidence filter only | 26.1% | 36.2% | 20.4% | 36.2% | 33.7% | 25.0 / 27.0 |
| **held-out test** | **PR #32 (both)** | **33.2%** | **43.3%** | 27.0% | 44.0% | **35.6%** | 31.8 / 34.5 |

The configuration was fixed on the dev sets (tune96, confirm48) before the
one-shot held-out check. On the held-out split the PR's findings equal the
lab's `basic + cmin0.2 + patterns` case by case (242/242); held-out p50 2.6 s,
p95 9.3 s, no timeouts.

### 10. Example-derived patterns (`patterns`)

- **What:** each label example containing an identifier-like token becomes
  a regular expression: literal prefix, separators and domain suffix,
  generalized digit and code runs (`acct-00918-BZ` →
  `acct-\p{N}{3,8}-[\p{L}\p{N}]{1,6}`); plain names give none. Matches join
  the model's findings under the same label, without repeating a span the
  model found (`src/slm-patterns.ts`; lab `src/lab/patterns.ts`).
- **Evidence:** the model nearly missed identifier-like labels on the
  held-out split (internal hosts 8% recall, account refs 7%, internal
  services 0%). The patterns are 85-100% precise and add +7 to +10 F1 on
  every set at almost no FP cost (LOG P1): held-out 27.4 → 34.0, with the
  filter 26.1 → 33.2 (V2). Caveat: the fictional identifiers follow each
  company's format consistently; users whose examples do not share a format
  with their real identifiers gain less. Standalone money/percent patterns
  were within noise and not shipped (P2).
- **Off:** the model's findings only.

### 11. Answer-confidence filter at 0.2 (`confidence`)

- **What:** a label's answer whose least likely generated token (the final
  line break, EOS or cap excluded) has probability below 0.2 counts as NONE
  (`SLM_MIN_ANSWER_PROBABILITY`). The lab's `minAnswerProbability` uses the
  same rule on probabilities rounded to 4 decimals.
- **Evidence:** thresholds swept on tune96, confirmed unchanged on
  confirm48 (LOG C2-C3): at 0.2, FP 36 → 21% on tune96 and 50 → 44% on
  confirm48, F1 within 2 points. Held-out one-shot: FP 44.6 → 33.7% for −1.3
  F1 without patterns, 45.5 → 35.6% for −0.8 F1 with them (H2, V2). The
  probability at the first token (P(NONE), T2) was anti-informative; the
  weakest answer token tracks correctness. 0.3 cuts FP further (held-out
  25% without the patterns) for 4 F1 points: a candidate sensitivity
  setting, not shipped.
- **Note:** the extension records probabilities only for completion
  framing; the lab applies the filter to whatever answer the configuration
  produces, so in `shipped-no-completion` it also filters chat answers.
- **Off:** every anchored answer kept (no probabilities recorded, so the
  requests equal the PR #26 baseline's).

### 12. Overfit stop words removed (`stopwords`)

- **What:** "simple" and "terms" left the plausibility filter's stop-word
  list (item 8).
- **Evidence:** both came from one tune96 false positive ("simple terms" in
  legal-en-040), so the filter was tuned on the tuning set. Removing them:
  tune96 FP 36 → 38% (that case), confirm48 and held-out unchanged (LOG "Fix:
  overfit words in the plausibility filter's stop-word list"). A correctness
  fix, not a quality lever.
- **Off:** the plausibility filter also drops passages made only of stop
  words plus "simple"/"terms" (`extraStopWords`).

## Extension PR #38: full-precision weights on WebGPU, WASM q8 by default (no request change)

https://github.com/mmarsot/InsustyPromptCoach/pull/38, merge commit
aabbf99 (2026-09-28 11:31 UTC). It changes which device and weight format
run the model, not what the model is asked:

- **WebGPU weights:** the "Model precision" `Auto` setting loads fp16 on
  WebGPU when the adapter reports `shader-f16`, otherwise fp32, instead of
  q4 (`slmDeviceDtypes` in `src/slm-backends.ts`; the cached WebGPU probe
  now records `shaderF16`). A forced `q4` still loads q4 on WebGPU. WASM
  keeps q8 (q4 when forced). SmolLM2-360M downloads 1381 MB in fp32 and
  691 MB in fp16, against 346 MB in q8.
- **Default backend:** "Runs on" defaults to `WASM` (q8) and no longer
  offers `Auto`, so WebGPU runs only when the user chooses it. A stored,
  imported or synced `auto` loads as the WASM default. Before this PR the
  default was `auto`, which ran WebGPU with q4 whenever an adapter was
  usable.
- **Fallback:** a format that fails to load on WebGPU no longer retries the
  WebGPU default. A forced q4 that fails there moves on to WASM instead of
  retrying full precision (`loadFirstAvailable` in `src/slm-engine.ts`).

Evidence, LOG G1-G3 and REPORT "GPU (WebGPU) on this laptop" (GTX 1050,
headful Chrome with `--enable-features=Vulkan`, `src/lab/browser/`):

- q4 halves the quality whatever the device. SmolLM2-360M, raw-pl-lang,
  iter32: F1 15 on WebGPU q4 and 21 on Chrome WASM q4, against 36 on Chrome
  WASM q8 and 38 in the lab (Node WASM q8) (G2).
- q8 on WebGPU is unusable: about 28 s per request, because its operators
  fall back to the CPU (G2).
- fp32 on WebGPU kept q8 quality on the smaller SmolLM2-135M (G3; that
  model and its evidence were retired on 2026-10-17).

Not verified: fp32 quality and speed for SmolLM2-360M, fp16 (the GTX 1050 has no `shader-f16`), and the extension's own
full-precision load. A headed load of SmolLM2-360M fp32 in the extension on
this laptop was OOM-killed at about 2.5 GB of renderer RAM, which is why
WASM q8 became the default.

It has no switch. The lab and the bench run Node WASM q8, which is now the
extension's default path, and the rendered requests are unchanged: between
the ablation's extension commit (71a29e3) and aabbf99, the request-building
modules differ only in `slm-generation.ts` accepting the new formats when
validating runtime reports. Device and format are run parameters of the lab
(`--dtype`, and `--backend webgpu` for results produced by
`src/lab/browser/`), not configurations of the `shipped` baseline, so the
ablation table stands without a rerun. What changes for users is that the
default no longer drops to WebGPU q4 (G2's F1 15) when an adapter is
usable, so the default path is the one this ledger measures.

## Extension PR #48: Trusted AI redaction on a connected model (not the in-browser baseline)

https://github.com/mmarsot/InsustyPromptCoach/pull/48, merge commit
71e0c25 (2026-09-29 21:25 UTC). Trusted AI redaction can now run on a
connected model (Amazon Bedrock Converse, or an OpenAI-compatible server)
from the service worker, mirroring what was then the bench's hosted
backend (since removed: the bench now runs the extension's own client):

- **Task prompt:** the native-v2 system prompt and user message
  (`NATIVE_SYSTEM_V2`, `nativeUserMessage`, label examples always sent; in
  the extension's `hosted-framing.ts`).
- **Per-model framing** (`resolveRequestFormat`): GLM and any chat model get
  the native task prompt; the answer-cue format (the on-device completion
  text with the cue as an assistant prefill) is chosen for other models.
  Greedy decoding, topK 1 on Converse, GLM thinking disabled.
- **Tolerant answer parser** (`hostedAnswerLines`): first line, a repeated
  `LABEL:` cue stripped, split on `|`, empty and `NONE` parts dropped, then
  handed to the on-device `reviewPrompt` parser.
- **Confidence filter:** the same minimum-token-probability 0.2 rule as item
  11, from the provider's log-probabilities where it returns them
  (OpenAI-compatible servers that do; Converse returns none, so Bedrock
  answers are unfiltered).
- **Fallback:** when the connected model fails (unreachable, auth, rate
  limit, timeout, unreadable answer), the review falls back to rule-based
  redaction.

Evidence: the held-out runs of the bench-side hosted framings (LOG B3-B6)
were deleted with the older models and hosted variants on 2026-10-17; that
evidence is retired. The bench now runs the connected model as
`glm47-flash-connected` through the extension's own client (README
"Connected model in the bench"); its first measurement is a smoke check on
`main` @ 95454ec (16 prompts: F1 51.9%, precision 41.2%, recall 70.0%).

This is a connected-model feature, not a change to the in-browser model: the
`shipped` lab baseline, its switches and the ablation above are unchanged,
and it has no switch.

## Extension PR #52: learning custom labels from the review dialog (not in the baseline)

https://github.com/mmarsot/InsustyPromptCoach/pull/52, merge commit
b40b5a2 (2026-09-30 09:55 UTC). While "Learn from my reviews" is on (the
default), the review dialog records, per custom label, the passages the user
confirmed (learned examples) and the findings the user rejected (learned
false alarms), at most 10 of each (`LEARNED_MAX_PER_LIST`), newest kept.
The Local AI review then uses them:

- **Extra demonstrations** (`learnedDemonstrations`, `composeLabelPrefix`
  in extension `src/slm-review.ts`): after the label's own two examples,
  the newest learned examples as further positive demonstrations, then the
  newest learned false alarms in the same carrier sentences answered
  `NONE`. The on-device model gets 2 + 2 (`ON_DEVICE_LEARNED_LIMITS`),
  within half its context budget; past it the oldest learned items are
  dropped. Connected models get all 10 + 10 (`HOSTED_LEARNED_LIMITS`, half
  the hosted budget): the completion/prefill framings use the same prefix,
  and the native user message appends learned examples to the label's
  examples and adds a "Passages the user marked as not LABEL (never copy
  them)" line.
- **Exact matches and suppression:** a learned example found verbatim in a
  prompt is a finding (`learnedExampleMatches`), and any finding whose text
  equals a learned false alarm of its label is dropped
  (`withoutLearnedFalseAlarms`).

A label that learned nothing renders exactly as before, so the `shipped`
baseline, which models a fresh install with no learned lists, is unchanged,
and there is no switch: turning learning off on the baseline would change
nothing. **Evidence: none measured yet.** The benchmark has no learned
lists; the review-learning simulation that would measure this is parked in
the `bench-t7-measurements` lane. A future measurement is a new lab
configuration (learned lists built from dev cases only), not a change to
`shipped`.

Hosted connectors at b40b5a2: for labels without learned lists the
extension's connected-model requests are byte-identical to PR #48's, so the
bench's `-trusted` hosted models still mirror the extension for every case
the dataset can express. The bench does not model learned lists (no
learned demonstrations, native false-alarm line, exact matches or
suppression) on either the in-browser or the hosted path.

## Rejected proposals

Proposals measured against the `shipped` baseline that did not ship. Their
lab configurations stay in `src/lab/configs.ts` (added on top of `shipped`,
off unless selected), so they can be rerun or revisited, but they are not
switches of the baseline. Those measured before PR #32 keep that baseline
(`BEFORE_PR32` in `src/lab/shipped.ts`), so their cached results still mean
what the LOG says.

### Segment x label Yes/No classification (captain's spec v1.1, 2026-09-27)

- **What:** code cuts the prompt into sentences or clauses with exact
  offsets. For each (segment, custom label), the model gets the label's
  policy (description, examples as covered cases, counter-examples as
  exclusions), four demonstrations and BEFORE/TARGET/AFTER context, and
  answers exactly Yes or No. Any other answer is unresolved. A Yes redacts
  the whole segment. There is also a hybrid: the same check as a second
  stage that keeps a shipped finding only when its segment is not a No.
- **Configurations:** `seg-yn` (the spec's chat-template prompt),
  `seg-yn-raw` (the same text in the shipped completion framing), `-nb`
  (neighbor segments only), `-d2` / `-d0` (fewer demonstrations), `-logit`
  (constrained Yes/No decoding) and `-p<t>` (P(Yes) threshold) decisions, and
  `seg-verify-raw*` (the hybrid). Code: `src/lab/segment.ts`, the `segment`
  field of a lab configuration.
- **Result:** rejected by the captain after the iter32 screen and a partial
  tune96 run (45 of 96 cases). Confirm48 and the held-out split were not run.
  SmolLM2-360M, [LOG S1-S4](../experiments/LOG.md):
  - The chat-template prompt answers Yes to everything: Yes on 83% of
    negative checks, ROC AUC 0.48, FP rate 100% on iter32.
  - The completion framing formats well but barely discriminates (AUC
    0.62-0.63). F1 was 25 vs 34 for `shipped` on iter32, and 24 vs 38 on the
    45 tune96 cases. No threshold, context size or number of demonstrations
    closes the gap.
  - It costs 8.8-9 requests per prompt: p50 2.7x and p95 8-10x `shipped`.
  - Whole-segment redaction puts 83-94% of the redacted characters outside
    the expected passages (`shipped`: 48-56%).
  - As a verifier of shipped findings its AUC is 0.60: at best −7 F1 for −13
    FP points, worse than the answer-confidence filter (about −2 F1 for −15
    FP, no extra request).
- **Lesson:** this is the same failure as LOG E4 (yes/no over code-proposed
  candidates, AUC 0.42-0.56). A sub-500M model cannot judge a policy from a
  description and a few examples, whatever the target granularity or
  context. Yes/No designs need a stronger model before they are worth
  retesting.
