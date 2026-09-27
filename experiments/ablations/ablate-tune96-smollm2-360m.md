# Ablation ablate-tune96-smollm2-360m

Leave-one-out grid of the shipped design (`npm run ablate -- --set tune96 --model smollm2-360m`),
2026-09-27, set `tune96` (96 cases), model smollm2-360m (q8), extension main@71a29e3.
Each row turns one shipped improvement off (docs/shipped-improvements.md); deltas are vs the baseline row, in points
(latency in seconds). Overlap F1 / precision / recall at passage level, FP rate = negatives with a false finding,
p50 = median review time per prompt. Lab runs: `experiments/runs/ablate-tune96-smollm2-360m.json`, `experiments/runs/ablate-tune96-smollm2-360m-no-model.json`.

| switched off | off means | F1 | ΔF1 | precision | ΔP | recall | ΔR | FP rate | ΔFP | detection | EN F1 | FR F1 | p50 s | Δp50 s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **nothing (shipped baseline)** | Extension as shipped (PR #26, #32): per-label completion, example demos, NONE last, first line, pinned greedy, plausibility filter, confidence filter 0.2, example patterns | 38.2 |  | 55.6 |  | 29.1 |  | 21.4 |  | 38.9 | 44.2 | 32.5 | 2.56 |  |
| Completion framing instead of chat | same instruction as the system message, demonstrations as prior chat turns, the model's chat template | 27.1 | −11.1 | 60.0 | +4.4 | 17.5 | −11.6 | 9.5 | −11.9 | 29.6 | 39.4 | 14.9 | 2.67 | +0.10 |
| One request per custom label | one request for all custom labels: every label listed, two demos per label answered `LABEL: passage`, multi-line answer (ref line stop), 48-token cap | 21.2 | −17.0 | 48.1 | −7.5 | 13.6 | −15.5 | 21.4 | ±0.0 | 20.4 | 29.2 | 14.3 | 3.20 | +0.64 |
| Label-example demonstrations | description only: the NONE demonstration alone (what a label without examples gets) | 17.7 | −20.5 | 100.0 | +44.4 | 9.7 | −19.4 | 0.0 | −21.4 | 14.8 | 29.1 | 6.9 | 2.27 | −0.29 |
| Language-matched demonstrations | English carrier sentences and NONE text for every prompt | 35.2 | −3.0 | 50.0 | −5.6 | 27.2 | −1.9 | 26.2 | +4.8 | 38.9 | 44.2 | 26.8 | 2.55 | −0.01 |
| NONE demonstration last | NONE demonstration first, example demonstrations last | 39.4 | +1.2 | 42.2 | −13.4 | 36.9 | +7.8 | 47.6 | +26.2 | 53.7 | 48.9 | 31.1 | 3.17 | +0.61 |
| First-line stop with a 48-token cap | no cap; the ref's line-protocol stop (blank line, NONE, repeated line), EOS or the 30 s deadline; every answer line parsed | 38.2 | ±0.0 | 55.6 | ±0.0 | 29.1 | ±0.0 | 19.0 | −2.4 | 38.9 | 44.2 | 32.5 | 2.64 | +0.07 |
| Pinned greedy decoding (repetition_penalty 1, no_repeat_ngram_size 0) | penalties from the model's generation_config.json (greedy kept; SmolLM2 ships none, Qwen2.5 ships repetition_penalty 1.1) | 38.2 | ±0.0 | 55.6 | ±0.0 | 29.1 | ±0.0 | 21.4 | ±0.0 | 38.9 | 44.2 | 32.5 | 2.53 | −0.03 |
| Basic plausibility filter | every anchored passage kept | 39.5 | +1.3 | 49.3 | −6.3 | 33.0 | +3.9 | 33.3 | +11.9 | 44.4 | 46.5 | 32.6 | 2.56 | ±0.00 |
| Example-derived patterns next to the model | the model's findings only | 29.5 | −8.7 | 47.8 | −7.8 | 21.4 | −7.7 | 21.4 | ±0.0 | 31.5 | 31.0 | 28.2 | 2.56 | ±0.00 |
| Answer-confidence filter (least likely token < 0.2 counts as NONE) | every anchored answer kept whatever its token probabilities | 39.5 | +1.3 | 47.3 | −8.3 | 34.0 | +4.9 | 38.1 | +16.7 | 48.1 | 44.2 | 35.2 | 2.37 | −0.19 |
| Overfit stop words "simple" and "terms" removed from the plausibility filter | the plausibility filter also drops passages made only of stop words and "simple"/"terms" (the PR #26 list) | 38.2 | ±0.0 | 55.6 | ±0.0 | 29.1 | ±0.0 | 21.4 | ±0.0 | 38.9 | 44.2 | 32.5 | 2.56 | ±0.00 |
| SmolLM2-360M default, SmolLM2-135M removed | baseline on SmolLM2-135M, the previous default | 26.9 | −11.3 | 43.9 | −11.7 | 19.4 | −9.7 | 31.0 | +9.6 | 27.8 | 32.9 | 20.0 | 1.43 | −1.13 |
