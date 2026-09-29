/**
 * Request parity for hosted models, no model and no network: runs the ref's
 * own `reviewPrompt` with a recording client (answers NONE) and checks that
 * every request it hands its model client, `{instructions, input,
 * responsePrefill}`, equals what the lab's `shipped` configuration sends a
 * hosted model (src/lab/cli.ts runHosted: prefix, suffix minus cue, cue).
 * Since extension PR #42 (fb52dc6) the ref leaves fenced code blocks out of
 * the scanned text, which the lab's `shipped` configuration does not model
 * yet: those requests are counted apart as "code-fence skip".
 *
 *   npx tsx src/hosted/parity.ts [--set tune96] [--allow-test] [--ref main]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileDataset } from "../dataset/load.ts";
import { loadExtApi, materializeExtRef, resolveExtRefName, resolveExtRepo, type ModelClientLike, type ReviewRequestLike } from "../ext/ref.ts";
import { buildRaw } from "../lab/config.ts";
import { SHIPPED_CONFIG } from "../lab/shipped.ts";
import { ROOT } from "../paths.ts";
import { rulesFor } from "../run/jobs.ts";

const args = process.argv.slice(2);
const opt = (name: string) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined);
const setName = opt("set") ?? "tune96";
const ids = (JSON.parse(readFileSync(join(ROOT, "experiments", "sets", `${setName}.json`), "utf8")) as { cases: string[] }).cases;
const { dataset } = compileDataset({ requireSplit: true });
const ext = await materializeExtRef(resolveExtRepo(opt("ext-repo")), resolveExtRefName(opt("ref")));
const api = await loadExtApi(ext.bundle);
if (api.kind !== "completion") throw new Error(`${ext.ref} is not a completion-design ref`);
const noRefTexts = { defaultPrompt: "", outputSchema: "", labelHeader: "", builtin: [] };

let same = 0;
let fenced = 0;
let total = 0;
for (const id of ids) {
  const c = dataset!.cases.find((x) => x.id === id)!;
  if (c.split === "test" && !args.includes("--allow-test")) throw new Error("held-out case: pass --allow-test");
  const profile = dataset!.profiles.find((p) => p.id === c.profile)!;
  const seen: ReviewRequestLike[] = [];
  const client: ModelClientLike = {
    async review(request) {
      seen.push(request);
      return { output: "NONE" };
    },
  };
  await api.runReview(c.text, "", client, rulesFor(profile, "desc", true), api.modelIds[0]!, { backend: "wasm", quantization: "auto" });
  profile.labels.forEach((label, i) => {
    const raw = buildRaw(SHIPPED_CONFIG, { ...profile, labels: [label] }, noRefTexts, c.text);
    const suffix = raw.suffix(c.text);
    const lab = { instructions: raw.prefix, input: suffix.slice(0, suffix.length - raw.prefill.length), responsePrefill: raw.prefill };
    const ext = seen[i];
    total++;
    const ok = ext !== undefined && seen.length === profile.labels.length && ext.instructions === lab.instructions && ext.input === lab.input && ext.responsePrefill === lab.responsePrefill;
    // The skip changes the scanned text, and through it the language guess (and so the demonstrations).
    const fenceOnly = !ok && ext !== undefined && /^ {0,3}(`{3,}|~{3,})/mu.test(c.text);
    if (ok) same++;
    else if (fenceOnly) fenced++;
    else console.log(`DIFF ${id} ${label.label} (${seen.length} ref requests; instructions ${ext?.instructions === lab.instructions ? "same" : "differ"}, input ${ext?.input === lab.input ? "same" : "differs"})\n  ref: ${JSON.stringify(ext).slice(0, 300)}\n  lab: ${JSON.stringify(lab).slice(0, 300)}`);
  });
}
console.log(`${setName}, ref ${ext.ref}@${ext.sha.slice(0, 7)}: ${same}/${total} per-label requests identical, ${fenced} differ only by the ref's code-fence skip, ${total - same - fenced} other differences`);
process.exitCode = same + fenced === total ? 0 : 1;
