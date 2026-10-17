/**
 * The two benchmark tracks, and which of them a change to the extension
 * needs. Benchmarks run with parsimony: a change to the deterministic rules
 * reruns only the deterministic track; a change to document reading or OCR
 * reruns both (Private AI reads documents through them); a Private AI change
 * reruns only the Private AI track; the full suite runs only on request.
 *
 * - **deterministic**: contract conformance, detbench (our prompts),
 *   docbench (our documents), and the literature adapters (TAB, Gretel,
 *   Nemotron-PII), with the Presidio baseline on full runs. CI fails on a
 *   regression here.
 * - **private-ai**: request parity with the lab's shipped baseline (no model,
 *   no network; CI fails on a difference), then the custom-label review
 *   suites on the shipped on-device model (SmolLM2) and the connected model
 *   (GLM-4.7 Flash, only with `--connected`: it is paid), and Private AI on
 *   documents. CI runs its smoke tier on Private AI changes, without failing
 *   on score deltas.
 */
export type Track = "deterministic" | "private-ai";

/** Which tracks a changed extension path needs, and why. */
export interface ChangeRule {
  /** Matches a path of the extension repository. */
  pattern: RegExp;
  tracks: Track[];
  why: string;
}

/** First match wins. Paths no rule matches (UI, capture, sync...) need no benchmark. */
export const CHANGE_RULES: ChangeRule[] = [
  {
    pattern: /^package(-lock)?\.json$/,
    tracks: ["deterministic", "private-ai"],
    why: "dependencies (validators, PDFium, OCR or the inference runtime)",
  },
  {
    pattern:
      /^src\/files\/(readers|ocr)\/|^src\/files\/(file-check|document-model)\.ts$|^src\/(document-worker|offscreen)\.ts$|^src\/(file-check|document-reader|document-model|ocr[^/]*)\.ts$/,
    tracks: ["deterministic", "private-ai"],
    why: "document reading or OCR",
  },
  {
    pattern: /^src\/config\/|^src\/config\.ts$/,
    tracks: ["deterministic", "private-ai"],
    why: "configuration (categories, address countries, Private AI settings)",
  },
  {
    pattern:
      /^src\/detection\/|^src\/(detector|detector-rules|secret-rules[^/]*|redaction)\.ts$/,
    tracks: ["deterministic"],
    why: "deterministic rules",
  },
  {
    pattern:
      /^src\/private-ai\/|^src\/model-worker\.ts$|^src\/background\/(review|connected-model|local-model|label-learning)\.ts$|^src\/labels\/|^src\/(slm-[^/]*|hosted-[^/]*|model-client)\.ts$/,
    tracks: ["private-ai"],
    why: "Private AI (prompting, engine, models, connected client, label learning)",
  },
];

/** The tracks a change needs, with the evidence for each. */
export interface Selection {
  tracks: Track[];
  /** Why each track was selected: the matching paths, by rule. */
  reasons: Array<{ why: string; tracks: Track[]; paths: string[] }>;
  /** Changed paths that need no benchmark. */
  ignored: string[];
}

/**
 * The tracks a set of changed extension paths needs: each path takes the first
 * rule it matches.
 */
export function selectTracks(paths: string[]): Selection {
  const reasons = new Map<ChangeRule, string[]>();
  const ignored: string[] = [];
  for (const path of paths) {
    const rule = CHANGE_RULES.find((r) => r.pattern.test(path));
    if (rule) reasons.set(rule, [...(reasons.get(rule) ?? []), path]);
    else ignored.push(path);
  }
  const tracks = new Set<Track>();
  for (const rule of reasons.keys()) for (const t of rule.tracks) tracks.add(t);
  return {
    tracks: (["deterministic", "private-ai"] as const).filter((t) =>
      tracks.has(t),
    ),
    reasons: [...reasons].map(([rule, p]) => ({
      why: rule.why,
      tracks: rule.tracks,
      paths: p,
    })),
    ignored,
  };
}

/** One command of a suite run. */
export interface Step {
  track: Track;
  name: string;
  /** npm script and its arguments. */
  script: string;
  args: string[];
  /** A failing exit fails the suite (CI gates: deterministic regressions, documents, parity). */
  gate: boolean;
}

/** Parsed `npm run suite` arguments. */
export interface SuiteOptions {
  ref: string;
  /** Compare against this ref and fail on a deterministic regression. */
  base?: string;
  tracks: Track[];
  ci: boolean;
  full: boolean;
  connected: boolean;
  extRepo?: string;
  /** Prefix of run names (CI writes to scratch names). */
  namePrefix?: string;
}

/** The commands of the selected tracks, in order. */
export function planSuite(o: SuiteOptions): Step[] {
  const common = [...(o.extRepo ? ["--ext-repo", o.extRepo] : [])];
  const name = (n: string) =>
    o.namePrefix ? ["--name", `${o.namePrefix}-${n}`] : [];
  const steps: Step[] = [];
  if (o.tracks.includes("deterministic")) {
    steps.push({
      track: "deterministic",
      name: "conformance",
      script: "conformance",
      args: ["--ref", o.ref, ...common],
      gate: true,
    });
    steps.push({
      track: "deterministic",
      name: "detbench",
      script: "detbench",
      args: [
        "--ref",
        o.ref,
        ...(o.base ? ["--compare", o.base, "--gate"] : name("detbench")),
        ...common,
      ],
      gate: true,
    });
    steps.push({
      track: "deterministic",
      name: "docbench",
      script: "docbench",
      args: [
        "--ref",
        o.ref,
        "--tier",
        o.ci ? "smoke" : o.full ? "full" : "quick",
        ...(o.base ? ["--compare", o.base, "--gate"] : name("docbench")),
        ...common,
      ],
      gate: true,
    });
    if (!o.ci)
      steps.push({
        track: "deterministic",
        name: "literature",
        script: "literature",
        args: [
          "--ref",
          o.ref,
          "--systems",
          o.full ? "insusty,presidio" : "insusty",
          ...name("literature"),
          ...common,
        ],
        gate: false,
      });
  }
  if (o.tracks.includes("private-ai")) {
    steps.push({
      track: "private-ai",
      name: "parity",
      script: "parity",
      args: ["--ref", o.ref, ...common],
      gate: true,
    });
    steps.push({
      track: "private-ai",
      name: "review (on device)",
      script: "bench",
      args: [
        "--ref",
        o.ref,
        "--tier",
        o.ci ? "smoke" : o.full ? "full" : "quick",
        ...name("review"),
        ...common,
      ],
      gate: false,
    });
    if (o.connected)
      steps.push({
        track: "private-ai",
        name: "review (connected)",
        script: "bench",
        args: [
          "--ref",
          o.ref,
          "--tier",
          o.ci ? "smoke" : "quick",
          "--models",
          "glm47-flash-connected",
          ...name("review-connected"),
          ...common,
        ],
        gate: false,
      });
    if (!o.ci)
      steps.push({
        track: "private-ai",
        name: "documents (Private AI)",
        script: "docbench",
        args: [
          "--ref",
          o.ref,
          "--tracks",
          "ai",
          "--ai",
          o.connected ? "default,glm47-flash-connected" : "default",
          ...name("docbench-ai"),
          ...common,
        ],
        gate: false,
      });
  }
  return steps;
}
