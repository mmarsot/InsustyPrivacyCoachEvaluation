import type { ModuleConfig, RedactionModule } from "../../contract/types.ts";
import { allLabelsConfig } from "../module/insusty.ts";

/** The deterministic track's configurations: the module's default, and every built-in label on; Private AI off in both. */
export function deterministicConfigs(
  module: RedactionModule,
): Record<string, ModuleConfig> {
  const off = { runsOn: "off" as const };
  return {
    default: { ...module.defaultConfig(), privateAi: off },
    all: { ...allLabelsConfig(module), privateAi: off },
  };
}
