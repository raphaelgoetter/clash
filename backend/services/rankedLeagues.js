// ============================================================
// rankedLeagues.js — Ligue ranked (Path of Legends) de l'API Clash Royale :
// bestPathOfLegendSeasonResult.leagueNumber → libellé.
// ============================================================

// leagueNumber du classement ranked correspondant à la ligue la plus haute
// du jeu, "Ultimate Champion" (FR : "Champion Suprême").
export const SUPREME_CHAMPION_LEAGUE_NUMBER = 10;
// Ligue juste en dessous, "Royal Champion" (FR : "Champion Royal").
export const ROYAL_CHAMPION_LEAGUE_NUMBER = 9;

/**
 * Libellé du meilleur palier ranked jamais atteint par un joueur (meilleure
 * saison), uniquement pour les deux ligues les plus hautes. Retourne null
 * pour tout autre palier (y compris jamais joué en ranked).
 * @param {number|null|undefined} leagueNumber
 * @returns {string|null}
 */
export function getBestRankedLeagueLabel(leagueNumber) {
  if (leagueNumber === SUPREME_CHAMPION_LEAGUE_NUMBER) return "Champion Suprême";
  if (leagueNumber === ROYAL_CHAMPION_LEAGUE_NUMBER) return "Champion Royal";
  return null;
}
