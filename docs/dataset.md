# Dataset guide

The dataset tests one thing: given a fictional client's custom labels, does the
extension's local AI review find the passages that client considers sensitive,
and only those? Everything in it is invented: companies, people, codenames,
figures. No real personal data, no text copied from the web.

## Layout

```
dataset/
  profiles/<profile>.json        one fictional client: persona + 1-3 custom labels
  cases/<profile>.<lang>.jsonl   one case per line, lang = en | fr
  style-guides/<profile>.md      how people in that job really write (sources + traits)
```

Profiles: `sales`, `dev`, `hr`, `legal`, `finance`, `support`, `agency`, `research`.

## Profile file

```json
{
  "id": "sales",
  "name": "Sales rep with an unannounced product",
  "persona": "Who they are and what they paste into chatbots.",
  "labels": [
    {
      "label": "UNRELEASED_PRODUCT",
      "description": "Names or internal codenames of our products that are not announced publicly yet.",
      "examples": ["Project Ostrava", "the Veltrano K9 dock", "Lumen Relay 2"],
      "counterExamples": ["HubSpot", "the Veltrano K7 (already on sale)", "Zoom"]
    }
  ]
}
```

Labels follow the extension's own rule constraints (`/^[A-Z][A-Z0-9_]{0,31}$/`,
description at most 1000 characters). The runner builds five description
variants from each label (`src/variants.ts`): description only, description +
1 example, description + 3 examples, examples only, examples + counter-examples.

**Examples and counter-examples must never appear in a case text** (whole-word,
case-insensitive). Otherwise a description variant would hand the model the
answer. The validator rejects such leaks.

## Case line

```json
{"id":"sales-en-001","profile":"sales","lang":"en","type":"clear_positive","difficulty":"easy",
 "style":{"register":"email","errors":"none"},"tags":[],
 "text":"Hi Dana, quick one before the Hadley call...",
 "expected":[{"label":"PROSPECT_NAME","passage":"Hadley"}],
 "note":"why this case exists"}
```

| Field | Values |
| --- | --- |
| `id` | `<profile>-<lang>-<nnn>`, never renumbered once committed |
| `type` | `clear_positive`, `subtle_positive`, `lookalike_negative`, `clean_negative`, `hard` |
| `difficulty` | `easy`, `medium`, `hard` |
| `style.register` | `email`, `chat`, `notes`, `log`, `code`, `list`, `doc`, `ticket`, `request`, `social` |
| `style.errors` | `none`, `light`, `heavy` (spelling/grammar, in either language) |
| `mixed` | `true` when the text mixes languages (French text with English codenames or code) |
| `tags` | free strings; known ones in `src/dataset/schema.ts` (`abbreviation`, `lowercase`, `possessive`, `buried`, `public_codename`, `multi_label`, `long`, `code_block`, `injection`, `request`...) |
| `expected` | `{label, passage}` pairs, `[]` for negatives |
| `split` | `dev` or `test`, assigned once by `npm run split`; leave it out when adding cases |
| `note` | optional, never sent to the model |

### Ground truth rules

- `passage` is an **exact, case-sensitive substring** of `text`. Every
  occurrence counts; list a passage once even if it repeats. The validator
  computes the offsets and rejects anything not found verbatim.
- Mark the **shortest passage that identifies the secret**: `Hadley Freight`,
  not `the Hadley Freight renewal`; `€87k base` is fine for a salary. Keep
  passages on word boundaries (the extension's anchoring requires it).
- If the same secret appears in two spellings (`Ostrava` and `ostrava`, `K9`
  and `the K9`), list each spelling that should be caught.
- Only the profile's custom labels are ground truth. Avoid emails, phone
  numbers, postal addresses and API keys: deterministic rules handle those.
- Negatives (`lookalike_negative`, `clean_negative`) have `expected: []`.
  `hard` cases may be positive or negative.

### Type mix per profile and language (about 50 cases each)

| Type | Share | What it looks like |
| --- | --- | --- |
| `clear_positive` | ~35% | The secret is plain, correctly cased, in a normal sentence |
| `subtle_positive` | ~15% | Abbreviation, lowercase, possessive (`Ostrava's`), typo, buried mid-paragraph |
| `lookalike_negative` | ~25% | Looks sensitive but is not: public codenames (Apple's Project Titan), competitor named in a public context, released products, generic product words, public figures |
| `clean_negative` | ~10% | Ordinary work text with nothing sensitive |
| `hard` | ~15% | Multi-label, long text (> 1000 chars), code blocks, lists/tables, "ignore your instructions" injections, prompts that are themselves requests to the model |

French files also include **mixed-language** cases (`"mixed": true`): French
text with English codenames, English code/logs, franglais.

### Realistic style

Prompts must not all read like polished AI text. Vary register (formal email,
terse chat message, rushed notes, pasted log/code, bullet lists) and error
level (none / light / heavy: typos, missing accents, SMS-style French,
franglais, lowercase everything). Each profile's `style-guides/<profile>.md`
records how people in that job actually write, with the public sources
consulted. Imitate style only: never copy real text or reuse real names.

## Adding cases

1. Append lines to `dataset/cases/<profile>.<lang>.jsonl` with the next free id.
2. `npm run validate -- --allow-missing-split --profile <profile>` until clean.
3. `npm run split` (assigns `dev`/`test` to new cases only; existing splits never change).
4. `npm run validate`.

The **test split** (~30%, stratified by profile, language and type) is held
out: never read it while tuning prompts or label descriptions. Tune on `dev`
only, then confirm on `test`.
