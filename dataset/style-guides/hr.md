# Style guide: hr (talent partner poaching from a competitor)

How recruiters and talent partners actually write when they paste into a chatbot:
outreach messages, offer drafts, interview debriefs, comp comparisons. Style only;
no text below or in the cases is copied from these sources, and every name,
company and figure in the dataset is invented.

## Sources consulted

- https://www.teamblind.com/post/recruiters-sending-linkedin-inmails-to-their-own-employees-31pb4xon : anonymous tech-worker thread about recruiter InMails; venting tone, lowercase, "idk", emojis.
- https://www.teamblind.com/post/amazon-l5-offer-negotiation-jgxcudrf : how people lay out an offer (base / bonus y1 / RSU over 4 years, "TC", "YOE", level codes).
- https://www.ashbyhq.com/blog/recruiting/hiring-memo : structure of a hiring memo / debrief (HM, loop, rubric, hire / no-hire).
- https://www.metaview.ai/resources/blog/create-effective-interview-scorecards : scorecard vocabulary (strong yes / no, evidence notes, competencies).
- https://juicebox.ai/blog/recruitment-email-sample and https://hunter.io/templates/recruitment : outreach and InMail templates, placeholders in brackets.
- https://raniahammami.substack.com/p/six-semaines-de-negociation-et-13 : French salary negotiation story; fixe / variable / package / K€ brut, prétentions.
- https://www.helloworkplace.fr/debriefing-candidat-recruteur-hiring-manager/ : French recruiter jargon (débrief, hiring manager, scorecard, grille d'évaluation, brief de poste).
- https://chomeuf.substack.com/p/7-linkedin-ta-mere : parody of French LinkedIn culture; tutoiement, emojis, "full remote", "scale-up", "opportunité".
- https://www.apec.fr/candidat/optimiser-votre-candidature/entretiens-de-recrutement/fiches-conseils/comment-negocier-votre-remuneration-en-entretien-de-recrutement.html : package components as French candidates and recruiters list them (fixe, variable, tickets resto, télétravail).

## Observed traits: English

- Two voices. Outreach / offer letters: warm, polished, second person, "I came across your work on...", "no pressure", "would love to grab 15 min". Internal chat / notes: terse, lowercase, fragments, arrows and slashes.
- Comp written as compact strings: "165k base / 15% bonus / 8k RSU over 4y", "TC ~210k", "L5 -> L6", "down-level", "sign-on to cover their unvested".
- Debriefs: bullet lists per interviewer, "strong hire / lean hire / no hire", "concern:", "HM wants to move fast", "calibrate on level".
- Chat typos: missing apostrophes (dont, thats), "u", "pls", "tmrw", "cand", "rec", dropped articles. Emojis occasionally in social posts.
- Requests to the bot are blunt: "make this sound less salesy", "tighten this up", "is this offer competitive?".

## Observed traits: French

- Outreach on LinkedIn: tutoiement or vouvoiement depending on seniority, emojis, franglais ("full remote", "scale-up", "challenge", "process", "onsite", "feedback").
- Package vocabulary: fixe, variable, package, K€ brut annuel, prime de cooptation, BSPCE / actions gratuites, 13e mois, période d'essai, préavis, clause de non-concurrence, statut cadre, coefficient / position (Syntec).
- Internal notes: abbreviations (RDV, CR, N+1, dispo, préavis 3 mois, entretien RH, tech, cand.), missing accents (a/à, ete, recu), SMS style (stp, svp, pk, jsp, bcp, qd, tt), sentences without verbs.
- Franglais is everywhere in tech recruiting: "le HM veut closer vite", "on a un gap sur le level", "le candidat est en late stage ailleurs", "offer letter".
- Polite emails: "Bonjour X,", "Je me permets de revenir vers vous", "Belle journée", "Bien à vous".

## Jargon

- EN: req, HM, loop, onsite, phone screen, debrief, scorecard, calibration, level / down-level / up-level, band, comp, TC, base, sign-on, RSU, refresher, cliff, vest, counter, exploding offer, notice period, garden leave, non-compete, backfill, pipeline, sourcing, passive candidate, poach, InMail, ATS.
- FR: chasse / approche directe, sourcing, vivier, short-list, entretien RH, entretien tech, débrief, fiche de poste, brief, fixe / variable, package, K€, BSPCE, prime d'arrivée, période d'essai, préavis, rupture conventionnelle, clause de non-concurrence, contre-offre, cooptation, promesse d'embauche, grille, niveau / position.

## Mapping to tags

- `register`: InMail / offer drafts and French polite mails -> `email`; Slack or WhatsApp lines -> `chat`; debrief jottings and call notes -> `notes`; comp tables and pipeline trackers -> `list`; ATS exports / JSON / CSV / scripts -> `code` or `log`; offer letter or memo excerpts -> `doc`; HRIS or IT access requests -> `ticket`; "rewrite this / is this fair" asks -> `request`; LinkedIn posts -> `social`.
- `errors: none` for polished emails, docs, templates and code; `light` for normal chat (a missing accent or apostrophe, "u", lowercase start, one typo); `heavy` for rushed notes and SMS-style French (no accents at all, stp / jsp / pk, several typos, no punctuation).
