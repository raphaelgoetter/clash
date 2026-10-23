// ============================================================
// saison.js — Saisons des mini-jeux : le mois calendaire (heure de Paris),
// indépendant des saisons Clash Royale et de leur API.
//
// Identifiant technique : un entier par mois, qui prolonge l'ancienne
// numérotation (octobre 2026 = 137) ; les clés Redis (`<jeu>:season:<id>`,
// `<jeu>:archived:<id>`) et l'alternance des groupes
// (ACTIVE_GAME_REFERENCE_SEASON) continuent donc sans migration. Affichage
// aux joueurs : le nom du mois (« Saison d'Octobre »), jamais l'identifiant.
// ============================================================

const PARIS = "Europe/Paris";

// Mois de référence de la numérotation : octobre 2026 = saison 137.
const REFERENCE = { annee: 2026, moisIndex: 9, seasonId: 137 };

const MOIS = [
  "Janvier", "Février", "Mars", "Avril", "Mai", "Juin",
  "Juillet", "Août", "Septembre", "Octobre", "Novembre", "Décembre",
];

const partsFormatter = new Intl.DateTimeFormat("en-US", {
  timeZone: PARIS,
  year: "numeric",
  month: "numeric",
  day: "numeric",
  hour: "numeric",
  minute: "numeric",
  second: "numeric",
  hourCycle: "h23",
});

function parisParts(date) {
  const parts = Object.fromEntries(
    partsFormatter.formatToParts(date).map((p) => [p.type, Number(p.value)]),
  );
  return {
    annee: parts.year,
    moisIndex: parts.month - 1,
    jour: parts.day,
    heure: parts.hour,
    minute: parts.minute,
    seconde: parts.second,
  };
}

// Instant UTC du 1er du mois à minuit, heure de Paris (moisIndex peut
// déborder : 12 = janvier de l'année suivante).
function debutDuMois(annee, moisIndex) {
  const guess = Date.UTC(annee, moisIndex, 1);
  const p = parisParts(new Date(guess));
  const decalage =
    Date.UTC(p.annee, p.moisIndex, p.jour, p.heure, p.minute, p.seconde) - guess;
  return new Date(guess - decalage);
}

/** Identifiant de la saison (mois calendaire, heure de Paris) contenant `date`. */
export function seasonIdForDate(date = new Date()) {
  const { annee, moisIndex } = parisParts(date);
  return (
    REFERENCE.seasonId +
    (annee - REFERENCE.annee) * 12 +
    (moisIndex - REFERENCE.moisIndex)
  );
}

/** Saison en cours. Asynchrone pour rester compatible avec les appelants
 * (l'ancienne version interrogeait l'API Clash Royale). */
export async function getCurrentSeasonId(now = new Date()) {
  return seasonIdForDate(now);
}

/** Mois et année d'un identifiant de saison. */
export function moisDeSaison(seasonId) {
  const index = REFERENCE.moisIndex + (seasonId - REFERENCE.seasonId);
  return {
    annee: REFERENCE.annee + Math.floor(index / 12),
    moisIndex: ((index % 12) + 12) % 12,
  };
}

/** « d'Octobre », « de Novembre » : complément du nom de saison. */
export function deMois(seasonId) {
  const mois = MOIS[moisDeSaison(seasonId).moisIndex];
  return /^[AEIOUÉ]/.test(mois) ? `d'${mois}` : `de ${mois}`;
}

/** Nom affiché d'une saison (« Saison d'Octobre »). */
export function nomSaison(seasonId) {
  return `Saison ${deMois(seasonId)}`;
}

/** « Octobre 2026 » : libellé avec année (historique), pour la saison
 * contenant `date`. */
export function libelleMoisAnnee(date) {
  const { annee, moisIndex } = parisParts(date);
  return `${MOIS[moisIndex]} ${annee}`;
}

/** Bornes [start, end) de la saison contenant `now` : 1er du mois à minuit
 * (Paris) → 1er du mois suivant. */
export function getCurrentSeasonBounds(now = new Date()) {
  const { annee, moisIndex } = parisParts(now);
  return {
    start: debutDuMois(annee, moisIndex),
    end: debutDuMois(annee, moisIndex + 1),
  };
}

/** Nombre d'occurrences du jour de semaine `weekday` (0 = dimanche … 6 =
 * samedi, jours UTC) dans [start, end). */
export function countWeekdayOccurrencesInRange(start, end, weekday) {
  let count = 0;
  const cursor = new Date(
    Date.UTC(start.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  if (cursor.getTime() < start.getTime()) cursor.setUTCDate(cursor.getUTCDate() + 1);
  while (cursor.getTime() < end.getTime()) {
    if (cursor.getUTCDay() === weekday) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/** Occurrences de `weekday` STRICTEMENT après le jour de `now` et avant la
 * fin de la saison (sert au « X » de « Manche N/X »). */
export function countRemainingWeekdayOccurrences(now, weekday) {
  const { end } = getCurrentSeasonBounds(now);
  const demain = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return countWeekdayOccurrencesInRange(demain, end, weekday);
}

/** Mercredis restants dans la saison après le jour de `now`. */
export function countRemainingWednesdays(now = new Date()) {
  return countRemainingWeekdayOccurrences(now, 3);
}
