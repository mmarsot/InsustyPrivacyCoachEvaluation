# Style guide: support (Tier-2 customer support agent, Parcelio)

How e-commerce / delivery support agents actually write, observed in public
sources (style only; no text, names or numbers were reused).

## Sources consulted

- https://forum.quechoisir.org/sav-et-service-client-un-scandale-t133540.html : French customer complaint thread plus brand "service client" replies; register gap between angry customer and polished agent.
- https://www.merci-app.com/article/strategies-pour-accelerer-la-resolution-des-tickets : French ticketing jargon (niveaux 1/2/3, SAV, routage, pré-remplissage).
- https://www.easiware.com/blog/escalade-service-client/ : French N1/N2 escalation vocabulary, "geste commercial", "litige", English terms kept as-is.
- https://www.souffrance-et-travail.com/magazine/dossiers/stress-travail-et-sante/temoignage-teleconseillere-pour-une-banque-jai-vecu-lenfer-des-centres-dappels/ : first-person téléconseillère testimony; plateau, superviseur, scripted greetings, timed pauses.
- https://textexpander.com/templates/customer-service-response-examples : English reply macros, bracket placeholders, channel-dependent length.
- https://www.zendesk.com/blog/customer-experience/retention/customer-apology-letter-template/ (search summary) : late-delivery apology structure (apology, reason, new date, compensation).
- https://community.shopify.com/c/shopify-discussions/help-with-tracking-package-and-order/td-p/2985456 : merchant/support forum posts about tracking; numbered steps, @mentions.
- https://www.gorgias.com/blog/customer-service-terms : e-commerce support acronyms (WISMO, RMA, macros, internal note, chargeback).
- https://hiverhq.com/blog/customer-service-acronyms (search summary) : AHT, FCR, CSAT, FRT.

## Observed traits: English

- Customer-facing replies: "Hi <first name>," + "Thanks for reaching out" / "I completely understand your frustration" + one action + "Best, <agent>, Parcelio Support". 3-5 sentences, polished.
- Internal notes and team chat: terse, lowercase, no greeting, arrows and slashes ("cx says INR, tracking shows DLV -> escalate to carrier"), "cx"/"cust" for customer, "pls", "tbh", "fyi".
- References quoted with prefixes and hashes: "order #...", "ticket 48213", "trk ...", "acct ...". Often pasted right after a colon, sometimes without the prefix.
- Requests to the chatbot are short and blunt: "make this less passive aggressive", "summarize this thread in 3 bullets", "translate to english pls". Pasted content follows or precedes the ask.
- Pasted exports: ticket threads with "--- Customer wrote ---" separators, CSV exports from the helpdesk, JSON from the order API, carrier scan logs.
- Typical errors: missing apostrophes, lowercase names, doubled letters, "recieved", "alot", run-on sentences in chat.

## Observed traits: French

- Réponses client: "Bonjour Madame X," / "Bonjour M. X," vouvoiement, "Je suis navré(e) pour la gêne occasionnée", "Nous restons à votre disposition", "Cordialement" or "Cdt", signed "Le service client".
- Customers (quoted in threads) write long angry sentences, "!!!", missing accents, "cde n°", "colis toujours pas recu", "sa fait 3 semaines".
- Internal notes: SMS style and abbreviations ("cli" / "cliente", "cde", "rbt" for remboursement, "stp", "jsp", "pb", "dc"), missing accents, franglais ("je te forward le ticket", "le cx a été escalé", "c'est flaggé fraud", "check le tracking").
- Order/ticket references in French: "commande n°...", "cde ...", "ticket #...", "n° de suivi", "réf. client".
- Requests to the chatbot: "reformule moi ça plus poliment stp", "résume ce fil", "traduis en anglais", often without accents or punctuation.

## Jargon

- EN: tier 1/tier 2, escalate, macro, internal note, WISMO, INR (item not received), RTS (return to sender), RMA, chargeback, goodwill credit, CSAT, AHT, FRT, SLA breach, merge ticket, carrier claim, POD (proof of delivery), DLV/exception scan, hub, last mile.
- FR: N1/N2, escalade/escalader, SAV, litige, geste commercial, avoir, remboursement, colis perdu/avarié, preuve de livraison, retour expéditeur, point relais, transporteur, réclamation, relance, macro, ticket fusionné, plateau, superviseur.

## Mapping to case tags

- `style.register`: customer replies and escalation mails -> `email`; team chat -> `chat`; internal notes on a ticket -> `notes`; full ticket threads / helpdesk exports -> `ticket`; carrier scan logs -> `log`; SQL / JSON / CSV snippets -> `code`; shift handover lists and tables -> `list`; procedure / KB excerpts -> `doc`; "can u rewrite..." asks -> `request`; forum/LinkedIn-style posts about the job -> `social`.
- `style.errors`: `none` for polished replies, KB docs and code; `light` for chat/notes with a few typos, lowercase names or missing accents; `heavy` for SMS-style French, angry quoted customers, run-on chat with several misspellings.
- `mixed`: French cases with English helpdesk exports, carrier logs, English macros or franglais agent notes.
