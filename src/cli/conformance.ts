/**
 * Runs the contract's conformance cases (`contract/conformance.ts`) on a
 * system: by default the extension's module at a ref.
 *
 *   npm run conformance -- [--system insusty|reference] [--ref main] [--ext-repo <path>]
 *
 * Exits 1 when any case fails.
 */
import { checkConformance } from "../../contract/conformance.ts";
import { loadSystem, SYSTEMS, type SystemName } from "../systems/index.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const name = (opt("system") ?? "insusty") as SystemName;
if (!SYSTEMS.includes(name)) {
  console.error(`--system must be one of ${SYSTEMS.join(", ")}`);
  process.exit(2);
}
const module = await loadSystem(name, { ref: opt("ref"), extRepo: opt("ext-repo") });
console.log(`${module.info.name} ${module.info.version} implements contract ${module.contract}; builtins ${module.capabilities.builtins.join(", ")}; documents ${module.capabilities.documents}; Private AI ${module.capabilities.privateAi.join(", ") || "none"}`);
const results = await checkConformance(module);
for (const r of results) console.log(`${r.problems.length ? "FAIL" : "ok  "} ${r.case}${r.problems.map((p) => `\n       ${p}`).join("")}`);
await module.dispose?.();
process.exit(results.some((r) => r.problems.length) ? 1 : 0);
