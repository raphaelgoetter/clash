// Source de vérité unique pour l'arrondi d'affichage de la projection de fame GDC.
// Importé par le frontend (frontend/warGroup.js) et le bot Discord (api/discord/interactions.js).
// Ne jamais dupliquer cette règle ailleurs — modifier ici uniquement.

/**
 * Arrondit une projection de fame pour l'affichage.
 * Quand le nombre de decks max du jour est atteint, la projection est exacte
 * (plus aucun deck restant à jouer), donc on affiche la valeur précise.
 * Sinon, on affiche une estimation prudente arrondie vers le bas à la centaine.
 * @param {number} projectedFame
 * @param {number|null|undefined} decksToday
 * @param {number|null|undefined} targetDecksToday
 * @returns {number|null}
 */
export function roundProjectedFame(projectedFame, decksToday, targetDecksToday) {
  if (typeof projectedFame !== "number" || !Number.isFinite(projectedFame)) {
    return null;
  }

  if (
    typeof decksToday === "number" &&
    typeof targetDecksToday === "number" &&
    decksToday >= targetDecksToday
  ) {
    return Math.round(projectedFame);
  }

  return Math.floor(projectedFame / 100) * 100;
}
