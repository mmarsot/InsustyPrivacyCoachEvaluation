# Style guide: agency (account director at a creative agency)

How people in agency account / project roles write when they paste things into a chatbot.
Observed for style only; no text copied, no real names reused.

## Sources consulted

- https://www.lafabriquedunet.fr/agences/tendances/modele-de-brief-a-envoyer-a-une-agence-de-communication : French brief templates, section headings (contexte, cible, objectifs, budget, planning).
- https://l.ateliercortical.com/jargon-de-la-pub/ : French ad-agency glossary (packshot, détourage, ghost/"gosht" work for pitches, chef de pub, graisser).
- https://www.llllitl.fr/2019/06/charrette-agence-publicite/ : French creatives' blog; self-deprecating tone, "en mode charrette", "team créa", commercial vs créa banter.
- https://commsofafrica.com/2024/05/30/expressions-incontournables-en-agence-de-communication-maitrisez-le-jargon-des-pros/ : francophone agency jargon, heavy untranslated anglicisms (brief, KPI, touchpoint, storytelling).
- https://www.1min30.com/inbound-marketing/5-cles-pour-faire-une-recommandation-strategique-efficace-12428 : how a French "reco" is structured (écoute du brief, analyse, axes créa, rédaction).
- https://umbrex.com/resources/industry-lingo/business-services-lingo/advertising-marketing-services-lingo/ : EN agency lingo (AOR, roster, tissue session, SMP, RTB, KV, mandatories, cutdowns, PPM, flighting).
- https://info.duvalpartnership.com/blog/your-crash-course-in-agency-new-business-terminology : EN new-business terms (RFI/RFP, capabilities deck, spec work, win rate).
- https://activecollab.com/blog/project-management/project-status-report : shape of agency WIP / status reports (client, job, status, blockers, next steps, owner).
- https://superthread.com/learn/weekly-client-status-reporting/ : weekly client status emails (outcomes first, client actions with owner + deadline).

## Traits observed: English

- Emails are short, friendly-professional: "Hi team", "Quick recap from today's call", "Thanks, J", "Shout if any Qs".
- Heavy shorthand in chat/notes: EOD, EOW, asap, w/, re:, tbc, tbd, FYI, v2/v3, "amends", "rounds of feedback", "sign-off".
- Status reports are list-shaped: job number, client, deliverable, status, blocker, next step; RAG-style words (on track / at risk).
- Chat is lowercase, fragmentary, lol / pls / u, missed apostrophes (were, dont), doubled letters and swapped letters.
- Chatbot prompts look like: "can you make this punchier: ...", "give me 10 names for ...", "summarise these feedback points", "draft a polite no".
- Famous campaigns are cited constantly as references ("something like Patagonia's ad", "the Dove thing").

## Traits observed: French

- Franglais everywhere: brief, reco, KV, deck, feedback, call, asap, rework, draft, "on est charrette", "la team créa", "le planning strat".
- Abbreviations: DA, DC, CP (chef de projet), reco, compète, prez, BAT, PPM, KV, OOH, "plan média", RS (réseaux sociaux).
- Emails: "Bonjour à tous", "Suite à notre call", "Je reviens vers vous", "Belle journée", "Bien à vous".
- Chat / SMS style: stp, svp, jsp, pk, bcp, qd, tkt, "c" for "c'est", missing accents (a/à, deja, reunion), no capitals, few commas.
- Requests to a chatbot: "résume moi ce mail stp", "tu peux reformuler plus pro", "donne moi 5 accroches pour...", "corrige les fautes".
- English codenames and English logs/exports pasted inside French text are normal (international clients, tools in English).

## Jargon lists

EN: brief, creative brief, SMP, RTB, big idea, route, KV (key visual), endline, lockup, mandatories, packshot, animatic, cutdown, adapts, OOH, 48-sheet, VO, PPM, tissue session, WIP, amends, rounds, sign-off, AOR, roster, RFP, spec work, pitch, chemistry meeting, QBR, scope creep, day rate, prod co, DC/AD/CD.

FR: brief, reco, compète, prez, charrette, DA, DC, CP, planning strat, KV, accroche, signature, BAT, maquette, plan média, OOH/affichage, RS, prod, devis, hors périmètre, allers-retours, validation client, "on revient vers vous".

## Mapping to tags

- `style.register`: email (status updates, client replies), chat (Slack/WhatsApp one-liners), notes (kickoff/debrief bullets), list (tables, WIP trackers, CSV media plans), doc (brief / reco excerpts), ticket (traffic/job tickets), code (JSON exports from project tools, CSV with headers), request (direct asks to the chatbot), social (LinkedIn-style drafts).
- `style.errors`: none = clean corporate email or brief; light = a missing accent, one typo, lowercase start, "w/"-style shorthand; heavy = SMS French (stp, jsp, c), no accents at all, several typos, run-on lowercase chat.
- `mixed` (FR only): French text with English codenames, English CSV/JSON/log exports, or dense franglais.
