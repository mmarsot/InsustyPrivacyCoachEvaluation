/**
 * Classification lab worker: loads ONE model and, for each case prefix
 * (instructions + the text), prefills it once, then scores each
 * (candidate, label) question with a single forward pass: the probability of
 * a "yes" answer versus "no" at the first reply token. No text is generated.
 *
 * Usage (spawned by src/lab/classify-cli.ts): node --import tsx src/lab/classify-worker.ts <spec.json>
 */
import { appendFileSync, readFileSync } from "node:fs";
import { register } from "node:module";
import type { PreTrainedModel, Tensor } from "@huggingface/transformers";

if (process.env.LAB_ORT === "next") register(new URL("./ort-next-hooks.mjs", import.meta.url));
const { ones, Tensor: TensorClass } = await import("@huggingface/transformers");
const { idsTensor, loadPretrained } = await import("../run/transformers-loader.ts");

export interface ClsJob {
  key: string;
  suffix: string;
}
export interface ClsGroup {
  key: string;
  caseId: string;
  prefix: string;
  jobs: ClsJob[];
}
export interface ClsWorkerSpec {
  model: string;
  dtype: string;
  resultFile: string;
  groups: ClsGroup[];
  yes: string[];
  no: string[];
}
export interface ClsRecord {
  key: string;
  kind: "prefix" | "question";
  caseId: string;
  ms: number;
  tokens: number;
  /** P(yes) / (P(yes) + P(no)) at the first reply token. */
  pYes?: number;
  /** P(yes) + P(no): how much of the distribution is a yes/no answer at all. */
  pAnswer?: number;
  top?: string;
  at: string;
}
export type ClsEvent =
  | { type: "loaded"; loadMs: number }
  | { type: "case"; caseId: string; done: number; total: number; ms: number }
  | { type: "done"; maxRssMb: number }
  | { type: "fatal"; error: string };

const emit = (e: ClsEvent) => process.stdout.write(`@@${JSON.stringify(e)}\n`);

async function main() {
  const spec = JSON.parse(readFileSync(process.argv[2] ?? "", "utf8")) as ClsWorkerSpec;
  const t0 = performance.now();
  const { tokenizer, model } = await loadPretrained(spec.model, spec.dtype as "q8");
  const session = (model as unknown as { sessions: Record<string, { inputNames: string[] }> }).sessions.model;
  const needsKeep = Boolean(session?.inputNames.includes("num_logits_to_keep"));
  const forward = (ids: number[], total: number, pkv?: unknown) =>
    model.forward({
      input_ids: idsTensor(ids),
      attention_mask: ones([1, total]),
      ...(pkv === undefined ? {} : { past_key_values: pkv }),
      ...(needsKeep ? { num_logits_to_keep: new TensorClass("int64", BigInt64Array.from([1n]), []) } : {}),
    }) as Promise<{ logits: Tensor } & Record<string, unknown>>;
  const encode = (text: string) => tokenizer.encode(text, { add_special_tokens: false });
  const firstIds = (words: string[]) => [...new Set(words.map((w) => encode(w)[0]).filter((id): id is number => id !== undefined))];
  const yesIds = firstIds(spec.yes);
  const noIds = firstIds(spec.no).filter((id) => !yesIds.includes(id));
  emit({ type: "loaded", loadMs: Math.round(performance.now() - t0) });

  let done = 0;
  for (const group of spec.groups) {
    const c0 = performance.now();
    const prefixIds = encode(group.prefix);
    const out = await forward(prefixIds, prefixIds.length);
    const pkv = (model as unknown as { getPastKeyValues(o: unknown, p: null): unknown }).getPastKeyValues(out, null);
    const at = () => new Date().toISOString();
    appendFileSync(spec.resultFile, JSON.stringify({ key: group.key, kind: "prefix", caseId: group.caseId, ms: Math.round(performance.now() - c0), tokens: prefixIds.length, at: at() } satisfies ClsRecord) + "\n");
    for (const job of group.jobs) {
      const q0 = performance.now();
      const ids = encode(job.suffix);
      const { logits } = await forward(ids, prefixIds.length + ids.length, pkv);
      const [, seq, vocab] = logits.dims as [number, number, number];
      const row = (logits.data as Float32Array).subarray((seq - 1) * vocab, seq * vocab);
      let max = -Infinity;
      let arg = 0;
      for (let i = 0; i < vocab; i++) if (row[i]! > max) (max = row[i]!), (arg = i);
      let z = 0;
      for (let i = 0; i < vocab; i++) z += Math.exp(row[i]! - max);
      const p = (id: number) => Math.exp(row[id]! - max) / z;
      const py = yesIds.reduce((a, id) => a + p(id), 0);
      const pn = noIds.reduce((a, id) => a + p(id), 0);
      const record: ClsRecord = {
        key: job.key,
        kind: "question",
        caseId: group.caseId,
        ms: Math.round(performance.now() - q0),
        tokens: ids.length,
        pYes: py + pn > 0 ? py / (py + pn) : 0,
        pAnswer: py + pn,
        top: tokenizer.decode([arg]),
        at: at(),
      };
      appendFileSync(spec.resultFile, JSON.stringify(record) + "\n");
    }
    done++;
    emit({ type: "case", caseId: group.caseId, done, total: spec.groups.length, ms: Math.round(performance.now() - c0) });
  }
  await model.dispose();
  emit({ type: "done", maxRssMb: Math.round(process.resourceUsage().maxRSS / 1024) });
}

main().catch((error: unknown) => {
  emit({ type: "fatal", error: error instanceof Error ? `${error.message}\n${error.stack}` : String(error) });
  process.exitCode = 1;
});
