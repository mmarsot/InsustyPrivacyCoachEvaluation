# gretel: Gretel synthetic PII finance multilingual

Watson, Meyer, Van Segbroeck, Grossman, Torbey, Mlocek, Greco (2024),
Gretel.ai: synthetic financial documents with character spans for 29 PII
types, the bench's French source next to English. Apache-2.0, pinned at
`7b844d1`; the English and French test files (3,334 documents) are scored.

- `manifest.json`: source, revision, licence (`resultsId`
  `gretel-pii-finance-multilingual` keys cached outputs and runs).
  `contract.json`: its 29 labels. `loader.ts`: the two pinned parquet files.
- How each module answers its labels: `modules/<module>/dataset-adapters/gretel.json`
  (insusty-privacy 16 of 29 with built-in labels, presidio 14).
- Scores and how they are computed: [`../README.md`](../README.md).
