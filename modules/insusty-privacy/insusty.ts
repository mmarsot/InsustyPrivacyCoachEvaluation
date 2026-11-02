/**
 * The extension's redaction module at a git ref, as the bench scores it: the
 * ref's own package (`insusty-prompt-coach/redaction`, installed by
 * `materialize.ts`), wrapped in the redaction contract by the package itself
 * (`createContractModule`). Rules, documents, the Private AI review, the
 * merge of rule and custom-label findings and the redaction are all the
 * ref's. The bench supplies only what the package takes from its host:
 *
 * - the on-device runtime: the Node WASM loader
 *   (`runtime/transformers-loader.ts`), or a scripted one
 *   (`runtime/scripted.ts`), for generation models (SmolLM2);
 * - what the ref's span runtime (GLiNER2) runs on
 *   (`runtime/span-environment.ts`);
 * - the connected transport (`connected.ts`: reply cache, cost, budget);
 * - PDFium, at the version the ref's lockfile pins;
 * - what a run measures around each call: peak memory, the machine.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import type * as Redaction from "insusty-prompt-coach/redaction";
import type { RedactionModule } from "../../contract/types.ts";
import { machineProfile, peakRssMb } from "../../engine/machine.ts";
import type { ModuleRef } from "./materialize.ts";

/**
 * How Private AI runs: `device` starts the on-device generation runtime on
 * first use, `spans` gives what span models load on (read on first use), and
 * `connected` lists the connected models. The ref lists an on-device model
 * only when its kind has a runtime.
 */
export interface InsustyOptions {
  device?: () => Promise<Redaction.DeviceRuntime>;
  spans?: () => Promise<Redaction.SpanEnvironment>;
  connected?: Redaction.ConnectedTarget[];
}

/** The extension at a ref as a contract module, with the ref it was installed from. */
export interface InsustyModule extends RedactionModule {
  ref: ModuleRef;
}

/** The ref's package, imported from its own install. */
export const importPackage = (ref: Pick<ModuleRef, "entry">) =>
  import(pathToFileURL(ref.entry).href) as Promise<typeof Redaction>;

/** PDFium from the ref's install, initialised once, on first use. */
function pdfiumOf(dir: string): () => Promise<unknown> {
  let loaded: Promise<unknown> | undefined;
  return () =>
    (loaded ??= (async () => {
      const { init } = (await import(
        pathToFileURL(join(dir, "dist", "index.js")).href
      )) as {
        init(options: {
          wasmBinary: ArrayBuffer;
          locateFile?: (file: string) => string;
        }): Promise<{ PDFiumExt_Init(): void }>;
      };
      const wasm = readFileSync(join(dir, "dist", "pdfium.wasm"));
      const pdfium = await init({
        wasmBinary: wasm.buffer.slice(
          wasm.byteOffset,
          wasm.byteOffset + wasm.byteLength,
        ) as ArrayBuffer,
        locateFile: (file) => file,
      });
      pdfium.PDFiumExt_Init();
      return pdfium;
    })());
}

/** Imports an installed ref's package and returns its contract module. */
export async function loadInsustyModule(
  ref: ModuleRef,
  options: InsustyOptions = {},
): Promise<InsustyModule> {
  const { createContractModule } = await importPackage(ref);
  const module: RedactionModule = createContractModule({
    info: { version: ref.sha.slice(0, 12), sha: ref.sha },
    ...(options.device ? { device: options.device } : {}),
    ...(options.spans ? { spans: options.spans } : {}),
    ...(options.connected ? { connected: options.connected } : {}),
    ...(ref.pdfium
      ? {
          pdfium: pdfiumOf(ref.pdfium) as NonNullable<
            Redaction.NodeRedactionOptions["pdfium"]
          >,
        }
      : {}),
    measure: () => ({ peakRssMb: peakRssMb(), machine: machineProfile() }),
  });
  return { ...module, ref };
}
