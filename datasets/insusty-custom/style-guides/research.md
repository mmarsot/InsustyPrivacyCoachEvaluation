# Style guide: research (postdoc in a biology lab)

How wet-lab and computational biologists write when they talk shop, ask for
help, or paste things into a chatbot. Observed for style only; no text, names
or data were copied into the dataset.

## Sources consulted

- https://www.biostars.org/p/440143/ and https://www.biostars.org/p/9566206/ (Biostars DESeq2 threads: question titles and structure; page body blocked, style inferred from listings)
- https://support.bioconductor.org/p/122274/ (Bioconductor support: how padj / LFC questions are phrased, inline code, "Hi ... Thank you")
- https://github.com/satijalab/seurat/issues/7502 and #718, #3729 (Seurat issues: R code pasted inline or in blocks, session info, non-native English)
- https://forums.futura-sciences.com/biologie/158959-western-blot-proteine-hrp.html (French western blot troubleshooting: tutoiement, missing accents, "westeren" style typos)
- https://forums.futura-sciences.com/biologie/567613-immunohistochimie-immunomarquage.html (French IHC thread: "Ac", "o/n", hedging, "Bonjour à tous")
- https://zestedesavoir.com/forums/sujet/14101/serieuse-remise-en-question-apres-7-mois-de-doctorat/ (French PhD student post: labo, manip, biblio, papier, directeur de thèse, long self-reflective sentences, emoticons)
- https://www.dementiaresearcher.nihr.ac.uk/blog-first-time-through-the-publication-process (early-career blog: co-authors, desk reject, revisions, cover letter)
- https://michaelsylee.wordpress.com/2021/09/27/how-to-contact-a-potential-collaborator/ (etiquette of emails to collaborators: timelines, sharing preliminary data)
- ANR AAPG FAQ / guides (anr.fr) (French grant vocabulary: pré-proposition, AAPG, JCJC, PRC, dossier)

## Observed traits: English

- Two registers coexist: polished grant/abstract prose ("Building on pilot data, we will test whether...") and terse lab chat ("qPCR repeats done, Il6 down again in KO").
- Heavy abbreviation, never explained: PI, KO/WT, WB, IHC, qPCR, PE150, MTA, DTA, ELN, SOP, padj, LFC, HR, CI, n =, o/n, -80.
- Results written inline with stats in parentheses: "(p = 0.002)", "HR 0.61", "7/19 vs 3/20", "0.67-fold".
- Questions to forums start with "Hi," / "quick q", end with "thanks!" or nothing; code pasted in fenced blocks or raw, often with the error message after it.
- Typical errors: dropped apostrophes (cant, doesnt), "u", "pls", "thx", "untill", "dependant", "grammer", lowercase everything in chat, "lol" to soften complaints.
- Emails to collaborators: "Dear Dr. X" / "Hi all", short paragraphs, "Best," / "Kind regards,". Slack pastes use "Name: message" lines.

## Observed traits: French

- Tutoiement on forums and in team chat; "Bonjour à tous", "Merci d'avance", "Bonne journée", sign-off with first name.
- Lab jargon and franglais: manip, labo, réu labo, papier, biblio, dossier ANR, visio, plateforme, animalerie, KO/WT, "le batch", "les hits", "un preprint", "le MTA", "faire tourner le script", "cringe", "fyi", "tbd".
- Missing accents (a, deja, verifier), SMS forms (jsuis, tjs, tjr, pr, qd, c, pk, bcp, mdr, jpp, stp), "sa" for "ça", past participle/infinitive confusion ("on a observer").
- Numbers in French format: "p = 0,004", "38 %" with a space, "1 180 aliquots", "S14" for week 14.
- Code, logs and error messages stay in English inside a French question.

## Jargon lists

- EN: cohort, arm, interim, responders, enrollment, endpoint, knockout, organoid, crypt budding, IHC, frozen sections, qPCR, cfDNA, PE150, MTA, DTA, co-first, co-senior, preprint, bioRxiv, steering committee, Specific Aims, Preliminary Results, R01/fellowship.
- FR: cohorte, bras, analyse intermédiaire, répondeurs, inclusions, critère principal, souris KO, organoïdes, bourgeonnement, coupes congelées, plateforme de séquençage, convention de transfert, co-premier auteur, rapporteurs, AAPG, JCJC, pré-proposition, cahier de labo électronique.

## Mapping to tags

- `style.register`: pasted grant/abstract paragraphs = `doc`; messages to PI/partners = `email`; Slack/Teams one-liners = `chat`; meeting or bench notes = `notes`; R/Python/JSON/YAML = `code`; pipeline console output = `log`; author orders, order lists, tables/CSV = `list`; core-facility forms = `ticket`; "can you rewrite / summarize / explain..." with little else = `request`; LinkedIn / X drafts = `social`.
- `style.errors`: `none` for grant prose and formal emails; `light` for chat with lowercase, dropped apostrophes, "pls/u", a missing accent or two; `heavy` for SMS-style French, several spelling/grammar errors per sentence, non-native grammar ("knockdown reduce the migration").
- `mixed: true` in French cases with English codenames or partner names used as-is, English logs/code/config, or franglais-heavy chat.
