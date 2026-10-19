/**
 * Runs the contract's conformance cases (`contract/conformance.ts`) on a
 * module, and checks it against its manifest: by default the extension's
 * module (insusty-privacy) at a ref.
 *
 *   npm run conformance -- [--module insusty-privacy|presidio|reference] [--ref main] [--ext-repo <path>]
 *
 * `--system` is accepted for `--module` (and `insusty` for insusty-privacy).
 * Exits 1 when any case fails or the module offers more than its manifest
 * declares.
 */
import { checkConformance } from "../../contract/conformance.ts";
import { manifestIssues } from "../module.ts";
import {
  loadModule,
  readModuleManifest,
  REFERENCE_MODULE,
  resolveModuleId,
} from "../registry.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
let id: string;
try {
  id = resolveModuleId(opt("module") ?? opt("system") ?? "insusty-privacy");
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
const module = await loadModule(id, {
  ref: opt("ref"),
  extRepo: opt("ext-repo"),
});
console.log(
  `${module.info.name} ${module.info.version} implements contract ${module.contract}; builtins ${module.capabilities.builtins.join(", ")}; documents ${module.capabilities.documents}; Private AI ${module.capabilities.privateAi.join(", ") || "none"}`,
);
const results = await checkConformance(module);
for (const r of results)
  console.log(
    `${r.problems.length ? "FAIL" : "ok  "} ${r.case}${r.problems.map((p) => `\n       ${p}`).join("")}`,
  );
let manifestErrors = 0;
if (id !== REFERENCE_MODULE) {
  const { errors, warnings } = manifestIssues(module, readModuleManifest(id));
  for (const e of errors) console.log(`FAIL manifest: ${e}`);
  for (const w of warnings) console.log(`warn manifest: ${w}`);
  if (!errors.length) console.log("ok   manifest matches the module");
  manifestErrors = errors.length;
}
await module.dispose?.();
process.exit(results.some((r) => r.problems.length) || manifestErrors ? 1 : 0);
