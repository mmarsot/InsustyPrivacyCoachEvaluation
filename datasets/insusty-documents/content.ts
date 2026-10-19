/**
 * What the document bench puts in its documents, all derived from labelled
 * ground truth already in the repository:
 *
 * - **prose units**: rendered detbench cases (`datasets/insusty-builtin/cases/`) with their
 *   exact items and decoys, placed whole in a zone (a body paragraph, a
 *   footnote, speaker notes...);
 * - **field units**: one detbench item with a label in a two-cell row
 *   (`IBAN | FR76 …`), for table cells, sheets, form fields and properties;
 * - **decoy fields**: detbench hard negatives the same way (`Order | 2026-0318`);
 * - **filler**: neutral business prose from a fixed sentence bank, so a
 *   document reads like a document and has pages and words to scale.
 *
 * Every choice comes from a PRNG seeded by (seed, case id): the same seed
 * gives the same documents. Values stay the dataset's fictional,
 * checksum-valid ones.
 */
import { loadDetDataset } from "../insusty-builtin/dataset.ts";
import { rngFor, type Rng } from "../insusty-builtin/perturb.ts";
import type { DetCase, DetCategory } from "../insusty-builtin/schema.ts";

/** Document languages: those of the detbench prompts the content comes from. */
export type Lang = "en" | "fr";

/** One ground-truth value as placed in a document. */
export interface PlacedItem {
  key: string;
  category: DetCategory;
  kind: string;
  value: string;
}
/** One hard negative as placed in a document. */
export interface PlacedDecoy {
  key: string;
  kind: string;
  value: string;
}
/** A unit of content: its text and the values it holds. */
export interface Unit {
  /** detbench case id, or `field:<case>:<key>`. */
  source: string;
  lang: Lang;
  text: string;
  items: PlacedItem[];
  decoys: PlacedDecoy[];
  /** Field units: the row label and the value cell. */
  field?: { label: string; value: string };
}

// ------------------------------------------------------------ filler

const FILLER: Record<Lang, string[]> = {
  en: [
    "The steering group met on Tuesday to review the quarterly roadmap and agreed to keep the current priorities.",
    "Most of the discussion focused on how the onboarding flow could be simplified for new teams.",
    "Several attendees noted that the documentation is still scattered across too many places.",
    "We will consolidate the guides into a single handbook before the end of the next sprint.",
    "The pilot with the regional offices went well, although the training sessions ran longer than planned.",
    "Feedback from the support desk suggests that the search feature is the most requested improvement.",
    "The design review highlighted a few accessibility issues in the settings pages.",
    "Budget figures remain within the envelope approved at the start of the year.",
    "The vendor confirmed that the migration window can be moved to a quieter weekend.",
    "Please read the attached summary before the workshop so that we can focus on decisions.",
    "Action items are tracked in the shared planner and reviewed every Monday morning.",
    "The team agreed to retire the legacy export once the new reporting dashboard is stable.",
    "Customer interviews showed that clear wording matters more than additional features.",
    "Next steps include a short survey, a prototype review and a go or no-go meeting.",
    "Risks are listed in the register, with owners and mitigation plans for each of them.",
    "The facilities team will move the shared printers to the second floor next month.",
    "We also discussed the hiring plan for the analytics team and the timing of the interviews.",
    "The quality checks passed on the staging environment after the last round of fixes.",
    "Communication to the wider organisation will go out once the leadership team has signed off.",
    "The retrospective identified handovers between teams as the main source of delays.",
    "A draft of the policy update is available for comments until the end of the week.",
    "The marketing calendar was aligned with the product milestones for the autumn launch.",
    "Training materials will be translated so that every office can use the same version.",
    "The finance team asked for a simpler approval path for small purchases.",
  ],
  fr: [
    "Le comité de pilotage s'est réuni mardi pour revoir la feuille de route du trimestre et a gardé les priorités actuelles.",
    "L'essentiel des échanges a porté sur la simplification du parcours d'accueil des nouvelles équipes.",
    "Plusieurs participants ont rappelé que la documentation reste dispersée dans trop d'espaces.",
    "Nous allons regrouper les guides dans un manuel unique avant la fin du prochain sprint.",
    "Le pilote avec les agences régionales s'est bien passé, même si les formations ont duré plus longtemps que prévu.",
    "Les retours du support montrent que la recherche est l'amélioration la plus demandée.",
    "La revue de conception a relevé quelques problèmes d'accessibilité dans les pages de réglages.",
    "Le budget reste dans l'enveloppe validée en début d'année.",
    "Le prestataire a confirmé que la fenêtre de migration peut être décalée à un week-end plus calme.",
    "Merci de lire la synthèse jointe avant l'atelier afin de consacrer la séance aux décisions.",
    "Les actions sont suivies dans le planificateur partagé et revues chaque lundi matin.",
    "L'équipe a convenu d'arrêter l'ancien export une fois le nouveau tableau de bord stabilisé.",
    "Les entretiens clients montrent qu'une formulation claire compte plus que de nouvelles fonctions.",
    "Les prochaines étapes sont un court questionnaire, une revue de maquette et une réunion de décision.",
    "Les risques figurent dans le registre, avec un responsable et un plan d'atténuation pour chacun.",
    "Les services généraux déplaceront les imprimantes partagées au deuxième étage le mois prochain.",
    "Nous avons aussi évoqué le plan de recrutement de l'équipe données et le calendrier des entretiens.",
    "Les contrôles qualité sont passés sur l'environnement de recette après la dernière série de corrections.",
    "La communication à l'ensemble de l'entreprise partira une fois que la direction aura validé.",
    "La rétrospective a désigné les passages de relais entre équipes comme principale source de retard.",
    "Un projet de mise à jour de la politique est ouvert aux commentaires jusqu'à la fin de la semaine.",
    "Le calendrier marketing a été aligné sur les jalons produit du lancement d'automne.",
    "Les supports de formation seront traduits pour que chaque site utilise la même version.",
    "L'équipe finance a demandé un circuit de validation plus simple pour les petits achats.",
  ],
};

/** About `words` words of neutral prose, in paragraphs of 3-6 sentences. */
export function fillerParagraphs(
  lang: Lang,
  words: number,
  rng: Rng,
): string[] {
  const bank = FILLER[lang];
  const out: string[] = [];
  let count = 0;
  while (count < words) {
    const n = 3 + Math.floor(rng() * 4);
    const sentences: string[] = [];
    for (let i = 0; i < n && count < words; i++) {
      const s = bank[Math.floor(rng() * bank.length)]!;
      sentences.push(s);
      count += s.split(/\s+/).length;
    }
    out.push(sentences.join(" "));
  }
  return out;
}

// ------------------------------------------------------------ labels for field units

const ITEM_LABELS: Record<string, [en: string, fr: string]> = {
  email: ["Email", "E-mail"],
  phone_fr: ["Phone", "Téléphone"],
  phone_us: ["Phone", "Téléphone"],
  phone_uk: ["Phone", "Téléphone"],
  phone_de: ["Phone", "Téléphone"],
  address_fr: ["Address", "Adresse"],
  address_us: ["Address", "Adresse"],
  address_uk: ["Address", "Adresse"],
  iban: ["IBAN", "IBAN"],
  bic: ["BIC", "BIC"],
  card: ["Card number", "Numéro de carte"],
  cvv: ["CVV", "Cryptogramme"],
  card_expiry: ["Card expiry", "Expiration carte"],
  nir: ["Social security no.", "N° de sécurité sociale"],
  ssn: ["SSN", "SSN"],
  nhs: ["NHS number", "Numéro NHS"],
  nino: ["NI number", "Numéro NI"],
  passport: ["Passport no.", "N° de passeport"],
  dob: ["Date of birth", "Date de naissance"],
  ipv4: ["Server IP", "IP serveur"],
  ipv4_private: ["Internal IP", "IP interne"],
  ipv6: ["IPv6 address", "Adresse IPv6"],
  mac: ["MAC address", "Adresse MAC"],
  siren: ["SIREN", "SIREN"],
  siret: ["SIRET", "SIRET"],
  tva: ["VAT number", "N° TVA"],
  password: ["Password", "Mot de passe"],
  private_key: ["Private key", "Clé privée"],
};
const SECRET_LABEL: [string, string] = ["API key", "Clé API"];
const DECOY_LABELS: Record<string, [string, string]> = {
  timestamp: ["Last sync", "Dernière synchro"],
  date: ["Date", "Date"],
  git_sha: ["Commit", "Commit"],
  hash: ["Checksum", "Empreinte"],
  trace_id: ["Trace id", "Trace"],
  uuid: ["Request id", "Id requête"],
  version: ["Version", "Version"],
  price: ["Amount", "Montant"],
  order_number: ["Order", "Commande"],
  number: ["Quantity", "Quantité"],
  identifier: ["Reference", "Référence"],
  url: ["Link", "Lien"],
  invalid_checksum: ["Reference", "Référence"],
  loopback: ["Host", "Hôte"],
  port: ["Port", "Port"],
  masked_secret: ["Key (masked)", "Clé (masquée)"],
  base64: ["Data", "Données"],
  public_key: ["Public key", "Clé publique"],
  placeholder: ["Password", "Mot de passe"],
  term: ["Method", "Méthode"],
};
/**
 * The field label a value gets in a two-cell row (`IBAN | FR76 …`), in the
 * document's language.
 */
export const itemLabel = (kind: string, category: DetCategory, lang: Lang) =>
  (ITEM_LABELS[kind] ??
    (category === "SECRET" ? SECRET_LABEL : [category, category]))[
    lang === "en" ? 0 : 1
  ];
/** Like `itemLabel`, for a hard negative. */
export const decoyLabel = (kind: string, lang: Lang) =>
  (DECOY_LABELS[kind] ?? ["Value", "Valeur"])[lang === "en" ? 0 : 1];

// ------------------------------------------------------------ pools

/**
 * Everything documents are built from, drawn from the detbench base cases
 * (large cases left out).
 */
export interface ContentPools {
  hash: string;
  prose: Record<Lang, Unit[]>;
  /** Prose units short enough for a footnote, a comment or speaker notes (<= 320 characters). */
  shortProse: Record<Lang, Unit[]>;
  /** Negative detbench cases (decoys only), by tag/register group. */
  negatives: Record<Lang, Unit[]>;
  fields: Record<Lang, Unit[]>;
  decoyFields: Record<Lang, Unit[]>;
  cases: DetCase[];
}

const unitOf = (c: DetCase): Unit => ({
  source: c.id,
  lang: c.lang,
  text: c.text,
  items: c.gold.map((g) => ({
    key: g.key,
    category: g.category,
    kind: g.kind,
    value: g.value,
  })),
  decoys: c.decoySpans.map((d) => ({
    key: d.key,
    kind: d.kind,
    value: d.value,
  })),
});

/** Splits a multi-line value (a PEM block) out of field units: a cell keeps one line. */
const oneLine = (v: string) => !/[\r\n]/.test(v);

/**
 * Builds the pools from the detbench dataset; throws when the dataset does not
 * validate.
 */
export function loadPools(): ContentPools {
  const { dataset, issues } = loadDetDataset();
  if (!dataset)
    throw new Error(
      `datasets/insusty-builtin/cases is invalid: ${issues.join("; ")}`,
    );
  const base = dataset.cases.filter((c) => !c.large);
  const by = (f: (c: DetCase) => boolean) =>
    Object.fromEntries(
      (["en", "fr"] as const).map((l) => [
        l,
        base.filter((c) => c.lang === l && f(c)).map(unitOf),
      ]),
    ) as Record<Lang, Unit[]>;
  const fields = { en: [] as Unit[], fr: [] as Unit[] };
  const decoyFields = { en: [] as Unit[], fr: [] as Unit[] };
  const seen = new Set<string>();
  for (const c of base) {
    for (const g of c.gold) {
      if (!oneLine(g.value) || seen.has(g.value)) continue;
      seen.add(g.value);
      const label = itemLabel(g.kind, g.category, c.lang);
      fields[c.lang].push({
        source: `field:${c.id}:${g.key}`,
        lang: c.lang,
        text: `${label}\t${g.value}`,
        items: [
          { key: g.key, category: g.category, kind: g.kind, value: g.value },
        ],
        decoys: [],
        field: { label, value: g.value },
      });
    }
    for (const d of c.decoySpans) {
      if (!oneLine(d.value) || seen.has(d.value) || d.value.length < 4)
        continue;
      seen.add(d.value);
      const label = decoyLabel(d.kind, c.lang);
      decoyFields[c.lang].push({
        source: `decoy:${c.id}:${d.key}`,
        lang: c.lang,
        text: `${label}\t${d.value}`,
        items: [],
        decoys: [{ key: d.key, kind: d.kind, value: d.value }],
        field: { label, value: d.value },
      });
    }
  }
  return {
    hash: dataset.hash,
    prose: by((c) => c.gold.length > 0 && c.text.length <= 900),
    shortProse: by(
      (c) =>
        c.gold.length > 0 && c.text.length <= 320 && !c.text.includes("```"),
    ),
    negatives: by((c) => c.gold.length === 0),
    fields,
    decoyFields,
    cases: base,
  };
}

/** Seeded shuffle (Fisher-Yates) of a copy. */
export function shuffled<T>(list: readonly T[], rng: Rng): T[] {
  const out = [...list];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
}

/**
 * Picks `n` units whose values are new to the document (`taken`), so every
 * value appears once and is located without ambiguity. Field units are drawn
 * round-robin over categories, so each document mixes kinds of values.
 */
export function pickUnits(
  pool: Unit[],
  n: number,
  rng: Rng,
  taken: Set<string>,
  byCategory = false,
): Unit[] {
  const fresh = (u: Unit) =>
    [...u.items, ...u.decoys].every(
      (v) =>
        ![...taken].some((t) => t.includes(v.value) || v.value.includes(t)),
    );
  const order = shuffled(pool, rng);
  const out: Unit[] = [];
  if (byCategory) {
    const groups = new Map<string, Unit[]>();
    for (const u of order) {
      const k = u.items[0]?.category ?? u.decoys[0]?.kind ?? "";
      groups.set(k, [...(groups.get(k) ?? []), u]);
    }
    const keys = shuffled([...groups.keys()].sort(), rng);
    let i = 0;
    while (out.length < n && [...groups.values()].some((g) => g.length)) {
      const g = groups.get(keys[i++ % keys.length]!)!;
      const u = g.shift();
      if (u && fresh(u)) {
        out.push(u);
        for (const v of [...u.items, ...u.decoys]) taken.add(v.value);
      }
    }
    return out;
  }
  for (const u of order) {
    if (out.length >= n) break;
    if (!fresh(u)) continue;
    out.push(u);
    for (const v of [...u.items, ...u.decoys]) taken.add(v.value);
  }
  return out;
}

export { rngFor, type Rng };
