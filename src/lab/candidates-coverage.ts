/**
 * Model-free check of the candidate generator (src/lab/candidates.ts): the
 * share of expected passages overlapped by at least one candidate (the recall
 * ceiling of the classification approach) and candidates per case (its cost).
 *
 *   npx tsx src/lab/candidates-coverage.ts [--split dev] [--misses 30]
 */
import { compileDataset } from "../dataset/load.ts";
import { generateCandidates } from "./candidates.ts";

const args = process.argv.slice(2);
const split = args.includes("--split") ? args[args.indexOf("--split") + 1] : "dev";
const showMisses = args.includes("--misses") ? Number(args[args.indexOf("--misses") + 1]) : 0;
const { dataset } = compileDataset({ requireSplit: true });
const cases = dataset!.cases.filter((c) => c.split === split);
let expected = 0;
let overlapped = 0;
let exact = 0;
let candidates = 0;
const byType = new Map<string, [number, number]>();
const misses: string[] = [];
for (const c of cases) {
  const cands = generateCandidates(c.text);
  candidates += cands.length;
  for (const e of c.expected) {
    const spans = c.spans.filter((s) => s.label === e.label && s.passage === e.passage);
    const hit = cands.some((k) => spans.some((s) => k.start < s.end && s.start < k.end));
    const ex = cands.some((k) => spans.some((s) => k.start === s.start && k.end === s.end));
    expected++;
    overlapped += hit ? 1 : 0;
    exact += ex ? 1 : 0;
    const t = byType.get(c.type) ?? [0, 0];
    byType.set(c.type, [t[0] + (hit ? 1 : 0), t[1] + 1]);
    if (!hit) misses.push(`${c.id} ${e.label}: ${JSON.stringify(e.passage)}`);
  }
}
const pct = (a: number, b: number) => `${Math.round((100 * a) / b)}%`;
console.log(`${split}: ${cases.length} cases, ${expected} expected passages`);
console.log(`overlapped by a candidate: ${pct(overlapped, expected)}, exact candidate: ${pct(exact, expected)}, candidates per case: ${(candidates / cases.length).toFixed(1)}`);
for (const [t, [h, n]] of byType) console.log(`  ${t}: ${pct(h, n)} of ${n}`);
if (showMisses) console.log(misses.slice(0, showMisses).join("\n"));
