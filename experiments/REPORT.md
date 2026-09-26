# Local SLM review: best configuration so far

Status: **in progress** (updated after every experiment; evidence and run
names in [LOG.md](LOG.md), model research in [RESEARCH.md](RESEARCH.md)).
Numbers are from the 32-case dev iteration set (`experiments/sets/iter32.json`,
22 positive / 10 negative, 16 EN / 16 FR) unless noted, extension `main` @
dc91f36, q8 on onnxruntime-web WASM (4 threads), greedy decoding. With 32
cases, differences under about 8 F1 points are noise.

## Baseline: the extension as shipped (`ref`)

| model | F1 (overlap) | precision | recall | case detection | FP rate on negatives | format OK | p50 latency | main failure |
|---|---|---|---|---|---|---|---|---|
| SmolLM2-135M (default) | 5% | 33% | 3% | 5% | 10% | 34% | 5.6 s | recites the label list (22/32) |
| SmolLM2-360M | 19% | 36% | 13% | 18% | 30% | 28% | 9.1 s | lists topics, recites labels, loops |
| Qwen2.5-0.5B | 0% | – | 0% | 0% | 0% | 0% | 8.0 s | writes analysis bullets / answers the text (23/32) |

## Best so far: `raw-pl` (completion framing, one pass per label, demonstrations)

| model | F1 | precision | recall | detection | FP rate | format OK | p50 | EN F1 | FR F1 |
|---|---|---|---|---|---|---|---|---|---|
| SmolLM2-135M | **30%** (was 5) | 30% | 29% | 41% | 80% | 100% | 1.6 s | 39% | 14% |
| **SmolLM2-360M** | **38%** (was 19) | 37% | 39% | 36% | 40% | 100% | 2.3 s | 51% | 20% |
| Qwen2.5-0.5B | **36%** (was 0) | 42% | 32% | 36% | 30% | 100% | 4.4 s | 55% | 14% |

Best combination today: **SmolLM2-360M + `raw-pl`** (Qwen2.5-0.5B is on par
in F1, better in precision and English, twice as slow and 3 GB of RAM).
Confirmation on a disjoint 48-case dev set is running (`c1-confirm48`).

What `raw-pl` changes, for each custom label (definition in
`src/lab/configs.ts`):

1. **No chat template.** The request is plain text that the model continues:

   ```
   Copy the CLIENT_NAME passages from each text, exactly as written. CLIENT_NAME: <description> Write NONE when the text has none.

   Text: Quick update before the call: <example 1> is still on the list for next week, can you tidy up this paragraph?
   CLIENT_NAME: <example 1>

   Text: Petit point avant la réunion : on reparle de <example 2> jeudi, tu peux reformuler ce message ?
   CLIENT_NAME: <example 2>

   Text: Can you rewrite this so it sounds friendlier? Thanks for your patience, we will get back to you shortly.
   CLIENT_NAME: NONE

   Text: <the user's prompt>
   CLIENT_NAME:
   ```

2. **One request per custom label**, each with a reusable prefix (instruction
   and demonstrations are prefilled once and cached, like today's instruction
   prefix). The label is attached by code; built-in labels are left to the
   deterministic detector.
3. **One-line answers**: stop at the first line break, 48-token cap. Each line
   is anchored with the existing parser (exact or case-insensitive match).
4. **Demonstrations come from the label's examples**, so each custom label
   needs 1-3 user-provided examples. Without them F1 falls to 5%.
5. **The last demonstration is a `NONE`**: ending on a positive makes the model
   always answer (FP rate 100%).

## What has been ruled out

| idea | result |
|---|---|
| Few-shot demonstrations as prior chat turns | SmolLM2 copies the last demo reply (always `NONE`, or the demo e-mail). |
| "Scanner, not assistant" instructions (`strict`, `v4`), system vs user placement | No gain on any bundled model. |
| Removing Qwen's inherited `repetition_penalty: 1.1` alone | Still F1 0 with chat prompts. |
| Output-format example in the schema; JSON extraction protocol | F1 0 on SmolLM2-360M. |
| Code-proposed candidates + yes/no classification by the model | No discrimination (ROC AUC 0.42-0.56), although candidates cover 93% of expected passages. |
| Relaxed anchoring (keep the longest matching word run) | +0-3 recall points for +10 FP-rate points. |
| `raw-pl` tweaks: lower-case cue, two-passage demo, no instruction line, `"""` delimiters | All worse than `raw-pl` on SmolLM2-360M. |

## Findings that matter for the extension

1. **Chat framing is the main problem.** All three models treat the scan as a
   chat request (answer it, summarize it, recite the label list). Completion
   framing with demonstrations fixes format compliance (100%) and cuts latency
   2-4x.
2. **Qwen2.5-0.5B silently runs with `repetition_penalty: 1.1`** from its
   `generation_config.json` (the engine only overrides `do_sample`); it
   penalizes copying passages. Worth pinning explicitly whatever the prompt.
3. **Candidate models need a newer onnxruntime-web.** LFM2.5-350M,
   LFM2-350M-Extract, Gemma 3 270M and Granite 4.0 H 350M fail on the pinned
   1.22.0-dev build; 1.24.3 loads them (plus two Transformers.js 3.8.1 gaps
   worked around in the lab: external weight data in Node, `num_logits_to_keep`).
   LFM2.5-350M under the shipped prompt: F1 13, p50 17 s; `raw-pl` not yet run.
4. **Memory: collect garbage after loading.** About 1 GB of JS copies of the
   weights stays alive after Qwen2.5-0.5B loads (RSS 3.34 GB → 2.36 GB after a
   forced GC). Bench, lab and playground workers now GC after load.
5. **Greedy q8 outputs depend on how the prompt is split into forward passes**
   (dynamic activation quantization), so judge on aggregates, not single cases.

## Open problems and next steps

- French: F1 14-20 vs 39-55 in English for every model.
- False positives on negatives: 30-80% with `raw-pl`.
- Run `raw-pl` on the candidates that load on onnxruntime-web 1.24.3
  (LFM2.5-350M, Gemma 3 270M, Granite 4.0 H 350M).
- Confirm the winner on the 48-case confirmation set (running).
