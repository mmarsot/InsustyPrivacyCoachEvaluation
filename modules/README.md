# Modules: what gets scored

One folder per redaction module. A module comes with its **module adapter**
(it implements the redaction contract, `contract/`) and one **dataset
adapter** per dataset it should run. The dashboard's Grid shows every module
configuration × every dataset; a cell can run when the module has both.

| Module | Role | Configurations |
| --- | --- | --- |
| [insusty-privacy](insusty-privacy/README.md) | the extension's module at any git ref (system under test) | `rules`, `rules-all`, `smollm2-360m` (device), `glm47-flash-connected` (connected, paid) |
| [presidio](presidio/README.md) | Microsoft Presidio (baseline) | `default` |

## A module folder

| File | What it is |
| --- | --- |
| `manifest.json` | `id`, `title`, `role`, the `contract` version it implements, `aliases` (other names commands accept), `source`, `inputs` (`text`, `document`), the `labels` it produces (`builtin` list, `custom` yes/no), its `configurations`, `notes` |
| `module.ts` | default export `{ manifest, load(options) }`: `load` returns a `RedactionModule` (`engine/module.ts`, `ModuleAdapter`) |
| `dataset-adapters/<dataset>.json` | how its output answers one dataset's expected labels (below) |

A **configuration** is a named recipe for a `ModuleConfig`: `builtins`
(`default`: the module's own; `all`: every built-in label it declares on),
`privateAi` (`off`, `device`, `connected`), `model`, and for a paid one
`paid`, `env` (variable names, never values) and `budgetUsd`.
`engine/module.ts` `configFor` builds the `ModuleConfig`; the dataset adds
its custom labels. Conformance (`npm run conformance -- --module <id>`)
fails when the loaded module offers more than its manifest declares, and
warns when it offers less (an older ref of the extension).

## Dataset adapters

`dataset-adapters/<dataset>.json` belongs to the module: a dataset only says
what it expects (`datasets/<id>/contract.json`), and each module says how its
output answers it, with the labels it cannot produce listed under `missing`.

```json
{
  "dataset": "gretel",
  "datasetContract": "1.0.0",
  "configurations": "all",
  "labels": {
    "email": "EMAIL",
    "iban": "FINANCIAL/iban",
    "name": { "custom": "Person names" }
  },
  "missing": ["date", "time", "local_latlng"]
}
```

- A target is a built-in label (`"EMAIL"`), the same with the finer type the
  module reports as the span's `subtype` (`"FINANCIAL/iban"`), a list for a
  coarse dataset label (TAB `"CODE": ["SECRET", "FINANCIAL", ...]`: any of
  them answers it), or a custom label (`{ "custom": "Person names" }`, scored
  outside the headline; with a `description`, a Private AI configuration
  can be given it).
- Every label of the dataset's contract is mapped or listed `missing`
  (`npm run validate -- --module <id>` checks it). A run scores the labels
  the module answers with built-in spans; missing ones are reported apart,
  and a comparison of two modules uses the labels both map.
- `configurations`: `"all"`, or the configuration ids it serves (insusty-custom
  needs Private AI). `labels: "per-case"` passes each case's custom labels
  through; `customLabels: "per-case"` adds them to a built-in-label dataset
  that has a Private AI suite (insusty-documents). `options` lists runner
  options (insusty-custom's `labelVariants`).
- `datasetContract` is the contract version it was written for: when the
  dataset adds a label (a version bump), the adapter shows "invalid" in the
  grid until it is updated.

## Adding a module

1. `cp -r modules/presidio modules/<id>`.
2. `manifest.json`: the contract version (same major as `contract/`),
   inputs, the built-in labels it produces, custom labels yes/no, its
   configurations (mark paid ones).
3. `module.ts`: `load()` returns a `RedactionModule`. Anything it needs (a
   Python environment, a git ref, an API key from the environment) stays in
   the folder.
4. For each dataset it should run: `npm run adapter -- --module <id>
   --dataset <d>` drafts `dataset-adapters/<d>.json` from another module's
   adapter for that dataset (keeping only the labels this module produces;
   everything else under `missing`). Review it.
5. `npm run conformance -- --module <id>` and `npm run validate -- --module <id>`.
6. Open the dashboard (`npm run dashboard`): the module is under Modules, its
   row in the Grid. Run a cell, or `npm run bench -- --module <id> --config
   <c> --dataset <d>`. Then `npm run check`.

The insusty-builtin (detbench) and literature runners take any module with an
adapter. The custom-label review (insusty-custom) and the document runner
(insusty-documents) drive insusty-privacy's Private AI and document reader
directly, so they run insusty-privacy only for now (`engine/route.ts` says so
when asked for another module).
