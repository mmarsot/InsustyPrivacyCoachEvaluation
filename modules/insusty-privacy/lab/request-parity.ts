/**
 * Parity of the lab's shipped baseline with the ref, no model and no network
 * once the ref is installed (`npm run parity`, a CI gate of the Private AI
 * track). The ref runs through its package, on a scripted on-device runtime
 * (`runtime/scripted.ts`) that records what the ref's engine hands the model:
 *
 * - requests: every per-label prompt (prepared prefix, then the framed text
 *   and the answer cue) must equal what the lab's `shipped` configuration
 *   renders (prefix, suffix). Since extension PR #42 (fb52dc6) the ref
 *   leaves fenced code blocks out of the scanned text, which the lab's
 *   `shipped` configuration does not model yet: those requests are counted
 *   apart as "code-fence skip";
 * - answers: the scripted model answers each label with a passage of the
 *   case (plain, quoted, two at once, lower-cased, a bare number, a stop
 *   word, NONE...), and the ref's findings must equal what the lab reads
 *   from the same answer with its copy of the line protocol (`protocol.ts`).
 *   Fenced cases are left out: the ref reads them without their code.
 *
 *   npm run parity -- [--set tune96] [--allow-test] [--ref main]
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { compileDataset } from "../../../datasets/insusty-custom/load.ts";
import type {
  CompiledCase,
  Profile,
} from "../../../datasets/insusty-custom/schema.ts";
import { SETS_DIR } from "../../../engine/paths.ts";
import { rulesFor } from "../../../engine/jobs.ts";
import { importPackage, loadInsustyModule } from "../insusty.ts";
import { materializeModule } from "../materialize.ts";
import { resolveExtRefName, resolveExtRepo } from "../ref.ts";
import { scriptedRuntime, type ScriptedRequest } from "../runtime/scripted.ts";
import { buildRaw, passagesToLines, plausibleLines } from "./config.ts";
import { isPlausiblePassage, validateModelOutput } from "./protocol.ts";
import { findLabModel } from "./models.ts";
import { SHIPPED_CONFIG } from "./shipped.ts";

const args = process.argv.slice(2);
const opt = (name: string) =>
  args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : undefined;
const setName = opt("set") ?? "tune96";
const ids = (
  JSON.parse(readFileSync(join(SETS_DIR, `${setName}.json`), "utf8")) as {
    cases: string[];
  }
).cases;
const { dataset } = compileDataset({ requireSplit: true });
const ext = await materializeModule(
  resolveExtRepo(opt("ext-repo")),
  resolveExtRefName(opt("ref")),
);
/** The lab models the generation model's prompts: SmolLM2, named, since the ref's default may be a span model (GLiNER2, extension PR #170). */
const generationModel = findLabModel("smollm2-360m")!.id;
const noRefTexts = {
  defaultPrompt: "",
  outputSchema: "",
  labelHeader: "",
  builtin: [],
};
const FENCE = /^ {0,3}(`{3,}|~{3,})/mu;
/** A profile's labels as the contract takes them: `desc` descriptions, three examples. */
const labelsOf = (profile: Profile) =>
  rulesFor(profile, "desc", true).map((r) => ({
    label: r.label,
    description: r.prompt,
    examples: r.examples ?? [],
  }));

// ------------------------------------------------------------ requests

const recorded = scriptedRuntime();
const module = await loadInsustyModule(ext, {
  device: () => Promise.resolve(recorded.runtime),
});
let same = 0;
let fenced = 0;
let total = 0;
const cases: CompiledCase[] = [];
for (const id of ids) {
  const c = dataset!.cases.find((x) => x.id === id)!;
  if (c.split === "test" && !args.includes("--allow-test"))
    throw new Error("held-out case: pass --allow-test");
  cases.push(c);
  const profile = dataset!.profiles.find((p) => p.id === c.profile)!;
  const from = recorded.requests.length;
  await module.redact(
    { kind: "text", text: c.text },
    {
      ...module.defaultConfig(),
      customLabels: labelsOf(profile),
      privateAi: { runsOn: "device", model: generationModel },
    },
  );
  const seen = recorded.requests.slice(from);
  profile.labels.forEach((label, i) => {
    const raw = buildRaw(
      SHIPPED_CONFIG,
      { ...profile, labels: [label] },
      noRefTexts,
      c.text,
    );
    const lab = { prefix: raw.prefix, suffix: raw.suffix(c.text) };
    const ref = seen[i];
    total++;
    const ok =
      ref !== undefined &&
      seen.length === profile.labels.length &&
      ref.prefix === lab.prefix &&
      ref.suffix === lab.suffix;
    // The skip changes the scanned text, and through it the language guess (and so the demonstrations).
    const fenceOnly = !ok && ref !== undefined && FENCE.test(c.text);
    if (ok) same++;
    else if (fenceOnly) fenced++;
    else
      console.log(
        `DIFF ${id} ${label.label} (${seen.length} ref requests; instructions ${ref?.prefix === lab.prefix ? "same" : "differ"}, input ${ref?.suffix === lab.suffix ? "same" : "differs"})\n  ref: ${JSON.stringify(ref).slice(0, 300)}\n  lab: ${JSON.stringify(lab).slice(0, 300)}`,
      );
  });
}
await module.dispose?.();
console.log(
  `${setName}, ref ${ext.ref}@${ext.sha.slice(0, 7)}: ${same}/${total} per-label requests identical, ${fenced} differ only by the ref's code-fence skip, ${total - same - fenced} other differences`,
);

// ------------------------------------------------------------ answers

/** The label a request asks about: its answer cue ends the prompt. */
const cueLabel = (request: ScriptedRequest) =>
  /(?:^|\n)(?<label>[^\n]*):$/u.exec(request.suffix)?.groups?.label ?? "";
/** One scripted answer per case and label, cycling through the shapes the parser reads. */
const answerFor = (c: CompiledCase, label: string, turn: number): string => {
  const passages = [
    ...new Set(
      c.expected.filter((e) => e.label === label).map((e) => e.passage),
    ),
  ];
  const [first, second] = passages;
  if (first !== undefined)
    return [
      ` ${first}`,
      ` "${first}".`,
      ` ${first} | ${second ?? first}`,
      ` ${first.toLocaleLowerCase()}`,
      ` - ${first}`,
    ][turn % 5]!;
  const word = /\p{L}{4,}/u.exec(c.text)?.[0] ?? "NONE";
  return [" NONE", " the", ` ${word}`, " 12", " NONE."][turn % 5]!;
};

const { createNodeRedactionModule, redactionConfigOf } =
  await importPackage(ext);
let turn = 0;
let alike = 0;
let answers = 0;
for (const c of cases.filter((x) => !FENCE.test(x.text))) {
  const profile = dataset!.profiles.find((p) => p.id === c.profile)!;
  const given = new Map<string, string>();
  const scripted = scriptedRuntime((request) => {
    const label = cueLabel(request);
    const answer = answerFor(c, label, turn++);
    given.set(label, answer);
    return answer;
  });
  const facade = createNodeRedactionModule({
    device: () => Promise.resolve(scripted.runtime),
  });
  const labels = labelsOf(profile);
  facade.configure(
    redactionConfigOf({
      ...module.defaultConfig(),
      customLabels: labels,
      privateAi: { runsOn: "device", model: generationModel },
    }),
  );
  const review = await facade.reviewText(c.text);
  await facade.dispose();
  const key = (s: { label: string; start: number; end: number }) =>
    `${s.label}@${s.start}-${s.end}`;
  const ref = review.spans
    .filter((s) => s.source === "model")
    .map(key)
    .sort();
  // The lab's shipped reading of each answer; a span found for two labels keeps the first.
  const byLabel = new Map<string, string>();
  for (const { label } of labels)
    for (const f of validateModelOutput(
      plausibleLines(
        passagesToLines(given.get(label) ?? "", label),
        isPlausiblePassage,
      ),
      { text: c.text, offset: 0 },
      0,
      [label],
    ))
      if (!byLabel.has(`${f.start}-${f.end}`))
        byLabel.set(`${f.start}-${f.end}`, label);
  const lab = [...byLabel].map(([span, label]) => `${label}@${span}`).sort();
  answers++;
  if (ref.join() === lab.join()) alike++;
  else
    console.log(
      `ANSWER DIFF ${c.id}: answers ${JSON.stringify(Object.fromEntries(given))}\n  ref: ${ref.join(" ")}\n  lab: ${lab.join(" ")}`,
    );
}
console.log(
  `${setName}, ref ${ext.ref}@${ext.sha.slice(0, 7)}: ${alike}/${answers} cases read alike from scripted answers (${cases.length - answers} fenced cases left out)`,
);
process.exitCode = same + fenced === total && alike === answers ? 0 : 1;
