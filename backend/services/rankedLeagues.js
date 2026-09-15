// ============================================================
// rankedLeagues.js — Ligue ranked de l'API Clash Royale :
// bestPathOfLegendSeasonResult.leagueNumber → libellé.
//
// ⚠️ Le champ leagueNumber mélange DEUX échelles historiques sans indiquer
// laquelle s'applique à un résultat donné :
//   - Échelle héritée (avant la réforme "Ranked" de juillet 2025, qui incluait
//     encore les paliers Challenger I/II/III) : 10 paliers, Royal Champion=9,
//     Ultimate Champion=10.
//   - Échelle actuelle (depuis juillet 2025, Challenger supprimés) : 7 paliers
//     (Master I/II/III, Champion, Grand Champion, Royal Champion, Ultimate
//     Champion), Royal Champion=6, Ultimate Champion=7.
// L'API ne renuméroté pas rétroactivement les anciens bestPathOfLegendSeasonResult,
// donc un joueur ayant culminé avant juillet 2025 garde sa valeur sur l'ancienne
// échelle, et un joueur ayant culminé depuis est sur la nouvelle. On accepte les
// deux valeurs par palier pour ne pas sous-compter les joueurs récents (au prix
// d'un risque de sur-comptage pour d'anciens paliers coïncidant numériquement,
// ex. Master III=6 sous l'ancienne échelle vs Royal Champion=6 sous la nouvelle).
// ============================================================

// "Ultimate Champion" (FR : "Champion Suprême") : 7 (échelle actuelle) ou 10 (héritée).
export const SUPREME_CHAMPION_LEAGUE_NUMBERS = [7, 10];
// "Royal Champion" (FR : "Champion Royal") : 6 (échelle actuelle) ou 9 (héritée).
export const ROYAL_CHAMPION_LEAGUE_NUMBERS = [6, 9];

export function isSupremeChampionLeague(leagueNumber) {
  return SUPREME_CHAMPION_LEAGUE_NUMBERS.includes(leagueNumber);
}

export function isRoyalChampionLeague(leagueNumber) {
  return ROYAL_CHAMPION_LEAGUE_NUMBERS.includes(leagueNumber);
}

/**
 * Libellé du meilleur palier ranked jamais atteint par un joueur (meilleure
 * saison), uniquement pour les deux ligues les plus hautes. Retourne null
 * pour tout autre palier (y compris jamais joué en ranked).
 * @param {number|null|undefined} leagueNumber
 * @returns {string|null}
 */
export function getBestRankedLeagueLabel(leagueNumber) {
  if (isSupremeChampionLeague(leagueNumber)) return "Champion Suprême";
  if (isRoyalChampionLeague(leagueNumber)) return "Champion Royal";
  return null;
}
