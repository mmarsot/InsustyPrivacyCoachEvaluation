/**
 * The insusty-privacy module through its public interfaces: the materializer
 * on a git repository, and the module the bench builds from the extension's
 * package (the version pinned in package.json), with only the system
 * boundaries scripted: the on-device runtime (`runtime/scripted.ts`) and the
 * connected model's HTTP transport. No network, no model.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import type { ModuleConfig } from "../../contract/types.ts";
import { CACHE_DIR, ROOT } from "../../engine/paths.ts";
import { loadInsustyModule } from "./insusty.ts";
import { materializeModule, type ModuleRef } from "./materialize.ts";
import { refReview } from "./ref.ts";
import { scriptedRuntime, tracedRuntime } from "./runtime/scripted.ts";

/** The pinned package as an installed ref (its PDFium is the bench's own). */
const pinned: ModuleRef = {
  ref: "pinned",
  sha: "0".repeat(40),
  subject: "",
  committedAt: "",
  dir: ROOT,
  entry: fileURLToPath(import.meta.resolve("insusty-prompt-coach/redaction")),
  pdfium: dirname(
    dirname(fileURLToPath(import.meta.resolve("@embedpdf/pdfium"))),
  ),
  packages: {},
  runtime: {},
};

const PROJECT = {
  label: "PROJECT",
  description: "Internal project codenames",
  examples: ["Project Bluefin", "Project Kestrel", "Project Larch"],
};
const TEXT =
  "Mail anna.keller@example.org about Project Orca before the launch.";
const withPrivateAi = (
  base: ModuleConfig,
  runsOn: "device" | "connected",
): ModuleConfig => ({
  ...base,
  customLabels: [PROJECT],
  privateAi: { runsOn },
});

test("the materializer refuses a commit whose package.json has no redaction export, before installing anything", async () => {
  const repo = join(CACHE_DIR, "tmp", `ext-test-${process.pid}`);
  rmSync(repo, { recursive: true, force: true });
  mkdirSync(repo, { recursive: true });
  const git = (...args: string[]) =>
    execFileSync("git", ["-C", repo, ...args], { stdio: "ignore" });
  try {
    git("init", "-q");
    writeFileSync(
      join(repo, "package.json"),
      JSON.stringify({ name: "insusty-prompt-coach", version: "0.1.0" }),
    );
    git("add", "package.json");
    git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "old");
    await assert.rejects(
      materializeModule(repo, "HEAD", () => undefined),
      /predates the redaction package \(extension PR #132\).*Score a later ref/s,
    );
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("rules alone: the ref's detection and redaction, Private AI off", async () => {
  const module = await loadInsustyModule(pinned);
  assert.equal(module.info.sha, pinned.sha);
  assert.deepEqual(module.capabilities.privateAi, []);
  const out = await module.redact(
    { kind: "text", text: TEXT },
    module.defaultConfig(),
  );
  const email = out.spans.find((s) => s.label === "EMAIL");
  assert.equal(email?.source, "rules");
  assert.equal(
    out.text.slice(email!.start, email!.end),
    "anna.keller@example.org",
  );
  assert.ok(!out.redaction.text?.includes("anna.keller@example.org"));
  assert.ok(out.runtime.peakRssMb! > 0, "the bench measures each call");
});

test("Private AI on the device: the ref's review on a scripted runtime, its prompts recorded", async () => {
  const scripted = scriptedRuntime((request) =>
    request.suffix.endsWith("PROJECT:")
      ? { output: " Project Orca\n", probability: 0.9 }
      : " NONE\n",
  );
  const module = await loadInsustyModule(pinned, {
    device: () => Promise.resolve(scripted.runtime),
  });
  assert.deepEqual(module.capabilities.privateAi, ["device"]);
  const config = withPrivateAi(module.defaultConfig(), "device");
  const prepared = await module.prepare!(config);
  assert.ok(prepared.loadMs !== undefined, "the first preparation loads");
  const out = await module.redact({ kind: "text", text: TEXT }, config);
  const custom = out.spans.filter((s) => s.kind === "custom");
  assert.deepEqual(
    custom.map((s) => [s.label, out.text.slice(s.start, s.end), s.source]),
    [["PROJECT", "Project Orca", "model"]],
  );
  assert.equal(out.runtime.requests?.length, 1);
  assert.equal(out.runtime.requests![0]!.label, "PROJECT");
  assert.equal(out.runtime.requests![0]!.confidence, 0.9);
  const [request] = scripted.requests;
  assert.ok(request!.prefix.includes("Internal project codenames"));
  assert.ok(request!.suffix.includes(TEXT));
  assert.ok(scripted.prefixes.includes(request!.prefix));

  // An answer below the ref's confidence threshold counts as NONE.
  const unsure = scriptedRuntime(() => ({
    output: " Project Orca\n",
    probability: 0.05,
  }));
  const filtered = await (
    await loadInsustyModule(pinned, {
      device: () => Promise.resolve(unsure.runtime),
    })
  ).redact({ kind: "text", text: TEXT }, config);
  assert.equal(filtered.spans.filter((s) => s.kind === "custom").length, 0);
});

test("refReview lists the ref's models and the instructions it prepares for a label set", async () => {
  const review = await refReview(pinned);
  assert.ok(review.modelIds.includes(review.defaultModelId));
  const rules = [
    {
      label: PROJECT.label,
      prompt: PROJECT.description,
      examples: PROJECT.examples,
    },
  ];
  const prefixes = await review.prefixes(rules);
  assert.ok(prefixes.length >= 1);
  assert.ok(prefixes.every((p) => p.includes("Internal project codenames")));
  assert.equal(await review.instructions(rules), prefixes.join("\n\n"));
});

test("a traced runtime reports each generation without changing it", async () => {
  const scripted = scriptedRuntime(() => " Project Orca\n");
  const seen: string[] = [];
  const module = await loadInsustyModule(pinned, {
    device: () =>
      Promise.resolve(
        tracedRuntime(scripted.runtime, (g) => void seen.push(g.output)),
      ),
  });
  const out = await module.redact(
    { kind: "text", text: TEXT },
    withPrivateAi(module.defaultConfig(), "device"),
  );
  assert.deepEqual(seen, [" Project Orca\n"]);
  assert.equal(out.spans.filter((s) => s.kind === "custom").length, 1);
});

test("Private AI on a connected model: the ref's client over the bench's transport, with its cost", async () => {
  const bodies: string[] = [];
  const module = await loadInsustyModule(pinned, {
    connected: [
      {
        id: "test-connected",
        connection: {
          provider: "openai-compatible",
          baseUrl: "http://127.0.0.1:9/v1",
          model: "m",
          displayName: "Test",
          format: "auto",
          timeLimitMs: 5_000,
          maxRequestsPerMinute: null,
        },
        apiKey: "k",
        fetch: async (_url, init) => {
          bodies.push(String(init?.body ?? ""));
          return new Response(
            JSON.stringify({
              choices: [{ message: { content: "Project Orca" } }],
              usage: { prompt_tokens: 100, completion_tokens: 3 },
            }),
            { headers: { "content-type": "application/json" } },
          );
        },
        usage: () => ({ inputTokens: 100, outputTokens: 3, usd: 0.25 }),
      },
    ],
  });
  assert.deepEqual(module.capabilities.privateAi, ["connected"]);
  const out = await module.redact(
    { kind: "text", text: TEXT },
    withPrivateAi(module.defaultConfig(), "connected"),
  );
  assert.equal(bodies.length, 1);
  assert.ok(bodies[0]!.includes("Project Orca"));
  assert.deepEqual(
    out.spans
      .filter((s) => s.kind === "custom")
      .map((s) => out.text.slice(s.start, s.end)),
    ["Project Orca"],
  );
  assert.equal(out.runtime.cost?.usd, 0.25);
  assert.equal(out.runtime.cost?.connected, true);
});

test("documents: the ref reads and redacts a file with the PDFium the bench supplies", async () => {
  const module = await loadInsustyModule(pinned);
  assert.equal(module.capabilities.documents, true);
  const out = await module.redact(
    {
      kind: "document",
      name: "notes.txt",
      bytes: new TextEncoder().encode(TEXT),
    },
    module.defaultConfig(),
  );
  assert.equal(out.coverage.checked, "full");
  const file = out.redaction.file;
  assert.equal(out.redaction.mode, "in_place");
  assert.ok(!new TextDecoder().decode(file!.bytes).includes("anna.keller"));
});
