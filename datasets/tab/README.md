# tab: Text Anonymization Benchmark

Pilán, Lison, Øvrelid, Papadopoulou, Sánchez, Batet (2022), Computational
Linguistics 48(4): 1,268 English ECHR judgements, mentions marked DIRECT,
QUASI or NO_MASK by one or more annotators, grouped into entities. MIT,
pinned at `558e09e`; the test split (127 documents) is scored.

- `manifest.json`: source, revision, licence. `contract.json`: its 8 labels
  (`CODE`, `PERSON`, `ORG`, `DATETIME`, `LOC`, `DEM`, `QUANTITY`, `MISC`).
  `loader.ts`: the pinned JSON files; only DIRECT and QUASI mentions must be
  masked, NO_MASK ones are kept as safe; `native` adds TAB's entity-level
  recall (ER_di, ER_qi), micro-averaged over annotators as the paper defines
  it.
- Scores and how they are computed: [`../README.md`](../README.md).
