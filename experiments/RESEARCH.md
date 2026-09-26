# Model research notes (2026-09-26)

Web research on the bundled models and on candidate replacements, used to pick
lab hypotheses. Verified against the Hugging Face API and the
`@huggingface/transformers` 3.8.1 source (`src/models.js`) on 2026-09-26.

## Bundled models

| | SmolLM2-135M / 360M-Instruct | Qwen2.5-0.5B-Instruct |
|---|---|---|
| Default system prompt injected by the template when none is given | "You are a helpful AI assistant named SmolLM, trained by Hugging Face" | "You are Qwen, created by Alibaba Cloud. You are a helpful assistant." |
| `generation_config.json` | token ids only | `do_sample`, temperature 0.7, top_p 0.8, top_k 20, **repetition_penalty 1.1** |
| IFEval (model cards) | 135M: 29.9, 360M: 41.0 | 31.6 |
| Known weaknesses | "primarily understand and generate content in English"; hard instruction-following data removed from the 135M/360M fine-tune | weak instruction following at this size; multilingual (French listed) |

Consequences for the review:

- The extension always sends its own system message, so the default personas
  are not injected, but both models are chat-tuned "helpful assistants", which
  matches the observed failure of answering the scanned text.
- The extension overrides only `do_sample: false`; Transformers.js merges the
  rest of `generation_config.json`, so **Qwen2.5 runs with repetition_penalty
  1.1**. That penalty applies to every token already in the sequence,
  including the scanned text, so it pushes the model away from copying
  passages verbatim. Lab hypothesis `rp1`.

Sources: https://huggingface.co/HuggingFaceTB/SmolLM2-135M-Instruct,
https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct,
https://huggingface.co/Qwen/Qwen2.5-0.5B-Instruct/blob/main/generation_config.json,
https://arxiv.org/abs/2502.02737

## Candidates that load on transformers.js 3.8.1

Ranked by promise for this task (CPU WASM, peak RSS well under ~3.5 GB). Sizes
are ONNX weights (external `.onnx_data` included). Details in
`models/candidates.json`.

1. **LFM2.5-350M** (`onnx-community/LFM2.5-350M-ONNX`, type `lfm2`, since
   3.7.0). q8 510 MB, q4 294 MB. IFEval 77.0, the best of all candidates;
   the card recommends it "for data extraction, structured outputs". French
   supported. LFM Open License (check before bundling). No default system
   prompt. Suggested sampling: temperature 0.1, repetition_penalty 1.05.
   https://huggingface.co/LiquidAI/LFM2.5-350M
2. **LFM2-350M-Extract** (`onnx-community/LFM2-350M-Extract-ONNX`). q8
   387 MB. Fine-tuned for extraction into JSON/XML/YAML following a schema
   given in the system prompt; greedy decoding recommended; single-turn only.
   https://huggingface.co/LiquidAI/LFM2-350M-Extract
3. **LFM2.5-230M** (`LiquidAI/LFM2.5-230M-ONNX`). IFEval 71.7. Has q4
   (211 MB) and `model_q8` but no `model_quantized.onnx`, so q8 needs a file
   name override in Transformers.js.
4. **Gemma 3 270M-it** (`onnx-community/gemma-3-270m-it-ONNX`, `gemma3_text`).
   q8 545 MB, q4 323 MB. 170M of its 270M parameters are embeddings. No system
   role (merged into the first user turn). Meant mainly for fine-tuning.
5. **Granite 4.0 H 350M** (`onnx-community/granite-4.0-h-350m-ONNX`,
   `granitemoehybrid`). q8 473 MB. Apache-2.0, French supported, IBM lists
   text extraction. Injects its own default system prompt if none is given.
6. **Qwen3-0.6B** (`onnx-community/Qwen3-0.6B-ONNX`). q8 618 MB, likely too
   heavy here. Thinking must be disabled with the `enable_thinking: false`
   template variable. (Avoid `onnx-community/Qwen3-0.6B-Instruct-ONNX`, a fork
   with thinking on by default.)
7. **NuExtract-1.5-tiny** (Qwen2.5-0.5B extraction fine-tune, custom prompt
   format, same memory as Qwen2.5-0.5B) and **Baguettotron** (321M, French,
   but a reasoning model with 80 layers: slow on WASM): low priority.

Not viable on 3.8.1 or on this machine: Falcon-H1-Tiny (`falcon_h1`, v4 only),
Qwen3.5-0.8B (v4 only), Gemma 3 1B, Granite 4.0 H 1B, LFM2-1.2B (too big),
MobileLLM-R1 (math/code, non-commercial), SmolLM3 (3B).

## Few-shot and templates

- No rigorous reports of few-shot for these exact tiny models. Liquid's cards
  put format and examples in the system prompt; LFM2-Extract is single-turn.
- Tiny models copy demonstration content: keep demo passages clearly
  different from real ones.
- Gemma 3: strict user/model alternation, no system role.
- Qwen3: pass `enable_thinking: false` to the chat template.
