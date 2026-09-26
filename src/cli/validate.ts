/**
 * Validates the dataset: schema, verbatim passages, label-example leaks, and
 * the type mix. Exits non-zero on any error.
 *   npm run validate [-- --allow-missing-split] [--quiet] [--profile <id>]
 */
import { compileDataset } from "../dataset/load.ts";
import { CASE_TYPES, LANGS, TYPE_TARGET_SHARE } from "../dataset/schema.ts";

const argv = process.argv.slice(2);
const args = new Set(argv);
const only = argv.includes("--profile") ? argv[argv.indexOf("--profile") + 1] : undefined;
const { dataset, issues } = compileDataset({ requireSplit: !args.has("--allow-missing-split"), profiles: only ? [only] : undefined });
const errors = issues.filter((i) => i.level === "error");
const warnings = issues.filter((i) => i.level === "warning");
for (const issue of [...errors, ...(args.has("--quiet") ? [] : warnings)])
  console.log(`${issue.level === "error" ? "ERROR" : "warn "} ${issue.where}: ${issue.message}`);

if (!dataset) {
  console.log(`\n${errors.length} error(s), ${warnings.length} warning(s). Dataset rejected.`);
  process.exit(1);
}

const pct = (n: number, d: number) => (d ? `${Math.round((100 * n) / d)}%` : "-");
console.log(`\nDataset ${dataset.hash.slice(0, 12)}: ${dataset.profiles.length} profiles, ${dataset.cases.length} cases, ${warnings.length} warning(s).\n`);
const header = ["profile", "lang", "n", ...CASE_TYPES.map((t) => t.replace("_positive", "+").replace("_negative", "-")), "mixed", "test"];
console.log(header.join("\t"));
for (const profile of dataset.profiles)
  for (const lang of LANGS) {
    const cs = dataset.cases.filter((c) => c.profile === profile.id && c.lang === lang);
    if (!cs.length) continue;
    console.log(
      [
        profile.id,
        lang,
        cs.length,
        ...CASE_TYPES.map((t) => `${cs.filter((c) => c.type === t).length} (${pct(cs.filter((c) => c.type === t).length, cs.length)})`),
        cs.filter((c) => c.mixed).length,
        pct(cs.filter((c) => c.split === "test").length, cs.length),
      ].join("\t"),
    );
  }
console.log(`\ntarget mix: ${CASE_TYPES.map((t) => `${t} ${Math.round(TYPE_TARGET_SHARE[t] * 100)}%`).join(", ")}`);
