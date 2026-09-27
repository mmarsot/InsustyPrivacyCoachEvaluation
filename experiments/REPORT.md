# Local SLM review: best configuration so far

Status: **in progress** (updated after every experiment; evidence and run
names in [LOG.md](LOG.md), model research in [RESEARCH.md](RESEARCH.md)).
Extension `main` (dc91f36 → 91c5b61 during the runs; the later commits do not
touch the SLM modules), q8 on onnxruntime-web WASM (4 threads), greedy
decoding, dev split only.

Sets: `tune96` (96 dev cases, 54 positive / 42 negative, half EN half FR) for
tuning, `confirm48` (48 dev cases, disjoint) to confirm, `iter32` (subset of
tune96) for quick screens. With 32 cases, differences under ~15 F1 points
are noise; with 96, under ~8.

## Recommendation (current best): `raw-pl-lang` on SmolLM2-360M

SmolLM2-360M on tune96:

| config | F1 (overlap) | precision | recall | exact-match F1 | case detection | FP rate on negatives | format OK | p50 latency | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| `ref` (as shipped) | 17% | 42% | 11% | 12% | 17% | 14% | 29% | 9.3 s | 20% | 14% |
| `raw-pl` | 30% | 32% | 29% | 18% | 39% | 36% | 100% | 2.8 s | 38% | 23% |
| **`raw-pl-lang`** | **33%** | 37% | 30% | 26% | 46% | 48% | 100% | 3.1 s | 35% | **31%** |

All bundled models, `ref` vs `raw-pl`:

| model | set | ref F1 | raw-pl F1 | ref FP rate | raw-pl FP rate | p50 ref → raw-pl |
|---|---|---|---|---|---|---|
| SmolLM2-135M (default) | iter32 | 5% | 30% | 10% | 80% | 5.6 → 1.6 s |
| SmolLM2-135M | confirm48 | 3% | 29% | 6% | 81% | 4.4 → 1.7 s |
| SmolLM2-360M | iter32 | 19% | 38% | 30% | 40% | 9.1 → 2.3 s |
| SmolLM2-360M | tune96 | 17% | 30% | 14% | 36% | 9.3 → 2.8 s |
| SmolLM2-360M | confirm48 | 30% | 32% | 19% | 44% | 10.5 → 3.5 s |
| Qwen2.5-0.5B | iter32 | 0% | 36% | 0% | 30% | 8.0 → 4.4 s |

Honest reading: the new framing turns the default 135M model from useless
into something (F1 ~30), makes Qwen2.5-0.5B work at all (0 → 36), gives 100%
parseable output and cuts latency 3x everywhere. On SmolLM2-360M the F1 gain
is large on tune96 (+13 to +16) but small on confirm48 (+2), where `ref`
happened to do well. The price is a much higher false-positive rate on
negatives: the models answer *something* for look-alike texts. Qwen2.5-0.5B
could not be re-run on the larger sets: the machine often had less than
4.75 GB available (its 3.45 GB load peak + margin).

### What `raw-pl-lang` is

For each custom label, one request rendered as plain text (no chat
template), which the model continues:

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

The carrier sentences and the NONE demonstration are French when the prompt
looks French (stop-word count, 564/567 correct on dev). Generation stops at
the first line break (48-token cap). The answer is anchored with the
existing parser (`validateModelOutput`: exact or case-insensitive,
word-bounded) and labelled by code.

### How the extension could implement it

1. **Label examples.** Each custom label needs 1-3 examples (a new field in
   the label editor). Without examples the framing collapses (F1 5%).
2. **Completion framing in the engine.** `SlmEngine` always applies the chat
   template when the tokenizer has one; add a request option for plain
   framing (the existing `plainInstructionFraming` path is close: prefix =
   instructions + demonstrations, input = `Text: …\n`, prefill = `LABEL:`).
3. **One request per custom label** in `reviewPrompt`, each with its own
   cached prefix (the prepared-instruction cache already holds 8). Built-in
   labels stay with the deterministic detector.
4. **Stop at the first newline** (a variant of `LineOutputTracker`) plus a
   small token cap; the 30 s budget is then never reached (p50 3 s).
5. **Pin generation settings explicitly** (`repetition_penalty: 1`) instead of
   inheriting each model's `generation_config.json`.
6. Pick the demonstration language from the prompt.

## LFM2.5-350M (requested by the captain): not usable as exported

Run with the prefix-cache bug worked around (every request prefilled whole),
onnxruntime-web 1.24.3, `raw-pl-lang`:

| set | dtype | F1 | precision | recall | exact F1 | detection | FP rate | p50 | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|---|
| tune96 | q8 | 13% | 18% | 11% | 11% | 19% | 40% | 21.4 s | 15% | 12% |
| tune96, + basic filter | q8 | 13% | 18% | 10% | 11% | 17% | 36% | 21.4 s | 13% | 12% |
| confirm48 | q8 | 18% | 23% | 15% | 16% | 28% | 63% | 17.8 s | 16% | 21% |
| iter32 | q8 | 23% | 29% | 18% | 19% | 27% | 30% | 19.5 s | | |
| iter32 | q4 | 14% | 50% | 8% | 14% | 9% | 10% | 21.8 s | | |

(SmolLM2-360M, same framing: tune96 33%, iter32 38%, p50 ~3 s.)

- Answers start right, then degenerate into repeated characters or
  syllables (`sshportportport...`, `keycloecoooo...`). The same outputs,
  byte for byte, come out of Transformers.js 4.3 with onnxruntime-web 1.31,
  so this is not a Transformers.js 3.8.1 decoding bug; q4 is no better.
- Remedies tried on iter32: the card's `repetition_penalty: 1.05` (20%), a
  penalty on the answer's own tokens only (22%, loops become word salad),
  chat framing per label (21%, French 0%).
- Integration cost on top: onnxruntime-web upgrade (1.24+), prefix KV reuse
  must be disabled (Transformers.js 3.8.1 breaks LFM2's conv state when the
  prompt is prefilled in two parts), so latency is 6x SmolLM2-360M's.

## Gemma 3 270M-it (candidate)

iter32, onnxruntime-web 1.24.3 (prefix reuse works): `raw-pl-lang` F1 39%
(P 34, R 45, EN 45, FR 30) — the best recall so far — but it flags every
negative (FP rate 100%; 40% after the basic + dedup filters, F1 31%), p50
8.4 s, peak RSS 2.5 GB. Not yet run on tune96/confirm48.

## GPU (WebGPU) on this laptop

- **Reaching the NVIDIA GPU:** a normal (headful) Chrome started with
  `--enable-features=Vulkan` exposes the GTX 1050 as the default and
  high-performance WebGPU adapter (Intel for low-power). Without that flag
  Chrome offers only SwiftShader, and headless Chrome cannot create a Vulkan
  instance at all. No PRIME variables or ANGLE flags needed. (LOG G1.)
- **q4 halves the quality.** The extension uses q4 weights on WebGPU; with
  the new framing, SmolLM2-360M scores F1 15% on WebGPU q4 and 21% on WASM
  q4, versus 36-38% with q8. (LOG G2.)
- **q8 on WebGPU is unusable** (~28 s per request; its operators fall back
  to the CPU), and the GTX 1050 has no fp16.
- **fp32 on WebGPU keeps q8 quality and is fast:** SmolLM2-135M F1 21% on
  both, 0.66 s per request on the GPU, 1.9 s per prompt without any prefix
  cache (WASM needs its cached prefix to reach 1.6 s). (LOG G3.)
- Recommendation for the extension's WebGPU path: use fp32 (or fp16 on GPUs
  that have `shader-f16`) instead of q4, and keep WASM q8 as the default.

## What has been ruled out

| idea | result |
|---|---|
| Few-shot demonstrations as prior chat turns | SmolLM2 copies the last demo reply (always `NONE`, or the demo e-mail). |
| "Scanner, not assistant" instructions, system vs user placement | No gain on any bundled model. |
| Removing Qwen's inherited `repetition_penalty: 1.1` alone | Still F1 0 with chat prompts. |
| Output-format example in the schema; JSON extraction protocol | F1 0 on SmolLM2-360M. |
| Code-proposed candidates + yes/no classification | No discrimination (ROC AUC 0.42-0.56), though candidates cover 93% of expected passages. |
| Relaxed anchoring (keep the longest matching word run) | Recall ±0, FP rate +10-14 points. |
| Confidence gate on P(first token = NONE) | Anti-informative: removes true positives faster than false ones. |
| raw-pl tweaks: lower-case cue, two-passage demo, no instruction, `"""` delimiters, counter-example demo, two NONE demos, examples in the description | All equal or worse than `raw-pl` / `raw-pl-lang`. |

## Findings that matter for the extension

1. **Chat framing is the main problem.** All three bundled models treat the
   scan as a chat request (answer it, summarize it, recite the label list).
2. **Qwen2.5-0.5B silently runs with `repetition_penalty: 1.1`** from its
   `generation_config.json`; the engine only overrides `do_sample`.
3. **Candidate models need a newer onnxruntime-web.** LFM2.5-350M,
   LFM2-350M-Extract, Gemma 3 270M and Granite 4.0 H 350M fail on the pinned
   1.22.0-dev build; 1.24.3 loads them (with two Transformers.js 3.8.1 gaps
   worked around: external weight data in Node, `num_logits_to_keep`).
   Screening with `raw-pl` is running.
4. **Memory: collect garbage after loading.** About 1 GB of JS copies of the
   weights stays alive after Qwen2.5-0.5B loads (RSS 3.34 → 2.36 GB after a
   forced GC). Bench, lab and playground workers now GC after load.
5. **Greedy q8 outputs depend on how the prompt is split into forward passes**
   (dynamic activation quantization): judge configurations on aggregates.

## Open problems

- False positives on look-alike negatives (36-48% with the new framing).
- Qwen2.5-0.5B on the larger sets (memory permitting).
- Candidate models (screen running).
