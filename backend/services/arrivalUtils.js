// ============================================================
// arrivalUtils.js — Détection des arrivées en cours de GDC
// Permet de ne pas pénaliser les membres ayant rejoint le clan
// en cours de semaine dans les listes de sous-quota / fail.
// ============================================================

/**
 * Détermine si un joueur est arrivé en cours de GDC.
 *
 * Logique :
 * - streakInCurrentClan === 0 et day1Decks > 0
 *                                          → arrivé le jour 1 mais a quand même
 *                                            pu jouer ses decks ce jour-là
 *                                          → pas pénalisé (a eu toute la GDC)
 * - streakInCurrentClan === 0 (sinon)   → 0 semaines complètes dans le clan
 *                                          → arrivé cette semaine
 * - streakInCurrentClan === 1 et pas de deck joué au jour 1 (jeudi)
 *                                          → arrivé en début de GDC
 *                                          (a raté le jour 1, ne peut pas faire 16/16)
 * - streakInCurrentClan === 1, day1Decks inconnu et totalDecks < maxDecks
 *                                          → probablement arrivé en cours (heuristique
 *                                            pour les semaines passées du race log)
 * - Autres cas                           → membre installé
 *
 * La source de `streakInCurrentClan` est buildWarHistory() dans warHistory.js,
 * qui parcourt les semaines du race log (de la plus récente à la plus ancienne)
 * et compte les semaines complètes consécutives passées dans le clan actuel.
 *
 * @param {number|null} streakInCurrentClan - Semaines consécutives complètes
 *        dans le clan actuel (hors semaine en cours)
 * @param {number|null} [day1Decks] - Nombre de decks joués au jour 1 (jeudi)
 *        de la GDC en cours. null / 0 si pas joué.
 * @param {number|null} [totalDecks] - Nombre total de decks joués dans la semaine
 *        (alternative si day1Decks n'est pas disponible)
 * @param {number} [maxDecks=16] - Nombre maximal de decks possibles sur la semaine
 * @returns {boolean} true si le joueur est arrivé en cours de GDC
 */
export function isJoinedThisWar(streakInCurrentClan, day1Decks = null, totalDecks = null, maxDecks = 16) {
  if (streakInCurrentClan == null) return false;
  if (streakInCurrentClan === 0) {
    if (day1Decks != null && day1Decks > 0) return false;
    return true;
  }
  if (streakInCurrentClan === 1 && day1Decks != null && day1Decks === 0) return true;
  if (streakInCurrentClan === 1 && day1Decks == null) {
    if (totalDecks != null) return totalDecks < maxDecks;
    return true;
  }
  return false;
}
