# Local SLM review: best configuration so far

Status: **current** as of 2026-09-27 (updated after every experiment).
Evidence and run names: [LOG.md](LOG.md); model research: [RESEARCH.md](RESEARCH.md).
Runtime everywhere unless noted: q8 weights on onnxruntime-web WASM (4
threads), greedy decoding, the extension's own code for anything the
extension ships.

## Summary

- **The per-label completion design on SmolLM2-360M has shipped** (extension
  PR #26, merge 372c8ff; benched as branch commit d42c466;
  the bench confirms it reproduces the lab byte for byte). On the held-out
  test split it more than doubles F1 (12% → 27%), finds 3.5x more passages,
  never times out and answers in 2.4 s instead of 10 s.
- **Example-derived patterns and the confidence filter have shipped too**
  (extension PR #32, merge b4f96b1; benched as ebf077f, which reproduces the
  lab case by case, LOG V2). Each label example that looks like an
  identifier (`acct-00918-BZ`, `db-07.int.corp.net`, `ticket #558120`)
  becomes a regular expression whose matches join the model's findings
  (held-out F1 27% → 34%), and a label's answer whose least likely token has
  probability below 0.2 counts as NONE (held-out FP 46% → 36%). Together:
  held-out **F1 33%, precision 43%, FP 36%**.
- **False positives remain the main weakness** (36% of held-out negatives,
  vs 11% for the old chat design). A threshold of 0.3 cuts them to 25% for
  4 F1 points (measured without the patterns): a candidate sensitivity
  setting.
- **Models:** SmolLM2-360M as default is right. Qwen2.5-0.5B, Gemma 3 270M
  and LFM2.5-350M all fail the keep/add criterion (below). SmolLM2-135M only
  becomes marginally useful with the new design (F1 ~30% on dev, FP 80%).
- **GPU:** reachable on this laptop (Chrome with `--enable-features=Vulkan`),
  but the extension's WebGPU q4 weights halve the quality; use fp32/fp16 on
  WebGPU, keep WASM q8 as the default.

- **Shipped baseline:** extension PR #26 (merge 372c8ff) and PR #32 (merge
  b4f96b1). It is the lab's `shipped` configuration, with one switch per
  improvement (`docs/shipped-improvements.md`). The leave-one-out ablation
  on tune96 (LOG A2) shows that example demonstrations, one request per
  label, completion framing and the example patterns carry the F1 gain,
  while NONE-last, the confidence filter and the plausibility filter are
  false-positive levers. Measure new proposals
  with `npm run ablate -- --with <config>`.
- **Rejected: segment x label Yes/No classification** (captain's spec v1.1).
  Code cuts the prompt into sentences, the model answers Yes/No per
  (sentence, label), and a Yes redacts the whole sentence. With the spec's
  chat template SmolLM2-360M says Yes to everything (AUC 0.48, FP 100%). In
  the completion framing it formats well but barely discriminates (AUC
  0.62-0.63; F1 24-25 vs 34-38 for the shipped design on the same cases).
  It needs ~9 requests per prompt (p50 2.7x, p95 8-10x), and 83-94% of what
  it redacts is outside the sensitive passages. As a second-stage verifier of
  shipped findings it does worse than the confidence filter. Stopped after
  the iter32 screen and a partial tune96 run. (LOG S1-S4; ledger "Rejected
  proposals".)

Sets: `tune96` (96 dev cases, 54 positive / 42 negative, half EN half FR) for
tuning, `confirm48` (48 disjoint dev cases) to confirm, `heldout-test` (the
242 test-split cases) for one-shot evaluation of choices made on dev only.
With 96 cases, F1 differences under ~8 points are noise.

## Held-out confirmation (242 test cases, never used for tuning)

SmolLM2-360M through the bench (`npm run bench -- --tier full --split test`):

| design | F1 | precision | recall | detection | FP rate | format OK | timeouts | p50 | p95 | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| shipped chat design (dc91f36) | 12.0% | 44% | 6.9% | 11% | 11% | 33% | 34 | 10.0 s | 30.1 s | 13% | 11% |
| **completion design (d42c466)** | **27.4%** | 32% | **23.9%** | **42%** | 45% | 100% | 0 | **2.4 s** | 8.8 s | 26% | 29% |
| + confidence filter, min token prob < 0.2 (lab) | 26% | 36% | 20% | 36% | **34%** | 100% | 0 | 2.4 s | | 25% | 27% |
| + confidence filter, min token prob < 0.3 (lab) | 23% | 37% | 17% | 30% | 25% | 100% | 0 | 2.4 s | | 22% | 24% |
| + example-derived patterns (lab) | **34%** | 38% | **30%** | **50%** | 46% | 100% | 0 | 2.4 s | | 32% | 36% |
| **+ patterns + confidence filter 0.2 (lab)** | 33% | **43%** | 27% | 44% | 36% | 100% | 0 | 2.4 s | | 32% | 34% |
| **same, extension PR #32 (ebf077f, bench)** | 33.2% | **43%** | 27.0% | 44% | 36% | 100% | 0 | 2.6 s | 9.3 s | 32% | 34.5% |

(LOG H1, H2, P1, V2. The lab's unfiltered row reproduces the bench's d42c466
numbers; the bench run of PR #32 reproduces the lab's patterns + filter
findings case by case.)

## The recommended design

For each custom label, one plain-text request (no chat template) that the
model continues:

```
Copy the CLIENT_NAME passages from each text, exactly as written. CLIENT_NAME: <description> Write NONE when the text has none.

Text: Quick update before the call: <example 1> is still on the list for next week, can you tidy up this paragraph?
CLIENT_NAME: <example 1>

Text: Reminder for tomorrow: we need to go over <example 2> with the team, keep it short.
CLIENT_NAME: <example 2>

Text: Can you rewrite this so it sounds friendlier? Thanks for your patience, we will get back to you shortly.
CLIENT_NAME: NONE

Text: <the user's prompt>
CLIENT_NAME:
```

- Demonstrations come from the label's first two examples (a new `examples`
  field; without examples F1 falls to ~5%). The NONE demonstration must stay
  last (ending on a positive makes the model always answer).
- Carrier sentences and the NONE text follow the prompt's language (French
  when the stop-word guess says so, 564/567 right on dev); the instruction
  line stays English (a French one drops French F1 from 31% to 17%).
- One line per answer: stop at the first line break, 48-token cap; pinned
  greedy settings (`repetition_penalty: 1`, overriding e.g. Qwen's shipped 1.1).
- Code attaches the label, drops implausible passages (under 3 characters,
  1-2 digit numbers, only stop words, over 8 words) and anchors the rest with
  the existing parser. Built-in labels stay with the deterministic detector.

**Implementation status:** done in `fm/slm-completion-framing` (d42c466).
Bench parity on tune96 (SmolLM2-360M): F1 32.1%, precision 41.5%, recall
26.2%, FP rate 35.7%, EN 33% / FR 31.5%, p50 2.75 s, identical to the lab;
239 of 240 per-label answers byte-identical (the other differs only by the
lab summary's truncation). (LOG V1.)

## Recommended next changes to the extension

Done in PR #32 (merge b4f96b1): example-derived patterns, the confidence
filter at 0.2, and removing "simple"/"terms" from the stop words (LOG P1,
C2-C3, H2, V2; ledger items 10-12).

1. **Confidence threshold as a sensitivity setting** (optional): 0.3 cuts
   the held-out FP rate to 25% for about 4 F1 points (LOG H2, measured
   without the patterns).
2. **Patterns without the model:** they run in `reviewPrompt` after the
   model requests; they could also run when Local AI is unavailable.
3. (Not recommended any more) **recall mode:** re-asking a label on the text
   with its found passages masked raised recall, but once the patterns are in
   it adds no held-out F1 (34% either way) and costs about 1 s. (LOG I1-I2, H3, P1.)
4. **WebGPU path:** do not use q4 (it halves quality); use fp32, or fp16 on
   GPUs with `shader-f16`; keep WASM q8 as default. (LOG G2-G3.)
5. **Free the fetched weight buffers after session creation** (the Node
   workers now force a GC after load: Qwen2.5-0.5B RSS 3.34 → 2.36 GB).

## Model decisions (completion design + plausibility filter, dev sets)

Criterion for keeping or adding a model next to SmolLM2-360M: F1 within ~5
points or clearly better in French, FP rate no worse.

| model | tune96 F1 | confirm48 F1 | FR F1 (t96 / c48) | FP rate (t96 / c48) | p50 | verdict |
|---|---|---|---|---|---|---|
| **SmolLM2-360M** (default) | 32 | 31 | 31 / 36 | 36% / 50% | 3.1 s | keep |
| Qwen2.5-0.5B | 24 | 24 | 27 / 23 | 45% / 56% | 5.4-6.3 s | drop: −8 F1, worse in French and FP |
| Gemma 3 270M (candidate) | 33 | 37 | 33 / 33 | 76% / 75% | 7-10 s | don't add: FP far worse, the confidence filter doesn't fix it (FP ≥ 50%), needs onnxruntime-web ≥ 1.24 |
| LFM2.5-350M (candidate) | 13 | 18 | 12 / 21 | 40% / 63% | 18-21 s | not usable (below) |
| Granite 4.0 H 350M (candidate) | – | – | – | – | – | not runnable on Transformers.js 3.8.1 (Mamba state inputs never initialized) |
| LFM2-350M-Extract (candidate) | – | – | – | – | 13.6 s | iter32 F1 25% in its native JSON mode vs 38% for SmolLM2-360M; invents keys, fills every key |
| Qwen3-0.6B (candidate) | – | – | – | – | – | not run: q8 load peak would exceed ~3.5 GB on this machine; most promising untested model |

Also measured: SmolLM2-135M with the new design reaches F1 ~30% on iter32
and confirm48 (from 3-5%) but flags 80% of negatives.

### LFM2.5-350M (requested by the captain): not usable as exported

With the prefix-cache bug worked around (every request prefilled whole),
onnxruntime-web 1.24.3: tune96 F1 13% (q8), confirm48 18%, iter32 23% (q8)
and 14% (q4). Answers start right, then degenerate into repeated characters
(`sshportportport...`, `keycloecoooo...`); Transformers.js 4.3 with
onnxruntime-web 1.31 produces the same outputs byte for byte. The card's
`repetition_penalty: 1.05`, a penalty on the answer's own tokens only, and
chat framing per label do not help (20-22%). Integration would also need the
onnxruntime-web upgrade and disabling prefix KV reuse (Transformers.js 3.8.1
breaks LFM2's conv state when the prompt is prefilled in two parts), making it
6x slower than SmolLM2-360M. (LOG E7a, L1-L5.)

## Dev-set evidence for the design (SmolLM2-360M)

| config | set | F1 | precision | recall | exact F1 | detection | FP rate | format OK | p50 | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| shipped chat design | tune96 | 17% | 42% | 11% | 12% | 17% | 14% | 29% | 9.3 s | 20% | 14% |
| per-label completion, English demos | tune96 | 30% | 32% | 29% | 18% | 39% | 36% | 100% | 2.8 s | 38% | 23% |
| per-label completion, language-matched demos | tune96 | 33% | 37% | 30% | 26% | 46% | 48% | 100% | 3.1 s | 35% | 31% |
| same + plausibility filter (= d42c466) | tune96 | 32% | 41% | 26% | 28% | 41% | 38% | 100% | 3.1 s | 33% | 31% |
| same + confidence filter 0.2 | tune96 | 30% | 48% | 21% | 26% | 31% | 21% | 100% | 2.5 s | 31% | 28% |
| shipped chat design | confirm48 | 30% | 58% | 20% | 28% | 22% | 19% | 27% | 10.5 s | 36% | 20% |
| same as d42c466 | confirm48 | 31% | 38% | 25% | 29% | 38% | 50% | 100% | 3.1 s | 27% | 36% |
| same + confidence filter 0.2 | confirm48 | 33% | 45% | 25% | 30% | 38% | 44% | 100% | 2.4 s | 30% | 37% |

How it was found: every chat-style variant (instruction wording, system vs
user placement, few-shot chat turns, format examples, JSON output, removing
Qwen's repetition penalty) left the models reciting the label list, answering
the prompt or looping (F1 0-27% on iter32). Plain completion with
demonstrations was the first framing all three bundled models could follow.
(LOG E1-E6, T1-T5.)

## GPU (WebGPU) on this laptop

- **Reaching the NVIDIA GPU:** a normal (headful) Chrome started with
  `--enable-features=Vulkan` exposes the GTX 1050 as the default and
  high-performance adapter (Intel for low-power). Without the flag Chrome
  offers only SwiftShader, and headless Chrome cannot create a Vulkan
  instance at all. No PRIME variables or ANGLE flags needed. (LOG G1.)
- **q4 halves the quality** whatever the device: SmolLM2-360M F1 15% on
  WebGPU q4 and 21% on WASM q4, versus 36-38% with q8 (the extension uses q4
  on WebGPU). (LOG G2.)
- **q8 on WebGPU is unusable** (~28 s per request: its operators fall back to
  the CPU), and the GTX 1050 has no fp16.
- **fp32 on WebGPU keeps q8 quality and is fast:** SmolLM2-135M F1 21% on
  both, 0.66 s per request, 1.9 s per prompt without any prefix cache. For
  the 360M that means a 1.45 GB download, so WASM q8 stays the default.
  (LOG G3.)

## What has been ruled out

| idea | result |
|---|---|
| Few-shot demonstrations as prior chat turns | SmolLM2 copies the last demo reply. |
| "Scanner, not assistant" instructions; system vs user placement | No gain on any bundled model. |
| Removing Qwen's inherited `repetition_penalty: 1.1` alone | Still F1 0 with chat prompts. |
| Output-format example; JSON extraction protocol | F1 0 on SmolLM2-360M. |
| Code-proposed candidates + yes/no classification | No discrimination (ROC AUC 0.42-0.56) though candidates cover 93% of expected passages. |
| Sentence segments + one Yes/No per (segment, label), whole-segment redaction (spec v1.1), also as a verifier of shipped findings | Chat template: always Yes (AUC 0.48). Completion framing: AUC 0.62-0.63, F1 24-25 vs 34-38, ~9 requests per prompt, 83-94% over-redaction. As a verifier (AUC 0.60) it is worse than the confidence filter. (LOG S1-S4) |
| Relaxed anchoring (keep the longest matching word run) | Recall ±0, FP +10-14 points. |
| Gate on P(first token = NONE) | Anti-informative. |
| Completion-design tweaks: lower-case cue, two-passage demo, no instruction, `"""` delimiters, counter-example demo, two NONE demos, examples in the description, three example demos, French instruction line, alternative carrier sentences | Equal or worse. |
| Agreement between two demonstration variants | FP 10% but recall halves; worse than the confidence filter. |
| Shape-based label resolution for passages claimed by two labels | Loses more true positives than false ones. |
| `uint8` weights instead of q8 | More recall, far more false positives; no gain once the confidence filter applies. |

## Other findings

1. **Candidate models need a newer onnxruntime-web** (1.24+): the pinned
   1.22.0-dev build cannot load their opset-21 / external-data exports, and
   Transformers.js 3.8.1 needs two workarounds (external data in Node,
   `num_logits_to_keep`). (LOG E2b.)
2. **Greedy q8 outputs depend on how the prompt is split into forward
   passes** (dynamic activation quantization): judge configurations on
   aggregates, not single cases. (LOG E2c.)
3. **Memory on this 7 GB laptop:** Qwen2.5-0.5B loads with a ~3.1 GB peak;
   runs were killed twice by the lab's guard when other processes grew. The
   bench and lab now wait for memory and stop a model below 600 MB available.

## Open problems

- False positives on look-alike and clean texts: the confidence filter
  helps; look-alike public entities ("Fellbeck Tooling", "eLife") need context
  a 360M model does not have.
- Absolute quality is still modest (held-out F1 27%): a 360M model finds
  about a quarter of the sensitive passages. Larger gains likely need a
  better small model that runs on the extension's runtime, not more prompt
  tuning (demo-wording changes now move results only at the noise level).
