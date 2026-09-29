/**
 * Connection check for hosted models, like the extension's "Test
 * connection": one synthetic per-label review request (fictional text, no
 * dataset case) per model through its adapter, printing the answer, stop
 * reason, tokens, latency, answer confidence (when the provider returns log
 * probabilities) and cost. Nothing is cached; benchmark with `npm run bench`.
 *
 *   npm run hosted:check -- --models ollama-smollm2-360m-native-v2,glm47-flash-oai-native-v2
 */
import { releaseHostedModel, reviewHosted } from "./client.ts";
import { describeTarget, findHostedModel } from "./models.ts";

const args = process.argv.slice(2);
const names = (args[args.indexOf("--models") + 1] ?? "").split(",").filter(Boolean);
if (!args.includes("--models") || !names.length) {
  console.error("usage: npm run hosted:check -- --models <short>[,<short>]");
  process.exit(2);
}

// The extension's request for one label (composeLabelPrefix, frameReviewInput, reviewAnswerCue) on a fictional text.
const label = { label: "CLIENT_NAME", description: "Names of our client companies.", examples: ["Brightwell Logistics", "Orvane Foods"] };
const text = "Hi Sam, can you tidy up my notes from the call with Kestrel Marine? They want the renewal quote by Friday.";
const instructions =
  `Copy the ${label.label} passages from each text, exactly as written. ${label.label}: ${label.description} Write NONE when the text has none.\n\n` +
  `Text: Quick update before the call: ${label.examples[0]} is still on the list for next week, can you tidy up this paragraph?\n${label.label}: ${label.examples[0]}\n\n` +
  `Text: Reminder for tomorrow: we need to go over ${label.examples[1]} with the team, keep it short.\n${label.label}: ${label.examples[1]}\n\n` +
  `Text: Can you rewrite this so it sounds friendlier? Thanks for your patience, we will get back to you shortly.\n${label.label}: NONE\n\n`;
const request = { instructions, input: `Text: ${text}\n`, responsePrefill: `${label.label}:`, native: { label, text } };

let failed = 0;
for (const name of names) {
  const model = findHostedModel(name);
  if (!model) {
    console.error(`unknown hosted model ${name}`);
    failed++;
    continue;
  }
  try {
    const r = await reviewHosted(model, request, { maxTokens: model.maxTokens ?? 48, stopAtNewline: true, maxAttempts: 3, timeoutMs: 30_000 });
    const confidence = r.answerProbability === undefined ? "none returned" : r.answerProbability.toFixed(3);
    console.log(`${model.short} (${describeTarget(model)}, ${model.framing}): ${JSON.stringify(r.output)} · stop ${r.stopReason} · ${r.inputTokens} in / ${r.outputTokens} out tokens · ${r.ms} ms · confidence ${confidence} · ${r.costUsd.toFixed(6)} USD`);
  } catch (error) {
    console.error(`${model.short}: FAILED ${(error as Error).message}`);
    failed++;
  } finally {
    await releaseHostedModel(model);
  }
}
process.exitCode = failed ? 1 : 0;
