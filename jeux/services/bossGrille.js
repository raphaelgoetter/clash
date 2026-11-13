// ============================================================
// bossGrille.js — La Grille en Boss de fin de saison (boss.js), interface
// commune décrite dans bossQuatre.js. Règles pures (grilleRules.js).
//
// Donne commune : le seul hasard de La Grille est le lancer de dé (Kévina
// joue en glouton, déterministe). Le n-ième dé lancé de la partie vient de
// rngBossDe(graine, "de:n") : n = 0 pour le premier dé (creer), puis n =
// nombre de coups joués après la pose qui déclenche le lancer. Les dés ne
// dépendent donc pas des coups : tous les qualifiés reçoivent la même
// suite (dés pairs pour le joueur, impairs pour Kévina).
// ============================================================

import { HAUTEUR, choixGlouton, creerDuel, poser, scoreGrille } from "./grilleRules.js";
import { formatDie } from "./dices.js";
import { rngBossDe } from "./bossRng.js";
import { loadDuelConfig } from "./grilleDuel.js";

// Dé n de la partie (voir l'en-tête)
const rngDe = (graine, n) => rngBossDe(graine, `de:${n}`);

const LIEUX = ["à gauche", "au centre", "à droite"];

const ERREURS = {
  termine: "La partie est terminée.",
  pleine: "Cette colonne est pleine.",
  impossible: "Coup impossible.",
};

const ecart = (d) => scoreGrille(d.grilles.joueur) - scoreGrille(d.grilles.bot);

export const BOSS_GRILLE = {
  jeu: "grille",
  nom: "La Grille",
  chargerConfig: loadDuelConfig,
  creer: ({ graine }) => creerDuel({ commence: "joueur", rng: rngDe(graine, 0) }),
  // `action` : { colonne } (0 gauche, 1 centre, 2 droite).
  jouer(d, { colonne }, { graine }) {
    if (d.termine) return { erreur: "termine", message: ERREURS.termine };
    // Le lancer suivant la pose porte le numéro du coup (d.coups + 1)
    const r = poser(d, "joueur", colonne, { rng: rngDe(graine, d.coups + 1) });
    if (r.erreur) {
      const code = d.grilles.joueur[colonne]?.length >= HAUTEUR ? "pleine" : "impossible";
      return { erreur: code, message: ERREURS[code] };
    }
    const detruitsKevina = r.desDetruits
      ? ` et détruis ${r.desDetruits > 1 ? `${r.desDetruits} dés` : "un dé"} de Kévina !`
      : ".";
    const texte = `Tu poses ${formatDie(r.valeur, "bleu")} ${LIEUX[r.colonne]}${detruitsKevina}`;
    if (d.termine) return { texte, avantKevina: null, texteKevina: null };

    // Tour de Kévina (son dé est déjà lancé) : choix glouton du mode normal
    const avantKevina = structuredClone(d);
    const k = poser(d, "bot", choixGlouton(d, "bot"), { rng: rngDe(graine, d.coups + 1) });
    const detruitsJoueur = k.desDetruits
      ? ` et détruit ${k.desDetruits > 1 ? `${k.desDetruits} de tes dés` : "un de tes dés"} !`
      : ".";
    const texteKevina = `Kévina pose ${formatDie(k.valeur, "rouge")} ${LIEUX[k.colonne]}${detruitsJoueur}`;
    return { texte, avantKevina, texteKevina };
  },
  resultat: (d) => (d.gagnant === "joueur" ? "victoire" : d.gagnant === "nul" ? "nul" : "defaite"),
  // Score (plus haut = mieux) :
  // - victoire : 100 + écart de points (101 et plus), large victoire en tête ;
  // - nul : 50 + total commun / 4 (50 à 99) : un nul à gros score (combos)
  //   passe devant un nul serré à petit score ;
  // - défaite : 25 à 49, défaite serrée en tête (49 - (écart - 1) / 3,
  //   plancher 25 dès 73 points d'écart) ;
  // - inactivité : 0 à 24, nombre de coups joués (toujours sous une défaite
  //   jouée jusqu'au bout : abandonner en tête ne rapporte rien).
  score(d, { inactif = false } = {}) {
    if (inactif || !d.termine) return Math.min(d.coups, 24);
    const e = ecart(d);
    if (d.gagnant === "joueur") return 100 + e;
    if (d.gagnant === "nul") return 50 + Math.min(49, Math.floor(scoreGrille(d.grilles.joueur) / 4));
    return 49 - Math.min(24, Math.floor((-e - 1) / 3));
  },
};
