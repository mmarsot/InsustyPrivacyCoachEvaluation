/**
 * The smallest module that conforms to contract v1: e-mail addresses and
 * IBANs by regular expression, text input only. It is the conformance
 * tests' reference and an example for anyone implementing the contract; it
 * is not a baseline worth scoring.
 */
import { performance } from "node:perf_hooks";
import {
  CONTRACT_VERSION,
  type ModuleConfig,
  type RedactionModule,
  type RedactionOutput,
  type Span,
} from "./types.ts";

const RULES: Array<{
  label: "EMAIL" | "FINANCIAL";
  subtype: string;
  re: RegExp;
}> = [
  { label: "EMAIL", subtype: "email", re: /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g },
  {
    label: "FINANCIAL",
    subtype: "iban",
    re: /\b[A-Z]{2}\d{2}(?: ?[A-Z0-9]{4}){3,7}(?: ?[A-Z0-9]{1,3})?\b/g,
  },
];

/**
 * A fresh instance of the reference module; it holds no state, so instances are
 * interchangeable.
 */
export function referenceModule(): RedactionModule {
  const info = { name: "reference-regex", version: "1.0.0" };
  return {
    contract: CONTRACT_VERSION,
    info,
    capabilities: {
      builtins: ["EMAIL", "FINANCIAL"],
      customLabels: false,
      documents: false,
      ocr: false,
      privateAi: [],
    },
    defaultConfig: (): ModuleConfig => ({
      builtins: { EMAIL: true, FINANCIAL: true },
      addressCountries: [],
      customLabels: [],
      privateAi: { runsOn: "off" },
      ocr: { enabled: false, languages: [] },
    }),
    async redact(input, config): Promise<RedactionOutput> {
      const t0 = performance.now();
      if (input.kind === "document")
        return {
          contract: CONTRACT_VERSION,
          module: info,
          text: "",
          spans: [],
          redaction: { mode: "none", leakChecked: false },
          coverage: {
            checked: "none",
            reason: "unsupported",
            gaps: [],
            ocrPages: 0,
          },
          runtime: { stages: [], totalMs: performance.now() - t0 },
        };
      const text = input.text;
      const spans: Span[] = [];
      for (const rule of RULES)
        for (const m of text.matchAll(rule.re))
          spans.push({
            start: m.index,
            end: m.index + m[0].length,
            label: rule.label,
            kind: "builtin",
            subtype: rule.subtype,
            source: "rules",
            redacted: config.builtins[rule.label] !== false,
          });
      spans.sort((a, b) => a.start - b.start);
      const rulesMs = performance.now() - t0;
      let redacted = "";
      let cursor = 0;
      for (const s of spans.filter((x) => x.redacted && x.start >= cursor)) {
        redacted += `${text.slice(cursor, s.start)}[${s.label}]`;
        cursor = s.end;
      }
      redacted += text.slice(cursor);
      const any = spans.some((s) => s.redacted);
      const totalMs = performance.now() - t0;
      return {
        contract: CONTRACT_VERSION,
        module: info,
        text,
        spans,
        redaction: any
          ? { text: redacted, mode: "in_place", leakChecked: false }
          : { mode: "none", leakChecked: false },
        coverage: { checked: "full", gaps: [], format: "text", ocrPages: 0 },
        runtime: {
          stages: [{ stage: "rules", ms: rulesMs }],
          totalMs,
          backend: { name: "native" },
        },
      };
    },
  };
}
