/**
 * The systems the harness can score, each behind the redaction contract:
 *
 * - `insusty`: the extension's module at a git ref (`src/module/`), the
 *   system under test;
 * - `presidio`: Microsoft Presidio, a baseline only (`./presidio.ts`);
 * - `reference`: the contract's reference regex module, for smoke checks.
 */
import { referenceModule } from "../../contract/reference-module.ts";
import type { RedactionModule } from "../../contract/types.ts";
import { resolveExtRefName, resolveExtRepo } from "../ext/ref.ts";
import { loadInsustyModule, type InsustyModule, type InsustyOptions } from "../module/insusty.ts";
import { materializeModule } from "../module/materialize.ts";

export const SYSTEMS = ["insusty", "reference"] as const;
export type SystemName = (typeof SYSTEMS)[number];

/** The extension's module at a ref (`--ref`, `--ext-repo`, else the configured clone and `main`). */
export async function loadExtensionModule(o: { ref?: string; extRepo?: string; log?: (line: string) => void } & InsustyOptions = {}): Promise<InsustyModule> {
  const ref = await materializeModule(resolveExtRepo(o.extRepo), resolveExtRefName(o.ref), o.log);
  return loadInsustyModule(ref, o);
}

export async function loadSystem(name: SystemName, o: { ref?: string; extRepo?: string; log?: (line: string) => void } = {}): Promise<RedactionModule> {
  switch (name) {
    case "insusty":
      return loadExtensionModule(o);
    case "reference":
      return referenceModule();
  }
}
