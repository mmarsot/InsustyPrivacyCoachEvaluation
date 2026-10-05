# Deterministic redaction bench

`npm run detbench` measures the extension's **rule-based** detector
(`detectSensitiveData` in `src/detector.ts`): the part that finds secrets,
emails, phones, addresses and, after the detector upgrade, financial data,
national IDs, dates of birth, IP addresses and company IDs. It loads no model:
a run over 301 base cases and ~3,200 perturbed variants takes a few seconds.

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
| `all` | every category in the ref's `CATEGORIES` on, and every `SUPPORTED_ADDRESS_COUNTRIES` when the ref exports that list (`main` does not, so `all` keeps its `FR`) |

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
  `log`, `config`, `table` (rows pasted from a spreadsheet or a CSV/TSV
  export).
- `generated` (large cases): placeholders rendered as plain text by a named
  generator in `src/detbench/generate.ts`, e.g.
  `"generated":{"rows_a":{"generator":"orders_tsv","from":10000,"count":1000}}`
  for 1,000 spreadsheet rows, so a case of thousands of rows stays one short
  line. Generated text is neither item nor decoy: every detection in it is a
  false positive. A case with `generated` is **large**: it is not perturbed
  and is scored apart (see Metrics). Generators are pure functions of the row
  number and their output is part of the dataset hash; add a new generator
  rather than changing one a case uses.
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

`en-133`–`en-140` and `fr-122`–`fr-126` (tags `reference_links` and
`ark_link`, `hex_id_link`, `isbn_typo`, `url_secret_control`) come from the
review of InsustyPromptCoach PR #72, which fixed the first round: Gallica ARK
links (`https://gallica.bnf.fr/ark:/12148/bpt6k5619759j/f12.item`, the
reported link, and fictional variants, in a link and bare), Semantic Scholar
paper links and GitHub/GitLab commit, tree, blob and pull-commit links with a
hex id in the path, in citations and bare, EN and FR. Five controls put a real
secret in or next to such a link (an `api_key=` or 40-hex `access_token=`
query, a Google API key in a Maps query, a `ghp_` token as URL credentials, a
random token in a webhook path), so a fix cannot ignore every URL. A
misspelled `ISNB` label is not a book number to the detector: the ISBN-10
behind it reads as a French landline, so it is ground truth `PHONE` by design
(`en-140`, `fr-125`), next to the same number correctly labelled as a decoy.

`en-141`–`en-149` and `fr-127`–`fr-134` (tag `table_paste`, plus `tsv`,
`csv`, `space_joined`, `numeric_cells`, `state_code_cell`,
`address_in_cell`, `address_split_cells`, `table_flood`) are spreadsheet and
CSV pastes, from the document-upload research (a 60,000-row sheet extracted
as TSV gave 29,999 false ADDRESS hits, e.g. `35000⇥note 10000⇥ok`): order,
invoice and dashboard tables where five-digit amounts sit next to short cells
(`ok`, `in`, `me`, `or`, `de`, `la`, `EUR`), the same rows as comma or
semicolon CSV and joined with spaces, numeric cells that concatenate into a
NIR, a card or a phone, and positive controls with an email, an IBAN or an
address in a cell. A French address split over Street, Postcode and City
columns is one item spanning the three cells and their tabs. `en-149`
(2,003 lines, generator `orders_tsv`) and `fr-132` (1,003 lines,
`commandes_tsv`) are the large cases, with an email, an IBAN and an address
in cells in the middle.

`en-150`–`en-160` and `fr-135`–`fr-141` (tag `env_var_names`, plus
`diagnostic_dump`, `env_listing`, `config_file`, `feature_list`,
`extension_list`, `secret_control`, `dump_flood`) come from a Chrome
about:gpu report the captain pasted, where `main` redacted 32 spans as
SECRET (the case values are fictional; the dump itself is not committed):
about:gpu Driver Information and workaround sections, `printenv` and
`kubectl describe` environment listings (`NAME=value`, `NAME: value`),
vulkaninfo properties, kernel `.config`, an INI file and C code, and Chrome
feature lists. Uppercase environment-style names with plain values
(versions, vendor names, booleans, paths, hex device ids) are template text
or decoys, never items. GL/EGL/Vulkan extension and format names, ANGLE,
Dawn, WebGPU, Chrome and Vulkan feature names, pod and node names with a
hash suffix, machine model strings and a GNOME terminal path with an
underscored UUID are decoys of kind `identifier`. The controls put real
secrets under such names (`API_KEY=<token>`, AWS keys, `DATABASE_URL` and
`REDIS_URL` passwords, GitHub, GitLab, OpenAI, Stripe and Hugging Face
tokens, and keyword-less names such as `X_TELEMETRY_KEY=` whose value only
the high-entropy rule catches), next to the identifiers. `en-160` (600
generated lines, generator `gpu_report`) and `fr-141` (360 lines) are the
large cases, with secrets in `NAME : value` lines in the middle.

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
- **Large generated cases**, apart from every metric above so one flood does
  not swamp them: per case, items found and redacted, false positives in all
  and per ref category, and the call time.
- Latency per prompt (p50/p95/max) and the ten slowest base-case calls in
  `run.json`.

## Outputs and commands

```bash
npm run detbench -- --ref main                          # runs/detbench/main-<sha7>/
npm run detbench -- --ref main --compare <branch>       # both runs + compare-<A>-vs-<B>.html
npm run detbench -- --compare-runs runs/detbench/A runs/detbench/B
npm run detbench -- --perturbations case,linebreak --variants 5 --seed 3
```

`runs/detbench/<name>/`: `report.html`, `results.jsonl` (base cases, one row
per configuration and case; a large case keeps its detections on items and
its first 50 false positives, without its text), `variants.jsonl` (perturbed
rows; not committed, regenerated identically), `metrics.json`, `metrics.csv` (long format:
config, slice, value, metric, number) and `run.json` (ref, sha, packages,
configurations, seed, timing).
