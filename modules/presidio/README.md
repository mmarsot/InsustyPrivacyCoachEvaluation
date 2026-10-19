# presidio: Microsoft Presidio baseline

A baseline only, never a component of the product: presidio-analyzer 2.2.364
with spaCy `en_core_web_sm`, default recognizers, every text analysed as
English (`presidio.ts`). It runs locally in a pinned uv environment
(`requirements.txt`, created under `cache/tmp/presidio/` on first use) with
sockets disabled and tldextract pinned to its bundled Public Suffix List, so
it never reaches the network (`server.py`).

```bash
npm run conformance -- --module presidio
npm run bench -- --module presidio --config default --dataset insusty-builtin   # our prompts (detbench)
npm run bench -- --module presidio --config default --dataset gretel --tier smoke
```

This folder is also the template for a new module: copy it, change
`manifest.json`, return any `RedactionModule` from `module.ts`, and write one
dataset adapter per dataset ([`../README.md`](../README.md)).

## What it produces

Its types map to built-in labels inside the module, as in the design report:
cards, IBANs, US bank numbers and crypto wallets → FINANCIAL; e-mail; phone;
IP and MAC → IP; national ids of every country pack → NATIONAL_ID; company
registers → COMPANY_ID; LOCATION → ADDRESS (its closest type); DATE_TIME →
DATE_OF_BIRTH only after birth words (it flags every date). PERSON,
ORGANIZATION, NRP, URL and the rest have no built-in label and are dropped.
It has **no secret recognizer**, and reads text only (documents are reported
unsupported).

## Dataset adapters

| Dataset | Adapter |
| --- | --- |
| insusty-builtin | 8 of 9 labels; `SECRET` missing |
| tab | `CODE` ← its identifier labels; PERSON, ORG and the rest missing |
| gretel | 14 of 29 labels; `api_key` and `password` missing, with names, companies and the labels no module has a rule for |
| nemotron | 14 of 55 labels; `api_key`, `password` and `http_cookie` missing, with the rest |

No adapter for insusty-custom (it takes no custom labels) or
insusty-documents (it reads text only): those grid cells say so. A run scores
the labels its adapter maps, and comparisons with another module use the
labels both map (the dataset's README has the scores).

On our own prompts (insusty-builtin, `main` @ `95454ec`, 2026-10-17):
66.7% of items redacted, F1 62.8%; 0 of 117 secrets (SECRET is not scored);
110 of 502 hard negatives flagged, against 9 for the extension. About 27-32 k
characters per second, against about 1.3 M for the extension's rules (45x).
