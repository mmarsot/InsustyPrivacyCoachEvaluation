# Model research notes (2026-09-26)

Web research on the on-device model, used to pick lab hypotheses. Verified
against the Hugging Face API and the `@huggingface/transformers` 3.8.1 source
(`src/models.js`) on 2026-09-26. Notes on other models (candidates and models
the extension no longer ships) were deleted with them on 2026-10-17; git
history keeps them.

## SmolLM2-360M-Instruct

| | SmolLM2-360M-Instruct |
|---|---|
| Default system prompt injected by the template when none is given | "You are a helpful AI assistant named SmolLM, trained by Hugging Face" |
| `generation_config.json` | token ids only |
| IFEval (model card) | 41.0 |
| Known weaknesses | "primarily understand and generate content in English"; hard instruction-following data removed from the fine-tune |

Consequences for the review:

- The extension always sends its own requests, so the default persona is not
  injected, but the model is a chat-tuned "helpful assistant", which matches
  the observed failure of answering the scanned text under chat prompts.
- Its `generation_config.json` sets no penalty, so pinned greedy decoding
  (ledger item 7) changes nothing for it.

Sources: https://huggingface.co/HuggingFaceTB/SmolLM2-360M-Instruct,
https://arxiv.org/abs/2502.02737

## Few-shot and templates

- No rigorous reports of few-shot for models this small.
- Tiny models copy demonstration content: keep demo passages clearly
  different from real ones.
