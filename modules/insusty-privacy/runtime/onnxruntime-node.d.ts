/**
 * `onnxruntime-node` is `onnxruntime-web` here (the alias in `package.json`).
 * It ships its types, but its package `exports` hide them from NodeNext
 * resolution, so the bench declares the part it imports, as the extension
 * does (`src/private-ai/on-device/onnxruntime-web.d.ts`): what the ref's
 * span runtime reads, and the WASM settings `span-environment.ts` applies.
 */
declare module "onnxruntime-node" {
  import type { SpanEnvironment } from "insusty-prompt-coach/redaction";

  export const Tensor: SpanEnvironment["ort"]["Tensor"];
  export const InferenceSession: SpanEnvironment["ort"]["InferenceSession"];
  export const env: {
    wasm: { wasmPaths?: string; numThreads?: number };
  };
}
