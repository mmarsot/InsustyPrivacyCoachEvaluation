/**
 * Materializes an extension ref's rule-based detector (`src/detector.ts`,
 * `detectSensitiveData`) and wraps it for scoring.
 *
 *   1. `git archive` copies the ref's `src`, `package.json` and
 *      `package-lock.json` into `cache/detbench/ext/<sha>/` (the clone is never
 *      touched).
 *   2. A first esbuild pass lists the npm packages the detector imports
 *      (libphonenumber-js, addressit, and whatever a later ref adds).
 *   3. Those packages, with their dependencies, are installed at the exact
 *      versions of the ref's package-lock (`npm ci` on a lockfile subset), so
 *      phone metadata and validators match what that commit ships.
 *   4. esbuild bundles the detector and `config.ts` into `bench-detector.mjs`.
 *
 * Everything is cached per commit sha; after the first run a ref loads offline.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { builtinModules } from "node:module";
import { pathToFileURL } from "node:url";
import { build, type Plugin } from "esbuild";
import { CACHE_DIR } from "../paths.ts";
import { archiveCommit, resolveCommit } from "../ext/ref.ts";
import { DET_CATEGORIES, type DetCategory } from "./schema.ts";

export const DETECTOR_CACHE_DIR = join(CACHE_DIR, "detbench", "ext");

export interface DetectorRef {
  ref: string;
  sha: string;
  subject: string;
  committedAt: string;
  dir: string;
  bundle: string;
  /** npm packages bundled with the detector, at the ref's locked versions. */
  packages: Record<string, string>;
}

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

const packageName = (spec: string) => (spec.startsWith("@") ? spec.split("/").slice(0, 2).join("/") : spec.split("/")[0]!);
export const isBuiltin = (spec: string) => spec.startsWith("node:") || builtinModules.includes(packageName(spec));

/**
 * The lockfile entries needed to install `names` and their dependencies,
 * following npm's nested `node_modules` resolution.
 */
export function lockSubset(lock: Lockfile, names: string[]): Record<string, LockEntry> {
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
        else if (!optional) throw new Error(`package-lock has no entry for ${dep} (needed by ${path})`);
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
  await build({ entryPoints: [entry], bundle: true, write: false, platform: "node", format: "esm", plugins: [collect], logLevel: "error" });
  return [...found].sort();
}

/** Installs `names` at the versions locked by the ref into `<dir>/node_modules`. */
export function installLocked(dir: string, names: string[], log: (line: string) => void): Record<string, string> {
  if (!names.length) return {};
  const depsDir = join(dir, "_deps");
  mkdirSync(depsDir, { recursive: true });
  const lockPath = join(dir, "package-lock.json");
  const pkg = JSON.parse(readFileSync(join(dir, "package.json"), "utf8")) as { dependencies?: Record<string, string>; devDependencies?: Record<string, string> };
  const versions: Record<string, string> = {};
  if (existsSync(lockPath)) {
    const lock = JSON.parse(readFileSync(lockPath, "utf8")) as Lockfile;
    const subset = lockSubset(lock, names);
    for (const name of names) versions[name] = subset[`node_modules/${name}`]!.version ?? "?";
    const root = { name: "detbench-deps", version: "0.0.0", dependencies: versions };
    writeFileSync(join(depsDir, "package.json"), JSON.stringify(root, null, 2));
    writeFileSync(
      join(depsDir, "package-lock.json"),
      JSON.stringify({ name: root.name, version: root.version, lockfileVersion: 3, requires: true, packages: { "": root, ...subset } }, null, 2),
    );
    log(`  installing ${names.map((n) => `${n}@${versions[n]}`).join(", ")} (locked by the ref)`);
    execFileSync("npm", ["ci", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: depsDir, stdio: ["ignore", "ignore", "inherit"] });
  } else {
    for (const name of names) versions[name] = pkg.dependencies?.[name] ?? pkg.devDependencies?.[name] ?? "latest";
    writeFileSync(join(depsDir, "package.json"), JSON.stringify({ name: "detbench-deps", version: "0.0.0", dependencies: versions }, null, 2));
    log(`  installing ${names.map((n) => `${n}@${versions[n]}`).join(", ")} (no package-lock in the ref: package.json ranges)`);
    execFileSync("npm", ["install", "--ignore-scripts", "--no-audit", "--no-fund", "--loglevel=error"], { cwd: depsDir, stdio: ["ignore", "ignore", "inherit"] });
    for (const name of names)
      versions[name] = (JSON.parse(readFileSync(join(depsDir, "node_modules", name, "package.json"), "utf8")) as { version: string }).version;
  }
  renameSync(join(depsDir, "node_modules"), join(dir, "node_modules"));
  rmSync(depsDir, { recursive: true, force: true });
  return versions;
}

/** Where a ref keeps its detector and its config: flat `src/` before PR #82 grouped it into folders. */
const DETECTOR_LAYOUTS = [
  ["src/detector.ts", "src/detection/detector.ts"],
  ["src/config.ts", "src/config/config.ts"],
];

/** Resolves and materializes the detector of a ref; cached per commit sha. */
export async function materializeDetector(repo: string, ref: string, log: (line: string) => void = console.log): Promise<DetectorRef> {
  const { sha, subject, committedAt } = resolveCommit(repo, ref);
  const dir = join(DETECTOR_CACHE_DIR, sha);
  const bundle = join(dir, "bench-detector.mjs");
  const packagesFile = join(dir, "packages.json");
  if (!existsSync(bundle) || !existsSync(packagesFile)) {
    log(`materializing the detector of ${ref} (${sha.slice(0, 8)})`);
    const staging = `${dir}.staging-${process.pid}`;
    rmSync(staging, { recursive: true, force: true });
    mkdirSync(staging, { recursive: true });
    archiveCommit(repo, sha, ["src", "package.json", "package-lock.json"], staging);
    const [detectorFile, configFile] = DETECTOR_LAYOUTS.map((files) => files.find((file) => existsSync(join(staging, file))));
    if (!detectorFile || !configFile)
      throw new Error(`Ref ${ref} (${sha.slice(0, 8)}) has no ${DETECTOR_LAYOUTS.map((files) => files.join(" or ")).join(" and ")}; detbench cannot drive it.`);
    const entry = join(staging, "bench-detector-entry.ts");
    writeFileSync(entry, `export * as detector from "./${detectorFile}";\nexport * as config from "./${configFile}";\n`);
    const packages = installLocked(staging, await importedPackages(entry), log);
    await build({
      entryPoints: [entry],
      outfile: join(staging, "bench-detector.mjs"),
      bundle: true,
      platform: "node",
      format: "esm",
      target: "node20",
      // Resolve packages only from the ref's own install, never from the bench's node_modules.
      nodePaths: [],
      plugins: [
        {
          name: "ref-packages-only",
          setup(b) {
            b.onResolve({ filter: /^[^./]/ }, async (args) => {
              if (isBuiltin(args.path) || args.pluginData === "inner") return undefined;
              const result = await b.resolve(args.path, { resolveDir: args.resolveDir, kind: args.kind, pluginData: "inner" });
              if (result.errors.length) return result;
              if (!result.path.startsWith(join(staging, "node_modules")))
                return { errors: [{ text: `${args.path} resolved outside the ref's locked packages (${result.path})` }] };
              return result;
            });
          },
        },
      ],
      logLevel: "error",
    });
    writeFileSync(join(staging, "packages.json"), JSON.stringify(packages, null, 2) + "\n");
    rmSync(dir, { recursive: true, force: true });
    mkdirSync(DETECTOR_CACHE_DIR, { recursive: true });
    renameSync(staging, dir);
  }
  const packages = JSON.parse(readFileSync(packagesFile, "utf8")) as Record<string, string>;
  return { ref, sha, subject, committedAt, dir, bundle, packages };
}

// ------------------------------------------------------------ adapter

/**
 * Ref category names mapped to the dataset's categories. Today's `API_KEY` is
 * the upgrade's `SECRET`; the other aliases cover plausible spellings of the
 * new categories so a ref that picks one of them is scored without edits.
 * SIREN, SIRET and VAT numbers are `COMPANY_ID`, as in the upgrade: a ref that
 * files them under `NATIONAL_ID` scores them as wrong category.
 */
export const CATEGORY_ALIASES: Record<string, DetCategory> = {
  API_KEY: "SECRET",
  SECRET: "SECRET",
  PRIVATE_KEY: "SECRET",
  PASSWORD: "SECRET",
  CREDENTIAL: "SECRET",
  EMAIL: "EMAIL",
  PHONE: "PHONE",
  ADDRESS: "ADDRESS",
  FINANCIAL: "FINANCIAL",
  IBAN: "FINANCIAL",
  CARD: "FINANCIAL",
  NATIONAL_ID: "NATIONAL_ID",
  DATE_OF_BIRTH: "DATE_OF_BIRTH",
  DOB: "DATE_OF_BIRTH",
  IP: "IP",
  IP_ADDRESS: "IP",
  NETWORK: "IP",
  COMPANY_ID: "COMPANY_ID",
  COMPANY: "COMPANY_ID",
  BUSINESS_ID: "COMPANY_ID",
};
export const mapCategory = (category: string): DetCategory | null =>
  CATEGORY_ALIASES[category] ?? ((DET_CATEGORIES as readonly string[]).includes(category) ? (category as DetCategory) : null);

export interface RefDetection {
  /** The ref's own category name. */
  category: string;
  /** The dataset category it maps to, or null for a category the dataset does not know. */
  mapped: DetCategory | null;
  start: number;
  end: number;
  value: string;
  source: string;
  selected: boolean;
}

export type DetConfigName = "default" | "all";

export interface DetectorApi {
  /** The ref's `CATEGORIES`. */
  refCategories: string[];
  /** Dataset categories this ref can report. */
  supported: DetCategory[];
  configs: Record<DetConfigName, Record<string, unknown>>;
  /** What the "all" configuration changes from the default, for the report. */
  allConfigNote: string;
  detect(text: string, config: DetConfigName): RefDetection[];
}

type RawDetection = { category: string; start: number; end: number; value: string; source?: string; selected?: boolean };

/**
 * Loads a materialized detector bundle. `default` is the ref's
 * `DEFAULT_CONFIG`; `all` turns every category on and adds every supported
 * address country.
 */
export async function loadDetector(bundle: string): Promise<DetectorApi> {
  const mod = (await import(pathToFileURL(bundle).href)) as {
    detector: { detectSensitiveData?: (text: string, config: unknown) => RawDetection[] };
    config: { DEFAULT_CONFIG?: Record<string, unknown>; CATEGORIES?: string[]; SUPPORTED_ADDRESS_COUNTRIES?: readonly string[] };
  };
  const detect = mod.detector.detectSensitiveData;
  const base = mod.config.DEFAULT_CONFIG;
  if (typeof detect !== "function") throw new Error("The ref does not export detectSensitiveData from src/detector.ts.");
  if (!base) throw new Error("The ref does not export DEFAULT_CONFIG from src/config.ts.");
  const baseCategories = (base.categories ?? {}) as Record<string, boolean>;
  const refCategories = mod.config.CATEGORIES ?? Object.keys(baseCategories);
  const all = structuredClone(base);
  all.categories = Object.fromEntries(refCategories.map((c) => [c, true]));
  const notes: string[] = [];
  const off = refCategories.filter((c) => baseCategories[c] === false);
  if (off.length) notes.push(`turns on ${off.join(", ")}`);
  if (mod.config.SUPPORTED_ADDRESS_COUNTRIES && Array.isArray(base.addressCountries)) {
    const countries = [...mod.config.SUPPORTED_ADDRESS_COUNTRIES];
    all.addressCountries = countries;
    const added = countries.filter((c) => !(base.addressCountries as string[]).includes(c));
    if (added.length) notes.push(`adds address countries ${added.join(", ")}`);
  }
  const configs: Record<DetConfigName, Record<string, unknown>> = { default: structuredClone(base), all };
  return {
    refCategories,
    supported: [...new Set(refCategories.map(mapCategory).filter((c): c is DetCategory => c !== null))],
    configs,
    allConfigNote: notes.length ? notes.join("; ") : "same as default",
    detect: (text, name) =>
      detect(text, configs[name]).map((d) => ({
        category: d.category,
        mapped: mapCategory(d.category),
        start: d.start,
        end: d.end,
        value: d.value ?? text.slice(d.start, d.end),
        source: d.source ?? "",
        selected: d.selected !== false,
      })),
  };
}
