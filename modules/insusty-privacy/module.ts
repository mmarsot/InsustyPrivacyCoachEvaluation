/**
 * The insusty-privacy module's entry: the extension's redaction module at any
 * git ref of the clone (`bench.local.json`, `INSUSTY_EXT_REPO` or
 * `--ext-repo`; `main` by default), materialized read-only by
 * `materialize.ts` and adapted to the redaction contract by `insusty.ts`.
 * Its configurations (rules, every label, the on-device and connected
 * models) are in `manifest.json`.
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
    );
  },
} satisfies ModuleAdapter;
