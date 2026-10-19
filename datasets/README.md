# Datasets: what modules are scored on

One folder per dataset. A dataset comes with its data (or how to download
it) and its **expected output contract**: the labels it scores. It says
nothing about any module; each module maps its own output onto these labels
in `modules/<module>/dataset-adapters/<dataset>.json`
([`modules/README.md`](../modules/README.md)).

| Dataset | Origin | What it is | Scorer |
| --- | --- | --- | --- |
| [insusty-custom](insusty-custom/README.md) | ours | 809 fictional EN/FR prompts, 8 client profiles, custom labels per profile (30% held-out test split) | custom-passages |
| [insusty-builtin](insusty-builtin/README.md) | ours | 316 fictional EN/FR prompts, 532 labelled items across the 9 built-in labels, 502 hard negatives, seeded perturbations (detbench) | builtin-spans |
| [insusty-documents](insusty-documents/README.md) | ours | 156 documents generated from insusty-builtin (Word, Excel, PowerPoint, OpenDocument, PDF, text, zip), size sweeps, and a Private AI suite (docbench) | documents |
| [tab](tab/README.md) | published, MIT | Text Anonymization Benchmark: 127 ECHR judgements (test split), 8 labels | literature |
| [gretel](gretel/README.md) | published, Apache-2.0 | Gretel synthetic PII finance: 3,334 EN and FR documents, 29 labels | literature |
| [nemotron](nemotron/README.md) | published, CC BY 4.0 | Nemotron-PII: a seeded sample of 3,000 of 100,000 EN records, 55 labels | literature |
| ai4privacy | listed, blocked | open-pii-masking-500k: not wired, see "Not wired" below | – |

## A dataset folder

| File | What it is |
| --- | --- |
| `manifest.json` | `id` (the folder), `resultsId` (the id cached outputs and run files use, when it predates the folder name: never change it), `title`, `origin` (`ours`, `published`), `source` (URL, pinned revision), `licence` (SPDX, note, `commercialResults`: may a commercial project publish results), `citation`, `languages`, `size`, and `blocked` for a listed dataset that is not wired |
| `contract.json` | the output it expects: `input` (`text`, `document`), `scorer` (`engine/scorers/<scorer>/`), `labels` (each with one line of meaning, or `per-case` for custom labels that come with each case), `customLabels` (cases that also carry custom labels), `splits`, `tiers` (named sizes; for literature datasets, the `--limit` of each) and a `version` (a new label is a minor bump) |
| `loader.ts` | published datasets: the pinned files (URL, SHA-256) and how to read them into cases whose gold spans carry the dataset's own labels (`engine/dataset.ts`, `DatasetLoader`) |
| `gate.ts` | ours: what counts as a regression on `--compare <base> --gate` |

Our datasets keep their own code next to the data (insusty-custom: schema,
loader, validation, splits, label-description variants; insusty-builtin:
schema, perturbations, generators, checksums, defanging; insusty-documents:
case specs, writers, sweeps, the Private AI suite).

## Adding a dataset

1. `cp -r datasets/gretel datasets/<id>` (a published dataset; ours follow
   insusty-builtin).
2. `manifest.json`: source and pinned revision, and the licence with a
   verdict on publishing results commercially (required: only datasets whose
   licence allows it are wired).
3. `contract.json`: input kind, the labels it expects with one line of
   meaning each, the scorer, splits and tiers.
4. `loader.ts`: the pinned files with their SHA-256, and `load()` reading a
   split into cases with gold in the dataset's labels.
5. `npm run validate -- --dataset <id>`: downloads once into
   `cache/datasets/`, checks the hashes and that every gold label is in the
   contract.
6. The dashboard's Grid has a new column, with "no adapter" in every row
   until a module adds its dataset adapter (`npm run adapter -- --module <m>
   --dataset <id>`).

## Published datasets (literature benchmarks)

```bash
npm run literature -- --ref main                                   # TAB, Gretel, Nemotron-PII; default and all configs
npm run literature -- --systems insusty,presidio --datasets nemotron --limit 0   # every Nemotron record, with the baseline
npm run bench -- --module presidio --config default --dataset gretel --tier smoke  # one grid cell
```

Files download once into `cache/datasets/<id>/<revision>/` at a pinned
revision and are checked against pinned SHA-256s; nothing is committed. Only
datasets whose licence allows a commercial project to publish results are
wired, each confirmed on its card at the pinned revision:

| Dataset | Licence | Revision | What is scored |
| --- | --- | --- | --- |
| [TAB](https://github.com/NorskRegnesentral/text-anonymization-benchmark) (ECHR judgements, EN) | MIT | `558e09e` | test split, 127 documents; TAB's ER_di / ER_qi as native metrics |
| [Gretel synthetic PII finance multilingual](https://huggingface.co/datasets/gretelai/synthetic_pii_finance_multilingual) | Apache-2.0 | `7b844d1` | EN and FR test files, 3,334 documents (the French source) |
| [Nemotron-PII](https://huggingface.co/datasets/nvidia/Nemotron-PII) (EN, US and international) | CC BY 4.0 (NVIDIA) | `b70ffaf` | seeded sample of 3,000 of the 100,000 test records (`--limit 0`: all) |

**Not wired: ai4privacy open-pii-masking-500k** (`ai4privacy/manifest.json`,
`blocked`). Its card metadata says `license: other` (named cc-by-4.0), but
its body puts use and redistribution under the Llama 3.1/3.3 Community
License ("Built with Llama" attribution, model-naming rule, Llama
acceptable-use policy) and says commercial use beyond the permitted scope may
need written permission from Ai4Privacy (checked at `506996d`, 2026-10-17).
Do not add it back without a licence decision; ai4privacy
pii-masking-300k/400k are non-commercial.

**How it is scored** (`engine/scorers/literature/`). Each module is scored
through its own dataset adapter: the **headline** covers the gold whose label
the module answers with built-in labels (Gretel `iban` → FINANCIAL, TAB
`CODE` ← any identifier label...). Gold the adapter maps to custom labels
(names, organisations: Private AI territory) and gold it lists as missing
(labels the module cannot produce: dates, locations, demographics..., and for
Presidio secrets) are separate rows, next to the dataset-native total, never
in the headline. A comparison of two modules uses the labels both map (the
dashboard's Compare and Results views). Recall counts a gold span as masked
when a redacted span overlaps it (`typed`: with a label the adapter accepts;
`exact`: same boundaries); precision counts a redacted span as right when it
overlaps any span that must be masked. Over-redaction is characters masked
outside every such span per 1,000 characters. Runs write
`results/runs/literature/<name>/` (report.html, metrics.json, run.json with
the dataset hashes, licences and each module's label map, spans.jsonl
without text); outputs are cached per module version, dataset revision,
case and configuration (`results/jobs/literature/`), and the dashboard's
Literature view lists the runs.

Before the modules/datasets layout every module shared one denominator, so a
label a module cannot produce counted as missed: Presidio's Gretel and
Nemotron headlines included the secrets it has no recognizer for. They are
re-quoted below on its own labels; the extension's are unchanged (its
adapters are the label maps it was scored with).

Scores, extension `main` @ `95454ec` (2026-10-17) and Presidio (re-quoted
2026-10-19 on its adapter's labels), machine profile `adhoc` (the 8-thread,
7 GB bench laptop), headline recall / precision / F1:

| Dataset | Extension `default` | Extension `all` | Presidio |
| --- | --- | --- | --- |
| TAB test (1,612 `CODE` mentions) | 0.0% / – / 0.0% (3 spans in 648k chars) | same | 3.3% / 74.7% / 6.4% |
| Gretel EN+FR test (4,670 spans; Presidio 4,557: no `api_key`, `password`) | 23.2% / 48.4% / 31.4% | 26.3% / 50.9% / 34.7% | 61.8% / 22.2% / 32.7% (was 60.5% / 22.2% / 32.5%) |
| Nemotron-PII sample (6,063 spans; Presidio 5,561: no `api_key`, `password`, `http_cookie`) | 48.9% / 99.4% / 65.5% | 54.0% / 99.3% / 70.0% | 79.2% / 95.6% / 86.6% (was 74.2% / 95.6% / 83.5%) |
| Our insusty-builtin prompts (share of items redacted) | 78.5% (F1 87.0%) | 93.1% (F1 95.3%) | 66.7% (F1 62.8%; SECRET not scored, 0/117) |

- **TAB is out of the product's scope by construction**: its `CODE` mentions
  are ECHR application numbers (`36110/97`), which no rule targets; its
  direct identifiers are mostly person names (custom-label territory). ER_di
  is 0.0% for both modules.
- **Where Presidio leads** (Gretel, Nemotron): US-style phones (Nemotron
  94% vs 28%), street addresses (its LOCATION; the extension's ADDRESS is
  FR-only in both configurations because `main` does not export its
  address-country list), national ids, and account and routing numbers the
  extension does not validate as FINANCIAL (card recall 11% on Nemotron,
  whose synthetic card numbers often fail the checksum the extension
  requires).
- **Where the extension leads**: secrets (Nemotron 57%, Gretel 72% typed;
  Presidio has no secret recognizer, so they are outside its headline),
  precision on its own prompts and hard negatives (insusty-builtin: 9 vs 110
  of 502 decoys flagged), and speed: about 1.3 M characters per second vs
  27-32 k for Presidio (45x), single process.
- **Caveats**: Gretel's synthetic gold leaves many real-looking e-mails and
  identifiers unlabelled, so precision there is understated for every module;
  Nemotron flags a real weakness (SECRET fires on Markdown bold labels such as
  `Policy**`).
