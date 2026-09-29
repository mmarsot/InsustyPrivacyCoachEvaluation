# Deterministic redaction bench

`npm run detbench` measures the extension's **rule-based** detector
(`detectSensitiveData` in `src/detector.ts`): the part that finds secrets,
emails, phones, addresses and, after the detector upgrade, financial data,
national IDs, dates of birth and IP addresses. It loads no model: a run over
130 base cases and ~1,500 perturbed variants takes a few seconds.

Code: `src/detbench/` (dataset, perturbations, ref loading, scoring, report)
and `src/cli/detbench.ts`. Tests: `tests/detbench.test.ts`.

## How a ref is run

`src/detbench/ext.ts` reuses the bench's read-only ref materialization
(`git archive`, see [approach.md](approach.md)) into
`cache/detbench/ext/<sha>/`, then:

1. lists the npm packages the detector imports (a first esbuild pass);
2. installs exactly the versions the ref's `package-lock.json` pins
   (`npm ci` on a lockfile subset, into that cache directory; network only the
   first time), so libphonenumber metadata and any validator library match
   what that commit ships;
3. bundles `src/detector.ts` and `src/config.ts`, resolving packages only from
   that install.

Each ref runs with two configurations:

| Config | What it is |
| --- | --- |
| `default` | the ref's `DEFAULT_CONFIG`, as a new user gets it |
| `all` | every category in the ref's `CATEGORIES` on, and every `SUPPORTED_ADDRESS_COUNTRIES` |

Only **selected** detections count: what gets redacted without the user
ticking anything. A category switched off leaves its detections unselected.

## Categories and ref support

Ground truth uses the upgraded names: `SECRET`, `EMAIL`, `PHONE`, `ADDRESS`,
`FINANCIAL`, `NATIONAL_ID`, `DATE_OF_BIRTH`, `IP` (`src/detbench/schema.ts`).
A ref's category names are mapped with `CATEGORY_ALIASES`
(`src/detbench/ext.ts`): today's `API_KEY` is `SECRET`, and plausible
spellings such as `IP_ADDRESS` or `IBAN` map too. A dataset category with no
matching ref category is **not supported by this ref**: its items are left out
of precision, recall and F1 and reported apart, with the share that another
category happened to redact. So the same dataset scores today's `main` and
the upgrade branch. If a ref introduces a category name the aliases do not
know, its detections count as false positives until you add an alias.

## Dataset

`dataset/detbench/<lang>.jsonl`, one case per line:

```json
{"id":"fr-021","lang":"fr","register":"email",
 "template":"… virement sur l'IBAN {{iban}}, BIC {{bic}}, facture F-{{inv}} …",
 "items":{"iban":{"category":"FINANCIAL","kind":"iban","value":"FR76 6078 0229 8901 2384 8588 948"},
          "bic":{"category":"FINANCIAL","kind":"bic","value":"QTRNFRPPXXX"}},
 "decoys":{"inv":{"kind":"order_number","value":"2026-0318"}},
 "tags":["context_keyword"]}
```

- `template` holds `{{key}}` placeholders. Each key is an **item** (ground
  truth: category, value `kind` from `ITEM_KINDS`, value) or a **decoy** (a
  hard negative that must not be flagged, `DECOY_KINDS`). A key may repeat;
  every occurrence counts.
- Rendering gives the prompt and exact spans; perturbations rewrite the parts
  separately, so spans stay exact. The case type is derived: `negative` (no
  item), `single` (one category) or `multi` (several).
- `register`: `email`, `chat`, `notes`, `doc`, `form`, `ticket`, `code`,
  `log`, `config`.
- Dates of birth also carry `iso` (`YYYY-MM-DD`), for the format perturbations.

Ground-truth rules:

- The item is the value only: the key without `OPENAI_API_KEY=`, the password
  without `user:`, the whole PEM block, the whole address.
- Every value is fictional and, where a checksum exists, valid: IBAN mod 97
  (French ones also with a valid RIB key), card Luhn, NIR key, SIREN/SIRET
  Luhn, French VAT key, NHS mod 11, SSN structure (`src/detbench/checksums.ts`;
  the loader rejects failures). Use documentation IP ranges (`192.0.2.0/24`,
  `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`) or private ones
  (kind `ipv4_private`).
- No unlabelled sensitive value: if a prompt needs an address or a card
  expiry for realism, label it or leave it out, or a correct detection would
  count as a false positive. Names are out of scope (the product does not
  detect them).

**Adding cases**: append lines with the next free id, then run
`npm run detbench -- --validate`. Secret-looking values must not appear raw in
the files, so secret scanners (GitHub push protection) do not block the repo:
run `npm run detbench -- --defang-dataset`, which writes one character of each
provider prefix as a `\uXXXX` escape (`JSON.parse` restores it). Committed
outputs are escaped the same way (`src/detbench/defang.ts`).

## Perturbations

`src/detbench/perturb.ts` generates up to `--variants` (default 2) variants
per base case and type, from a PRNG seeded by (`--seed`, case id, type,
variant number), so a variant never changes when other cases are added.

| Type | Change |
| --- | --- |
| `spacing` | grouped values compact, regrouped, with no-break or double spaces |
| `separators` | dots or dashes between groups (`06.12.34.56.78`, `4925-9130-…`, `14.03.1991`) |
| `alt_format` | `+33`/`+44`/`+1`/`+49` phone forms, textual or ISO dates of birth, street-type abbreviations, no comma in addresses |
| `case` | prose and case-insensitive values (email, IBAN, BIC, VAT, address, hex hashes) lower- or upper-cased; secrets keep their case |
| `linebreak` | a line break inside an IBAN, card, NIR, SIRET or address |
| `punctuation` | values in quotes, brackets, guillemets or backticks, or followed by punctuation |
| `code_block` | the whole prompt inside a ``` or ~~~ fence |
| `env` | the values rewritten as `.env`, `export`, YAML or TOML settings |
| `accents` | accents stripped everywhere |
| `typo` | a typo in the word before each value (the context keyword), or in prose for negatives |

Each type is scored against the same base cases it was applied to, so the
report shows the drop per type.

## Metrics

Per configuration, over base cases, overall and per category, category ×
language, value kind, language, case type and register:

- **Precision / recall / F1, overlap**: a detection of the right category
  overlaps the item. **Exact**: same span.
- **Redacted**: some detection overlaps the item, whatever its category (all
  items, supported or not; compares refs end to end). **Leak-free**: no
  non-space character of the item is left visible.
- **Wrong category**: detection overlapping only items of another supported
  category (a password flagged as EMAIL). **Merged items**: items sharing one
  detection span with another item (one span swallowed two values).
- **Hard negatives**: decoys flagged, per decoy kind, and negative cases with
  any false positive.
- **Confusion**: what each item category is detected as.
- Latency per prompt (p50/p95/max) in `run.json`.

## Outputs and commands

```bash
npm run detbench -- --ref main                          # runs/detbench/main-<sha7>/
npm run detbench -- --ref main --compare <branch>       # both runs + compare-<A>-vs-<B>.html
npm run detbench -- --compare-runs runs/detbench/A runs/detbench/B
npm run detbench -- --perturbations case,linebreak --variants 5 --seed 3
```

`runs/detbench/<name>/`: `report.html`, `results.jsonl` (base cases, one row
per configuration and case), `variants.jsonl` (perturbed rows; not committed,
regenerated identically), `metrics.json`, `metrics.csv` (long format:
config, slice, value, metric, number) and `run.json` (ref, sha, packages,
configurations, seed, timing).
