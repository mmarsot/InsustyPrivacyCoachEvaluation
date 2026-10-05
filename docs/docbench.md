# Document bench

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

Code: `src/docbench/` and `src/cli/docbench.ts`; planning in
`src/run/plan.ts` (`parseDocbenchArgs`, `planDocbench`), shared with the
dashboard (`src/dashboard/docbench.ts`). Tests: `tests/docbench.test.ts`.
The research behind it is section 9 of the document-upload analysis. The
baseline on `main` @ `2aece81` and what it shows are in the README
("Document bench"); its run is `runs/docbench/main-2aece81/`.

## Running it

```bash
npm run docbench -- --ref main                          # suite + quick sweeps, ~5 min
npm run docbench -- --ref main --tier full              # sweeps up to the caps (300k words, 100k rows, 500 pages, 4,000 entries)
npm run docbench -- --ref main --compare <branch>       # two refs + runs/docbench/compare-<A>-vs-<B>.html
npm run docbench -- --ref main --ai smollm2-360m        # adds Private AI on documents (a model, minutes to hours)
npm run docbench -- --dry-run                           # plan and estimate only
npm run docbench -- --validate                          # generate every case and check its ground truth
npm run bench -- --track docbench --ref main            # the same, from npm run bench
npm run docbench -- --compare-runs runs/docbench/<A> runs/docbench/<B>
```

Options: `--tier smoke|quick|full` (sweep sizes; `smoke` also keeps only
English positive cases), `--tracks suite,sweep,ai`, `--formats docx,pdf,...`
(families or extensions), `--kinds positive,negative,failure`,
`--sweep-types txt,csv,docx,xlsx,pptx,pdf,odt,ods,zip`, `--configs
default,all`, `--seed 1`, `--reps 3` (timing repetitions per sweep point,
median kept), `--ai <models>`, `--ai-tier smoke|quick|full` (default smoke) and
`--ai-sizes 1000,5000,20000,50000`,
`--name`, `--max-rss-mb 3000`, `--cached-only`, `--ext-repo`.

The extension clone is found like the other tracks (`--ext-repo`,
`INSUSTY_EXT_REPO`, `bench.local.json`). Documents are generated, never
committed: `cache/docbench/files/` holds them by spec hash. Results are
cached per ref commit in `cache/docbench/results/<sha>.jsonl`, keyed by the
commit, the hash of `dataset/detbench/`, the generator and scorer versions (`GEN_VERSION` in
`src/docbench/specs.ts`, `DOC_SCORE_VERSION` in `src/run/plan.ts`), the seed,
the configurations and the case spec; a rerun only computes what is missing
and rescores. Private AI jobs go through the shared model result cache
(`cache/results/<sha>/<model>.jsonl`) like any bench job.

Memory: the suite runs in one worker process; each sweep point runs in its
own (`src/docbench/worker.ts`) so its peak memory is its own. Before a
worker starts, the runner waits until `MemAvailable` covers its estimate
plus 1.5 GB (`BENCH_MIN_FREE_MB`; `LAB_MEM_WAIT_S=3600` waits up to an hour
instead of skipping after 180 s) and kills it past `--max-rss-mb` or when
the system drops below 600 MB. The Private AI track runs one model at a
time through `src/run/worker.ts`, with the bench's memory wait.

## How a ref is run

`src/docbench/ext.ts` materializes the ref read-only like detbench
(`git archive` of `src`, `package.json`, `package-lock.json` into
`cache/docbench/ext/<sha>/`), installs the npm packages its file check
imports at the ref's locked versions (`@embedpdf/pdfium`, `fflate`, the
detector's libraries), and bundles `src/file-check.ts`,
`src/document-reader.ts`, `src/document-model.ts`, `src/redaction.ts`,
`src/detector.ts` and `src/config.ts`. PDFium is loaded in Node from the
ref's own `pdfium.wasm`, as the extension's own tests do.

`src/docbench/pipeline.ts` then follows the extension's `checkFile` and
`redactedVersion` (`src/file-attach.ts`) step by step, with each step timed:

1. `readFileForCheck` classifies the file by its bytes and name;
2. `readDocument` reads a PDF, Office/OpenDocument file or zip (text,
   parts, gaps, signed);
3. `detectSensitiveData` scans the whole text, per configuration
   (`default` = the ref's `DEFAULT_CONFIG`, `all` = every category on); a
   switched-off category's findings start unselected, as in
   `reviewDetectionsOf`;
4. the redacted version: a text file re-encoded in place (`redactPrompt`,
   `encodeText`), a PDF or an archive by `redactDocument`, falling back to
   the redacted text copy when that throws (the extension's D2 fallback),
   an Office file as its text copy (`textCopy`).

A ref without `src/document-reader.ts` (before PR #76) still runs: its PDFs,
Office files and zips come out `unchecked:<reason>` as the ref would report
them, so `--compare` across the feature boundary works. Refs before
`src/file-check.ts` read every file as UTF-8 text.

## Cases

Generated deterministically from the seed and labelled ground truth already
in the repository: `dataset/detbench/` (items with exact values, decoys) for
the rule-based track, `dataset/cases/` (dev split only) for Private AI. The
writers (`src/docbench/writers/`) are our own minimal, deterministic writers
for zip (stored, deflated, ZipCrypto), Office Open XML, OpenDocument and
OLE2, and pdf-lib for PDFs (Helvetica, WinAnsi, A4) with hand-written
encryption, signature fields and scanned pages. They never use the
extension's own readers.

Content (`src/docbench/content.ts`):

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

`src/docbench/sweeps.ts`: per type, the same kind of document at growing
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
  (`src/docbench/verify.ts`: our own zip walker, the PDF's raw bytes and
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

With `--ai <model>`, dev-split custom-label cases (`--ai-tier smoke`, the
default: dev and finance, EN; `quick`: every profile, EN and FR, one clear
positive each; `full`: plus one look-alike negative) are put in the middle of Word documents of
`--ai-sizes` characters of neutral filler, read by the ref's reader and
reviewed by the model with the ref's own `reviewPrompt` through the model
runner (the ref's shipped instruction, `desc` label descriptions). Reported
per size: recall of expected passages, false positives, review time p50 and
max, requests; a power-law fit of review time against characters; and the
largest document whose median review stays within 30 s, 60 s and 120 s,
next to the extension's `localAi.fileReviewLimit` (20,000 characters by
default; 5,000 to 100,000 offered).

## Outputs

`runs/docbench/<name>/`: `report.html` (tables, charts), `results.jsonl`
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

- A new zone: add it to `ZONES` in `src/docbench/specs.ts` and its branch in
  `buildPositive` (`src/docbench/cases.ts`); prose zones take `prose()` or
  `shortProse()` units, cell-like zones `fields()` and `decoyFields()`.
- A new failure file: add it to `FAILURES` with its expected report, and its
  branch in `buildFailure`.
- A new hard negative: add it to `NEGATIVES` and `buildNegative`.
- New values: add detbench cases (`docs/detbench.md`); documents pick them
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
