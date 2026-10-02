# Deterministic redaction bench

`npm run detbench` measures the extension's **rule-based** detector
(`detectSensitiveData` in `src/detector.ts`): the part that finds secrets,
emails, phones, addresses and, after the detector upgrade, financial data,
national IDs, dates of birth, IP addresses and company IDs. It loads no model:
a run over 253 base cases and ~2,900 perturbed variants takes a few seconds.

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
`FINANCIAL`, `NATIONAL_ID`, `DATE_OF_BIRTH`, `IP`, `COMPANY_ID`
(`src/detbench/schema.ts`). As in the upgrade, SIREN, SIRET and French VAT
numbers are `COMPANY_ID`, not `NATIONAL_ID`, and a MAC address is `IP`; `IP`
and `COMPANY_ID` are off in the upgrade's `default` configuration, so their
items count as misses there and are scored in `all`.
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
- A decoy of kind `invalid_checksum` (an IBAN, card, NIR or NHS look-alike
  with a wrong check digit) names the kind it imitates in `of`; the validator
  checks that it fails that checksum.
- Each item and decoy gets a **zone**, derived from the rendered text:
  `code` inside a ``` or ~~~ fenced block or a Markdown indented block (four
  spaces or a tab after a blank line), `prose` elsewhere (inline `` `code` ``
  and unfenced pastes such as a CSV stay prose). Many cases are prose around
  a pasted snippet (stack traces, `.env`, docker-compose, SQL output, curl,
  JSON, git output, access logs), with sensitive values on both sides and
  hard negatives inside the code.

Ground-truth rules:

- The item is the value only: the key without `OPENAI_API_KEY=`, the password
  without `user:` (in `curl -u user:pw` and `redis://:pw@host` too), the
  whole PEM block, the whole address. An email keeps every `=` of its local
  part (VERP `list-bounces+jo=example.org@lists.example.net`, ezmlm
  `list-return-42-jo=example.org@…`) but not a leading key (`SMTP_USER=`,
  `user=`, `login=`). An SRS forwarding address
  (`SRS0=HHH=TT=example.org=jo@fwd…`) is the exception: its `SRS0=` tag
  holds no personal data and may stay visible, so the item starts after it
  (the tag is template text) and the hash, timestamp, original domain and
  user must be redacted. The same holds without the tag (a bare config value
  `LAST_RETURN_PATH=Hn7c=6D=…`) and inside brackets after it (`SRS0=(…)`,
  `SRS0=«…»`): the whole address is the item, so trimming the hash as if it
  were a `key=` leaks it.
- A value wrapped in brackets, backticks or doubled quotes is the value
  without them: `curl --user deploy:<Hc7!pR2v>`, `redis://:<pw>@host`,
  `"token": "`uuid`"`, CSV-escaped `""token"": ""uuid""`. Angle brackets are
  ambiguous with placeholder syntax; the rule here: a bracketed descriptive
  word (`<password>`, `<mot_de_passe>`, decoy kind `placeholder`) is a
  placeholder, a bracketed string mixing letters with digits or symbols is
  the password (an item, brackets excluded).
- A key before an email stays out of the item even when it has an inner
  hyphen and no leading `--` (`mail-from=`, `reply-to=`,
  `adresse-expediteur=`).
- Every value is fictional and, where a checksum exists, valid: IBAN mod 97
  (French and Monaco ones also with a valid RIB key; Belgian, Spanish,
  Italian, Dutch and Portuguese ones with their national check), card Luhn,
  NIR key (Corsica `2A`/`2B` too), SIREN/SIRET Luhn, French VAT key, NHS
  mod 11, NINO prefix and suffix rules, SSN structure
  (`src/detbench/checksums.ts`; the loader rejects failures). A value may hold
  a line break (an IBAN wrapped by a mail client). Use documentation IP ranges (`192.0.2.0/24`,
  `198.51.100.0/24`, `203.0.113.0/24`, `2001:db8::/32`) or private ones
  (kind `ipv4_private`).
- No unlabelled sensitive value: if a prompt needs an address or a card
  expiry for realism, label it or leave it out, or a correct detection would
  count as a false positive. Names are out of scope (the product does not
  detect them).
- Not sensitive, so decoys: public keys, masked or truncated keys
  (`sk-...Qx7T`), base64 images and fonts, hashes, loopback addresses
  (`127.0.0.1`, `localhost`, `::1`, `0.0.0.0`), ports, netmasks and OIDs,
  IP-shaped versions (`1.2.3.4`, `4.2.1.8`), ordinary dates next to a date of
  birth, SSN-shaped part numbers, 9- and 14-digit client or file numbers,
  a `docker run -u 1000:1000` user id, an IBAN-shaped line that fails mod 97
  (an order reference, a typo) above a real IBAN. A UUID is a decoy, except
  as a secret's value (`token: <uuid>` is a `generic_token`); a dotted quad
  after `v`, `==` or a version word is a version, while an address after
  `The conversion server is` or `Version 2 ships today, server` is an IP.
  A card expiry (`card_expiry`) or CVV is an item only next to its card
  context.
- A parenthetical after a secret keyword is prose unless it holds a
  value-shaped string: `Generate a private key (RSA-2048) first`,
  `the token (v2) expired`, `secret (2FA)`, `access token (OAuth2)`,
  `private key (ed25519)` are decoys (kind `term`), while
  `token: (<uuid>)` and `password is (<value>)` are items. An OpenSSH public
  key blob is public even without its `ssh-ed25519`/`ssh-rsa` label
  (`JWT_PUBLIC_KEY=AAAAC3NzaC1lZDI1NTE5…`; the RFC 4253 wire format starts
  `AAAAC3NzaC1lZDI1NTE5`, `AAAAB3NzaC1yc2E` or
  `AAAAE2VjZHNhLXNoYTItbmlzdHA`).

Regression cases pin hard cases found in extension reviews: `en-108`–`en-116`
and `fr-101`–`fr-108` come from InsustyPromptCoach PR #43 (`=` in email local
parts and `KEY=` before an email, IBAN lists and wrapped IBANs, IBANs under a
mod-97-failing line, `curl -u` and `redis://:pw@` passwords with their
look-alikes, version quads, UUID tokens, JSON/YAML/`.env` dates of birth and
expiries, a repeated compact SSN or NIR). `en-117`–`en-124` and
`fr-109`–`fr-116` come from PR #45: SRS addresses without their `SRS0=` tag,
angle-bracketed passwords in `curl --user` and URL credentials next to
`<password>` placeholders, doubled quoting around keyword values, bare
OpenSSH public-key blobs, hyphenated keys before an email, and prose
parentheticals after secret keywords next to real `token: (…)` and
`password is (…)` values.

`en-125`–`en-132` and `fr-117`–`fr-121` (tag `reference_links`) are
bibliography references: the captain's Oxford Companion citation (`doi:10.1093/acref/9780198604464.001.0001`, ISBN
978-0-19-172760-3) whose DOI `main` redacted as `doi:10.[SECRET].001.0001`, APA, Chicago, Vancouver,
Wikipedia-rendered and French (ISO 690) styles, `doi:`, `https://doi.org/` and
`dx.doi.org` forms, ISBN-10/13 with and without hyphens, ISSN, PMID/PMC,
arXiv, JSTOR, Handle, HAL, Persée and Cairn links (decoy kinds `identifier`
and `url`). Four of them mix in a real email or key, so recall is still
measured next to references.

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
| `code_block` | the whole prompt inside a ``` or ~~~ fence (a longer one if the prompt already holds a fence) |
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
- **Prose vs code**: the same metrics for items, decoys and detections in
  prose and inside code blocks (a detection counts where it starts).
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
