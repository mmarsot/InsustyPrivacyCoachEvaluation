# Style guide: legal (in-house counsel on a confidential M&A deal)

How in-house lawyers write when they paste deal material into a chatbot: term sheet
summaries, NDA and SPA clauses, board memo paragraphs, deal-team chat, closing
checklists, data room logs. Style only: no text in the cases is copied from these
sources, and every company, codename, person and figure in the dataset is invented
(public deals such as Adobe/Figma or Microsoft/Activision are cited only as public knowledge).

## Sources consulted

- https://www.village-justice.com/forum/viewtopic.php?t=25081 : French legal forum thread between juristes d'entreprise; semi-formal, "Bonjour à tous", "Je vous remercie par avance", occasional missing accents, smileys.
- https://www.village-justice.com/forum/viewtopic.php?f=13&t=4034&p=58892 : forum thread on a pacte d'actionnaires / share sale; short paragraphs, "earn-out" left in English, GAP spelled out, sign-offs by initials or "Bon courage !".
- https://www.village-justice.com/articles/garantie-actif-passif-gap-est-que-est-tout-comprendre-sur-interet-gap-pour,42356.html : French deal vocabulary (GAP, cédant, cessionnaire, séquestre, plafond, franchise).
- https://cms.law/fr/fra/legal-updates/la-lettre-des-fusions-acquisitions-et-du-private-equity-la-lettre-d-intention : polished French law-firm register on the lettre d'intention (exclusivité, offre non engageante, conditions suspensives).
- https://thelegalprompts.com/blog/ai-ma-lawyers-due-diligence-loi-drafting : how M&A lawyers phrase prompts to AI (LOI, SPA, APA, DD, R&W, MAC, VDR, HSR; "pro-buyer", "flag risks", "put it in a table").
- https://www.focus-ai.fr/blog/50-prompts-chatgpt-pour-juristes-et-avocats : French lawyer prompts: imperative "Rédige", "Résume", "Analyse", tutoiement of the bot, NDA / SPA / RGPD acronyms.
- https://aegislaw.com/disclosure-schedules-ma-sell-side/ and https://montague.law/blog/disclosure-schedule-update-bring-down-no-cure-2026/ : US deal jargon (disclosure schedules, bring-down, sandbagging, walk right).
- https://www.anonym-ia.com/blog/utiliser-chatgpt-documents-confidentiels-avocats : French debate on pasting confidential client material into ChatGPT (secret professionnel, Cloud Act), which is exactly the persona's risk.
- Reddit r/Lawyertalk could not be fetched; its tone (vent posts, "OC", "anyone else...") is known and only used as a loose reference for chat register.

## Observed traits: English

- Two voices. Documents (board memos, SPA clauses, counsel letters): long, formal sentences, defined terms in capitals ("the Buyer", "Completion", "the Sellers"), numbered paragraphs, "subject to", "on a cash-free, debt-free basis".
- Internal chat and notes: terse fragments, "w/", "re", "pls", "thx", "tmrw", "OC" (opposing counsel), "turn the draft", "mark-up", "redline", lowercase starts, arrows.
- Money written compactly: "$286m", "£94.5 million", "1.1bn", "11.4x EBITDA", "EV", "NWC adjustment", "escrow / holdback", "earn-out".
- Requests to the bot are blunt and task-shaped: "summarise in 5 bullets for the GC", "make this less aggressive, it goes to sellers' counsel", "don't change the numbers".
- Placeholders in templates: [BUYER], [TARGET], [PURCHASE PRICE]; codenames used as subject lines ("Project X – closing checklist").

## Observed traits: French

- Formal emails: "Bonjour à tous,", "Suite au comité de ce jour", "Je me permets de", "Cordialement", "Bien à vous"; vouvoiement with externals, tutoiement inside the team.
- Heavy franglais in deal practice: closing, signing, data room, earn-out, locked box, side letter, W&I, funds flow, SPA used alongside "protocole de cession".
- Chat / notes: SMS style (slt, stp, qqn, tjs, ds, c, jsp), missing accents (a/à, reu, deconnecte), no final punctuation, "CR call", "reu".
- Amounts: "145 M€", "58,2 M€", "2,9 Md$", "22,40 € par action", "9,5x l'EBITDA", comma decimals and spaces as thousands separators.
- Requests to the bot: "résume moi ce mail stp", "reformule de façon moins agressive", "corrige les fautes", "traduis en anglais pour le CFO".

## Jargon

- EN: LOI, NDA, SPA, APA, term sheet, DD / confirmatory DD, VDR / data room, R&W, W&I, MAC / MAE, CPs, long-stop date, signing / closing / completion, locked box, completion accounts, NWC, EV, escrow, holdback, earn-out, specific indemnity, de minimis / basket / cap, drag-along, rollover, disclosure letter, bring-down, merger control, HSR, CMA, break fee.
- FR: lettre d'intention, accord de confidentialité, protocole de cession, cible, cédant, cessionnaire, prix de cession, valeur d'entreprise (VE), dette nette, BFR, complément de prix, séquestre, GAP, conditions suspensives (CS), date butoir, PV du CA, mainlevée, CSE, Autorité de la concurrence, AMF, OPA / OPE, table de capi, clause de changement de contrôle.

## Mapping to tags

- `register`: counsel letters and team emails -> `email`; Teams/WhatsApp lines -> `chat`; call/meeting jottings -> `notes`; closing checklists, pipeline tables -> `list`; JSON / CSV / scripts -> `code`; data room audit logs -> `log`; board memo or integration plan excerpts -> `doc`; legal-ops tracker or data room access requests -> `ticket`; "rewrite / summarise / explain" asks -> `request`; LinkedIn drafts -> `social`.
- `errors: none` for memos, clauses, formal emails and code; `light` for normal chat (pls, thx, a missing accent or apostrophe, one typo, lowercase start); `heavy` for rushed notes and SMS-style French (no accents, slt / stp / tjs / c, several typos, no punctuation).
