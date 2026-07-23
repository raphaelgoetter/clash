// ============================================================
// dateUtils.js — Utilitaires de dates, décalages timezone et
// clés de journées de guerre GDC.
// ============================================================

export const MS_PER_DAY = 1000 * 60 * 60 * 24;

/**
 * Heures de reset GDC par clan (UTC). Les clans absents de cette table utilisent
 * le défaut 09:40 UTC.
 *
 * ⚠️ ATTENTION : L'heure du reset de chaque clan (CLAN_RESET_TIMES) change à
 * chaque nouvelle Saison. Elle n'est pas connue à l'avance et il faut la
 * renseigner à la main à chaque saison.
 *
 * @type {Object<string,{h:number,m:number}>}
 */
export const CLAN_RESET_TIMES = {
  Y8JUPC9C: { h: 9, m: 33 }, // La Resistance (Clan 1) — reset spécifique 09:33 UTC
  LRQP20V9: { h: 9, m: 36 }, // Les Resistants (Clan 2) — reset spécifique 09:36 UTC
  QU9UQJRL: { h: 9, m: 56 }, // Les Revoltes (Clan 3) — reset spécifique 09:56 UTC
};

/** Décalage UTC→Paris en ms pour une date donnée (+3 600 000 hiver, +7 200 000 été) */
export function parisOffsetMs(date = new Date()) {
  const p = new Date(
    date.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  const u = new Date(date.toLocaleString("en-US", { timeZone: "UTC" }));
  return p - u;
}

/**
 * Nombre de ms à soustraire à un timestamp UTC pour obtenir le « jour GDC ».
 * Par défaut 09:40 UTC ; certains clans ont un reset différent (voir CLAN_RESET_TIMES).
 * @param {string|null} [clanTag]  Tag du clan sans '#' (ex. 'LRQP20V9'). Optionnel — fallback 09:40.
 */
export function warResetOffsetMs(clanTag = null) {
  const cfg = clanTag
    ? CLAN_RESET_TIMES[String(clanTag).replace("#", "").toUpperCase()]
    : null;
  const h = cfg?.h ?? 9;
  const m = cfg?.m ?? 40;
  return (h * 60 + m) * 60 * 1000;
}

/**
 * Parse a Clash Royale timestamp string (YYYYMMDDTHHmmss.000Z) into a Date.
 * @param {string} ts
 * @returns {Date}
 */
export function parseClashDate(ts) {
  if (!ts) return new Date(0);
  // Format: 20240315T123456.000Z → standard ISO-ish
  const iso = ts.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/,
    "$1-$2-$3T$4:$5:$6.$7Z",
  );
  return new Date(iso);
}

/**
 * Return the war-day key (YYYY-MM-DD) for a timestamp, accounting for the
 * clan-specific daily reset (default 09:40 UTC).
 * @param {Date|string} dateOrTs
 * @param {string|null} [clanTag]  Tag du clan (optionnel). Fallback 09:40 si absent.
 * @returns {string}
 */
export function warDayKey(dateOrTs, clanTag = null) {
  const d = dateOrTs instanceof Date ? dateOrTs : parseClashDate(dateOrTs);
  return new Date(d.getTime() - warResetOffsetMs(clanTag))
    .toISOString()
    .slice(0, 10);
}

// ============================================================
// Semaine / Saison Clash Royale — source de vérité
//
// • Une saison dure environ un mois.
// • Elle commence toujours le PREMIER LUNDI du mois, juste après le reset
//   de la Guerre de Clan (09:40 UTC).
// • Elle est composée de 3 à 5 semaines selon le mois.
//
// Représentation API Clash Royale :
//   seasonId      : entier (ex. 130) — identifiant unique de la saison
//   sectionIndex  : entier 0-based  (W1=0, W2=1, W3=2, W4=3, W5=4)
//
// ⚠️  /currentriverrace ne fournit PAS de seasonId.
//     On le déduit du dernier war log terminé (raceLog[0]).
//
// Détection de rollover de saison :
//     Si sectionIndex courant ≤ sectionIndex du dernier log terminé,
//     le compteur a repassé par 0 → on est passé à la saison suivante.
//     Ex. : raceLog[0].sectionIndex=4 (S130W5) et currentRace.sectionIndex=0
//           → S131W1 (seasonId+1, section 0 → W1).
// ============================================================

/**
 * Calcule le weekId de la semaine en cours (ex. "S130W5").
 *
 * @param {object|null} currentRace  Réponse /currentriverrace (sectionIndex présent, seasonId absent)
 * @param {Array}       raceLog      Guerres terminées — raceLog[0] = la plus récente (seasonId + sectionIndex requis)
 * @returns {string|null}            "S<seasonId>W<week>" ou null si données insuffisantes
 */
export function computeCurrentWeekId(currentRace, raceLog) {
  if (!currentRace || !raceLog?.length) return null;
  const currSection = currentRace.sectionIndex ?? 0;
  const lastEntry = raceLog[0];
  if (lastEntry.seasonId == null) return null;
  let seasonId = lastEntry.seasonId;
  // Rollover : sectionIndex qui repart de 0 indique une nouvelle saison
  if (currSection <= (lastEntry.sectionIndex ?? -1)) seasonId += 1;
  return `S${seasonId}W${currSection + 1}`;
}

/**
 * Calcule le seasonId en cours (ex. 131).
 *
 * @param {object|null} currentRace  Réponse /currentriverrace
 * @param {Array}       raceLog      Guerres terminées — raceLog[0] = la plus récente
 * @returns {number|null}            L'ID de la saison ou null si données insuffisantes
 */
export function computeCurrentSeasonId(currentRace, raceLog) {
  if (!currentRace || !raceLog?.length) return raceLog?.[0]?.seasonId || null;
  const currSection = currentRace.sectionIndex ?? 0;
  const lastEntry = raceLog[0];
  if (lastEntry.seasonId == null) return null;
  let seasonId = lastEntry.seasonId;
  // Rollover : sectionIndex qui repart de 0 indique une nouvelle saison
  if (currSection <= (lastEntry.sectionIndex ?? -1)) seasonId++;
  return seasonId;
}

/**
 * Calcule le weekId de la dernière semaine terminée (ex. "S130W4").
 *
 * @param {Array} raceLog  Guerres terminées — raceLog[0] = la plus récente
 * @returns {string|null}  "S<seasonId>W<week>" ou null si données insuffisantes
 */
export function computePrevWeekId(raceLog) {
  const entry = raceLog?.[0];
  if (!entry || entry.seasonId == null || entry.sectionIndex == null)
    return null;
  return `S${entry.seasonId}W${entry.sectionIndex + 1}`;
}

/**
 * Parse un weekId ("S134W1") en { seasonId, sectionIndex }. À utiliser plutôt
 * que de dériver seasonId/sectionIndex séparément du weekId lui-même, pour
 * garantir qu'ils restent toujours cohérents entre eux.
 * @param {string|null} weekId
 * @returns {{seasonId: number, sectionIndex: number}|null}
 */
export function parseWeekId(weekId) {
  const match = /^S(\d+)W(\d+)$/.exec(weekId ?? "");
  if (!match) return null;
  return { seasonId: Number(match[1]), sectionIndex: Number(match[2]) - 1 };
}

// ============================================================
// Bornes calendaires d'une saison — jeux Frame (mercredi) et Anagram (samedi)
//
// Calcul purement calendaire (mois civil), indépendant de l'API Clash
// Royale : sert uniquement à prédire le nombre total de manches (Frame :
// mercredis, Anagram : samedis) de la saison en cours, pour l'affichage
// "Manche N/X". Ne pas confondre avec seasonId/computeCurrentSeasonId
// ci-dessus, qui restent la seule source de vérité pour l'identifiant de
// saison lui-même.
// ============================================================

/** Premier lundi (UTC minuit) du mois donné. `monthIndex` accepte des
 * valeurs hors [0,11] (12, -1, ...) : Date.UTC() normalise automatiquement
 * l'année/le mois, ce qui simplifie le calcul du mois suivant/précédent en
 * bordure d'année dans getCurrentSeasonBounds(). */
export function getFirstMondayOfMonth(year, monthIndex) {
  const first = new Date(Date.UTC(year, monthIndex, 1));
  const dow = first.getUTCDay(); // 0=dimanche..6=samedi
  const offset = (1 - dow + 7) % 7;
  return new Date(Date.UTC(year, monthIndex, 1 + offset));
}

/** Bornes [start, end) de la saison Frame calendaire en cours à la date `now`. */
export function getCurrentSeasonBounds(now = new Date()) {
  const year = now.getUTCFullYear();
  const monthIndex = now.getUTCMonth();
  const candidate = getFirstMondayOfMonth(year, monthIndex);
  const start =
    now.getTime() >= candidate.getTime()
      ? candidate
      : getFirstMondayOfMonth(year, monthIndex - 1);
  const end = getFirstMondayOfMonth(start.getUTCFullYear(), start.getUTCMonth() + 1);
  return { start, end };
}

/** Nombre d'occurrences du jour de semaine `weekday` (0=dimanche..6=samedi)
 * dans [start, end) (borne de fin exclue). */
export function countWeekdayOccurrencesInRange(start, end, weekday) {
  let count = 0;
  const cursor = new Date(start.getTime());
  while (cursor.getTime() < end.getTime()) {
    if (cursor.getUTCDay() === weekday) count++;
    cursor.setUTCDate(cursor.getUTCDate() + 1);
  }
  return count;
}

/** Nombre d'occurrences de `weekday` STRICTEMENT après `now` avant la fin de
 * la saison calendaire en cours (borne de fin exclue). Volontairement séparé
 * du nombre de manches déjà jouées (inconnu de dateUtils.js, qui n'a aucune
 * notion d'état de partie) — voir computeSeasonMancheTotal() dans
 * frames.js/anagrams.js, qui combine les deux pour obtenir X de façon
 * robuste même si le jeu démarre en cours de saison (occurrences déjà
 * passées non comptées). */
export function countRemainingWeekdayOccurrences(now, weekday) {
  const { end } = getCurrentSeasonBounds(now);
  const tomorrow = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate() + 1),
  );
  return countWeekdayOccurrencesInRange(tomorrow, end, weekday);
}

/** Nombre de mercredis dans [start, end) (borne de fin exclue). */
export function countWednesdaysInRange(start, end) {
  return countWeekdayOccurrencesInRange(start, end, 3);
}

/** Nombre de mercredis STRICTEMENT après `now` avant la fin de la saison
 * calendaire en cours — voir countRemainingWeekdayOccurrences(). */
export function countRemainingWednesdays(now = new Date()) {
  return countRemainingWeekdayOccurrences(now, 3);
}
