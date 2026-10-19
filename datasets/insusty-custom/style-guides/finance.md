# Style guide: finance (FP&A before earnings)

How FP&A analysts and management accountants (contrôleurs de gestion) actually
write, observed on public pages in September 2026. Style only: no text, names
or figures were copied.

## Sources consulted

- https://www.compta-online.com/controleur-de-gestion-clotures-mensuelles-t67934 : FR forum thread on monthly close tasks (greetings, deference, franglais "cut off").
- https://www.compta-online.com/mise-place-une-cloture-mensuelle-t14776 : FR forum thread on setting up a monthly close (CDG/CAC/OD abbreviations, "Re-bonjour", "Cdt").
- https://fr.linkedin.com/pulse/la-repr%C3%A9vision-budgetaire-votre-meilleur-alli%C3%A9-th%C3%A9bault-h%C3%A9rault : FR LinkedIn article on reforecasting ("atterrissage", "reprévision", T1-T4, N-1, capitalised emphasis).
- https://www.spendesk.com/fr/blog/reforecast/ and https://forekasts.fr/blog/budget-previsionnel-forecast-reforecasts-rolling-forecast-business-plan-quelles-differences/ (search snippets) : how FR finance people mix "forecast", "reforecast", "rolling forecast" into French.
- https://fpandhey.substack.com/archive?sort=top : EN FP&A newsletter (casual, punchy, emoji, VMaP/price-volume-mix, waterfall, "business partner").
- https://www.financialprofessionals.org/training-resources/resources/articles/Details/the-fp-a-checklist-for-period-end-closing : EN period-end checklist (3+9 / 6+6 / 9+3 rolling forecasts, accruals, flux, candid practitioner quotes).
- https://www.mrexcel.com/board/threads/dynamic-formula-based-on-latest-column-added-budget-vs-actual.1170428/ (search snippet; page 403) : EN Excel forum question on Act/Bud/Fcst columns, pasted formulas.
- https://www.wallstreetoasis.com/forum/corporate (search snippets; pages 403) : EN corporate-finance forum on close crunch, reforecast timing, audit-to-FP&A moves.
- Reddit r/FPandA could not be fetched; relied on the above.

## Observed traits, English

- Two modes. Upward (CFO, Board, IR): polished, short declarative sentences, "delivered", "underlying", "we remain confident", bps changes, one message plus proof points. Sideways (team chat): terse, lowercase, numbers without units ("gm 40.8", "rev 1.4bn"), "pls", "thx", "lmk", "tmrw".
- Numbers dominate: £m/£bn, %, bps, x (leverage), p (EPS pence). Tables pasted as CSV or tab-separated from Excel; formulas pasted inline (=XLOOKUP, =SUMIFS).
- Scenario names used as nouns: ACT, BUD, RF2/RF3, LE, 9+3, PY/LY, YTD, FY26, H1/H2, Q3.
- Typical errors: dropped apostrophes (dont, its), missing units, "reforcast", run-on bullets, inconsistent decimals.
- Greetings: "Hi all", "Hi <name>, quick one", sign-off "Thanks", "Cheers", "Kind regards" for formal.

## Observed traits, French

- Forum register is polite ("Bonjour", "Merci d'avance", "Cordialement", "Cdt") but internal chat is SMS-ish: "stp", "pr", "tjs", "vs", "dc", "c" for "c'est", missing accents (resultat, deja, a la place de à).
- Heavy franglais: forecast, reforecast, LE, flash, run-rate, board pack, deck, pricing, mix, cut-off, "on est on track", "je te fwd".
- Abbreviations: CA, MB, ROC, EBE, REX, BFR, DSO, CDG, CAC, N-1, N+1 (also the manager), T1-T4, S1/S2, pb (points de base), M€/M£, Md£.
- French number format: decimal comma, space before % (often missing), thin/regular space as thousands separator ("1 388,4").
- Aviation metaphor "atterrissage" for the year-end landing; "reprévision", "budget 2027", "objectif", "comité de pilotage".

## Jargon lists

- EN: FP&A, BvA, flux, bridge/waterfall, PVM (price/volume/mix), LFL, organic, underlying, adjusted, EBIT/EBITDA, op margin, GM, FCF, cash conversion, net debt, leverage, capex, opex, run-rate, RF, LE, 9+3, prelims, trading update, consensus, MNPI, board pack, talking points.
- FR: contrôle de gestion, clôture mensuelle, flash, reporting, écart budget/réel, atterrissage, reprévision, croissance organique, effet prix/mix/volume, CA, marge brute, ROC, EBITDA, BFR, trésorerie, dette nette, levier, capex, éléments de langage, communiqué, publication, consensus, comité d'audit, CAC.

## Mapping to tags

- `style.register`: email (IR/CFO/regional FD mails), chat (Teams one-liners), notes (prep bullets), list (Excel/CSV tables, target lists), log (EPM/SAP load logs), code (JSON configs, formulas, VBA/Python), doc (talking points, MBR notes), ticket (FPA-xxxx board pack fixes), request (direct ask to the chatbot), social (internal Viva Engage / LinkedIn-style drafts).
- `style.errors`: none = upward/formal texts; light = one or two slips (missing accent, "pls", dropped apostrophe, no unit); heavy = SMS French, lowercase everything, several typos, abbreviations without punctuation.
- `mixed: true` for French texts with English scenario names, segment names, code or logs.
