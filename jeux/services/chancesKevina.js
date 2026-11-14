// ============================================================
// chancesKevina.js — Taux de victoire d'un « bon joueur » contre Kévina
// (une partie, le joueur commence), mesuré par les simulateurs
// jeux/outils/<jeu>/simulateDuel.mjs sur les réglages de production
// (jeux/data/<jeu>/duel.json). Affiché sur le plateau public des duels
// contre Kévina. ⚠️ À remesurer à chaque réglage de Kévina (voir
// jeux/CONTRIBUTING.md, « Chances contre Kévina »).
// ============================================================

export const CHANCES_BON_JOUEUR = { quatre: 35, frise: 36, punto: 62, grille: 50, potato: 59 };

/** Ligne affichée sous le plateau public, null si le jeu n'est pas mesuré. */
export function ligneChances(jeu) {
  const p = CHANCES_BON_JOUEUR[jeu];
  return p == null ? null : `🎯 Un bon joueur bat Kévina ${p} % du temps.`;
}
