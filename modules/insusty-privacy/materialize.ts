/**
 * The one materializer: turns a git ref of the extension into its redaction
 * package, `insusty-prompt-coach/redaction`, installed for that commit
 * alone, without touching the extension clone.
 *
 *   1. The clone resolves the ref to a commit (read-only: `rev-parse`,
 *      `show`). A commit whose `package.json` does not export
 *      `./redaction` predates the package (extension PR #132) and is
 *      refused.
 *   2. npm installs `github:mmarsot/InsustyPromptCoach#<sha>` into
 *      `cache/module/<sha>/` (its `prepare` builds the package; a commit
 *      GitHub does not have, such as an unpushed branch, comes from
 *      `git+file://<clone>#<sha>` instead, which npm only reads), next to
 *      the `@embedpdf/pdfium` version the commit's lockfile pins, which the
 *      bench supplies to the package. Each commit gets its own install, so
 *      several refs score side by side and the bench's own lockfile never
 *      changes.
 *
 * Everything is cached per commit sha; after the first install a ref loads
 * offline. `insusty.ts` turns the package into the module the bench scores.
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
import { join } from "node:path";
import { CACHE_DIR, ROOT } from "../../engine/paths.ts";

/** Installed refs, one folder per commit sha. */
export const MODULE_CACHE_DIR = join(CACHE_DIR, "module");

/** The extension's package and the repository npm installs it from. */
export const EXT_PACKAGE = "insusty-prompt-coach";
const EXT_SOURCE = "github:mmarsot/InsustyPromptCoach";
/** The package's one subpath, and the extension PR that added it. */
const EXT_SUBPATH = "./redaction";
const PACKAGE_PR = "#132";

/** Bump when the install changes, so cached installs are redone. */
const INSTALL_VERSION = 2;

/** An installed ref: its commit and its package. */
export interface ModuleRef {
  ref: string;
  sha: string;
  subject: string;
  committedAt: string;
  dir: string;
  /** The package's JavaScript entry (`insusty-prompt-coach/redaction`). */
  entry: string;
  /** PDFium's folder (`@embedpdf/pdfium`), when the ref's lockfile pins it. */
  pdfium?: string;
  /** What the install holds: the package at the sha, PDFium at its locked version. */
  packages: Record<string, string>;
  /** Inference runtime versions the ref's lockfile pins (the bench supplies these packages). */
  runtime: Record<string, string>;
}

const git = (repo: string, args: string[]): string =>
  execFileSync("git", ["-C", repo, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    maxBuffer: 64 * 1024 * 1024,
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

/** A JSON file of a commit, read from the clone's object store; undefined when absent. */
const showJson = <T>(
  repo: string,
  sha: string,
  path: string,
): T | undefined => {
  try {
    return JSON.parse(git(repo, ["show", `${sha}:${path}`])) as T;
  } catch {
    return undefined;
  }
};

interface PackageJson {
  exports?: Record<string, unknown>;
}

/** The file the package's `exports` map gives for `./redaction` under Node's `import` (conditions `import`, `node`, `default`). */
function redactionTarget(pkg: PackageJson): string | undefined {
  const pick = (target: unknown): string | undefined => {
    if (typeof target === "string") return target;
    if (!target || typeof target !== "object") return undefined;
    for (const [condition, value] of Object.entries(target))
      if (["import", "node", "default"].includes(condition)) {
        const found = pick(value);
        if (found) return found;
      }
    return undefined;
  };
  return pick(pkg.exports?.[EXT_SUBPATH]);
}
interface Lockfile {
  packages?: Record<string, { version?: string }>;
}
const lockedVersion = (lock: Lockfile | undefined, name: string) =>
  lock?.packages?.[`node_modules/${name}`]?.version;

/** Whether a commit's package.json lacks the `./redaction` export. */
const withoutPackage = (pkg: PackageJson | undefined): boolean =>
  !pkg || redactionTarget(pkg) === undefined;

const predates = (ref: string, sha: string) =>
  new Error(
    `${ref} (${sha.slice(0, 8)}) predates the redaction package (extension PR ${PACKAGE_PR}): its package.json does not export ${EXT_PACKAGE}/redaction, which is the only way the bench scores a ref. Score a later ref.`,
  );

/** Installs `dependencies` into `dir` with npm; throws with npm's error output. */
function installInto(dir: string, dependencies: Record<string, string>) {
  writeFileSync(
    join(dir, "package.json"),
    JSON.stringify(
      {
        name: "ext-package",
        version: "0.0.0",
        private: true,
        dependencies,
      },
      null,
      2,
    ) + "\n",
  );
  try {
    // Not --ignore-scripts: npm builds the git dependency with its `prepare`.
    execFileSync(
      "npm",
      ["install", "--no-audit", "--no-fund", "--loglevel=error"],
      { cwd: dir, stdio: ["ignore", "ignore", "pipe"] },
    );
  } catch (error) {
    throw new Error(
      String((error as { stderr?: unknown }).stderr ?? error).trim(),
    );
  }
}

/** Resolves a ref and installs its package; cached per commit sha. */
export async function materializeModule(
  repo: string,
  ref: string,
  log: (line: string) => void = console.log,
): Promise<ModuleRef> {
  const { sha, subject, committedAt } = resolveCommit(repo, ref);
  if (withoutPackage(showJson<PackageJson>(repo, sha, "package.json")))
    throw predates(ref, sha);
  const lock = showJson<Lockfile>(repo, sha, "package-lock.json");
  const pdfium = lockedVersion(lock, "@embedpdf/pdfium");
  const runtime = Object.fromEntries(
    ["@huggingface/transformers", "onnxruntime-web"].flatMap((name) => {
      const version = lockedVersion(lock, name);
      return version ? [[name, version]] : [];
    }),
  );
  const dir = join(MODULE_CACHE_DIR, sha);
  const marker = join(dir, "installed.json");
  const fresh =
    existsSync(marker) &&
    (JSON.parse(readFileSync(marker, "utf8")) as { version: number })
      .version === INSTALL_VERSION;
  if (!fresh) {
    const staging = `${dir}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    try {
      // GitHub first; a commit it does not have (an unpushed branch) comes from the clone, read-only.
      const failures: string[] = [];
      for (const source of [EXT_SOURCE, `git+file://${repo}`]) {
        log(
          `installing ${EXT_PACKAGE} at ${ref} (${sha.slice(0, 8)}) from ${source}`,
        );
        try {
          installInto(staging, {
            [EXT_PACKAGE]: `${source}#${sha}`,
            ...(pdfium ? { "@embedpdf/pdfium": pdfium } : {}),
          });
          failures.length = 0;
          break;
        } catch (error) {
          failures.push(`${source}: ${(error as Error).message}`);
        }
      }
      if (failures.length)
        throw new Error(
          `npm could not install ${EXT_PACKAGE} at ${sha} (the GitHub repository is private: git needs credentials for github.com, such as \`gh auth setup-git\`):\n${failures.join("\n")}`,
        );
      const installed = JSON.parse(
        readFileSync(
          join(staging, "node_modules", EXT_PACKAGE, "package.json"),
          "utf8",
        ),
      ) as PackageJson;
      if (withoutPackage(installed)) throw predates(ref, sha);
      writeFileSync(
        marker.replace(dir, staging),
        JSON.stringify(
          {
            version: INSTALL_VERSION,
            packages: (
              JSON.parse(
                readFileSync(join(staging, "package.json"), "utf8"),
              ) as {
                dependencies: Record<string, string>;
              }
            ).dependencies,
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
  const modules = join(dir, "node_modules");
  const { packages } = JSON.parse(readFileSync(marker, "utf8")) as {
    packages: Record<string, string>;
  };
  const packageDir = join(modules, EXT_PACKAGE);
  const target = redactionTarget(
    JSON.parse(
      readFileSync(join(packageDir, "package.json"), "utf8"),
    ) as PackageJson,
  );
  if (!target) throw predates(ref, sha);
  return {
    ref,
    sha,
    subject,
    committedAt,
    dir,
    entry: join(packageDir, target),
    ...(pdfium ? { pdfium: join(modules, "@embedpdf", "pdfium") } : {}),
    packages,
    runtime,
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
