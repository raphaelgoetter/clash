// ============================================================
// bossQuatre.js — Quatre à la suite en Boss de fin de saison (boss.js).
// Règles pures (quatreRules.js) ; seul le hasard de Kévina devient commun.
//
// Interface commune des duels du Boss (voir boss.js, BOSS_JEUX) :
// - jeu, nom ;
// - chargerConfig() : config du mode normal (duel.json), réglages de Kévina ;
// - creer({ graine, config }) : état initial, le joueur commence ; tout
//   hasard tiré de rngBossDe(graine, …) ;
// - jouer(etat, action, { graine, config }) : modifie l'état (coup du
//   joueur, puis réponse de Kévina si c'est son tour) et renvoie { erreur }
//   ou { texte, avantKevina, texteKevina } (récit du coup du joueur, état
//   affiché pendant la réflexion de Kévina ou null, récit de Kévina) ;
// - resultat(etat) : "victoire" | "nul" | "defaite" (état terminé) ;
// - score(etat, { inactif }) : victoire ≥ 100, nul de 50 à 99, défaite ou
//   inactivité < 50 ; plus c'est haut, mieux c'est.
// ============================================================

import { HAUTEUR, NB_COLONNES, choixKevina, creerDuel, poser } from "./quatreRules.js";
import { rngBossDe } from "./bossRng.js";
import { loadDuelConfig } from "./quatreDuel.js";

const MAX_COUPS = NB_COLONNES * HAUTEUR;

export const BOSS_QUATRE = {
  jeu: "quatre",
  nom: "Quatre à la suite",
  chargerConfig: loadDuelConfig,
  creer: () => creerDuel({ commence: "joueur" }),
  // `action` : { colonne }.
  jouer(d, { colonne }, { graine, config }) {
    const r = poser(d, "joueur", colonne);
    if (r.erreur) return { erreur: d.termine ? "termine" : "impossible" };
    const texte = `Tu joues en colonne ${colonne + 1}.`;
    if (d.termine) return { texte, avantKevina: null, texteKevina: null };
    const avantKevina = structuredClone(d);
    const c = choixKevina(d, "bot", {
      profondeur: config.profondeur_kevina,
      marge: config.marge_kevina,
      ouverture: config.ouverture_kevina,
      rng: rngBossDe(graine, d.coups),
    });
    poser(d, "bot", c);
    return { texte, avantKevina, texteKevina: `Kévina joue en colonne ${c + 1}.` };
  },
  resultat: (d) => (d.gagnant === "joueur" ? "victoire" : d.gagnant === "nul" ? "nul" : "defaite"),
  // Victoire : plus elle est rapide, mieux c'est (101 à 136) ; nul : 50 ;
  // défaite ou inactivité : plus on a tenu, mieux c'est (coups joués, < 50).
  score(d, { inactif = false } = {}) {
    if (!inactif && d.gagnant === "joueur") return 100 + (MAX_COUPS + 1 - d.coups);
    if (!inactif && d.gagnant === "nul") return 50;
    return Math.min(d.coups, 49);
  },
};
