// ============================================================
// bossPunto.js — Punto en Boss de fin de saison (boss.js), interface
// décrite dans bossQuatre.js. Règles pures (puntoRules.js) ; tout le
// hasard devient commun :
// - les deux pioches, mélangées une fois pour toutes à la création
//   (`rngBossDe(graine, "creation")`) : chaque qualifié retourne les mêmes
//   cartes dans le même ordre, Kévina aussi (les pioches sont ensuite
//   dépilées sans hasard, défausses comprises) ;
// - le choix de Kévina parmi ses cases presque égales (`marge_kevina`) :
//   `rngBossDe(graine, "kevina:<coups>")`, `coups` = cartes posées avant
//   le sien (unique par coup de Kévina).
// Kévina est renforcée (`boss` de duel.json, par-dessus les réglages du
// mode normal) : anticipation de la prochaine carte du joueur et de la
// sienne (voir choixKevina(), puntoRules.js).
// ============================================================

import { ALIGNEMENT, TAILLE, choixKevina, creerDuel, poser } from "./puntoRules.js";
import { formatCarte } from "./puntoCartes.js";
import { rngBossDe } from "./bossRng.js";
import { loadDuelConfig } from "./puntoDuel.js";

// Cartes posables au plus (2 pioches de 36)
const MAX_COUPS = 72;

// Couleurs affichées, comme la vue du duel (handler puntoDuel.js) : les
// siennes froides, celles de Kévina chaudes
const COULEURS = { joueur: ["bleu", "vert"], bot: ["rouge", "orange"] };
const carteTexte = (carte, s) => formatCarte(COULEURS[s][carte.k], carte.v);

// Défausses qui ont suivi le dernier coup (même phrasé que recit() du
// handler puntoDuel.js, vu par le joueur) ; le coup n'est pas raconté, la
// dernière carte posée a un contour jaune sur le plateau
function recit(d) {
  const lignes = [];
  for (const { id, carte } of d.defausses ?? []) {
    lignes.push(`${id === "joueur" ? "Ta tuile" : "La tuile de Kévina"} ${carteTexte(carte, id)} ne peut être posée nulle part : défaussée.`);
  }
  return lignes.join("\n") || null;
}

// Fenêtres de 4 cases alignées (horizontale, verticale, diagonales)
const FENETRES = [];
for (let r = 0; r < TAILLE; r++) {
  for (let c = 0; c < TAILLE; c++) {
    for (const [dr, dc] of [[0, 1], [1, 0], [1, 1], [1, -1]]) {
      const rf = r + (ALIGNEMENT - 1) * dr;
      const cf = c + (ALIGNEMENT - 1) * dc;
      if (rf < 0 || cf < 0 || rf >= TAILLE || cf >= TAILLE) continue;
      FENETRES.push(Array.from({ length: ALIGNEMENT }, (_, k) => (r + k * dr) * TAILLE + c + k * dc));
    }
  }
}

// Meilleure ligne du joueur encore ouverte : plus grand nombre de ses
// cartes d'une même couleur dans une fenêtre de 4 sans carte étrangère
// (0 à 3 en cours de partie, 4 = alignement)
function meilleureLigne(grille) {
  let max = 0;
  for (const fenetre of FENETRES) {
    let k = null;
    let n = 0;
    for (const i of fenetre) {
      const x = grille[i];
      if (!x) continue;
      if (x.s !== "joueur" || (k !== null && x.k !== k)) {
        n = 0;
        break;
      }
      k = x.k;
      n++;
    }
    max = Math.max(max, n);
  }
  return max;
}

const casesDuJoueur = (grille) => grille.filter((x) => x?.s === "joueur").length;

export const BOSS_PUNTO = {
  jeu: "punto",
  nom: "Punto",
  chargerConfig: loadDuelConfig,
  creer: ({ graine }) => creerDuel({ commence: "joueur", rng: rngBossDe(graine, "creation") }),
  // `action` : { case, coup } (coup = d.coups affiché : un clic sur une vue
  // dépassée est refusé). Un seul appel par tour : poser sa carte.
  jouer(d, { case: i, coup }, { graine, config }) {
    if (d.termine) return { erreur: "termine", message: "La partie est terminée." };
    if (coup !== undefined && coup !== d.coups) return { erreur: "perime", message: "Le plateau a changé depuis : rejoue sur celui-ci." };
    const r = poser(d, "joueur", i);
    if (r.erreur) return { erreur: "interdite", message: "Ta tuile ne peut pas aller sur cette case." };
    const texte = recit(d);
    let avantKevina = null;
    const lignes = [];
    // Kévina joue tant que c'est son tour (plusieurs fois si la carte du
    // joueur est défaussée)
    while (!d.termine && d.actif === "bot") {
      avantKevina ??= structuredClone(d);
      const reglages = { ...config, ...config.boss };
      const c = choixKevina(d, "bot", {
        defense: reglages.defense_kevina,
        prudence: reglages.prudence_kevina,
        solidite: reglages.solidite_kevina,
        marge: reglages.marge_kevina,
        anticipation: reglages.anticipation_kevina ?? 0,
        rng: rngBossDe(graine, `kevina:${d.coups}`),
      });
      poser(d, "bot", c);
      lignes.push(recit(d));
    }
    return { texte, avantKevina, texteKevina: lignes.filter(Boolean).join("\n") || null };
  },
  resultat: (d) => (d.gagnant === "joueur" ? "victoire" : d.gagnant === "nul" ? "nul" : "defaite"),
  // Score (plus haut = mieux) :
  // - victoire : 100 + cartes posées en moins (MAX_COUPS − coups), donc
  //   plus elle est rapide, mieux c'est (101 à 165) ;
  // - nul (pioches vides) : 50 + cases de la grille finale tenues par le
  //   joueur (50 à 75) ;
  // - défaite ou inactivité : avoir tenu (coups / 2, jusqu'à 36) et être
  //   passé près (3 × sa meilleure ligne ouverte, 0 à 9), plafonné à 49.
  score(d, { inactif = false } = {}) {
    if (!inactif && d.gagnant === "joueur") return 100 + (MAX_COUPS - d.coups);
    if (!inactif && d.gagnant === "nul") return 50 + casesDuJoueur(d.grille);
    return Math.min(Math.floor(d.coups / 2) + 3 * Math.min(meilleureLigne(d.grille), 3), 49);
  },
};
