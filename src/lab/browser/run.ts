/**
 * Browser bench: runs lab requests in a real Chrome (WebGPU or WASM) and
 * stores the outputs as a lab cache file, so `npm run lab -- ... --backend
 * webgpu` scores them with the ref's parser like any lab run.
 *
 *   npx tsx src/lab/browser/run.ts --device webgpu --dtype q4 -- <lab args: --configs X --models Y [--set S]>
 *
 * Chrome is started headful with `--enable-features=Vulkan` (the only setup
 * that exposes the NVIDIA GPU here, see experiments/LOG.md G1) and a
 * throwaway profile under cache/tmp, read over the DevTools protocol, then
 * killed. Model files are served from cache/models (downloaded if missing).
 */
import { spawn, spawnSync } from "node:child_process";
import {
  createReadStream,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  appendFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { extname, join, normalize } from "node:path";
import { CACHE_DIR, MODEL_CACHE_DIR, ROOT } from "../../paths.ts";
import { readMemAvailableMb } from "../runtime.ts";

const argv = process.argv.slice(2);
const sep = argv.indexOf("--");
const own = sep >= 0 ? argv.slice(0, sep) : argv;
const labArgs = sep >= 0 ? argv.slice(sep + 1) : [];
const opt = (n: string, d: string) =>
  own.includes(`--${n}`) ? own[own.indexOf(`--${n}`) + 1]! : d;
const device = opt("device", "webgpu");
const dtype = opt("dtype", device === "webgpu" ? "q4" : "q8");
const timeoutS = Number(opt("timeout-s", "3600"));
const DTYPE_FILE: Record<string, string> = {
  q8: "model_quantized.onnx",
  q4: "model_q4.onnx",
  q4f16: "model_q4f16.onnx",
  fp16: "model_fp16.onnx",
  fp32: "model.onnx",
};

if (readMemAvailableMb() < 2500) {
  console.error(
    `only ${readMemAvailableMb()} MB available; the browser bench needs about 2.5 GB. Aborting.`,
  );
  process.exit(2);
}

// 1. Export the rendered requests with the lab's own planner (same cache keys).
const tmp = join(CACHE_DIR, "tmp");
mkdirSync(tmp, { recursive: true });
const jobsName = `browser-jobs-${process.pid}.json`;
const exp = spawnSync(
  process.execPath,
  [
    "--import",
    "tsx",
    join(ROOT, "src/lab/cli.ts"),
    ...labArgs,
    "--dtype",
    dtype,
    "--backend",
    device,
    "--export-jobs",
    join(tmp, jobsName),
  ],
  { cwd: ROOT, stdio: "inherit" },
);
if (exp.status) process.exit(exp.status);
const spec = JSON.parse(readFileSync(join(tmp, jobsName), "utf8")) as {
  model: string;
  jobs: Array<{ key: string }>;
};
const resultFile = join(
  CACHE_DIR,
  "lab",
  `${spec.model.replace(/^.*\//, "")}-${dtype}${device === "wasm" ? "-browserwasm" : `-${device}`}.jsonl`,
);
const done = new Set(
  existsSync(resultFile)
    ? readFileSync(resultFile, "utf8")
        .split("\n")
        .filter(Boolean)
        .map((l) => (JSON.parse(l) as { key: string }).key)
    : [],
);
spec.jobs = spec.jobs.filter((j) => !done.has(j.key));
writeFileSync(join(tmp, jobsName), JSON.stringify(spec));
console.log(
  `${spec.jobs.length} requests to run in Chrome (${device} ${dtype}); results -> ${resultFile.replace(ROOT, "")}`,
);
if (!spec.jobs.length) process.exit(0);

// 2. Make sure the weights for this dtype are in the local model cache.
const weights = join(
  MODEL_CACHE_DIR,
  spec.model,
  "onnx",
  DTYPE_FILE[dtype] ?? "model_quantized.onnx",
);
for (const file of [weights, `${weights}_data`]) {
  if (existsSync(file)) continue;
  const rel = file.slice(join(MODEL_CACHE_DIR, spec.model).length + 1);
  const r = spawnSync("curl", [
    "-sfL",
    "-o",
    file,
    `https://huggingface.co/${spec.model}/resolve/main/${rel}`,
  ]);
  if (r.status && file === weights)
    throw new Error(`could not download ${rel}`);
  if (r.status) rmSync(file, { force: true });
}

// 3. Static server with cross-origin isolation (SharedArrayBuffer for WASM threads).
const roots: Record<string, string> = {
  "/tf/": join(ROOT, "node_modules/@huggingface/transformers/dist"),
  "/models/": MODEL_CACHE_DIR,
  "/jobs/": tmp,
};
const types: Record<string, string> = {
  ".js": "text/javascript",
  ".mjs": "text/javascript",
  ".wasm": "application/wasm",
  ".json": "application/json",
  ".html": "text/html",
};
const server = createServer((req, res) => {
  const path = decodeURIComponent(new URL(req.url ?? "/", "http://x").pathname);
  const headers = {
    "Cross-Origin-Opener-Policy": "same-origin",
    "Cross-Origin-Embedder-Policy": "require-corp",
    "Cross-Origin-Resource-Policy": "same-origin",
  };
  let file =
    path === "/bench.html" ? join(ROOT, "src/lab/browser/bench.html") : "";
  for (const [prefix, dir] of Object.entries(roots))
    if (path.startsWith(prefix))
      file = join(
        dir,
        normalize(path.slice(prefix.length)).replace(/^(\.\.[/\\])+/, ""),
      );
  if (!file || !existsSync(file) || !statSync(file).isFile()) {
    res.writeHead(404, headers).end();
    return;
  }
  res.writeHead(200, {
    ...headers,
    "Content-Type": types[extname(file)] ?? "application/octet-stream",
    "Content-Length": statSync(file).size,
  });
  createReadStream(file).pipe(res);
});
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const port = (server.address() as { port: number }).port;

// 4. Headful Chrome with Vulkan, driven over CDP.
const debugPort = 9400 + Math.floor(Math.random() * 400);
const profile = join(tmp, `chrome-profile-${process.pid}`);
const url = `http://127.0.0.1:${port}/bench.html?jobs=${jobsName}&device=${device}&dtype=${dtype}`;
const chrome = spawn(
  "google-chrome",
  [
    "--enable-features=Vulkan",
    `--user-data-dir=${profile}`,
    "--no-first-run",
    "--no-default-browser-check",
    `--remote-debugging-port=${debugPort}`,
    "--window-size=500,300",
    url,
  ],
  { detached: true, stdio: "ignore" },
);
const cleanup = () => {
  try {
    process.kill(-chrome.pid!, "SIGKILL");
  } catch {
    // Chrome already exited, or never started.
  }
  server.close();
  rmSync(profile, { recursive: true, force: true });
};
process.on("SIGINT", () => (cleanup(), process.exit(130)));

/**
 * Reads the bench page's `#out` text over the DevTools protocol; empty until
 * the page is up.
 */
const evaluate = async (): Promise<string> => {
  const targets = (await (
    await fetch(`http://127.0.0.1:${debugPort}/json`)
  ).json()) as Array<{
    type: string;
    url: string;
    webSocketDebuggerUrl: string;
  }>;
  const page = targets.find(
    (t) => t.type === "page" && t.url.includes("bench.html"),
  );
  if (!page) return "";
  const ws = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener("open", r));
  const reply = await new Promise<{ result?: { result?: { value?: string } } }>(
    (resolve) => {
      ws.addEventListener(
        "message",
        (m) => resolve(JSON.parse(String(m.data))),
        { once: true },
      );
      ws.send(
        JSON.stringify({
          id: 1,
          method: "Runtime.evaluate",
          params: { expression: "document.getElementById('out').textContent" },
        }),
      );
    },
  );
  ws.close();
  return reply.result?.result?.value ?? "";
};

const started = Date.now();
let last = "";
let text = "";
while (Date.now() - started < timeoutS * 1000) {
  await new Promise((r) => setTimeout(r, 3000));
  try {
    text = await evaluate();
  } catch {
    continue;
  }
  if (text.startsWith("RESULT")) break;
  if (text !== last)
    console.log(
      `[chrome] ${text} · ${Math.round((Date.now() - started) / 1000)} s, ${readMemAvailableMb()} MB available`,
    );
  last = text;
  if (readMemAvailableMb() < 700) {
    console.error("system MemAvailable below 700 MB; stopping Chrome.");
    break;
  }
}
cleanup();
if (!text.startsWith("RESULT")) {
  console.error("no result from the page");
  process.exit(1);
}
const result = JSON.parse(text.slice(7)) as {
  error?: string;
  device: string;
  adapter: string | null;
  loadMs: number;
  results: unknown[];
};
if (result.error) {
  console.error(result.error);
  process.exit(1);
}
mkdirSync(join(CACHE_DIR, "lab"), { recursive: true });
for (const r of result.results)
  appendFileSync(resultFile, JSON.stringify(r) + "\n");
console.log(
  `done: ${result.results.length} results on ${result.device} (adapter: ${result.adapter}), model load ${result.loadMs} ms`,
);
