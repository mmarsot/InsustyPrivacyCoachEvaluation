/**
 * The insusty-privacy module's entry: the extension's redaction package at
 * any git ref (resolved in the clone of `bench.local.json`,
 * `INSUSTY_EXT_REPO` or `--ext-repo`; `main` by default), installed by
 * `materialize.ts` and loaded by `insusty.ts`, with the Node WASM loader as
 * its on-device runtime (started only when a model is used). Its
 * configurations (rules, every label, the on-device and connected models)
 * are in `manifest.json`.
 */
import type { ModuleAdapter, ModuleManifest } from "../../engine/module.ts";
import { loadInsustyModule } from "./insusty.ts";
import manifest from "./manifest.json" with { type: "json" };
import { materializeModule } from "./materialize.ts";
import { resolveExtRefName, resolveExtRepo } from "./ref.ts";

export default {
  manifest: manifest as ModuleManifest,
  async load({ ref, extRepo, log }) {
    return loadInsustyModule(
      await materializeModule(
        resolveExtRepo(extRepo),
        resolveExtRefName(ref),
        log,
      ),
      {
        device: async () => {
          const { nodeWasmLoader, disposeModels, WASM_THREADS } =
            await import("./runtime/transformers-loader.ts");
          return {
            loader: nodeWasmLoader,
            threads: WASM_THREADS,
            dispose: disposeModels,
          };
        },
      },
    );
  },
} satisfies ModuleAdapter;
