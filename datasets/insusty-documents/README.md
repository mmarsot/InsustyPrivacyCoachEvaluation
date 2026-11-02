# insusty-documents: generated documents (docbench)

`npm run docbench` measures how an extension ref checks **attached files**:
Word, Excel, PowerPoint, OpenDocument, PDF, text-like files and zip
archives, as the extension reads them since
[PR #75](https://github.com/mmarsot/InsustyPromptCoach/pull/75) (text-like
files) and [PR #76](https://github.com/mmarsot/InsustyPromptCoach/pull/76)
(PDFs with PDFium, Office/OpenDocument with its own part map, zips). It is
the third track next to the review bench and detbench, and answers:

- **Extraction**: does the ref read the value at all, wherever it sits
  (footnote, hidden sheet, speaker notes, form field, nested zip...)?
- **Detection**: of what it reads, what does the rule-based detector find,
  and how many false alarms does a document raise?
- **Classification**: are files that cannot be checked (encrypted, scanned,
  zip bombs...) reported as such, never as clean?
- **Redaction**: is a redacted value really gone from the file the
  extension would attach?
- **Speed and scaling**: how read, detection and redaction time and peak
  memory grow with document size, per type, and where the Private AI size
  threshold for files should sit.

Code: `datasets/insusty-documents/` and `engine/scorers/documents/` and `engine/cli/docbench.ts`; planning in
`engine/plan.ts` (`parseDocbenchArgs`, `planDocbench`), shared with the
dashboard (`dashboard/docbench.ts`). Tests: `datasets/insusty-documents/insusty-documents.test.ts`.
The research behind it is section 9 of the document-upload analysis. On
Insusty Privacy Coach 0.1.0 (`main` @ `7adec9b`, tier `full`, 2026-11-02,
run `main-7adec9b`, kept locally) it extracted 98% of the placed values,
with recall 68% / 88% and precision 98% / 98% in `default` / `all`, no
leaks, and 23/23 failure files classified ("Results" below).

## Running it

```bash
npm run docbench -- --ref main                          # suite + quick sweeps, ~5 min
npm run docbench -- --ref main --tier full              # sweeps up to the caps (300k words, 100k rows, 500 pages, 4,000 entries)
npm run docbench -- --ref main --compare <branch>       # two refs + results/runs/docbench/compare-<A>-vs-<B>.html
npm run docbench -- --ref main --ai                     # adds Private AI on documents with the ref's default model (minutes to hours)
npm run docbench -- --dry-run                           # plan and estimate only
npm run docbench -- --validate                          # generate every case and check its ground truth
npm run bench -- --track docbench --ref main            # the same, from npm run bench
npm run docbench -- --compare-runs results/runs/docbench/<A> results/runs/docbench/<B>
```

Options: `--tier smoke|quick|full` (sweep sizes; `smoke` also keeps only
English positive cases), `--tracks suite,sweep,ai`, `--formats docx,pdf,...`
(families or extensions), `--kinds positive,negative,failure`,
`--sweep-types txt,csv,docx,xlsx,pptx,pdf,odt,ods,zip`, `--configs
default,all`, `--seed 1`, `--reps 3` (timing repetitions per sweep point,
median kept), `--ai [default,<models>]` (alone or with `default`: the ref's own default
model, `DEFAULT_SLM_MODEL_ID`; `glm47-flash-connected` adds the connected
model), `--budget-usd 5` (connected spend cap, cached connected spend
included), `--ai-tier smoke|quick|full` (default smoke) and
`--ai-sizes 1000,5000,20000,50000`,
`--name`, `--max-rss-mb 3000`, `--cached-only`, `--ext-repo`.

The extension clone is found like the other tracks (`--ext-repo`,
`INSUSTY_EXT_REPO`, `bench.local.json`). Documents are generated, never
committed: `cache/docbench/files/` holds them by spec hash. Results are
cached per ref commit in `results/jobs/documents/<sha>.jsonl`, keyed by the
commit, the hash of `datasets/insusty-builtin/cases/`, the generator and scorer versions (`GEN_VERSION` in
`datasets/insusty-documents/specs.ts`, `DOC_SCORE_VERSION` in `engine/plan.ts`), the seed,
the configurations and the case spec; a rerun only computes what is missing
and rescores. Private AI jobs go through the shared model result cache
(`results/jobs/review/<sha>/<model>.jsonl`) like any bench job.

Memory: the suite runs in one worker process; each sweep point runs in its
own (`datasets/insusty-documents/` and `engine/scorers/documents/worker.ts`) so its peak memory is its own. Before a
worker starts, the runner waits until `MemAvailable` covers its estimate
plus 1.5 GB (`BENCH_MIN_FREE_MB`; `LAB_MEM_WAIT_S=3600` waits up to an hour
instead of skipping after 180 s) and kills it past `--max-rss-mb` or when
the system drops below 600 MB. The Private AI track runs one model at a
time through `engine/workers/model.ts`, with the bench's memory wait.

## How a ref is run

The ref's redaction package is installed at its commit by the bench's one
materializer (`modules/insusty-privacy/materialize.ts`: `insusty-prompt-coach/redaction`
in `cache/module/<sha>/`, with `@embedpdf/pdfium` at the version the ref's
lockfile pins). The bench hands the package that PDFium, loaded in Node from
its own `pdfium.wasm`, as the extension's own tests do. Each document goes
through the module's `redact()` (the redaction contract, `contract/README.md`),
once per configuration, and `datasets/insusty-documents/` and `engine/scorers/documents/pipeline.ts` reads the outputs
back for scoring. Inside, the package's document pipeline checks the file
the way the extension's `checkFile` and `redactedVersion` do, each stage
timed:

1. `readFileForCheck` classifies the file by its bytes and name;
2. `readDocument` reads a PDF, Office/OpenDocument file or zip (text,
   parts, gaps, signed);
3. `detectSensitiveData` scans the whole text, per configuration
   (`default` = the ref's `DEFAULT_CONFIG`, `all` = every category on); a
   switched-off category's findings are found but not redacted, as in
   `reviewDetectionsOf`;
4. the redacted version: a text file re-encoded in place (`redactPrompt`,
   `encodeText`), a PDF or an archive by `redactDocument`, falling back to
   the redacted text copy when that throws (the extension's D2 fallback),
   an Office file as its text copy (`textCopy`).

OCR is not wired in Node yet: images and scanned pages are reported as the
ref reports them with OCR off.

A ref without `src/document-reader.ts` (before PR #76) still runs: its PDFs,
Office files and zips come out `unchecked:<reason>` as the ref would report
them, so `--compare` across the feature boundary works. Refs before
`src/file-check.ts` read every file as UTF-8 text.

## Cases

Generated deterministically from the seed and labelled ground truth already
in the repository: `datasets/insusty-builtin/cases/` (items with exact values, decoys) for
the rule-based track, `datasets/insusty-custom/cases/` (dev split only) for Private AI. The
writers (`datasets/insusty-documents/` and `engine/scorers/documents/writers/`) are our own minimal, deterministic writers
for zip (stored, deflated, ZipCrypto), Office Open XML, OpenDocument and
OLE2, and pdf-lib for PDFs (Helvetica, WinAnsi, A4) with hand-written
encryption, signature fields and scanned pages. They never use the
extension's own readers.

Content (`datasets/insusty-documents/` and `engine/scorers/documents/content.ts`):

- **prose units**: whole rendered detbench cases (with their decoys), for
  body paragraphs, footnotes, comments, speaker notes, tracked deletions...;
- **field units**: one detbench item with a label (`IBAN ⇥ FR76…`), for
  table cells, sheets, form fields, properties, headers;
- **decoy fields**: detbench hard negatives as label/value rows;
- **filler**: neutral business prose from a fixed sentence bank (no digits).

Each value appears once per document, so it is located without ambiguity.

### Positive cases (format × zone, EN and FR)

| Format | Zones |
| --- | --- |
| docx | body, table_cell, header, footer, footnote, endnote, comment, tracked_deletion, text_box (DrawingML + VML fallback), split_runs (values cut across XML runs), hyperlink (`mailto:` targets), metadata (author, custom properties), embedded (an xlsx inside the docx) |
| xlsx | cell (between order rows), hidden_sheet, very_hidden_sheet, formula_result (cached value of a lookup), cell_comment, sheet_header (page header/footer), metadata |
| pptx | slide, slide_table, speaker_notes, hidden_slide, comment, metadata |
| odt / ods / odp | body, table_cell, header, footer, comment, tracked_deletion, metadata / cell, hidden_sheet, cell_comment, metadata / slide, speaker_notes |
| pdf | page, table_cell (ruled grid, long values wrap inside narrow cells), two_column, line_wrapped (a value broken at a space over two lines), hyphenated (a value without spaces broken with a hyphen), form_field (filled AcroForm field), annotation (sticky note), bookmark, metadata (document information) |
| text | txt, md, log body; csv cell; json value; html body (escaped as HTML) |
| zip | entry_txt, nested_zip (zip › zip › zip), entry_docx, entry_pdf, entry_csv |

### Hard negatives

Bibliographies (detbench `reference_links` cases: DOIs, ISBNs, ARK and
commit links) as docx and PDF; diagnostic dumps (detbench negative logs,
configs and code: SHAs, UUIDs, timestamps, versions, ports) as a log file
and a PDF; invoices (40 decoy fields); numeric order sheets of 10,000 rows
(xlsx, ods) and 20,000 rows (csv) from detbench's `orders_tsv` /
`commandes_tsv` generators; slides of negative prose. Every detection is a
false alarm.

### Failure cases

Each has an expected report; a fully checked read of any of them is a
**silent clean**:

| Case | Expected |
| --- | --- |
| password-protected PDF (RC4), docx and xlsx (OLE2 `EncryptedPackage`), ODT (manifest encryption data), zip (every entry ZipCrypto) | `unchecked:encrypted` |
| zip with one encrypted entry | `partial` |
| image-only PDF / PDF with scanned pages after text | `unchecked:scanned` / `partial` |
| signed PDF | `checked+signed` (redaction removes the signature) |
| PDF with an attached file | `partial` |
| zip bomb (80 MB of zeros in one entry), docx whose body inflates to 70 MB | `partial` (past the inflate caps) |
| zip nested 5 deep / with 5,001 entries | `partial` / `unchecked:unreadable` |
| docm with macros, xlsx with a data connection | `partial` |
| legacy `.doc`, truncated docx, a `.docx` zip that is not Office, a `.pdf` that is text | `unchecked:legacyOffice` / `unreadable` / `office` / `unreadable` |
| text with a 60,000-character base64 run | `unchecked:unbroken` |
| 2.7 MB text file (past the 2 MB scan cap) | `partial` |
| PNG image | `unchecked:image` |

### Size sweeps

`datasets/insusty-documents/` and `engine/scorers/documents/sweeps.ts`: per type, the same kind of document at growing
size, with values at a fixed density (one prose unit per ~1,000 words, one
field row per 500 rows, one per 5 slides or 10 entries):

| Type | Unit | full tier |
| --- | --- | --- |
| txt, docx | words | 1k, 5k, 20k, 100k, 300k |
| odt | words | 1k, 10k, 50k, 150k |
| csv, xlsx | rows (5 cells) | 1k, 5k, 20k, 60k, 100k |
| ods | rows | 1k, 10k, 30k, 60k |
| pptx | slides (+ notes) | 10, 50, 200, 500 |
| pdf | pages (~520 words) | 2, 10, 50, 200, 500 |
| zip | entries (~95 words each) | 10, 100, 1,000, 4,000 |

## Metrics

Per format × zone (positive cases), per configuration:

- **Extraction recall**: the value is in the text the ref read,
  whitespace-insensitive (a value wrapped over two lines counts; one broken
  by a hyphen does not, since the detector sees it broken).
- **Detection recall**: found (a detection of the item's category overlaps
  it) among extracted values; **recall**: found among all placed values;
  **precision**: true positives over true positives plus false alarms; F1.
  Detections are scored with detbench's `scoreDetCase` verdicts.
- **False alarms**: detections on no placed value; for hard negatives also
  per PDF page, per 10,000 cells and per 1,000 words (~6 characters each).
- **Classification**: the ref's report (`checked`, `partial`, `unchecked`
  with its reason, `+signed`) against the expectation; accuracy and silent
  cleans, for failure files and for every other case ("misread").
- **Redaction check**: the redacted output is read by an independent reader
  (`datasets/insusty-documents/` and `engine/scorers/documents/verify.ts`: our own zip walker, the PDF's raw bytes and
  every literal and hex string of every inflated stream, and Poppler's
  `pdftotext` when installed). A value redacted leak-free must be gone; it
  is counted as **leaked** when a reading method still finds more
  occurrences than the text kept on purpose (the same value may also be a
  decoy elsewhere). Values under 8 characters are only looked for in the
  text views, not in raw PDF bytes. The redaction mode is reported:
  `in_place`, `text_copy` (Office, by design), `fallback_text_copy` (a PDF
  or archive the ref could not redact safely).
- **Timing**: read (classify + extract), detect (per configuration), redact;
  suite cases once, sweep points `--reps` times (median), in a warm worker
  (PDFium loaded, detector called once).
- **Memory**: peak RSS during the check minus the worker's RSS before it
  (`/proc/self/clear_refs` resets the peak per document).
- **Scaling**: per sweep type, a power law `ms ≈ a · n^b` fitted on log-log
  points (total, read, detect), `b ≈ 1` linear; peak memory fitted linear;
  time per 1,000 characters; and the size the fit keeps within 1 s and 5 s.

### Private AI on documents

With `--ai` (the ref's default model, SmolLM2-360M at `2aece81`, and any
local or connected models named after it), dev-split custom-label cases (`--ai-tier smoke`, the
default: dev and finance, EN; `quick`: every profile, EN and FR, one clear
positive each; `full`: plus one look-alike negative) are put in the middle of Word documents of
`--ai-sizes` characters of neutral filler, read by the ref's reader and
reviewed by the model with the ref's own review through the model
runner (its package, `desc` label descriptions and examples). Reported
per size: recall of expected passages, false positives, review time p50 and
max, requests; a power-law fit of review time against characters; and the
largest document whose median review stays within 30 s, 60 s and 120 s,
next to the extension's `localAi.fileReviewLimit` (20,000 characters by
default; 5,000 to 100,000 offered).

The connected model (`glm47-flash-connected`, `modules/insusty-privacy/connected.ts`)
runs exactly as `npm run bench` runs it: through the contract, on the ref's
own connected-model client (requests, pacing, retries, parsing, its
25,000-token context budget and learned-example limits), with the bench
supplying only the transport (reply cache, cost, budget). The key comes only
from the environment (`AWS_BEARER_TOKEN_BEDROCK`), the plan prints a cost
estimate and refuses to start past `--budget-usd`, and each document's cost
is reported.

## Outputs

`results/runs/docbench/<name>/` (kept locally: `runs/` is git-ignored, so a fresh
clone has no run until you produce one, and `--compare-runs` says so):
`report.html` (tables, charts), `results.jsonl`
(suite rows with extracted text up to 60,000 characters), `sweeps.jsonl`
(sweep rows without item lists), `metrics.json`, `metrics.csv` (format ×
zone × configuration), `run.json` (ref, packages, caps, configurations,
machine) and with `--ai`, `ai.json`. Secret-looking values are defanged.

The dashboard's **Documents** view (`npm run dashboard`, `#docs`) lists these
runs and runs in progress (rebuilt from their arguments with `planDocbench`
and the result cache): overview, per format and per zone tables with a
configuration switch, failure files, hard negatives, scaling charts and
fits, Private AI curves, a document list with a drill-down (the extracted
text with found and missed values highlighted, gaps, timing, redaction,
false alarms), the full report, and the comparison of two runs. The Live
view shows a document-bench run's progress.

## Adding cases

- A new zone: add it to `ZONES` in `datasets/insusty-documents/specs.ts` and its branch in
  `buildPositive` (`datasets/insusty-documents/cases.ts`); prose zones take `prose()` or
  `shortProse()` units, cell-like zones `fields()` and `decoyFields()`.
- A new failure file: add it to `FAILURES` with its expected report, and its
  branch in `buildFailure`.
- A new hard negative: add it to `NEGATIVES` and `buildNegative`.
- New values: add detbench cases (`datasets/insusty-builtin/README.md`); documents pick them
  up through the pools, and must stay fictional and checksum-valid.
- Whenever a writer or builder changes what a document holds, bump
  `GEN_VERSION`; when scoring changes, bump `DOC_SCORE_VERSION`. Run
  `npm run docbench -- --validate` and `npm test`.

## Limits

- The documents are made by our writers, not by Word, Excel, LibreOffice or
  a PDF printer: they hold the structures that matter (and the ones other
  extractors skip), but not every variant real software writes. PDFs use a
  standard font without embedded subsets.
- Sweep filler repeats a fixed sentence bank, so files compress far better
  than real ones (a 300,000-word docx is ~100 KB): sizes are reported in
  characters of text, which drive read and detection time, and in file bytes.
- No OCR (phase 3 of the extension): scanned pages are only checked for
  being reported.
- Timings are this machine's, with other lanes running; compare refs from
  the same run (`--compare`) rather than across days.

## Results

**Insusty Privacy Coach 0.1.0** on `main` @ `7adec9b` (2026-11-02; the
release-checked `9fdfe56` plus store screenshots, same code; tier `full`,
seed 1; run `main-7adec9b`, kept locally):

|                                                  | `default`       | `all`           |
| ------------------------------------------------ | --------------- | --------------- |
| Values placed / extracted by the ref             | 740 / 98%       | 740 / 98%       |
| Recall / precision / F1                          | 68% / 98% / 80% | 88% / 98% / 93% |
| Redacted values gone from the redacted file      | 505 / 505       | 653 / 653       |
| Hard-negative documents with a false alarm       | 1 / 15 (3)      | 5 / 15 (7)      |
| Failure files reported correctly / silent cleans | 23 / 23, 0      | 23 / 23, 0      |

- Every redacted value is gone from the file the extension would attach,
  and every file that cannot be checked (encrypted, scanned, too large...) is
  reported as such, never as clean.
- Extraction is complete (100%) in every Office, OpenDocument and zip
  family; PDFs 90%, text-like files 99%.
- Detection (`all`, share of placed values found): EMAIL 98%, SECRET 94%,
  IP 98%, FINANCIAL 89%, ADDRESS 84%, PHONE 77%, COMPANY_ID 77%,
  NATIONAL_ID 79%, DATE_OF_BIRTH 67%. In `default`, `IP` and `COMPANY_ID`
  are opt-in, which explains most of the recall gap.
- PDF redaction: 22 PDFs redacted in place, 3 through the fallback; 6 of
  117 findings (e-mails) do not redact in place alone.
- Speed: within 5 s up to at least 300,000 words (docx, txt), 20,000 rows
  (xlsx, csv) and 500 slides (pptx); PDFs up to 47 pages. The 500-page PDF
  sweep point did not finish in this run (the worker stalled under memory
  pressure from other lanes and was stopped).

Private AI on documents, GLiNER2-PII (the default model; Private AI suite,
`--ai-tier smoke`: 2 documents at 4 sizes; run
`release-0.1.0-docbench-ai-gliner2`): review time grows linearly with size,
about 2 s per 1,000 characters (2.0 s at 1,071 characters, 10.2 s at 4,989,
39.0 s at 19,556, 101.9 s at 49,170). The largest document reviewed within
30 s is about 14,900 characters, within 60 s about 29,200, so a file at the
extension's default `localAi.fileReviewLimit` (20,000 characters) takes
about 40 s. The sample holds 3 expected items (1 found at every size): too
few to quote a recall.

The baselines below are earlier refs, kept for their history.

Baseline on `main` @ `2aece81` (PR #76; tier `full`, seed 1, detbench
dataset as of `c1c7a64`; run `main-2aece81`, 2026-10-06, kept locally):

|                                                  | `default`       | `all`           |
| ------------------------------------------------ | --------------- | --------------- |
| Values placed / extracted by the ref             | 719 / 98%       | 719 / 98%       |
| Recall / precision / F1                          | 67% / 94% / 78% | 83% / 95% / 88% |
| Redacted values gone from the redacted file      | 486 / 486       | 594 / 594       |
| Hard-negative documents with a false alarm       | 6 / 15 (83)     | 6 / 15 (83)     |
| Failure files reported correctly / silent cleans | 23 / 23, 0      | 23 / 23, 0      |

- **Extraction** is complete in every Office, OpenDocument, text and zip
  zone: hidden and very hidden sheets, tracked deletions, speaker notes,
  comments, text boxes, values split across XML runs, metadata, embedded and
  nested files. The misses are PDF-only: a value hyphenated over two lines
  is never read whole (0/12), and long values wrap inside narrow PDF table
  cells (92% extracted there).
- **Detection** (`all`, share of placed values found) follows the
  detector's own profile (EMAIL 98%, SECRET 92%, FINANCIAL 86%, ADDRESS 49%,
  PHONE 58%), with document-specific drops: a value wrapped over two PDF
  lines is read but found 17% of the time, PDF form-field values 58%, xlsx
  metadata 42%, a CSV inside a zip 50% (label/value pairs without sentence
  context).
- **False alarms** come from the new detbench diagnostic decoys (GPU
  report identifiers, pod and host names, `VK_FORMAT_*` constants) read as
  SECRET: 18-24 per diagnostic dump (~25 per 1,000 words, 7.7 per PDF page),
  and from base64 blobs in spreadsheet cells. The 10,000- and 20,000-row
  order sheets and CSVs give none; bibliographies none.
- **Redaction**: every value redacted leak-free is gone from the attached
  file (independent reader incl. `pdftotext`). Office files go out as text
  copies by design. PDFs are redacted in place except when an email starting
  with `j` has more text after it on its line: the ref's check finds "Text
  is still readable under a box" and the whole PDF falls back to its text
  copy (6 of 139 PDF findings; 3 of 26 PDFs with findings, and the 50-,
  200- and 500-page sweep PDFs).
- **Caps**: a spreadsheet whose text passes 2 MB (60,000 rows x 5 cells) is
  skipped whole, not truncated: 12 characters of the workbook are checked
  and the file is reported partly checked (xlsx and ods). Text files past
  2 MB keep their first 2 MB; a 4,000-entry zip drops 512 of its 4,000
  parts (past 2 MB of text, reported).
- **Speed** is linear in text size (fitted exponents 0.87-1.04, R² ≥ 0.98):
  about 0.5 ms per 1,000 characters for txt, docx, odt and csv, 0.8-1.3 for
  xlsx and ods (XML parsing), 1.7 for pptx, 2.7 for PDF (PDFium reading plus
  in-place redaction, 2.1 s of the 4.4 s for 500 pages). Detection is about
  0.5 ms per 1,000 characters everywhere, so a 2 MB text costs ~1 s of rules
  and every type stays under 5 s up to its caps. Peak memory stays under
  500 MB per document (worker baseline ~140 MB).
- **Private AI on documents** (`--ai default`, pinned to `2aece81`;
  `--ai-tier smoke`: 2 dev cases, 3 expected passages, each in Word
  documents of 1,000 to 50,000 characters; 18 passage instances).
  SmolLM2-360M, the ref's default on-device model:

  |                           | SmolLM2-360M (on device)        |
  | ------------------------- | ------------------------------- |
  | Passages found            | 2 / 18 (both at 20,000 chars)   |
  | False positives           | 1                               |
  | Review time, 1,000 chars  | 5-10 s                          |
  | Review time, 20,000 chars | 89-141 s                        |
  | Review time, 50,000 chars | 229-367 s                       |
  | Time fit                  | `5.78 · chars^0.98` ms (linear) |
  | Within 30 s               | ~6,300 chars                    |

  The 360M answers are mostly dropped by the ref's own checks
  (`hallucinated`, `echo_instructions`). Three passages are too few for a
  firm recall curve; `--ai-tier quick` (16 cases) gives one. This run also
  had GLM-4.7 Flash through a bench-side copy of the connected-model client
  (`glm47-flash-trusted`, removed with the older models on 2026-10-17; its
  points were retired). The connected model now runs as
  `glm47-flash-connected` through the ref's own client
  (`--ai default,glm47-flash-connected`).
