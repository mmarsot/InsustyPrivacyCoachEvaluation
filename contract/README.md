# Redaction contract v1

The bench scores redaction modules only through this contract: the
extension's module at a git ref (`modules/insusty-privacy/`), baselines such
as Presidio (`modules/presidio/`), or anyone else's module. Every module
folder's entry (`modules/<id>/module.ts`) returns a `RedactionModule`; its
manifest declares the contract version it implements, and the grid greys out
a module whose major version differs. This is the module side only: what a
dataset expects is its own contract (`datasets/<id>/contract.json`), and each
module maps its output onto it in a dataset adapter (see
[`modules/README.md`](../modules/README.md)). This folder holds:

| File | What it is |
| --- | --- |
| `types.ts` | TypeScript types and `CONTRACT_VERSION` (semver) |
| `redaction-contract.schema.json` | JSON Schema (draft 2020-12) of the same types, one `$defs` entry per type |
| `json.ts` | the JSON form: byte arrays become `{ size, sha256, base64? }` |
| `conformance.ts` | `checkConformance(module)`: fixed cases, the schema, and the rules a schema cannot express |
| `reference-module.ts` | the smallest conforming module (e-mail and IBAN regexes), the tests' reference |

`npm test` runs `contract/contract.test.ts`, which also checks that the types
and the schema have the same fields, and runs the conformance cases on the
extension's module when a clone is configured. `npm run conformance -- --ref
main` does the same from the command line (`--module presidio` for the
baseline), and checks the module against its manifest.

## Versioning

`CONTRACT_VERSION` is `1.0.0`. A harness accepts a module whose major
version equals its own (`isCompatibleContract`). New optional fields are a
minor bump; anything a harness or module could misread (a renamed field, a
new required field, a changed meaning) is a major bump. The schema's
`version` and `$id` carry the same version.

## Shape

```ts
RedactionModule = {
  contract, info: { name, version, sha? },
  capabilities: { builtins[], customLabels, documents, ocr, privateAi: ("device" | "connected")[],
                  addressCountries?, models?: [{ id, runsOn, default?, bytes? }] },
  defaultConfig(): ModuleConfig,
  redact(input, config): Promise<RedactionOutput>,
  prepare?(config): Promise<{ loadMs?, prepareMs?, backend? }>,   // warm-up, so redact() measures warm latency
  dispose?(),
}

RedactionInput = { kind: "text"; text; language? } | { kind: "document"; name; bytes }

ModuleConfig = {
  builtins: { SECRET?: boolean, FINANCIAL?: …, … },   // on, found-but-not-redacted, or the module's default
  addressCountries: string[],                          // ISO alpha-2
  customLabels: [{ label, description, examples[] }],  // zero-shot rules for Private AI
  privateAi: { runsOn: "off" | "device" | "connected", model?, backend? },
  ocr: { enabled, languages[] },
  limits?: { [name]: number },
}

RedactionOutput = {
  contract, module: { name, version, sha? },
  text,                         // the input text, or the text extracted from the document
  parts?: [{ start, end, where, page? }],
  spans: [{ start, end, label, kind: "builtin" | "custom", subtype?, source: "rules" | "model" | "pattern" | "learned",
            redacted, confidence?, page?, box? }],
  redaction: { text?, file?: { name, type, bytes }, mode: "in_place" | "text_copy" | "fallback_text_copy" | "none" | "error",
               leakChecked, unredactable?, error? },
  coverage: { checked: "full" | "partial" | "none", reason?, gaps[], format?, pages?, ocrPages, signed?, detail? },
  runtime: { stages: [{ stage: "read" | "ocr" | "rules" | "model" | "redact" | "verify", ms, pages?, requests? }],
             totalMs, peakRssMb?, charsPerSecond?, pagesPerMinute?,
             backend?: { name: "wasm" | "webgpu" | "native" | "python" | "api", threads?, dtype? },
             model?: { id, bytes?, cold, loadMs?, prepareMs? }, cost?: { usd, provider, connected: true },
             requests?: [{ label?, ms, promptTokens?, outputTokens?, finishReason?, output?, confidence?, cached? }],
             machine?: { id, cpu, cores, ramMb, os, node?, python?, chrome?, powerMode? } },
}
```

- **Built-in labels** are the extension's detection categories
  (`BUILTIN_LABELS`). A module declares the ones it supports
  (`capabilities.builtins`). Benchmark adapters map their labels onto these or
  onto custom labels, never the other way round.
- **`subtype`** is the rule that fired (the extension's `Detection.source`),
  so an adapter can split a coarse label (FINANCIAL into IBAN and card)
  without guessing.
- **`redacted: false`** is a span the module found but does not redact by
  default (a built-in label switched off).
- **Efficiency** is part of every output: per-stage times, throughput, peak
  RSS, backend, model id, size and cold or warm state, the cost of a
  connected path, and the machine profile. Absolute times and memory are
  comparable only within one `machine.id`; quality metrics never depend on
  it.

## Conformance rules beyond the schema

- span offsets inside `text`; built-in labels declared by the module; custom
  labels present in the configuration;
- a built-in label switched off is never `redacted`; no `model` span with
  Private AI off; no `cost` without a connected model;
- text input: `text` equals the input, and every redacted value is gone from
  `redaction.text` unless the same characters also occur unredacted;
- a redaction mode of `none` exactly when nothing is redacted; no spans when
  coverage is `none`; `totalMs` at least the longest stage.
