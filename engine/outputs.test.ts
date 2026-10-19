import { test } from "node:test";
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ROOT } from "./paths.ts";
import { missingRun } from "./outputs.ts";

test("a run folder with a run.json is not missing", () => {
  const dir = mkdtempSync(join(tmpdir(), "bench-run-"));
  writeFileSync(join(dir, "run.json"), "{}");
  assert.equal(missingRun(dir, "npm run bench"), undefined);
});

test("a missing run says it is local and how to produce it", () => {
  const root = mkdtempSync(join(tmpdir(), "bench-runs-"));
  const det = missingRun(join(root, "main-4d68779"), "npm run detbench");
  assert.match(det!, /^no run at .*main-4d68779$/m);
  assert.match(det!, /git-ignored/);
  assert.match(det!, /npm run detbench -- --ref 4d68779 --name main-4d68779/);
  assert.match(
    missingRun(join(root, "ext-d42c466-tune96-smol360"), "npm run bench")!,
    /npm run bench -- --ref d42c466 --name ext-d42c466-tune96-smol360/,
  );
  assert.match(
    missingRun(join(root, "smoke"), "npm run bench")!,
    /--ref <ref> --name smoke/,
  );
});

// The CLIs that read stored runs exit 2 with that message instead of crashing on a fresh clone.
const cli = (script: string, ...args: string[]) =>
  spawnSync(process.execPath, ["--import", "tsx", script, ...args], {
    cwd: ROOT,
    encoding: "utf8",
  });

for (const [script, args, command] of [
  ["engine/cli/detbench.ts", ["--compare-runs"], "npm run detbench"],
  ["engine/cli/docbench.ts", ["--compare-runs"], "npm run docbench"],
  ["engine/cli/compare.ts", [], "npm run bench"],
  ["engine/cli/report.ts", [], "npm run bench"],
] as const)
  test(`${script} reports a missing run plainly`, () => {
    const root = mkdtempSync(join(tmpdir(), "bench-runs-"));
    const r = cli(
      script,
      ...args,
      join(root, "main-1234567"),
      join(root, "main-89abcde"),
    );
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /no run at .*main-1234567/);
    assert.match(r.stderr, new RegExp(`${command} -- --ref 1234567`));
    assert.doesNotMatch(r.stderr, /ENOENT|at .*\.ts:\d+/);
  });
