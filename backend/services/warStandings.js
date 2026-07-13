// ============================================================
// warStandings.js — Classement et détection de victoire assurée en GDC.
//
// Deux mécaniques totalement différentes selon `periodType` :
//
//   - "warDay" (GDC normale, toutes les semaines sauf la dernière de la saison) :
//     le classement dépend de la progression du BATEAU vers la ligne d'arrivée
//     (10 000 pts). Cette progression est exposée directement par le champ
//     `fame` de chaque clan dans /currentriverrace (0-10000). Ce champ reflète
//     le dernier jour de guerre CLOS — il ne bouge pas en direct pendant la
//     journée en cours, uniquement au reset. Franchir 10 000 = victoire
//     immédiate ; sinon le classement final se fait sur la position atteinte
//     au reset du J4.
//     Le cumul brut de fame de bataille (sum(participants[].fame), échelle
//     ~100 000+) N'EST PAS le critère de classement ici — c'est uniquement le
//     score du jour ("PTS" affiché), sans rapport avec le classement final.
//
//   - "colosseum" (dernière semaine de chaque saison) : pas de course de
//     bateau — le classement dépend du cumul brut de fame de bataille sur
//     toute la semaine (sum(participants[].fame), ~80 000-160 000).
//
// Preuve empirique (voir docs/api-clash-royale.md § "Classement final GDC") :
// sur riverracelog réel, les semaines normales (sectionIndex 0-3) ont
// standings[].clan.fame ∈ [3 300, 10 000] avec le barème de trophées "GDC
// normale" (+20/+10/0/-5/-10/-20), tandis que la dernière semaine de saison
// (sectionIndex 4, Colisée) a fame ∈ [110 000, 130 000] avec le barème
// "Colisée" (+100/+50/0/-25/-50/-100).
// ============================================================

/** Ligne d'arrivée de la course de bateau en GDC normale (constatée à l'identique sur plusieurs semaines/clans). */
export const RACE_FINISH_LINE = 10000;

const MAX_WEEKLY_DECKS = 800; // 50 membres × 4 decks × 4 jours
const MAX_FAME_PER_DECK = 200;

function normalizeClanTag(tag) {
  if (!tag) return "";
  const raw = String(tag).trim().toUpperCase();
  return raw.startsWith("#") ? raw : `#${raw}`;
}

function sumFame(participants) {
  return (participants ?? []).reduce((s, p) => s + (p.fame ?? 0), 0);
}

function sumDecksUsed(participants) {
  return (participants ?? []).reduce((s, p) => s + (p.decksUsed ?? 0), 0);
}

/**
 * Calcule le standing d'un seul clan, indépendamment des rivaux.
 *
 * @param {object} clanRaceEntry - `currentRace.clan` (clan propre) ou un élément de `currentRace.clans[]`.
 * @param {object} opts
 * @param {boolean} opts.isColosseum
 * @returns {{
 *   raceProgress: number|null,     // GDC normale uniquement, 0-10000
 *   currentFame: number|null,      // Colisée uniquement, cumul semaine
 *   maxReachableFame: number|null, // Colisée uniquement, borne théorique
 * }}
 */
export function computeClanStanding(clanRaceEntry, { isColosseum }) {
  if (isColosseum) {
    const participants = clanRaceEntry?.participants ?? [];
    const currentFame = sumFame(participants);
    const decksUsedWeekly = sumDecksUsed(participants);
    const remainingDecks = Math.max(0, MAX_WEEKLY_DECKS - decksUsedWeekly);
    const maxReachableFame = currentFame + remainingDecks * MAX_FAME_PER_DECK;
    return { raceProgress: null, currentFame, maxReachableFame };
  }

  // GDC normale : `fame` est directement la progression du bateau (0-10000),
  // déjà fournie par l'API pour tous les clans du groupe en un seul appel.
  const raceProgress =
    typeof clanRaceEntry?.fame === "number" ? clanRaceEntry.fame : null;
  return { raceProgress, currentFame: null, maxReachableFame: null };
}

/**
 * Calcule le standing de tout le groupe (nécessite de comparer aux rivaux
 * pour déterminer `isClinchedWin`), trié par classement décroissant.
 *
 * @param {object[]} clanRaceEntries - `currentRace.clans[]` (inclut le clan propre).
 * @param {object} opts
 * @param {boolean} opts.isColosseum
 * @returns {Array<{ tag: string, raceProgress: number|null, currentFame: number|null, maxReachableFame: number|null, isClinchedWin: boolean }>}
 */
export function computeGroupStandings(clanRaceEntries, { isColosseum }) {
  const entries = (clanRaceEntries ?? []).map((c) => ({
    tag: normalizeClanTag(c?.tag),
    ...computeClanStanding(c, { isColosseum }),
  }));

  if (isColosseum) {
    // Victoire assurée : currentFame(clan) > max(maxReachableFame des rivaux).
    entries.forEach((entry) => {
      const rivalsMax = entries
        .filter((x) => x.tag !== entry.tag)
        .map((x) => x.maxReachableFame ?? 0);
      const bestRivalReachable =
        rivalsMax.length > 0 ? Math.max(...rivalsMax) : 0;
      entry.isClinchedWin =
        typeof entry.currentFame === "number" &&
        entry.currentFame > bestRivalReachable;
    });
    entries.sort((a, b) => (b.currentFame ?? 0) - (a.currentFame ?? 0));
  } else {
    // Victoire assurée : ligne d'arrivée franchie, constat direct — jamais de
    // prédiction anticipée (le bateau ne bouge qu'au reset d'un jour clos).
    entries.forEach((entry) => {
      entry.isClinchedWin =
        typeof entry.raceProgress === "number" &&
        entry.raceProgress >= RACE_FINISH_LINE;
    });
    entries.sort((a, b) => (b.raceProgress ?? -1) - (a.raceProgress ?? -1));
  }

  return entries;
}
