import assert from "node:assert/strict";
import test from "node:test";
import type { Profile } from "../src/dataset/schema.ts";
import { buildRaw, plausibleLines, type RefTexts } from "../src/lab/config.ts";
import { LAB_CONFIGS } from "../src/lab/configs.ts";
import { SHIPPED_COMPONENTS, SHIPPED_CONFIG, shippedOffId } from "../src/lab/shipped.ts";

const ref: RefTexts = { defaultPrompt: "", outputSchema: "", labelHeader: "", builtin: [] };
const profile: Profile = {
  id: "saas-eng" as Profile["id"],
  name: "test",
  persona: "",
  labels: [{ label: "CLIENT", description: "Names of our clients.", examples: ["Acme Corp", "Norvik Dynamics", "Halvard"], counterExamples: ["Google", "IBM"] }],
};

// What the extension's composeLabelPrefix + frameReviewInput + reviewAnswerCue
// render (InsustyPromptCoach src/slm-review.ts, PR #26); checked against the
// materialized ref on every tune96 request when the switches were added.
test("the shipped baseline renders the extension's completion request (EN and FR)", () => {
  const en = "Please tidy up this note about Acme Corp.";
  const rawEn = buildRaw(SHIPPED_CONFIG, profile, ref, en);
  assert.equal(
    rawEn.prefix + rawEn.suffix(en),
    "Copy the CLIENT passages from each text, exactly as written. CLIENT: Names of our clients. Write NONE when the text has none.\n\n" +
      "Text: Quick update before the call: Acme Corp is still on the list for next week, can you tidy up this paragraph?\nCLIENT: Acme Corp\n\n" +
      "Text: Reminder for tomorrow: we need to go over Norvik Dynamics with the team, keep it short.\nCLIENT: Norvik Dynamics\n\n" +
      "Text: Can you rewrite this so it sounds friendlier? Thanks for your patience, we will get back to you shortly.\nCLIENT: NONE\n\n" +
      `Text: ${en}\nCLIENT:`,
  );
  const fr = "Tu peux reformuler le mail pour le client de la semaine ?";
  const rawFr = buildRaw(SHIPPED_CONFIG, profile, ref, fr);
  assert.match(rawFr.prefix, /Text: Petit point avant la réunion : on reparle de Acme Corp jeudi/u);
  assert.match(rawFr.prefix, /Text: Tu peux corriger les fautes \? .* reponse\.\nCLIENT: NONE\n\n$/u);
});

test("every config switch is a registered leave-one-out config that differs from the baseline", () => {
  for (const component of SHIPPED_COMPONENTS) {
    assert.ok(component.off || component.offModel, component.id);
    if (!component.off) continue;
    const off = LAB_CONFIGS[shippedOffId(component)];
    assert.ok(off, shippedOffId(component));
    const changed = Object.keys(component.off).filter((k) => JSON.stringify(off[k as keyof typeof off]) !== JSON.stringify(SHIPPED_CONFIG[k as keyof typeof off]));
    assert.ok(changed.length, `${component.id} changes nothing`);
  }
  assert.equal(LAB_CONFIGS.shipped, SHIPPED_CONFIG);
});

test("the language switch keeps English demonstrations for a French prompt", () => {
  const off = LAB_CONFIGS["shipped-no-lang"]!;
  const raw = buildRaw(off, profile, ref, "Tu peux reformuler le mail pour le client de la semaine ?");
  assert.match(raw.prefix, /Text: Quick update before the call: Acme Corp/u);
});

test("the plausibility filter uses the given predicate and keeps NONE", () => {
  const plausible = (p: string) => p.length >= 3;
  assert.equal(plausibleLines("CLIENT: Acme\nCLIENT: ab", plausible), "CLIENT: Acme");
  assert.equal(plausibleLines("CLIENT: ab", plausible), "NONE");
  assert.equal(plausibleLines("NONE", plausible), "NONE");
});
