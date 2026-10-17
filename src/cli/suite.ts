/**
 * Runs the benchmark tracks a change needs (src/tracks/select.ts).
 *
 *   npm run suite -- --since <base ref> [--ref <head ref>]   # tracks from `git diff base...head` in the extension clone
 *   npm run suite -- --full [--ref main]                      # every track (release runs)
 *   npm run suite -- --tracks deterministic|private-ai [...]  # explicit
 *     [--ci]          CI tiers: gates compare head against --since (detbench, docbench smoke, conformance, parity); Private AI smoke ungated
 *     [--connected]   also the connected model (paid: GLM-4.7 Flash; needs its key, capped by --budget-usd in each command)
 *     [--ext-repo <path>] [--name-prefix <p>] [--dry-run]
 *
 * The extension clone is read only (`git diff --name-only`). Exits 1 when a
 * gate fails (deterministic or document regression, conformance, parity).
 * Absolute speed and memory are labelled with the machine profile: set
 * BENCH_MACHINE_ID on a declared reference machine; anything else is
 * `adhoc`.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { resolveExtRefName, resolveExtRepo } from "../ext/ref.ts";
import { machineProfile } from "../module/machine.ts";
import { ROOT } from "../paths.ts";
import { planSuite, selectTracks, type Track } from "../tracks/select.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : undefined;
};
const flag = (name: string) => argv.includes(`--${name}`);
const fail = (message: string): never => {
  console.error(message);
  process.exit(2);
};

const extRepo = resolveExtRepo(opt("ext-repo"));
const ref = resolveExtRefName(opt("ref"));
const since = opt("since");
let tracks: Track[];
if (flag("full")) tracks = ["deterministic", "private-ai"];
else if (opt("tracks")) {
  tracks = opt("tracks")!.split(",") as Track[];
  for (const t of tracks) if (t !== "deterministic" && t !== "private-ai") fail(`unknown track ${t} (deterministic, private-ai)`);
} else if (since) {
  const paths = execFileSync("git", ["-C", extRepo, "diff", "--name-only", `${since}...${ref}`], { encoding: "utf8" }).split("\n").filter(Boolean);
  const selection = selectTracks(paths);
  console.log(`${paths.length} path(s) changed in ${since}...${ref}`);
  for (const r of selection.reasons) console.log(`  ${r.tracks.join(" + ")}: ${r.why} (${r.paths.slice(0, 5).join(", ")}${r.paths.length > 5 ? `, +${r.paths.length - 5}` : ""})`);
  if (selection.ignored.length) console.log(`  no benchmark: ${selection.ignored.length} path(s) (${selection.ignored.slice(0, 5).join(", ")}${selection.ignored.length > 5 ? ", ..." : ""})`);
  tracks = selection.tracks;
} else tracks = fail("Pass --since <base ref> (tracks from what changed), --tracks <list>, or --full.");

const ci = flag("ci");
if (ci && !since) fail("--ci compares against a base: pass --since <base ref>");
const steps = planSuite({ ref, ...(ci ? { base: since } : {}), tracks, ci, full: flag("full"), connected: flag("connected"), ...(opt("ext-repo") ? { extRepo: opt("ext-repo") } : {}), ...(opt("name-prefix") ? { namePrefix: opt("name-prefix") } : {}) });
const machine = machineProfile();
console.log(`Tracks: ${tracks.join(", ") || "none (nothing to benchmark)"}${ci ? " (CI tiers)" : ""}; machine profile ${machine.id}${machine.id === "adhoc" ? " (absolute speed and memory are indicative only; set BENCH_MACHINE_ID on the reference machine)" : ""}`);
for (const s of steps) console.log(`  [${s.track}] ${s.name}${s.gate ? " (gate)" : ""}: npm run ${s.script} -- ${s.args.join(" ")}`);
if (flag("dry-run") || !steps.length) process.exit(0);

const failed: string[] = [];
for (const s of steps) {
  console.log(`\n=== [${s.track}] ${s.name}`);
  const r = spawnSync("npm", ["run", "-s", s.script, "--", ...s.args], { cwd: ROOT, stdio: "inherit" });
  if (r.status !== 0) {
    console.error(`[${s.track}] ${s.name} exited with ${r.status}${s.gate ? " (gate)" : ""}`);
    if (s.gate) failed.push(s.name);
  }
}
console.log(failed.length ? `\nSuite FAILED: ${failed.join(", ")}` : "\nSuite passed.");
process.exit(failed.length ? 1 : 0);
