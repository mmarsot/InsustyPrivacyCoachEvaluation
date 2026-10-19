# insusty-builtin: built-in-label prompts (detbench)

`npm run detbench` measures the extension's **rule-based** detector
(`detectSensitiveData` in `src/detection/detector.ts`): the part that finds secrets,
emails, phones, addresses and, after the detector upgrade, financial data,
national IDs, dates of birth, IP addresses and company IDs. It loads no model:
a run over 316 base cases and ~3,400 perturbed variants takes a few seconds.

Code: `datasets/insusty-builtin/` and `engine/scorers/builtin-spans/` (dataset, perturbations, ref loading, scoring, report)
and `engine/cli/detbench.ts`. Tests: `datasets/insusty-builtin/insusty-builtin.test.ts`.

## How a ref is run

The ref is materialized read-only by the bench's one materializer
(`modules/insusty-privacy/materialize.ts`, see [its README](../../modules/insusty-privacy/README.md)): the ref's
`git archive` into `cache/module/<sha>/`, its npm packages at the versions its
`package-lock.json` pins (so libphonenumber metadata and validators match what
that commit ships), one bundle. detbench scores the built-in spans of the
module's `redact()` on each prompt, through the redaction contract
(`engine/scorers/builtin-spans/detector.ts`, `contract/README.md`), with Private AI off. Any other
module with a dataset adapter for this dataset scores the same way, on the
labels its adapter maps (`npm run detbench -- --module presidio`, or the
Grid's presidio row): the Presidio baseline on this dataset.

Each ref runs with two configurations:

| Config | What it is |
| --- | --- |
| `default` | the module's default configuration (the ref's `DEFAULT_CONFIG`), as a new user gets it |
| `all` | every built-in label the module declares on, and every address country it declares (the ref's `SUPPORTED_ADDRESS_COUNTRIES` when exported; `main` does not export it, so `all` keeps its `FR`) |

Only **selected** detections count: what gets redacted without the user
ticking anything. A category switched off leaves its detections unselected.

## Categories and ref support

Ground truth uses the upgraded names: `SECRET`, `EMAIL`, `PHONE`, `ADDRESS`,
`FINANCIAL`, `NATIONAL_ID`, `DATE_OF_BIRTH`, `IP`, `COMPANY_ID`
(`datasets/insusty-builtin/` and `engine/scorers/builtin-spans/schema.ts`). As in the upgrade, SIREN, SIRET and French VAT
numbers are `COMPANY_ID`, not `NATIONAL_ID`, and a MAC address is `IP`; `IP`
and `COMPANY_ID` are off in the upgrade's `default` configuration, so their
items count as misses there and are scored in `all`.
A ref's category names are mapped with `CATEGORY_ALIASES`
(`engine/scorers/builtin-spans/detector.ts`): today's `API_KEY` is `SECRET`, and plausible
spellings such as `IP_ADDRESS` or `IBAN` map too. A dataset category with no
matching ref category is **not supported by this ref**: its items are left out
of precision, recall and F1 and reported apart, with the share that another
category happened to redact. So the same dataset scores today's `main` and
the upgrade branch. If a ref introduces a category name the aliases do not
know, its detections count as false positives until you add an alias.

## Dataset

`datasets/insusty-builtin/cases/<lang>.jsonl`, one case per line:

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
  generator in `datasets/insusty-builtin/` and `engine/scorers/builtin-spans/generate.ts`, e.g.
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
  (`datasets/insusty-builtin/` and `engine/scorers/builtin-spans/checksums.ts`; the loader rejects failures). A value may hold
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

`fr-142`–`fr-156` (tag `fr_multiline_address`) come from rule-based
detection missing both postal addresses in the OCR of a scanned French
letter: the detector scans one line at a time, so a French address block
(street line, then `postcode CITY`) is never matched. Shape 1 (tag
`address_two_line`): a street line then a `postcode CITY` line, with a
multi-word uppercase city, `ST` abbreviated and an apostrophe lost by the OCR
(`00100 ST NULLE PART D ICI`, tag `abbreviated_city`). Shape 2 (tags
`uppercase_street`, `ocr_punctuation`): an all-caps street line ending with
` :`, ` ;` or `,` added by the OCR (`45 CHEMIN DE LA FICTION :`), which the
one-line FR pattern rejects too. Related shapes (tag `address_bp_cs_cedex`):
a `CS` line between street and postcode, and `CEDEX` with its office number.
`fr-150` puts a shape-1 sender and a shape-2 recipient in one letter header.
The item is the whole block, line breaks and OCR punctuation included.
`fr-151`–`fr-156` (tag `address_near_miss`) are line pairs that must not be
flagged (decoy kind `address_lookalike`): a sentence line under a street-like
line, tab-separated spreadsheet cells, a first line with no street type, a
blank line between street and postcode, a 4-digit postcode, a year and a
`Total` line. Tag `ocr_scan` marks the cases in the document's own shapes.

**Adding cases**: append lines with the next free id, then run
`npm run detbench -- --validate`. Secret-looking values must not appear raw in
the files, so secret scanners (GitHub push protection) do not block the repo:
run `npm run detbench -- --defang-dataset`, which writes one character of each
provider prefix as a `\uXXXX` escape (`JSON.parse` restores it). Committed
outputs are escaped the same way (`datasets/insusty-builtin/` and `engine/scorers/builtin-spans/defang.ts`).

## Perturbations

`datasets/insusty-builtin/` and `engine/scorers/builtin-spans/perturb.ts` generates up to `--variants` (default 2) variants
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
language, value kind, language, case type, register and tag:

- **Precision / recall / F1, overlap**: a detection of the right category
  overlaps the item. **Exact**: same span.
- **Redacted**: some detection overlaps the item, whatever its category (all
  items, supported or not; compares refs end to end). **Leak-free**: no
  non-space character of the item is left visible.
- **Wrong category**: detection overlapping only items of another supported
  category (a password flagged as EMAIL). **Merged items**: items sharing one
  detection span with another item (one span swallowed two values).
- **Per tag**: the same metrics per dataset tag (a case counts under each of
  its tags), so a group of regression cases reads as one row.
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
npm run detbench -- --ref main                          # results/runs/detbench/main-<sha7>/
npm run detbench -- --ref main --compare <branch>       # both runs + compare-<A>-vs-<B>.html
npm run detbench -- --compare-runs results/runs/detbench/A results/runs/detbench/B
npm run detbench -- --perturbations case,linebreak --variants 5 --seed 3
```

`results/runs/detbench/<name>/` (kept locally: `runs/` is git-ignored because results
copy the case texts, so a fresh clone has no run until you produce one, and
`--compare-runs` says so): `report.html`, `results.jsonl` (base cases, one row
per configuration and case; a large case keeps its detections on items and
its first 50 false positives, without its text), `variants.jsonl` (perturbed
rows, regenerated identically), `metrics.json`, `metrics.csv` (long format:
config, slice, value, metric, number) and `run.json` (ref, sha, packages,
configurations, seed, timing).

## Results

Baseline on `main` @ `4d68779` (after the detector upgrade, PR #42, its gap
fixes, PRs #43 and #45, the reference-link fixes, PRs #72 and #73, and the
spreadsheet fix, PR #74; run `main-4d68779`, 2026-10-05, kept locally),
base cases, `default` config (FR addresses only, `IP` and `COMPANY_ID` off)
and `all` (every category; the ref does not export its address-country list,
so FR addresses only too). The four large generated cases are scored apart
(below):

|                                                          | `default`       | `all`           |
| -------------------------------------------------------- | --------------- | --------------- |
| F1 / precision / recall (overlap)                        | 81% / 85% / 78% | 90% / 87% / 93% |
| F1, exact span                                           | 80%             | 89%             |
| Items redacted, all categories                           | 78%             | 93%             |
| Items redacted in prose (376) / inside code blocks (136) | 77% / 81%       | 91% / 97%       |
| Negative prompts with a false positive                   | 17% (14 / 82)   | 18% (15 / 82)   |
| Hard negatives flagged                                   | 69 / 496        | 70 / 496        |

- Every category is supported. In `default`, `IP` and `COMPANY_ID` are
  opt-in, so their 79 items count as misses: most of the recall gap to `all`.
- **Regression cases** from PRs #43 and #45 (`en-108`–`en-124`,
  `fr-101`–`fr-116`, see [datasets/insusty-builtin/README.md](datasets/insusty-builtin/README.md#dataset)):
  in `all`, `main` passes all of them, every item exact (in `default`, only
  their opt-in `IP` items are missed).
- **Bibliography references and reference links** (`en-125`–`en-140`,
  `fr-117`–`fr-126`, tag `reference_links`; the captain's report of a DOI
  hidden as `doi:10.[SECRET].001.0001`, then the review of
  [InsustyPromptCoach PR #72](https://github.com/mmarsot/InsustyPromptCoach/pull/72)):
  all pass since
  [PR #73](https://github.com/mmarsot/InsustyPromptCoach/pull/73), which
  stopped the SECRET rule "bounded high-entropy heuristic" from flagging
  Gallica ARK links and hex ids in Semantic Scholar and GitHub/GitLab link
  paths (20 decoys at `cf717aa`). The controls still pass: the `api_key=`,
  `access_token=`, Google key, `ghp_` URL credentials and webhook token next
  to such links are redacted, and the misspelled `ISNB 0-3064-6615-5` is
  redacted as PHONE by design (`en-140`, `fr-125`).
- **Spreadsheet and CSV pastes** (`en-141`–`en-149`, `fr-127`–`fr-134`, tag
  `table_paste`; the document-upload research, where a 60,000-row sheet
  extracted as TSV gave 29,999 false ADDRESS hits in ~11 s): since
  [PR #74](https://github.com/mmarsot/InsustyPromptCoach/pull/74) the TSV
  and CSV cases, both large tables included, have no false positive and every
  email, IBAN and French address in cells is still found (split-cell
  addresses too). Only the space-joined copies still fail: 5 false
  positives in `en-144` (ADDRESS on `35000 note 10000 ok`, a Luhn row as
  FINANCIAL, counts as PHONE) and 3 in `fr-133` (ADDRESS, PHONE). At
  `5540306` the large tables gave 1,998 and 854 false ADDRESS.
- **GPU reports, environment listings and config files** (`en-150`–`en-160`,
  `fr-135`–`fr-141`, tag `env_var_names`; the captain's about:gpu paste,
  where `main` redacted 32 spans in 1,275 lines, all SECRET from the
  "bounded high-entropy heuristic"): the target for the extension fix. Same
  result in both configs:
  - fail, every negative case (11 / 11) and 61 of 90 decoys: GL/EGL/Vulkan
    extension and format names with a mixed part (`GL_EXT_texture_sRGB_decode`,
    `…_s3tc_srgb`, `VK_FORMAT_A2B10G10R10_UNORM_PACK32`,
    `GL_COMPRESSED_RGBA_S3TC_DXT5_EXT`), ANGLE, Chrome and Vulkan feature
    names with digits inside a word (`emulateCopyTexImage2DFromRenderbuffers`,
    `limitMaxTextureBytesTo2MB`, `integerDotProduct4x8BitPackedSignedAccelerated`,
    `VaapiVideoDecoderAV1Main10Profile`), Dawn toggles and WebGPU features
    (`use_blit_for_depth16unorm_texture_to_buffer_copy`,
    `rg11b10ufloat-renderable`), pod and node names with a hash suffix
    (`render-worker-7f8c9d6b5-q4xzt`), laptop model strings and a GNOME
    terminal path holding a UUID with underscores. Uppercase environment
    names with plain values (`XDG_SESSION_TYPE : wayland`, `GDMSESSION=ubuntu`,
    `GPU0 : VENDOR= 0x10de, DEVICE=0x…`, `CONFIG_…=y`, versions, paths,
    booleans) already pass: the names are not the trigger, the token shape is.
  - large, scored apart: `en-160` (608 lines, 40 KB) gives 201 false SECRET
    and `fr-141` (368 lines, 24 KB) 121, in ~25 ms and ~15 ms.
  - pass, controls that a fix must keep (`en-157`–`en-160`,
    `fr-139`–`fr-141`, tag `secret_control`): all 21 secrets under
    environment names are redacted, exact: `API_KEY=` tokens, AWS keys,
    `DATABASE_URL` and `REDIS_URL` passwords, GitHub, GitLab, OpenAI,
    Stripe and Hugging Face tokens, session secrets. Three of them
    (`X_TELEMETRY_KEY=` in `en-157`, `TELEMETRIE_CLE_ENVOI :` in `fr-140`,
    `JETON_TELEMETRIE :` in `fr-141`) are caught only by the same
    high-entropy heuristic, so a fix that skips `NAME=value` or
    `NAME : value` lines would lose them.
- **French multi-line address blocks** (`fr-142`–`fr-156`, tag
  `fr_multiline_address`; added after `4d68779`, from the OCR of a scanned
  French letter in which rule-based detection missed both postal addresses):
  on `main` @ `3d22b5b`
  (run `main-3d22b5b`, 2026-10-06, F1 86% `default` / 94% `all`, "Per tag"
  under the slices of its report), in both configs, all 10 addresses are missed
  (`fr-142`–`fr-150`, nothing detected in them): street line, then
  `postcode CITY` (`7 rue des Glycines` / `00100 ST NULLE PART D ICI`),
  uppercase streets ending with an OCR ` :`, ` ;` or `,`, a `CS 70001` line
  and `CEDEX 08`. The detector scans one line at a time, so its FR pattern
  never crosses the line break. The 6 near-miss line pairs (`fr-151`–`fr-156`,
  tag `address_near_miss`) pass: none is flagged, so a fix must keep them
  clean. Fixed on `main` @ `539608e` (InsustyPromptCoach PR #91; run
  `main-539608e`, 2026-10-07, F1 87% `default` / 95% `all`):
  all 10 addresses are found with exact spans in both configs, the near-miss
  pairs stay clean, and no other base case or variant changes outcome
  (overall F1 86%→87% in `default`, 94%→95% in `all`; false positives
  unchanged at 11 and 12).
- Still missed in `all`: US, UK and DE phones (15), US and UK addresses (9),
  passports (4), dates of birth under a table header (2), 2 French
  passwords, 3 SIRENs and a BIC.
- Hard negatives flagged in `all`: the 61 GPU and environment identifiers
  above, 5 in the space-joined spreadsheet copies, two SSN-shaped part
  numbers as NATIONAL_ID, a Luhn-invalid card look-alike and
  `net-snmp 5.9.4.2` as IP.
- **Perturbations** (`all`, F1 base→perturbed): a line break inside a value
  95%→80%, typos in context words 90%→81%, spacing 95%→88%, punctuation
  95%→90%, `.env` rewrites 95%→90%; the others move F1 by 4 points or less.
