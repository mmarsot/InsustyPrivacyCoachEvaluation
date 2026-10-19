/**
 * Which grid rows of insusty-privacy a change to the extension needs, from
 * the paths `git diff --name-only <base>...<ref>` lists in the clone
 * (`npm run suite -- --since <base>`, `engine/suite.ts`). The two tracks are
 * slices of the grid:
 *
 * - **deterministic**: the `rules` and `rules-all` rows × insusty-builtin,
 *   insusty-documents (suite and sweeps), tab, gretel and nemotron, plus
 *   contract conformance (and the presidio row on `--full`);
 * - **private-ai**: the `smollm2-360m` row (and `glm47-flash-connected` with
 *   `--connected`: it is paid) × insusty-custom and insusty-documents' Private
 *   AI suite, plus request parity with the lab's shipped baseline.
 *
 * A change to the deterministic rules reruns only the deterministic track; a
 * change to document reading or OCR both (Private AI reads documents through
 * them); a Private AI change only the Private AI track.
 */
export type Track = "deterministic" | "private-ai";

/** The insusty-privacy configurations (grid rows) each track reruns. */
export const TRACK_CONFIGURATIONS: Record<Track, string[]> = {
  deterministic: ["rules", "rules-all"],
  "private-ai": ["smollm2-360m", "glm47-flash-connected"],
};

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
