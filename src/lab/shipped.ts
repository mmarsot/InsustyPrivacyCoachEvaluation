/**
 * The Local AI redaction design the extension ships, as a lab baseline with
 * one switch per shipped improvement (ledger: docs/shipped-improvements.md).
 *
 * `SHIPPED_CONFIG` renders the extension's requests (parity: experiments/LOG.md
 * V1, tests/shipped.test.ts). Each component's `off` overrides turn exactly
 * that improvement off on the baseline and become the lab configuration
 * `shipped-no-<id>`; `npm run ablate` runs the leave-one-out grid. A new
 * proposal is a configuration added on top of `shipped` in src/lab/configs.ts.
 *
 * When an improvement ships to the extension: add its setting to
 * `SHIPPED_CONFIG`, a component here, and a ledger entry. Never change what an
 * existing switch means (results are cached by rendered prompt); add a new one.
 */
import { REF_CONFIG, withOverrides, type LabConfig } from "./config.ts";

const EXT_PR = (n: number) => `https://github.com/mmarsot/InsustyPromptCoach/pull/${n}`;

/** Default model of the extension, and the previous default the model switch falls back to. */
export const SHIPPED_MODEL = "smollm2-360m";

export const SHIPPED_CONFIG: LabConfig = withOverrides(REF_CONFIG, "shipped", {
  note: "Extension as shipped (PR #26): per-label completion, example demos, NONE last, first line, pinned greedy, plausibility filter",
  raw: true,
  perLabel: true,
  passageOnly: true,
  instruction: "Copy the {label} passages from each text, exactly as written. {label}: {description} Write NONE when the text has none.",
  schema: "",
  labelHeader: "",
  labelLine: "",
  blockOrder: "i",
  // Built-in labels stay with the deterministic detector.
  builtinLabels: false,
  shots: ["ex-pos-auto", "clean-neg-auto"],
  demoLanguage: "auto",
  user: "Text: {text}\n",
  prefill: "{label}:",
  stopAtNewline: true,
  maxNewTokens: 48,
  repetitionPenalty: 1,
  noRepeatNgram: 0,
  plausibilityFilter: true,
});

export interface ShippedComponent {
  /** Switch id: the leave-one-out configuration is `shipped-no-<id>`. */
  id: string;
  title: string;
  pr: string;
  /** Overrides that turn this improvement off on the baseline. */
  off?: Partial<LabConfig>;
  /** Model switch: the baseline runs on this model instead. */
  offModel?: string;
  /** What "off" means, for tables and the ledger. */
  offNote: string;
}

export const SHIPPED_COMPONENTS: ShippedComponent[] = [
  {
    id: "completion",
    title: "Completion framing instead of chat",
    pr: EXT_PR(26),
    off: { raw: false, system: "{instructions}" },
    offNote: "same instruction as the system message, demonstrations as prior chat turns, the model's chat template",
  },
  {
    id: "perlabel",
    title: "One request per custom label",
    pr: EXT_PR(26),
    off: {
      perLabel: false,
      passageOnly: false,
      instruction:
        "Copy the passages of each text that match a label below, exactly as written, one per line as LABEL: passage. Write NONE when the text has none.",
      labelLine: "{label}: {description}",
      blockOrder: "il",
      shots: ["labelex-auto", "clean-neg-auto"],
      prefill: "",
      // One request answers every label, so it may write several lines: the
      // ref's line-protocol stop (blank line, NONE, repeat) replaces the first-line stop.
      stopAtNewline: false,
    },
    offNote: "one request for all custom labels: every label listed, two demos per label answered `LABEL: passage`, multi-line answer (ref line stop), 48-token cap",
  },
  {
    id: "examples",
    title: "Label-example demonstrations",
    pr: EXT_PR(26),
    off: { shots: ["clean-neg-auto"] },
    offNote: "description only: the NONE demonstration alone (what a label without examples gets)",
  },
  {
    id: "lang",
    title: "Language-matched demonstrations",
    pr: EXT_PR(26),
    off: { demoLanguage: "en" },
    offNote: "English carrier sentences and NONE text for every prompt",
  },
  {
    id: "nonelast",
    title: "NONE demonstration last",
    pr: EXT_PR(26),
    off: { shots: ["clean-neg-auto", "ex-pos-auto"] },
    offNote: "NONE demonstration first, example demonstrations last",
  },
  {
    id: "firstline",
    title: "First-line stop with a 48-token cap",
    pr: EXT_PR(26),
    off: { stopAtNewline: false, maxNewTokens: 0 },
    offNote: "no cap; the ref's line-protocol stop (blank line, NONE, repeated line), EOS or the 30 s deadline; every answer line parsed",
  },
  {
    id: "pinned",
    title: "Pinned greedy decoding (repetition_penalty 1, no_repeat_ngram_size 0)",
    pr: EXT_PR(26),
    off: { repetitionPenalty: null, noRepeatNgram: null },
    offNote: "penalties from the model's generation_config.json (greedy kept; SmolLM2 ships none, Qwen2.5 ships repetition_penalty 1.1)",
  },
  {
    id: "plausible",
    title: "Basic plausibility filter",
    pr: EXT_PR(26),
    off: { plausibilityFilter: false },
    offNote: "every anchored passage kept",
  },
  {
    id: "model",
    title: "SmolLM2-360M default, SmolLM2-135M removed",
    pr: EXT_PR(26),
    offModel: "smollm2-135m",
    offNote: "baseline on SmolLM2-135M, the previous default",
  },
];

export const shippedOffId = (component: ShippedComponent) => `shipped-no-${component.id}`;

/** `shipped` and one `shipped-no-<id>` configuration per config switch. */
export function shippedConfigs(): LabConfig[] {
  return [
    SHIPPED_CONFIG,
    ...SHIPPED_COMPONENTS.filter((c) => c.off).map((c) =>
      withOverrides(SHIPPED_CONFIG, shippedOffId(c), { note: `shipped without: ${c.title} (${c.offNote})`, ...c.off }),
    ),
  ];
}
