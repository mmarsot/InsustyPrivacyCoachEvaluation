# Style guide: dev (backend engineer pasting logs and code)

How backend developers actually write when they ask for help with a bug, a
config or a message. Observed on public forums in September 2026; style only,
nothing copied, no real names reused.

## Sources consulted

- https://github.com/PostgREST/postgrest/discussions/2252 : GitHub discussion, docker-compose + Postgres connection issue; no greeting, raw log lines, typo in the title.
- https://www.postgresql.org/message-id/CAADeyWiW%2BUz5z_RJrB%3DdhWoZAOngQ2dHQt%2B2UOGJiEv6pbcDCA%40mail.gmail.com : mailing-list email; formal greeting, Dockerfile pasted raw, TLDR at the end, "Best regards".
- https://discuss.kubernetes.io/t/deployment/7103 : Kubernetes forum thread; kubectl output pasted with "OUTPUT:"/"EVENTS:" labels, k8s/ns/pod shorthand.
- https://dev.to/leena_malhotra/the-deployment-error-that-nearly-took-down-my-app-4fed : incident blog post; LinkedIn-style hooks, short punchy lines, war-story tone.
- https://learn.microsoft.com/en-us/answers/questions/1050515/postgres-unable-to-connect-with-container : Q&A on container networking; terse question, then a pasted error.
- https://www.developpez.net/forums/d1607721/java/plateformes-java-ee-jakarta-ee-spring-serveurs/spring/probleme-lancement-l-application-spring-connection-refused/ : French Spring forum; "Bonjour", full stack traces in code blocks, franglais bean/config names, "A+".
- https://www.developpez.net/forums/d2138834/java/developpement-web-java/impossible-se-connecter-base-donnees/ : French JDBC thread; emoticons, "Merci d'avance", ellipses, frustration in caps, broken accents.
- https://zestedesavoir.com/forums/sujet/15246/docker-nginx-et-deploiement/ : French Docker/nginx thread; tutoiement, heavy franglais (scaler, load balancing, reverse proxy), small typos.
- https://openclassrooms.com/forum/ (search results: "Erreur 500" Node/Express threads) : French beginner titles, "[Résolu]", error codes in titles.

## Observed traits: English

- No greeting in chat/forum asks; the question comes first or right after the paste ("any idea?", "what am I missing?").
- Lowercase starts, dropped apostrophes (doesnt, cant), "w/", "tho", "smth", "lol", "wtf", "??".
- Logs pasted raw with ISO timestamps, level, logger/service in brackets; stack traces cut after a few frames.
- Config pasted as env vars, YAML or docker-compose snippets; SQL in caps keywords.
- Emails/tickets are more formal: "Hi team", "Steps:", "Expected:", "Thanks", Jira-style keys (OPS-1234).
- Blog/LinkedIn posts: hook line, short paragraphs, numbers ("p99 down 60%").

## Observed traits: French

- "Bonjour" / "Salut" / "Hello" then the problem; sign-offs "Merci d'avance", "A+", ":)".
- Missing accents (ca, deja, probleme, a la place), SMS forms (stp, svp, jsp, pk, bcp, tjr, qd, g, c).
- Franglais everywhere: déployer, merger, pusher, le build, la prod, la préprod, la recette, le run, le batch, crasher, timeout, fixer, checker, "c'est KO".
- Error messages, logs and code stay in English inside French text (mixed).
- Stack traces pasted in full; moderators reply short and direct, sometimes dry.

## Jargon

- EN: prod, staging, repo, PR/MR, CI, on-call, p99, OOMKilled, CrashLoopBackOff, k8s, ns, pod, replica, failover, rollback, hotfix, idempotency, backfill, cron, DLQ, SLO, postmortem.
- FR: MEP (mise en production), recette, préprod, astreinte, BDD, le back, le front, un ticket, un plantage, un rollback, la montée de version, le lettrage, le rapprochement, les relances, un batch de nuit, un POC.

## Mapping to tags

- `style.register`: pasted stack traces/log lines -> `log`; YAML/SQL/Python -> `code`; Slack-style one-liners -> `chat`;
  standup/retro bullets -> `notes`; checklists and tables/CSV -> `list`; Jira-style -> `ticket`; direct asks to the
  assistant with little paste -> `request`; forum/blog/LinkedIn post -> `social`; RFC/postmortem excerpt -> `doc`.
- `style.errors`: `none` = clean text (logs and code are usually `none`); `light` = lowercase starts, a dropped
  apostrophe or accent, "w/", one typo; `heavy` = SMS French, no accents at all, several typos, run-on sentences.
- `mixed: true` for French texts carrying English logs, code, error messages or franglais-heavy sentences.
