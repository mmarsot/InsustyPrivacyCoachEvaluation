# Style guide: sales (Account executive, Veltrano Systems)

How B2B account executives / business developers actually write, observed in
public sources (style only; no text, names or figures were reused).

## Sources consulted

- https://www.oltega.fr/blog/mail-de-relance-b2b-exemples-concrets-et-conseils-terrain : French B2B follow-up mails; "Bonjour <Prénom>", vouvoiement, under 100 words, "Comme convenu :" + bullets, low-friction question as CTA.
- https://www.mercuri.fr/insights/relance-prospect-par-mail/ : French relance subjects ("Suite à notre échange", "Je ferme le dossier ?"), "Bien à vous", franglais (call, démo, RDV, CR, POC, devis).
- https://rocket4sales.com/lexique-du-commercial-vente-saas/ : French SaaS sales lexicon, almost entirely English acronyms kept as-is (AE, SDR, OTE, ACV, pipe, forecast, churn, upsell).
- https://www.welcometothejungle.com/fr/pages/emploi-account-executive (search results) : French AE job posts; verbs like "closer", "gérer son pipe", "forecaster", English titles inside French sentences.
- https://forum.hardware.fr/hfr/EmploiEtudes/liste_sujet-1.htm : French forum titles about jobs; [TU] tags, missing accents, franglais ("full remote"), inconsistent capitals.
- https://www.apollo.io/insights/sales-follow-up-email : English follow-up mails; first-name greeting, "Worth a 15-min chat?", "closing the loop", ACV/ROI/SLA.
- https://news.ycombinator.com/item?id=11515307 : practitioners describing enterprise deals; lowercase casual openings, parentheses, POC/pilot, procurement, security review, PO, NDA.
- https://alex715.substack.com/p/when-a-promising-prospect-ghosts and https://prospeo.io/s/just-following-up : rep-voice writing about ghosting prospects, "just circling back", breakup emails.
- Search-result summaries on MEDDIC / pipeline reviews (oliv.ai, salesloft community) : forecast-call vocabulary (champion, economic buyer, commit/best case, single-threaded).

## Observed traits: English

- Prospect emails: "Hi <first name>," short paragraphs, one CTA ("does Thursday work?"), "Best," / "Cheers," / "Thanks!". Rarely more than 120 words.
- Internal chat and deal notes: terse, lowercase, dashes and arrows, "fyi", "lol", "tbh", "re:", "w/", "b4", "EOQ", "EOD", dates as 3/14; stage names in caps (COMMIT, BEST CASE).
- Call recaps: "attendees / pain / budget / timeline / next steps" bullets, often pasted then followed by "turn this into a recap email pls".
- Requests to the chatbot: blunt and practical: "make this less salesy", "give me 5 objection handlers", "shorter", "write a linkedin post but no emojis".
- Pasted artefacts: CRM pipeline tables (markdown or CSV), JSON exports of opportunities, call transcripts with speaker tags, forwarded email threads with "From:/Sent:" headers.
- Typical errors: missing apostrophes ("thats", "dont"), "trough" for "through", "tommorow", "grammer", run-on chat, lowercase company names.

## Observed traits: French

- Mails prospects: "Bonjour Madame X," / "Bonjour Marc," vouvoiement, "Suite à notre échange", "je me permets de revenir vers vous", "Bien cordialement" / "Bien à vous" / "Belle journée".
- Notes internes et messages au N+1: style SMS, accents manquants, "stp", "jsuis", "c koi", "pr" (pour), "rdv", "CR", "dc", "ptet", abréviations de sociétés.
- Franglais très fort: "closer un deal", "le pipe", "forecast", "follow-up", "call", "propale", "onboarder", "ghoster", "next steps", "loop in", "GA", "roadmap".
- Demandes au chatbot: "reformule moi ça", "résume ce mail stp", "fais moi un mail de relance qui fait pas relou", "traduis en anglais pour mon manager".
- Contenus collés: exports CRM (souvent en anglais: Salesforce, JSON), tableaux de pipe, CR de rendez-vous, mails en anglais de la maison mère.

## Jargon

- EN: AE, SDR/BDR, pipeline/pipe, forecast, commit, best case, EOQ, QBR, discovery call, demo, POC/pilot, champion, economic buyer, MEDDIC, procurement, redlines, MSA, SOW, PO, ACV, TCV, ARR, OTE, quota, upsell, renewal, closed won/lost, ghosting, breakup email, objection handling.
- FR: commercial / ingénieur d'affaires, grands comptes, ETI/PME, prospection, relance, RDV, CR, devis, propale, remise, appel d'offres, marché public, DSI, DAF, acheteur, comité, N+1, challenge, primes, CA, variable, "closer", "le pipe", forecast.

## Mapping to case tags

- `style.register`: prospect mails and forwarded threads -> `email`; Slack/Teams messages -> `chat`; call recaps and meeting notes -> `notes`; demo-tenant or sync logs -> `log`; CRM JSON / CSV / SQL -> `code`; pipeline tables and to-do lists -> `list`; internal memos, deck slides, enablement docs -> `doc`; CRM tasks / deal-desk requests -> `ticket`; "write me / give me ..." asks -> `request`; LinkedIn posts -> `social`.
- `style.errors`: `none` for polished mails, docs, code; `light` for chat/notes with a few typos, lowercase or missing accents; `heavy` for SMS-style French, run-on chat with several misspellings.
- `mixed`: French cases with English codenames, English mails from HQ, English CRM exports or heavy franglais.
