# Ablation ablate-tune96-smollm2-360m

Leave-one-out grid of the shipped design (`npm run ablate -- --set tune96 --model smollm2-360m`),
2026-09-27, set `tune96` (96 cases), model smollm2-360m (q8), extension main@b2c4ca1.
Each row turns one shipped improvement off (docs/shipped-improvements.md); deltas are vs the baseline row, in points
(latency in seconds). Overlap F1 / precision / recall at passage level, FP rate = negatives with a false finding,
p50 = median review time per prompt. Lab runs: `experiments/runs/ablate-tune96-smollm2-360m.json`, `experiments/runs/ablate-tune96-smollm2-360m-no-model.json`.

| switched off | off means | F1 | ΔF1 | precision | ΔP | recall | ΔR | FP rate | ΔFP | detection | EN F1 | FR F1 | p50 s | Δp50 s |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| **nothing (shipped baseline)** | Extension as shipped (PR #26): per-label completion, example demos, NONE last, first line, pinned greedy, plausibility filter | 32.1 |  | 41.5 |  | 26.2 |  | 35.7 |  | 40.7 | 32.9 | 31.5 | 2.37 |  |
| Completion framing instead of chat | same instruction as the system message, demonstrations as prior chat turns, the model's chat template | 16.7 | −15.4 | 37.9 | −3.6 | 10.7 | −15.5 | 14.3 | −21.4 | 20.4 | 23.0 | 11.3 | 2.29 | −0.08 |
| One request per custom label | one request for all custom labels: every label listed, two demos per label answered `LABEL: passage`, multi-line answer (ref line stop), 48-token cap | 9.0 | −23.1 | 20.0 | −21.5 | 5.8 | −20.4 | 33.3 | −2.4 | 9.3 | 9.4 | 8.6 | 2.14 | −0.23 |
| Label-example demonstrations | description only: the NONE demonstration alone (what a label without examples gets) | 1.9 | −30.2 | 100.0 | +58.5 | 1.0 | −25.2 | 0.0 | −35.7 | 1.9 | 4.2 | – | 1.78 | −0.59 |
| Language-matched demonstrations | English carrier sentences and NONE text for every prompt | 27.2 | −4.9 | 34.8 | −6.7 | 22.3 | −3.9 | 42.9 | +7.2 | 37.0 | 32.9 | 22.2 | 2.42 | +0.05 |
| NONE demonstration last | NONE demonstration first, example demonstrations last | 36.8 | +4.7 | 32.3 | −9.2 | 42.7 | +16.5 | 71.4 | +35.7 | 57.4 | 41.5 | 32.5 | 2.79 | +0.42 |
| First-line stop with a 48-token cap | no cap; the ref's line-protocol stop (blank line, NONE, repeated line), EOS or the 30 s deadline; every answer line parsed | 31.1 | −1.0 | 40.6 | −0.9 | 25.2 | −1.0 | 33.3 | −2.4 | 38.9 | 32.9 | 29.5 | 2.38 | +0.01 |
| Pinned greedy decoding (repetition_penalty 1, no_repeat_ngram_size 0) | penalties from the model's generation_config.json (greedy kept; SmolLM2 ships none, Qwen2.5 ships repetition_penalty 1.1) | 32.1 | ±0.0 | 41.5 | ±0.0 | 26.2 | ±0.0 | 35.7 | ±0.0 | 40.7 | 32.9 | 31.5 | 3.08 | +0.71 |
| Basic plausibility filter | every anchored passage kept | 33.0 | +0.9 | 36.6 | −4.9 | 30.1 | +3.9 | 47.6 | +11.9 | 46.3 | 34.9 | 31.3 | 2.37 | ±0.00 |
| SmolLM2-360M default, SmolLM2-135M removed | baseline on SmolLM2-135M, the previous default | 23.1 | −9.0 | 28.6 | −12.9 | 19.4 | −6.8 | 47.6 | +11.9 | 31.5 | 26.6 | 19.3 | 1.19 | −1.18 |
