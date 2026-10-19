# nemotron: Nemotron-PII

NVIDIA (2025): synthetic, persona-grounded English records (US and
international locales) with character spans for 55 PII/PHI types. CC BY 4.0
(attribution: NVIDIA Corporation), pinned at `b70ffaf`. The test file holds
100,000 records (96 M characters), so a default run scores a pinned, seeded
sample of 3,000 (`--limit 0`, or the `full` tier, for all).

- `manifest.json`: source, revision, licence (`resultsId` `nemotron-pii`
  keys cached outputs and runs). `contract.json`: its 55 labels.
  `loader.ts`: the pinned parquet file (151 MB, downloaded once).
- How each module answers its labels: `modules/<module>/dataset-adapters/nemotron.json`
  (insusty-privacy 17 of 55 with built-in labels, presidio 14).
- Scores and how they are computed: [`../README.md`](../README.md).
