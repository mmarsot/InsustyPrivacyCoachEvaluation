/**
 * The presidio module's entry: Microsoft Presidio as a baseline behind the
 * redaction contract (`presidio.ts`), in a pinned local Python environment
 * created on first use. It has one configuration (`manifest.json`).
 */
import type { ModuleAdapter, ModuleManifest } from "../../engine/module.ts";
import manifest from "./manifest.json" with { type: "json" };
import { presidioModule } from "./presidio.ts";

export default {
  manifest: manifest as ModuleManifest,
  load: ({ log }) => presidioModule(log),
} satisfies ModuleAdapter;
