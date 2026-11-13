// ============================================================
// boss/punto.js — Vue de Punto en Boss de fin de saison (handler boss.js),
// interface décrite dans boss/quatre.js. Rendu du duel (handler
// puntoDuel.js) : à son tour, plateau en boutons (5 rangées de 5, custom_id
// `boss_jouer:<seasonId>:<case>:<coup>`, `coup` écarte un clic sur une vue
// dépassée) ; pendant la réflexion de Kévina et en fin de partie, plateau
// en texte (alignement gagnant surligné). Ni Règles ni abandon.
// Components V2 : conteneur + texte + 5 rangées + 25 boutons = 32 (≤ 40).
// ============================================================

import { TAILLE } from "../../../services/puntoRules.js";
import { boutonsPlateau, ligneCarte, plateau, versV2 } from "../puntoDuel.js";

const KEVINA = { Sujet: "Kévina", emoji: "🐉" };
const NOMS = { moi: "Toi", adv: "🐉 Kévina" };

export const VUE_PUNTO = {
  regle: [
    "Chacun retourne à son tour la carte du dessus de sa pioche (les tiennes sont bleues et vertes) et la pose sur une case vide voisine d'une carte, ou sur une carte plus faible qu'elle recouvre.",
    "Aligne 4 cartes de la même couleur avant Kévina. Tu commences.",
  ].join("\n"),
  partie(d, { seasonId, titre, texte, attente, couleur }) {
    const carte = d.termine ? null : ligneCarte(d, "joueur", KEVINA);
    if (attente || d.termine || d.actif !== "joueur") {
      // Plateau en texte, sans contrôle
      const lignes = [...(texte ? [texte, ""] : []), ...plateau(d, "joueur", NOMS), ...(carte ? ["", carte] : [])];
      return { embeds: [{ title: titre, description: lignes.join("\n").slice(0, 4096), color: couleur }], components: [] };
    }
    const [legende] = plateau(d, "joueur", NOMS);
    const lignes = [legende, ...(texte ? ["", texte] : []), "", carte];
    const components = boutonsPlateau(d, "joueur", true, "").map((rangee, r) => ({
      ...rangee,
      components: rangee.components.map((b, c) => ({ ...b, custom_id: `boss_jouer:${seasonId}:${r * TAILLE + c}:${d.coups}` })),
    }));
    return { embeds: [{ title: titre, description: lignes.join("\n").slice(0, 4096), color: couleur }], components };
  },
  action: ([i, coup]) => ({ case: Number(i), coup: Number(coup) }),
  raisonFin(d) {
    if (d.gagnant === "joueur") return "Tu alignes 4 cartes de la même couleur !";
    if (d.gagnant === "nul") return "Les pioches sont vides.";
    return "Kévina aligne 4 cartes de la même couleur.";
  },
  versV2,
};
