/**
 * Named lab configurations. Each is the shipped `ref` configuration plus
 * overrides, so its name states the hypothesis. Results for each are logged
 * in experiments/LOG.md; never edit a configuration that the log cites,
 * add a new one instead (results are cached by rendered prompt, so an edit
 * silently changes what a name means).
 */
import { REF_CONFIG, withOverrides, type LabConfig } from "./config.ts";

const defs: LabConfig[] = [REF_CONFIG];
const add = (base: string, id: string, note: string, overrides: Partial<LabConfig>) => {
  const from = defs.find((d) => d.id === base);
  if (!from) throw new Error(`unknown base config ${base}`);
  defs.push(withOverrides(from, id, { note, ...overrides }));
};

// --- generation settings
add("ref", "rp1", "No repetition penalty (Qwen2.5 inherits 1.1 from generation_config)", { repetitionPenalty: 1 });
add("ref", "cap64", "Token cap 64", { maxNewTokens: 64 });

// --- instruction content
add("ref", "strict", "Strict 'scanner, not assistant' instruction", { instruction: "@strict" });
add("ref", "nobuiltin", "Do not list the deterministic labels", { builtinLabels: false });

// --- few-shot as prior chat turns
add("ref", "shots-generic", "Few-shot: clean text -> NONE, email -> EMAIL line", { shots: ["none-clean", "builtin-email"] });
add("ref", "shots-labelex", "Few-shot: one shot per custom label from its examples, plus a NONE shot", { shots: ["labelex", "none-clean"] });

export const LAB_CONFIGS: Record<string, LabConfig> = Object.fromEntries(defs.map((d) => [d.id, d]));
