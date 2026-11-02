/**
 * Node counterpart of the span-model environment in the extension's
 * `src/model-worker.ts` (`spanEnvironment`): what the ref's own span runtime
 * (GLiNER2, `loadSpanModel` in its package) needs from its host. The ref
 * downloads the files, proves them against the hashes its catalog pins,
 * builds the sessions and runs the review; the bench supplies only:
 *
 * - `onnxruntime-web` (WASM, default session options, `min(4, CPU count)`
 *   threads, as the worker sets them through Transformers.js's `env`, which
 *   in the browser is the same `ort.env`), imported as `onnxruntime-node`,
 *   the alias Transformers.js loads in Node (`package.json`), so one
 *   instance holds the backends, as in the browser;
 * - Transformers.js's `DebertaV2Tokenizer`, encoding without special tokens;
 * - the model host the ref's build downloads from (`DEFAULT_MODEL_HOST` in
 *   its `scripts/bundle-options.mjs`, read by `materialize.ts`), or
 *   `INSUSTY_MODEL_HOST` as for an extension build;
 * - Node's `fetch` and SHA-256, and a disk cache of proven files under
 *   `cache/models/spans/` in place of Cache Storage.
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { DebertaV2Tokenizer } from "@huggingface/transformers";
import type { SpanEnvironment } from "insusty-prompt-coach/redaction";
import * as ort from "onnxruntime-node";
import { MODEL_CACHE_DIR, ROOT } from "../../../engine/paths.ts";
import { transformersVersion, WASM_THREADS } from "./transformers-loader.ts";

/** Where proven span-model files are kept, by name and hash. */
const SPAN_CACHE_DIR = join(MODEL_CACHE_DIR, "spans");

ort.env.wasm.wasmPaths = pathToFileURL(
  join(ROOT, "node_modules", "onnxruntime-web", "dist") + "/",
).href;
ort.env.wasm.numThreads = WASM_THREADS;

/** What a span model runs on, recorded in run metadata. */
export const spanRuntimeVersion = `onnxruntime-web ${
  (
    JSON.parse(
      readFileSync(
        join(ROOT, "node_modules", "onnxruntime-node", "package.json"),
        "utf8",
      ),
    ) as { version: string }
  ).version
} (WASM, ${WASM_THREADS} threads), Transformers.js ${transformersVersion} tokenizer`;

/** A cache key (`<model>/<file>@<sha256>`) as a file name. */
const cacheFile = (key: string) =>
  join(SPAN_CACHE_DIR, encodeURIComponent(key));

/** The span environment for a ref whose build downloads from `modelHost`. */
export function nodeSpanEnvironment(
  modelHost: string | undefined,
): SpanEnvironment {
  const host = process.env.INSUSTY_MODEL_HOST || modelHost;
  return {
    ort,
    tokenizer: (json, config) => {
      const tokenizer = new DebertaV2Tokenizer(
        json as object,
        config as object,
      );
      return {
        encode: (text) => tokenizer.encode(text, { add_special_tokens: false }),
      };
    },
    host: host ? (host.endsWith("/") ? host : `${host}/`) : undefined,
    fetch: (url) => fetch(url),
    sha256: async (bytes) => createHash("sha256").update(bytes).digest("hex"),
    cache: {
      async get(key) {
        const file = cacheFile(key);
        // A Buffer is a Uint8Array: no copy of a 366 MB encoder.
        return existsSync(file) ? readFileSync(file) : undefined;
      },
      async put(key, bytes) {
        mkdirSync(SPAN_CACHE_DIR, { recursive: true });
        const file = cacheFile(key);
        const staging = `${file}.${process.pid}.part`;
        await writeFile(staging, bytes);
        renameSync(staging, file);
      },
    },
  };
}
