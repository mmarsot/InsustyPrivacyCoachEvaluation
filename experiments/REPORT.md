# Local SLM review: best configuration so far

Status: **current** as of 2026-09-27 (updated after every experiment).
Evidence and run names: [LOG.md](LOG.md); model research: [RESEARCH.md](RESEARCH.md).
Runtime everywhere unless noted: q8 weights on onnxruntime-web WASM (4
threads), greedy decoding, the extension's own code for anything the
extension ships.

## Summary

- **Ship the per-label completion design on SmolLM2-360M** (already
  implemented in the extension, branch `fm/slm-completion-framing`, d42c466;
  the bench confirms it reproduces the lab byte for byte). On the held-out
  test split it more than doubles F1 (12% → 27%), finds 3.5x more passages,
  never times out and answers in 2.4 s instead of 10 s.
- **Next, add example-derived patterns** (pure code, no model cost): each
  label example that looks like an identifier (`acct-00918-BZ`,
  `db-07.int.corp.net`, `ticket #558120`) becomes a regular expression whose
  matches join the model's findings. Held-out F1 27% → **34%**, FP rate
  unchanged. It fixes the model's blind spot (ids, hosts, codes).
- **Its weakness is false positives** (45% of negatives on the held-out
  split, vs 11% before). The best fix found: drop a label's answer when its
  least likely token has probability below 0.2. With the patterns: held-out
  **F1 33%, precision 43%, FP 36%**. Recommended, ideally exposed as a
  sensitivity setting.
- **Models:** SmolLM2-360M as default is right. Qwen2.5-0.5B, Gemma 3 270M
  and LFM2.5-350M all fail the keep/add criterion (below). SmolLM2-135M only
  becomes marginally useful with the new design (F1 ~30% on dev, FP 80%).
- **GPU:** reachable on this laptop (Chrome with `--enable-features=Vulkan`),
  but the extension's WebGPU q4 weights halve the quality; use fp32/fp16 on
  WebGPU, keep WASM q8 as the default.

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

(LOG H1, H2, P1. The lab's unfiltered row reproduces the bench's d42c466 numbers.)

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

1. **Example-derived patterns** (biggest remaining gain, no model cost).
   Port `src/lab/patterns.ts` (about 60 lines, unit-tested in
   `tests/patterns.test.ts`): for each custom label, examples containing an
   identifier-like token (digits, `_ = # @ : /`, or a dotted host) become
   regular expressions with the literal prefix, separators and domain suffix
   kept and digit/code runs generalized; plain names give none. Add their
   matches to the model's findings (they run even when the model is
   unavailable). Held-out F1 +7 points, precision 85% on their own. (LOG P1.)
2. **Confidence filter**. The engine records the
   probability of each greedy token while generating (a pass-through logits
   processor, cheap) and returns the minimum with the answer; `reviewPrompt`
   drops answers below a threshold. 0.2 recommended; could be a sensitivity
   setting (0 = today's behaviour). Dev: tune96 FP 38% → 21%, confirm48
   50% → 44%, F1 −2 / +2. Held-out: see the table above. (LOG C2-C3, H2.)
3. **Remove "simple" and "terms" from `PASSAGE_STOP_WORDS`**: they were added
   for one dev case in the lab and copied over; no effect on held-out.
4. (Not recommended any more) **recall mode:** re-asking a label on the text
   with its found passages masked raised recall, but once the patterns are in
   it adds no held-out F1 (34% either way) and costs about 1 s. (LOG I1-I2, H3, P1.)
5. **WebGPU path:** do not use q4 (it halves quality); use fp32, or fp16 on
   GPUs with `shader-f16`; keep WASM q8 as default. (LOG G2-G3.)
6. **Free the fetched weight buffers after session creation** (the Node
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
