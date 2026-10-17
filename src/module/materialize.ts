/**
 * The one materializer: turns a git ref of the extension into a module the
 * bench can load, without touching the extension clone.
 *
 *   1. `git archive` copies the ref's `src`, `package.json` and
 *      `package-lock.json` into `cache/module/<sha>/`.
 *   2. An entry re-exports every module of the redaction path the ref has
 *      (`LAYOUT`: detection, configuration, file reading and redaction,
 *      Private AI review, on-device engine and model list, connected-model
 *      client), each found by its area-folder path or the flat pre-#82 one.
 *   3. The npm packages they import are installed at the versions the ref's
 *      package-lock pins (`npm ci` on a lockfile subset), so validators,
 *      phone metadata and PDFium are the ones that commit ships.
 *   4. esbuild bundles the entry into `module.mjs`, resolving packages only
 *      from that install. `@huggingface/transformers` stays external: the
 *      bench supplies the inference runtime and checks it against the ref's
 *      lockfile (`runtimeMismatches`).
 *
 * Everything is cached per commit sha; after the first run a ref loads
 * offline. `src/module/insusty.ts` adapts the bundle to the redaction
 * contract.
 */
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { builtinModules } from "node:module";
import { join } from "node:path";
import { build, type Plugin } from "esbuild";
import { CACHE_DIR, ROOT } from "../paths.ts";

export const MODULE_CACHE_DIR = join(CACHE_DIR, "module");

/** Bump when the entry or the bundle options change, so cached bundles are rebuilt. */
const BUNDLE_VERSION = 1;

/** Packages the bench supplies instead of the ref's install (the inference runtime; see docs/approach.md). */
const BENCH_SUPPLIED = ["@huggingface/transformers"];

/** Where each module of the redaction path lives: area folders since PR #82, flat `src/` before. */
export const LAYOUT: ReadonlyArray<{
  name: ModuleName;
  files: string[];
  required?: boolean;
}> = [
  {
    name: "detector",
    files: ["src/detection/detector.ts", "src/detector.ts"],
    required: true,
  },
  {
    name: "config",
    files: ["src/config/config.ts", "src/config.ts"],
    required: true,
  },
  {
    name: "redaction",
    files: ["src/detection/redaction.ts", "src/redaction.ts"],
  },
  {
    name: "fileCheck",
    files: ["src/files/file-check.ts", "src/file-check.ts"],
  },
  {
    name: "documentReader",
    files: ["src/files/readers/document-reader.ts", "src/document-reader.ts"],
  },
  {
    name: "documentModel",
    files: ["src/files/document-model.ts", "src/document-model.ts"],
  },
  {
    name: "review",
    files: ["src/private-ai/slm-review.ts", "src/slm-review.ts"],
  },
  {
    name: "engine",
    files: ["src/private-ai/on-device/slm-engine.ts", "src/slm-engine.ts"],
  },
  {
    name: "models",
    files: ["src/private-ai/on-device/slm-models.ts", "src/slm-models.ts"],
  },
  {
    name: "generation",
    files: [
      "src/private-ai/on-device/slm-generation.ts",
      "src/slm-generation.ts",
    ],
  },
  {
    name: "hostedFraming",
    files: [
      "src/private-ai/connected-model/hosted-framing.ts",
      "src/hosted-framing.ts",
    ],
  },
  {
    name: "hostedClient",
    files: [
      "src/private-ai/connected-model/hosted-model-client.ts",
      "src/hosted-model-client.ts",
    ],
  },
];
export type ModuleName =
  | "detector"
  | "config"
  | "redaction"
  | "fileCheck"
  | "documentReader"
  | "documentModel"
  | "review"
  | "engine"
  | "models"
  | "generation"
  | "hostedFraming"
  | "hostedClient";

export interface ModuleRef {
  ref: string;
  sha: string;
  subject: string;
  committedAt: string;
  dir: string;
  /** The bundle (`module.mjs`). */
  bundle: string;
  /** Which `LAYOUT` modules the ref has, and the file each came from. */
  modules: Partial<Record<ModuleName, string>>;
  /** npm packages bundled, at the ref's locked versions. */
  packages: Record<string, string>;
  /** PDFium's WebAssembly binary from the ref's locked `@embedpdf/pdfium`, when the ref reads PDFs. */
  pdfiumWasm?: string;
  /** Inference runtime versions the ref's lockfile pins (the bench supplies these packages). */
  runtime: Record<string, string>;
}

// ------------------------------------------------------------ git

const git = (repo: string, args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  }).trim();

/** Resolves a ref to its commit, read-only. */
export function resolveCommit(
  repo: string,
  ref: string,
): { sha: string; subject: string; committedAt: string } {
  const sha = git(repo, ["rev-parse", "--verify", `${ref}^{commit}`]);
  return {
    sha,
    subject: git(repo, ["log", "-1", "--format=%s", sha]),
    committedAt: git(repo, ["log", "-1", "--format=%cI", sha]),
  };
}

/** Extracts `paths` of a commit into `dir` with `git archive` (the clone is never touched). Missing paths are skipped. */
export function archiveCommit(
  repo: string,
  sha: string,
  paths: string[],
  dir: string,
): void {
  const present = paths.filter((p) => {
    try {
      git(repo, ["cat-file", "-e", `${sha}:${p}`]);
      return true;
    } catch {
      return false;
    }
  });
  const tar = execFileSync(
    "git",
    ["-C", repo, "archive", "--format=tar", sha, ...present],
    { maxBuffer: 256 * 1024 * 1024 },
  );
  execFileSync("tar", ["-x", "-C", dir], { input: tar });
}

// ------------------------------------------------------------ locked packages

interface LockEntry {
  version?: string;
  resolved?: string;
  integrity?: string;
  dependencies?: Record<string, string>;
  optionalDependencies?: Record<string, string>;
  dev?: boolean;
  devOptional?: boolean;
  optional?: boolean;
  [key: string]: unknown;
}
interface Lockfile {
  lockfileVersion?: number;
  packages?: Record<string, LockEntry>;
}

const packageName = (spec: string) =>
  spec.startsWith("@")
    ? spec.split("/").slice(0, 2).join("/")
    : spec.split("/")[0]!;
export const isBuiltin = (spec: string) =>
  spec.startsWith("node:") || builtinModules.includes(packageName(spec));

/**
 * The lockfile entries needed to install `names` and their dependencies,
 * following npm's nested `node_modules` resolution.
 */
export function lockSubset(
  lock: Lockfile,
  names: string[],
): Record<string, LockEntry> {
  const all = lock.packages ?? {};
  const out: Record<string, LockEntry> = {};
  const resolveFrom = (from: string, dep: string): string | undefined => {
    let base = from;
    for (;;) {
      const candidate = `${base ? `${base}/` : ""}node_modules/${dep}`;
      if (all[candidate]) return candidate;
      if (!base) return undefined;
      const i = base.lastIndexOf("node_modules/");
      base = i <= 0 ? "" : base.slice(0, i - 1);
    }
  };
  const visit = (path: string) => {
    if (out[path]) return;
    const entry = all[path]!;
    const { dev, devOptional, ...rest } = entry;
    void dev;
    void devOptional;
    out[path] = rest;
    for (const [deps, optional] of [
      [entry.dependencies, false],
      [entry.optionalDependencies, true],
    ] as const)
      for (const dep of Object.keys(deps ?? {})) {
        const found = resolveFrom(path, dep);
        if (found) visit(found);
        else if (!optional)
          throw new Error(
            `package-lock has no entry for ${dep} (needed by ${path})`,
          );
      }
  };
  for (const name of names) {
    const path = `node_modules/${name}`;
    if (!all[path]) throw new Error(`package-lock has no entry for ${name}`);
    visit(path);
  }
  return out;
}

/** Lists the bare package imports reachable from `entry`. */
export async function importedPackages(entry: string): Promise<string[]> {
  const found = new Set<string>();
  const collect: Plugin = {
    name: "collect-packages",
    setup(b) {
      b.onResolve({ filter: /^[^./]/ }, (args) => {
        if (!isBuiltin(args.path)) found.add(packageName(args.path));
        return { path: args.path, external: true };
      });
    },
  };
  await build({
    entryPoints: [entry],
    bundle: true,
    write: false,
    platform: "node",
    format: "esm",
    plugins: [collect],
    logLevel: "error",
  });
  return [...found].sort();
}

/** Installs `names` at the versions locked by the ref into `<dir>/node_modules`. */
export function installLocked(
  dir: string,
  names: string[],
  log: (line: string) => void,
): Record<string, string> {
  if (!names.length) return {};
  const depsDir = join(dir, "_deps");
  mkdirSync(depsDir, { recursive: true });
  const lockPath = join(dir, "package-lock.json");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as {
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const versions: Record<string, string> = {};
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Lockfile;
    const subset = lockSubset(lock, names);
    for (const name of names)
      versions[name] = subset[`node_modules/${name}`]!.version ?? "?";
    const root = {
      name: "module-deps",
      version: "0.0.0",
      dependencies: versions,
    };
    writeFileSync(join(depsDir, "package.json"), JSON.stringify(root, null, 2));
    writeFileSync(
      join(depsDir, "package-lock.json"),
      JSON.stringify(
        {
          name: root.name,
          version: root.version,
          lockfileVersion: 3,
          requires: true,
          packages: { "": root, ...subset },
        },
        null,
        2,
      ),
    );
    log(
      `  installing ${names.map((n) => `${n}@${versions[n]}`).join(", ")} (locked by the ref)`,
    );
    execFileSync(
      "npm",
      ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"],
      { cwd: depsDir, stdio: ["ignore", "ignore", "inherit"] },
    );
  } else {
    for (const name of names)
      versions[name] =
        pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? "latest";
    writeFileSync(
      join(depsDir, "package.json"),
      JSON.stringify(
        { name: "module-deps", version: "0.0.0", dependencies: versions },
        null,
        2,
      ),
    );
    log(
      `  installing ${names.map((n) => `${n}@${versions[n]}`).join(", ")} (no package-lock in the ref: package.json ranges)`,
    );
    execFileSync(
      "npm",
      [
        "install",
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--loglevel=error",
      ],
      { cwd: depsDir, stdio: ["ignore", "ignore", "inherit"] },
    );
    for (const name of names)
      versions[name] = (
        JSON.parse(
          readFileSync(
            join(depsDir, "node_modules", name, "package.json"),
            "utf8",
          ),
        ) as { version: string }
      ).version;
  }
  renameSync(join(depsDir, "node_modules"), join(dir, "node_modules"));
  rmSync(depsDir, { recursive: true, force: true });
  return versions;
}

/** An esbuild plugin that resolves bare imports only from `dir`'s own install (never the bench's), except `external` ones. */
export const refPackagesOnly = (
  dir: string,
  external: readonly string[] = [],
): Plugin => ({
  name: "ref-packages-only",
  setup(b) {
    b.onResolve({ filter: /^[^./]/ }, async (args) => {
      if (isBuiltin(args.path) || args.pluginData === "inner") return undefined;
      if (external.includes(packageName(args.path)))
        return { path: args.path, external: true };
      const result = await b.resolve(args.path, {
        resolveDir: args.resolveDir,
        kind: args.kind,
        pluginData: "inner",
      });
      if (result.errors.length) return result;
      if (!result.path.startsWith(join(dir, "node_modules")))
        return {
          errors: [
            {
              text: `${args.path} resolved outside the ref's locked packages (${result.path})`,
            },
          ],
        };
      return result;
    });
  },
});

// ------------------------------------------------------------ materialize

const lockedVersion = (lock: Lockfile, name: string) =>
  lock.packages?.[`node_modules/${name}`]?.version;

/** Resolves and materializes a ref; cached per commit sha. */
export async function materializeModule(
  repo: string,
  ref: string,
  log: (line: string) => void = console.log,
): Promise<ModuleRef> {
  const { sha, subject, committedAt } = resolveCommit(repo, ref);
  const dir = join(MODULE_CACHE_DIR, sha);
  const metaFile = join(dir, "module.json");
  const fresh =
    existsSync(metaFile) &&
    (JSON.parse(readFileSync(metaFile, "utf8")) as { version: number })
      .version === BUNDLE_VERSION;
  if (!fresh) {
    log(`materializing the redaction module of ${ref} (${sha.slice(0, 8)})`);
    const staging = `${dir}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      archiveCommit(
        repo,
        sha,
        ["src", "package.json", "package-lock.json"],
        staging,
      );
      const modules: Partial<Record<ModuleName, string>> = {};
      for (const m of LAYOUT) {
        const file = m.files.find((f) => existsSync(join(staging, f)));
        if (file) modules[m.name] = file;
      }
      const missing = LAYOUT.filter((m) => m.required && !modules[m.name]);
      if (missing.length)
        throw new Error(
          `Ref ${ref} (${sha.slice(0, 8)}) lacks ${missing.map((m) => m.files.join(" or ")).join(", ")}; the bench cannot drive it.`,
        );
      const entry = join(staging, "module-entry.ts");
      writeFileSync(
        entry,
        Object.entries(modules)
          .map(([name, file]) => `export * as ${name} from "./${file}";`)
          .join("\n") + "\n",
      );
      const lock = existsSync(join(staging, "package-lock.json"))
        ? (JSON.parse(
            readFileSync(join(staging, "package-lock.json"), "utf8"),
          ) as Lockfile)
        : {};
      // PDFium is loaded by the ref's document worker, not imported by the reader (types only): install it too.
      const extra =
        modules.documentReader &&
        lock.packages?.["node_modules/@embedpdf/pdfium"]
          ? ["@embedpdf/pdfium"]
          : [];
      const imported = (await importedPackages(entry)).filter(
        (p) => !BENCH_SUPPLIED.includes(p),
      );
      const packages = installLocked(
        staging,
        [...new Set([...imported, ...extra])].sort(),
        log,
      );
      await build({
        entryPoints: [entry],
        outfile: join(staging, "module.mjs"),
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node20",
        nodePaths: [],
        plugins: [refPackagesOnly(staging, BENCH_SUPPLIED)],
        logLevel: "error",
      });
      const runtime = Object.fromEntries(
        ["@huggingface/transformers", "onnxruntime-web"].flatMap((name) => {
          const v = lockedVersion(lock, name);
          return v ? [[name, v]] : [];
        }),
      );
      const wasm = "node_modules/@embedpdf/pdfium/dist/pdfium.wasm";
      writeFileSync(
        join(staging, "module.json"),
        JSON.stringify(
          {
            version: BUNDLE_VERSION,
            modules,
            packages,
            runtime,
            pdfiumWasm: existsSync(join(staging, wasm)) ? wasm : null,
          },
          null,
          2,
        ) + "\n",
      );
      rmSync(dir, { recursive: true, force: true });
      mkdirSync(MODULE_CACHE_DIR, { recursive: true });
      renameSync(staging, dir);
    } finally {
      rmSync(staging, { recursive: true, force: true });
    }
  }
  const meta = JSON.parse(readFileSync(metaFile, "utf8")) as Pick<
    ModuleRef,
    "modules" | "packages" | "runtime"
  > & { pdfiumWasm: string | null };
  return {
    ref,
    sha,
    subject,
    committedAt,
    dir,
    bundle: join(dir, "module.mjs"),
    modules: meta.modules,
    packages: meta.packages,
    runtime: meta.runtime,
    ...(meta.pdfiumWasm ? { pdfiumWasm: join(dir, meta.pdfiumWasm) } : {}),
  };
}

/** The bench's own versions of the packages it supplies, against the ones the ref locks; empty when they agree. */
export function runtimeMismatches(ref: Pick<ModuleRef, "runtime">): string[] {
  const installed = (name: string) => {
    const file = join(ROOT, "node_modules", name, "package.json");
    return existsSync(file)
      ? (JSON.parse(readFileSync(file, "utf8")) as { version: string }).version
      : undefined;
  };
  return Object.entries(ref.runtime).flatMap(([name, locked]) => {
    const own = installed(name);
    return own === locked
      ? []
      : [
          `${name}: the ref locks ${locked}, the bench runs ${own ?? "nothing"}`,
        ];
  });
}
