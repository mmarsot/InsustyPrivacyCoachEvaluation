/**
 * Local benchmark dashboard (read-only, localhost).
 *   npm run dashboard [-- --port 4380] [--ref <git ref>] [--ext-repo <path>]
 */
import { Dashboard, startServer } from "../dashboard/server.ts";

const argv = process.argv.slice(2);
const opt = (name: string) => (argv.includes(`--${name}`) ? argv[argv.indexOf(`--${name}`) + 1] : undefined);
const port = Number(opt("port") ?? 4380);
const dash = new Dashboard({ extRepo: opt("ext-repo"), ref: opt("ref") });
await startServer(dash, port);
console.log(`Review Bench dashboard: http://127.0.0.1:${port}/  (read-only; Ctrl+C to stop)`);
