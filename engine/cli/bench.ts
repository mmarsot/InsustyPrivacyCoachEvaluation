/**
 * Runs one grid cell, or the review bench as before.
 *
 *   npm run bench -- --module <id> --config <id> --dataset <id> [--tier <tier>] [--ref main] [--dry-run] ...
 *   npm run bench -- [review bench arguments: --tier, --models, --set, ...]   (engine/cli/review.ts)
 *   npm run bench -- --track docbench ...                                      (engine/cli/docbench.ts)
 *
 * `--module` (default insusty-privacy) and `--config` name a row of the grid
 * (`modules/<id>/manifest.json`), `--dataset` (default insusty-custom) a
 * column (`datasets/<id>/`). The cell's runner (`engine/route.ts`) runs in a
 * child process with the arguments its own command takes, so plans, cache
 * keys and outputs are the same either way; every other argument passes
 * through. A cell that cannot run (no adapter, Private AI off for custom
 * labels...) exits 2 with the reason.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { ROOT } from "../paths.ts";
import { routeBench } from "../route.ts";

let route;
try {
  route = routeBench(process.argv.slice(2));
} catch (error) {
  console.error((error as Error).message);
  process.exit(2);
}
const result = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    join(ROOT, "engine", "cli", `${route.runner}.ts`),
    ...route.argv,
  ],
  { stdio: "inherit", cwd: ROOT },
);
process.exit(result.status ?? 1);
