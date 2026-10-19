/**
 * How each custom label of a profile is described to a module: a plain user
 * setting in the extension, so every variant here is something a real user
 * could type (insusty-privacy's adapter for this dataset offers them as the
 * `labelVariants` option).
 *
 * The user-editable system instruction was an axis too (`--instructions`);
 * refs since PR #26 take none, so every variant ran the same model call. It
 * was removed; jobs still record `instruction: "current"` (the ref's default
 * prompt) so cache keys and stored results do not change.
 */
import type { LabelSpec } from "./schema.ts";

/** The instruction every job records since the axis was removed (the ref's default prompt). */
export const CURRENT_INSTRUCTION = "current";

/** How a custom label is described (`composeLabelDescription`). */
export type LabelVariantId =
  "desc" | "desc_ex1" | "desc_ex3" | "ex3" | "ex_counter";

/** The label-description variants `--label-variants` picks from. */
export const LABEL_VARIANTS: ReadonlyArray<{
  id: LabelVariantId;
  title: string;
}> = [
  { id: "desc", title: "Description only" },
  { id: "desc_ex1", title: "Description + 1 example" },
  { id: "desc_ex3", title: "Description + 3 examples" },
  { id: "ex3", title: "Examples only (3)" },
  { id: "ex_counter", title: "Examples (3) + counter-examples" },
];

const quoteList = (items: readonly string[]) =>
  items.map((item) => `"${item}"`).join(", ");

/** The text a user would type in "What it should detect" for this label and variant. */
export function composeLabelDescription(
  spec: LabelSpec,
  variant: LabelVariantId,
): string {
  const three = spec.examples.slice(0, 3);
  switch (variant) {
    case "desc":
      return spec.description;
    case "desc_ex1":
      return `${spec.description} Example: "${spec.examples[0]}".`;
    case "desc_ex3":
      return `${spec.description} Examples: ${quoteList(three)}.`;
    case "ex3":
      return `Examples: ${quoteList(three)}.`;
    case "ex_counter":
      return `Examples: ${quoteList(three)}. Not this label: ${quoteList(spec.counterExamples)}.`;
  }
}

/** Whether `value` is a label-variant id. */
export const isLabelVariant = (value: string): value is LabelVariantId =>
  LABEL_VARIANTS.some((variant) => variant.id === value);
