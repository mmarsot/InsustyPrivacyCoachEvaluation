/**
 * Conformance of a redaction module to contract v1: every output must match
 * the JSON Schema and the rules the schema cannot express (offsets inside
 * the text, labels the configuration allows, redacted values gone from the
 * redacted text, coherent coverage and runtime). A harness runs
 * `checkConformance` on each module it scores; a module runs it in its own
 * CI.
 */
import { readFileSync } from "node:fs";
import { Ajv2020, type ValidateFunction } from "ajv/dist/2020.js";
import { outputToJson } from "./json.ts";
import {
  BUILTIN_LABELS,
  CONTRACT_VERSION,
  isCompatibleContract,
  type ModuleConfig,
  type RedactionInput,
  type RedactionModule,
  type RedactionOutput,
} from "./types.ts";

export const SCHEMA_FILE = new URL(
  "./redaction-contract.schema.json",
  import.meta.url,
);

let validators: Map<string, ValidateFunction> | undefined;
/** Validates the JSON form of a contract value against one of the schema's `$defs`. */
export function schemaErrors(
  def:
    | "RedactionOutput"
    | "ModuleConfig"
    | "RedactionInput"
    | "ModuleCapabilities",
  value: unknown,
): string[] {
  if (!validators) {
    const schema = JSON.parse(readFileSync(SCHEMA_FILE, "utf8")) as {
      $id: string;
      version: string;
    };
    if (schema.version !== CONTRACT_VERSION)
      throw new Error(
        `Schema ${schema.version} does not match contract ${CONTRACT_VERSION}`,
      );
    const ajv = new Ajv2020({
      allErrors: true,
      strict: true,
      strictTypes: false,
    });
    ajv.addKeyword("version");
    ajv.addSchema(schema);
    validators = new Map();
    for (const d of [
      "RedactionOutput",
      "ModuleConfig",
      "RedactionInput",
      "ModuleCapabilities",
    ])
      validators.set(d, ajv.getSchema(`${schema.$id}#/$defs/${d}`)!);
  }
  const validate = validators.get(def)!;
  return validate(value)
    ? []
    : (validate.errors ?? []).map(
        (e) => `${e.instancePath || "/"} ${e.message ?? "invalid"}`,
      );
}

/** Problems with one output for one input and configuration; empty when it conforms. */
export function outputProblems(
  module: Pick<RedactionModule, "capabilities">,
  input: RedactionInput,
  config: ModuleConfig,
  out: RedactionOutput,
): string[] {
  const problems = schemaErrors("RedactionOutput", outputToJson(out)).map(
    (e) => `schema: ${e}`,
  );
  if (problems.length) return problems;
  const p = (message: string) => problems.push(message);
  if (!isCompatibleContract(out.contract))
    p(`contract ${out.contract} is not compatible with ${CONTRACT_VERSION}`);
  if (input.kind === "text" && out.text !== input.text)
    p("text input: output.text differs from the input text");
  const custom = new Set(config.customLabels.map((l) => l.label));
  for (const s of out.spans) {
    const at = `span ${s.start}-${s.end} ${s.label}`;
    if (!(s.start < s.end && s.end <= out.text.length))
      p(`${at}: offsets outside the text or empty`);
    if (s.kind === "builtin") {
      if (!(BUILTIN_LABELS as readonly string[]).includes(s.label))
        p(`${at}: unknown built-in label`);
      else if (!module.capabilities.builtins.includes(s.label as never))
        p(`${at}: built-in label the module does not declare`);
      if (
        config.builtins[s.label as keyof ModuleConfig["builtins"]] === false &&
        s.redacted
      )
        p(`${at}: redacted although the label is switched off`);
    } else if (!custom.has(s.label))
      p(`${at}: custom label not in the configuration`);
    if (s.source === "model" && config.privateAi.runsOn === "off")
      p(`${at}: model span with Private AI off`);
  }
  for (const part of out.parts ?? [])
    if (!(part.start <= part.end && part.end <= out.text.length))
      p(`part ${part.where}: outside the text`);
  const redacted = out.spans.filter((s) => s.redacted);
  if (
    !redacted.length &&
    out.redaction.mode !== "none" &&
    out.redaction.mode !== "error"
  )
    p(`redaction mode ${out.redaction.mode} with nothing redacted`);
  if (redacted.length && out.redaction.mode === "none")
    p("spans are redacted but the redaction mode is none");
  if (input.kind === "text" && redacted.length) {
    if (out.redaction.text === undefined)
      p("text input with redacted spans has no redaction.text");
    else {
      // A redacted value must be gone, unless the same characters also occur unredacted elsewhere in the text.
      const covered = new Uint8Array(out.text.length);
      for (const s of redacted) covered.fill(1, s.start, s.end);
      for (const s of redacted) {
        const value = out.text.slice(s.start, s.end);
        if (value.trim().length < 4 || !out.redaction.text.includes(value))
          continue;
        let elsewhere = false;
        for (
          let i = out.text.indexOf(value);
          i >= 0 && !elsewhere;
          i = out.text.indexOf(value, i + 1)
        )
          elsewhere = covered
            .subarray(i, i + value.length)
            .some((c) => c === 0);
        if (!elsewhere)
          p(
            `span ${s.start}-${s.end} ${s.label}: its value is still in redaction.text`,
          );
      }
    }
  }
  if (out.coverage.checked === "none" && out.spans.length)
    p("coverage none but spans were reported");
  const longest = Math.max(0, ...out.runtime.stages.map((s) => s.ms));
  if (out.runtime.totalMs + 1 < longest)
    p(
      `runtime.totalMs ${out.runtime.totalMs} is below its longest stage (${longest})`,
    );
  if (out.runtime.cost && config.privateAi.runsOn !== "connected")
    p("a cost without a connected model");
  return problems;
}

/** Fictional, checksum-valid values (the FR IBAN is the standard test IBAN). */
const SAMPLE =
  "Please wire it to FR76 3000 6000 0112 3456 7890 189 and copy jo.martin@example.org before Friday.";

export interface ConformanceCase {
  name: string;
  input: RedactionInput;
  config: (defaults: ModuleConfig) => ModuleConfig;
}

/** The fixed cases every module must pass. Private AI is off: conformance never needs a model. */
export const CONFORMANCE_CASES: ConformanceCase[] = [
  {
    name: "text with identifiers, default configuration",
    input: { kind: "text", text: SAMPLE },
    config: (d) => ({ ...d, privateAi: { runsOn: "off" } }),
  },
  {
    name: "empty text",
    input: { kind: "text", text: "" },
    config: (d) => ({ ...d, privateAi: { runsOn: "off" } }),
  },
  {
    name: "text without identifiers",
    input: {
      kind: "text",
      text: "Can you shorten this paragraph about our team offsite?",
    },
    config: (d) => ({ ...d, privateAi: { runsOn: "off" } }),
  },
  {
    name: "every built-in label switched off",
    input: { kind: "text", text: SAMPLE },
    config: (d) => ({
      ...d,
      builtins: Object.fromEntries(BUILTIN_LABELS.map((l) => [l, false])),
      privateAi: { runsOn: "off" },
    }),
  },
  {
    name: "custom label with Private AI off",
    input: { kind: "text", text: `${SAMPLE} Project Bluefin ships in May.` },
    config: (d) => ({
      ...d,
      customLabels: [
        {
          label: "PROJECT",
          description: "Internal project codenames",
          examples: ["Project Bluefin"],
        },
      ],
      privateAi: { runsOn: "off" },
    }),
  },
  {
    name: "plain-text document",
    input: {
      kind: "document",
      name: "notes.txt",
      bytes: new TextEncoder().encode(SAMPLE),
    },
    config: (d) => ({ ...d, privateAi: { runsOn: "off" } }),
  },
];

export interface ConformanceResult {
  case: string;
  problems: string[];
}

/** Runs the fixed cases (and `extra`) on a module; also checks its declared contract, capabilities and default configuration. */
export async function checkConformance(
  module: RedactionModule,
  extra: ConformanceCase[] = [],
): Promise<ConformanceResult[]> {
  const results: ConformanceResult[] = [];
  const header: string[] = [];
  if (!isCompatibleContract(module.contract))
    header.push(
      `module implements contract ${module.contract}, harness ${CONTRACT_VERSION}`,
    );
  header.push(
    ...schemaErrors("ModuleCapabilities", module.capabilities).map(
      (e) => `capabilities: ${e}`,
    ),
  );
  const defaults = module.defaultConfig();
  header.push(
    ...schemaErrors("ModuleConfig", defaults).map((e) => `defaultConfig: ${e}`),
  );
  results.push({ case: "module", problems: header });
  for (const c of [...CONFORMANCE_CASES, ...extra]) {
    const config = c.config(structuredClone(defaults));
    try {
      const out = await module.redact(c.input, config);
      const problems = outputProblems(module, c.input, config, out);
      if (
        c.input.kind === "document" &&
        !module.capabilities.documents &&
        out.coverage.checked !== "none"
      )
        problems.push("documents unsupported but coverage is not none");
      results.push({ case: c.name, problems });
    } catch (error) {
      results.push({
        case: c.name,
        problems: [`threw: ${(error as Error).message}`],
      });
    }
  }
  return results;
}
