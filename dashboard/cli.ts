/**
 * Local benchmark dashboard (localhost): Modules, Datasets and the Grid of
 * module configurations × datasets, Live runs, Results, Lab and Playground.
 * It writes no results; the grid's Run button starts at most one bench
 * process and the playground at most one model.
 *   npm run dashboard [-- --port 4380] [--ref <git ref>] [--ext-repo <path>]
 */
import { Dashboard, startServer } from "./server.ts";

const argv = process.argv.slice(2);
const opt = (name: string) =>
  argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined;
const port = Number(opt("port") ?? 4380);
const dash = new Dashboard({ extRepo: opt("ext-repo"), ref: opt("ref") });
await startServer(dash, port);
// Free the playground model process with the server.
for (const signal of ["SIGINT", "SIGTERM"] as const)
  process.on(
    signal,
    () => void dash.playground.unload().finally(() => process.exit(0)),
  );
console.log(
  `Review Bench dashboard: http://127.0.0.1:${port}/  (writes no results; Run starts at most one bench process; Ctrl+C to stop)`,
);
