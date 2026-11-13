// ============================================================
// boss/quatre.js — Vue de Quatre à la suite en Boss de fin de saison
// (handler boss.js). Interface commune des vues du Boss :
// - regle : rappel affiché avant « Prêt » ;
// - partie(etat, { seasonId, titre, texte, attente, couleur }) : message
//   de la partie au format embed ({ embeds, components }) ; boutons et
//   menus en custom_id `boss_jouer:<seasonId>:<arg…>` ; `attente` : pendant
//   la réflexion de Kévina, sans contrôle ;
// - action(args, values) : action passée aux règles (boss<Jeu>.js) ;
// - raisonFin(etat) : phrase de fin de partie ;
// - versV2 : conversion du message (celle du duel).
// ============================================================

import { HAUTEUR, NB_COLONNES } from "../../../services/quatreRules.js";
import { plateau, versV2 } from "../quatreDuel.js";

export const VUE_QUATRE = {
  regle: "Aligne 4 pions (horizontale, verticale ou diagonale) avant Kévina. Tu commences.",
  partie(d, { seasonId, titre, texte, attente, couleur }) {
    const lignes = [...(texte ? [texte, ""] : []), ...plateau(d, "joueur", { moi: "Toi", adv: "🐉 Kévina" })];
    const bouton = (c) => ({
      type: 2,
      style: 1,
      label: String(c + 1),
      custom_id: `boss_jouer:${seasonId}:${c}`,
      disabled: d.colonnes[c].length >= HAUTEUR,
    });
    const colonnes = Array.from({ length: NB_COLONNES }, (_, c) => c);
    const components =
      attente || d.termine
        ? []
        : [
            { type: 1, components: colonnes.slice(0, 4).map(bouton) },
            { type: 1, components: colonnes.slice(4).map(bouton) },
          ];
    return { embeds: [{ title: titre, description: lignes.join("\n").slice(0, 4096), color: couleur }], components };
  },
  action: ([colonne]) => ({ colonne: Number(colonne) }),
  raisonFin(d) {
    if (d.gagnant === "joueur") return "Tu alignes 4 pions !";
    if (d.gagnant === "nul") return "La grille est pleine.";
    return "Kévina aligne 4 pions.";
  },
  versV2,
};
