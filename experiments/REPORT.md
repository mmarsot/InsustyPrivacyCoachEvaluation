# Local SLM review: best configuration so far

Status: **in progress** (updated after every experiment; evidence and run
names in [LOG.md](LOG.md), model research in [RESEARCH.md](RESEARCH.md)).
All numbers are from the 32-case dev iteration set (`experiments/sets/iter32.json`,
22 positive / 10 negative, 16 EN / 16 FR) unless noted, extension `main` @ dc91f36.

## Baseline: the extension as shipped

| model | F1 (overlap) | precision | recall | case detection | FP rate on negatives | format OK | p50 latency |
|---|---|---|---|---|---|---|---|
| SmolLM2-135M (default) | 5% | 33% | 3% | 5% | 10% | 34% | 5.6 s |
| SmolLM2-360M | 19% | 36% | 13% | 18% | 30% | 28% | 9.1 s |
| Qwen2.5-0.5B | running | | | | | | |

The shipped default model finds almost nothing: it recites the label list
back (22 of 32 cases) instead of scanning the text.

## What has been ruled out

| idea | result |
|---|---|
| Few-shot demonstrations as prior chat turns | Harmful on SmolLM2: it copies the last demo reply (always `NONE`, or the demo e-mail). |
| "Scanner, not assistant" instruction (`strict`, `v4`) | No gain on SmolLM2-135M/360M. |
| Output-format example in the schema | SmolLM2-360M imitates it as prose (F1 0). |
| JSON extraction protocol (LFM2-Extract style) | SmolLM2-360M F1 0. |
| Code-proposed candidates + yes/no classification by the model | The models cannot discriminate (ROC AUC 0.42-0.56 on SmolLM2-360M and LFM2.5-350M), even though candidates cover 93% of expected passages. |
| Relaxed anchoring (keep the longest matching word run) | +0-3 recall points, +10 FP-rate points in 3 of 8 rows. |

## Findings that matter for the extension

1. **Qwen2.5-0.5B silently runs with `repetition_penalty: 1.1`.** The engine
   only overrides `do_sample`; Transformers.js merges the rest of the model's
   `generation_config.json`. The penalty applies to the scanned text too, so it
   discourages copying passages verbatim. (Measured in E5.)
2. **The label list looks like the expected output.** `- LABEL: description`
   lines are recited back as if they were findings. Changing the layout to
   `* LABEL means description` raised SmolLM2-135M from F1 5 to 27 (small n).
3. **Candidate models need a newer onnxruntime-web.** LFM2.5-350M,
   LFM2-350M-Extract, Gemma 3 270M and Granite 4.0 H 350M fail to load on the
   pinned 1.22.0-dev build; 1.24.3 loads them (with two Transformers.js 3.8.1
   gaps worked around: external weight data in Node and `num_logits_to_keep`).
4. **Memory: collect garbage after loading.** About 1 GB of JS copies of the
   weights stays alive after Qwen2.5-0.5B loads (RSS 3.34 GB, 2.36 GB after a
   forced GC). The bench and lab workers now GC after load; a browser worker
   could release its references to the fetched model buffer right after
   session creation.
5. **Greedy q8 outputs depend on how the prompt is split into forward passes**
   (dynamic activation quantization), so single-case comparisons are noisy;
   judge configurations on aggregates.

## Best so far

Not determined yet: SmolLM2-360M `ref` (F1 19) is the best measured
combination until the Qwen2.5-0.5B and per-label runs finish.
