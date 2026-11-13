// ============================================================
// bossFrise.js — Frise en Boss de fin de saison (boss.js). Règles pures
// (friseRules.js) ; tout le hasard devient commun (interface décrite dans
// bossQuatre.js) :
// - paquet mélangé, frise de départ, mains et pioche : rngBossDe(graine,
//   "creation") ;
// - coup de Kévina (erreur ou non, créneau voisin visé) :
//   rngBossDe(graine, `kevina:${d.vue}`), `d.vue` comptant les cartes déjà
//   placées (+1 par pose) : deux joueurs aux mêmes actions ont la même suite.
// La pioche de pénalité est déterministe (haut de la pioche). Kévina garde
// les réglages du mode normal (duel.json : erreur_kevina, echelle_kevina).
//
// Tour du joueur en deux actions : { type: "carte", index, vue } (carte de
// sa main, sans réponse de Kévina) puis { type: "placer", creneau, vue }
// (pose, puis tour de Kévina). `vue` : d.vue affiché, une vue dépassée est
// refusée (« perime »).
// ============================================================

import { choisir, choixKevina, creerDuel, placer } from "./friseRules.js";
import { rngBossDe } from "./bossRng.js";
import { loadDuelConfig } from "./friseDuel.js";

const ERREURS = {
  termine: "La partie est terminée.",
  pasTonTour: "Ce n'est pas ton tour.",
  carte: "Cette carte n'est plus dans ta main.",
  creneau: "Créneau invalide.",
  perime: "La frise a changé depuis : rejoue sur celle-ci.",
  action: "Action inconnue.",
};

const erreur = (code) => ({ erreur: code, message: ERREURS[code] ?? "Coup impossible." });

const formatAnnee = (a) => (a < 0 ? `${-a} av. J.-C.` : String(a));

// Récit du dernier coup (point final jamais doublé après « av. J.-C. »).
function recit(d) {
  const x = d.dernier;
  const toi = x.id === "joueur";
  const qui = toi ? "Tu places" : "Kévina place";
  const annee = formatAnnee(x.carte.annee);
  const point = (t) => (t.endsWith(".") ? t : `${t}.`);
  if (x.juste) return point(`${qui} « ${x.carte.libelle} » : ✅ ${annee}`);
  const penalite = x.pioche ? (toi ? ", tu pioches une carte" : ", et pioche une carte") : "";
  return point(`${qui} « ${x.carte.libelle} » : ❌ c'était ${annee}${penalite}`);
}

const erreursDe = (d, siege) => (d.erreurs ?? []).filter((e) => e.id === siege).length;
// Cartes du joueur restées sur la frise (bien placées)
const justesDe = (d, siege) => d.frise.filter((c) => c.par === siege).length - erreursDe(d, siege);

export const BOSS_FRISE = {
  jeu: "frise",
  nom: "Frise",
  chargerConfig: loadDuelConfig,
  creer: ({ graine, config }) =>
    creerDuel(config.cartes, {
      commence: "joueur",
      tailleMain: config.taille_main,
      ecartMin: config.ecart_min_annees,
      rng: rngBossDe(graine, "creation"),
    }),
  jouer(d, action, { graine, config }) {
    if (d.termine) return erreur("termine");
    if (d.actif !== "joueur") return erreur("pasTonTour");
    if (action?.vue !== d.vue) return erreur("perime");
    if (action.type === "carte") {
      const r = choisir(d, "joueur", action.index);
      if (r.erreur) return erreur(r.erreur);
      return { texte: null, avantKevina: null, texteKevina: null };
    }
    if (action.type !== "placer") return erreur("action");
    const r = placer(d, "joueur", action.creneau);
    if (r.erreur) return erreur(r.erreur);
    const texte = recit(d);
    if (d.termine || d.actif === "joueur") return { texte, avantKevina: null, texteKevina: null };
    const avantKevina = structuredClone(d);
    // Kévina joue jusqu'à ce que ce soit de nouveau au joueur (un seul coup
    // avec les règles actuelles) ou la fin de partie
    const recits = [];
    while (!d.termine && d.actif === "bot") {
      const k = choixKevina(d, "bot", {
        erreur: config.erreur_kevina,
        echelle: config.echelle_kevina,
        rng: rngBossDe(graine, `kevina:${d.vue}`),
      });
      choisir(d, "bot", k.index);
      placer(d, "bot", k.creneau);
      recits.push(recit(d));
    }
    return { texte, avantKevina, texteKevina: recits.join("\n") };
  },
  resultat: (d) => (d.gagnant === "joueur" ? "victoire" : d.gagnant === "nul" ? "nul" : "defaite"),
  // Score (plus haut = mieux) :
  // - victoire, 100 à 199 : 100 + 10 × (9 − erreurs du joueur, plancher 0)
  //   + cartes restées dans la main de Kévina (9 au plus) ; d'abord le
  //   moins d'erreurs, puis la plus large avance ;
  // - nul, 50 à 99 : 99 − erreurs du joueur (49 au plus) ;
  // - défaite ou inactivité, 0 à 49 : 45 − 5 × (cartes en main du joueur
  //   − 1, 9 au plus) + cartes bien placées par le joueur (4 au plus) ;
  //   d'abord le plus près d'avoir vidé sa main, puis la frise la mieux
  //   remplie (une inactivité dès le départ : 4 cartes, 0 posée = 30).
  score(d, { inactif = false } = {}) {
    const erreurs = erreursDe(d, "joueur");
    if (!inactif && d.termine && d.gagnant === "joueur") {
      return 100 + 10 * Math.max(0, 9 - erreurs) + Math.min(d.mains.bot.length, 9);
    }
    if (!inactif && d.termine && d.gagnant === "nul") return 99 - Math.min(erreurs, 49);
    const main = Math.min(Math.max(d.mains.joueur.length - 1, 0), 9);
    return 45 - 5 * main + Math.min(Math.max(justesDe(d, "joueur"), 0), 4);
  },
};
