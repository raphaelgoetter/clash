// ============================================================
// boss/grille.js — Vue de La Grille en Boss de fin de saison (handler
// boss.js), interface commune décrite dans boss/quatre.js. Même plateau et
// mêmes boutons que le duel contre Kévina (grilleDuel.js), sans bouton
// Règles ni explosions animées (le récit du coup suffit).
// ============================================================

import { HAUTEUR, scoreGrille } from "../../../services/grilleRules.js";
import { formatDie } from "../../../services/dices.js";
import { ADV, COLONNES, MOI, plateau } from "../grilleDuel.js";

export const VUE_GRILLE = {
  regle: [
    "À ton tour, un dé est lancé : pose-le dans une de tes 3 colonnes. Des dés identiques d'une colonne se multiplient, et ton dé détruit ceux de même valeur dans la colonne d'en face de Kévina.",
    "La partie s'arrête dès qu'une grille est pleine : le plus haut total gagne. Tu commences.",
  ].join("\n"),
  partie(d, { seasonId, titre, texte, attente, couleur }) {
    const monTour = !d.termine && d.actif === "joueur";
    const lignes = [
      ...(texte ? [texte, ""] : []),
      ...plateau(d, "joueur", { moi: "Toi", adv: "🐉 Kévina" }),
      ...(d.termine
        ? []
        : monTour
          ? ["", `# Ton dé : ${formatDie(d.de, MOI)}`]
          : ["", "⏳ Au tour de Kévina.", ...(d.de ? [`Dé de Kévina : ${formatDie(d.de, ADV)}`] : [])]),
    ];
    const components =
      attente || !monTour
        ? []
        : [
            {
              type: 1,
              components: COLONNES.map((col, c) => ({
                type: 2,
                style: 1,
                label: col.nom,
                custom_id: `boss_jouer:${seasonId}:${c}`,
                disabled: d.grilles.joueur[c].length >= HAUTEUR,
              })),
            },
          ];
    return { embeds: [{ title: titre, description: lignes.join("\n").slice(0, 4096), color: couleur }], components };
  },
  action: ([colonne]) => ({ colonne: Number(colonne) }),
  raisonFin(d) {
    const s = `(${scoreGrille(d.grilles.joueur)} à ${scoreGrille(d.grilles.bot)})`;
    return d.dernier?.id === "joueur" ? `Ta grille est pleine ${s}.` : `La grille de Kévina est pleine ${s}.`;
  },
  // Le duel envoie des embeds classiques (titres # admis dans la
  // description) : message transmis tel quel, sans Components V2.
  versV2: (payload) => payload,
};
