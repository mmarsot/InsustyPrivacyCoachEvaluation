/**
 * Parity check: runs the ref's own SlmEngine + reviewPrompt (like the bench
 * worker) on a few cases and compares raw outputs with the lab's `ref`
 * configuration results in experiments/runs/<run>.json.
 *
 *   npx tsx src/lab/parity.ts <model id> <run name> <case id>...
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileDataset } from "../dataset/load.ts";
import { loadExtApi, materializeExtRef, resolveExtRefName, resolveExtRepo, type ModelClientLike } from "../ext/ref.ts";
import { ROOT } from "../paths.ts";
import { rulesFor } from "../run/jobs.ts";
import { disposeModels, nodeWasmLoader } from "../run/transformers-loader.ts";

const [model, run, ...ids] = process.argv.slice(2);
const lab = JSON.parse(readFileSync(join(ROOT, "experiments", "runs", `${run}.json`), "utf8")) as { cases: Array<{ config: string; caseId: string; output: string }> };
const { dataset } = compileDataset({ requireSplit: true });
const ext = await materializeExtRef(resolveExtRepo(), resolveExtRefName());
const api = await loadExtApi(ext.bundle);
const engine = new api.SlmEngine(nodeWasmLoader);
const selection = { backend: "wasm" as const, quantization: "auto" as const };
let same = 0;
for (const id of ids) {
  const c = dataset!.cases.find((x) => x.id === id)!;
  const rules = rulesFor(dataset!.profiles.find((p) => p.id === c.profile)!, "desc");
  let output = "";
  const client: ModelClientLike = {
    async review(request) {
      const r = await engine.review(model!, selection, request, api.generationBudgetMs);
      output = r.output;
      return r;
    },
  };
  await api.runReview(c.text, api.defaultPrompt, client, rules, model!, selection).catch(() => undefined);
  const mine = lab.cases.find((x) => x.config === "ref" && x.caseId === id)?.output ?? "<missing>";
  const ok = mine === output.slice(0, 300);
  same += ok ? 1 : 0;
  console.log(`${ok ? "SAME" : "DIFF"} ${id}\n  engine: ${JSON.stringify(output.slice(0, 200))}\n  lab:    ${JSON.stringify(mine.slice(0, 200))}`);
}
console.log(`${same}/${ids.length} identical`);
await disposeModels();
