// ============================================================
// arrivalUtils.js — Détection des arrivées en cours de GDC
// Permet de ne pas pénaliser les membres ayant rejoint le clan
// en cours de semaine dans les listes de fail.
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

/**
 * Détecte un pattern de « retour en cours de semaine » à partir du détail
 * jour par jour des snapshots (thu→sun, valeurs null quand le joueur
 * n'était pas encore dans le clan au moment du snapshot).
 *
 * Un membre peut avoir quitté puis réintégré le même clan au sein de la
 * semaine de GDC en cours : son streak historique (semaines complètes
 * *avant* son départ) reste élevé, ce qui masque à tort son absence
 * réelle en début de semaine courante si on ne regarde que le streak.
 *
 * On exige au moins 2 jours d'absence consécutifs en tête de semaine
 * suivis d'une donnée réelle : un seul jour manquant est trop faible
 * comme signal (peut être un simple trou de collecte de snapshot pour
 * un membre installé) pour l'utiliser seul comme preuve d'arrivée tardive.
 *
 * @param {Array<number|null>} daily - Tableau à 4 entrées (jeu→dim),
 *        null si aucune donnée de snapshot pour ce jour.
 * @returns {boolean}
 */
export function hasLateArrivalDailyPattern(daily) {
  if (!Array.isArray(daily) || daily.length === 0) return false;
  const firstDataIdx = daily.findIndex((v) => v != null);
  return firstDataIdx >= 2;
}
