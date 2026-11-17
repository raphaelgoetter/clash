// ============================================================
// boss/quatre.js — Vue de Quatre à la suite en Boss de fin de saison
// (handler boss.js). Interface commune des vues du Boss :
// - regle : rappel affiché avant « Prêt » ;
// - partie(etat, { seasonId, titre, texte, attente, couleur }) : message
//   de la partie au format embed ({ embeds, components }) ; boutons et
//   menus en custom_id `boss_jouer:<seasonId>:<arg…>` ; `attente` : pendant
//   la réflexion de Kévina, sans contrôle ;
//   affichage seul (sans coup) : `boss_curseur:<seasonId>:<arg…>`, passé
//   en `curseur` (premier argument, nombre) ;
// - action(args, values) : action passée aux règles (boss<Jeu>.js) ;
// - raisonFin(etat) : phrase de fin de partie ;
// - versV2 : conversion du message (celle du duel).
// ============================================================

// Quatre à la suite ajoute `curseur` (colonne du pion à jouer, ◀️ ▶️ en
// boss_curseur:<seasonId>:<colonne>:<g|d>, voir boss.js) et, sans `texte`,
// rappelle le dernier coup de Kévina.

import { boutonsCurseur, colonneCurseur, urlBandeau, urlGrille, versV2 } from "../quatreDuel.js";

export const VUE_QUATRE = {
  regle: "Aligne 4 pions (horizontale, verticale ou diagonale) avant Kévina. Tu commences.",
  partie(d, { seasonId, titre, texte, attente, couleur, curseur = null }) {
    const recit = texte ?? (d.dernier?.id === "bot" ? `Kévina joue en colonne ${d.dernier.colonne + 1}.` : null);
    const grille = urlGrille(d, "joueur", { moi: "Toi", adv: "Kévina" });
    const colonne = attente || d.termine ? null : colonneCurseur(d, curseur);
    const ids = {
      gauche: (c) => `boss_curseur:${seasonId}:${c}:g`,
      droite: (c) => `boss_curseur:${seasonId}:${c}:d`,
      poser: (c) => `boss_jouer:${seasonId}:${c}`,
    };
    return {
      embeds: [
        {
          title: titre,
          description: recit ?? "",
          images: colonne === null ? [grille] : [urlBandeau(colonne), grille],
          color: couleur,
        },
      ],
      components: colonne === null ? [] : [{ type: 1, components: boutonsCurseur(d, colonne, ids) }],
    };
  },
  action: ([colonne]) => ({ colonne: Number(colonne) }),
  raisonFin(d) {
    if (d.gagnant === "joueur") return "Tu alignes 4 pions !";
    if (d.gagnant === "nul") return "La grille est pleine.";
    return "Kévina aligne 4 pions.";
  },
  versV2,
};
