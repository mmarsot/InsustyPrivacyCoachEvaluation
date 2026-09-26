/**
 * Assigns a split to every case that has none, and never changes an existing
 * one, so the held-out test set stays fixed as the dataset grows. Within each
 * (profile, lang, type) group, cases are ordered by a hash of their id and
 * test cases are added until the group reaches ~30% test.
 *   npm run split [-- --profile <id>]
 */
import { createHash } from "node:crypto";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CASES_DIR } from "../paths.ts";
import type { Case } from "../dataset/schema.ts";

const TEST_SHARE = 0.3;
const hash = (id: string) => createHash("sha256").update(id).digest("hex");
const only = process.argv.includes("--profile") ? process.argv[process.argv.indexOf("--profile") + 1] : undefined;
let assigned = 0;
for (const file of readdirSync(CASES_DIR).filter((f) => f.endsWith(".jsonl") && (!only || f.startsWith(`${only}.`))).sort()) {
  const path = join(CASES_DIR, file);
  const cases = readFileSync(path, "utf8").split("\n").filter((l) => l.trim()).map((l) => JSON.parse(l) as Case);
  const groups = new Map<string, Case[]>();
  for (const c of cases) {
    const key = `${c.profile}/${c.lang}/${c.type}`;
    groups.set(key, [...(groups.get(key) ?? []), c]);
  }
  for (const group of groups.values()) {
    const target = Math.round(group.length * TEST_SHARE);
    let test = group.filter((c) => c.split === "test").length;
    for (const c of [...group].filter((c) => !c.split).sort((a, b) => hash(a.id).localeCompare(hash(b.id)))) {
      c.split = test < target ? "test" : "dev";
      if (c.split === "test") test++;
      assigned++;
    }
  }
  writeFileSync(path, cases.map((c) => JSON.stringify(c)).join("\n") + "\n");
}
console.log(`assigned a split to ${assigned} case(s)`);
