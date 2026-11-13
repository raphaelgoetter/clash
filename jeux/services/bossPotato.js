// ============================================================
// bossPotato.js — Potato en Boss de fin de saison (boss.js). Règles pures
// (potatoRules.js) ; tout le hasard devient commun (interface décrite dans
// bossQuatre.js).
//
// Donne commune : chaque source de hasard tire d'une étape distincte de
// rngBossDe(graine, …) :
// - `manche:<m>` : température d'explosion de la manche m (ne dépend que de
//   la graine et du numéro de manche, voir `rng.manche` dans potatoRules.js) ;
// - `evenement:<m>:<vue>` : événements (et fourchette du Thermomètre) tirés
//   par la chauffe jouée sur la vue <vue> (`d.vue`, +1 à chaque chauffe,
//   jamais remis à zéro) de la manche m ; `evenement:1:0` à la création ;
// - `kevina:<m>:<vue>` : choix de Kévina (erreurs et égalités comprises).
// Deux joueurs qui font les mêmes chauffes obtiennent donc les mêmes états.
//
// Une action = une chauffe ({ k, vue }) : les événements s'appliquent seuls,
// le joueur n'a rien d'autre à faire. Retour à l'envoyeur : il rejoue, sans
// tour de Kévina (`avantKevina` null). Sinon Kévina joue tout son tour (et
// les suivants, nouvelle manche comprise) jusqu'à ce que la patate revienne
// au joueur ou que la partie finisse. Pas de délai par action : le Boss a
// sa propre inactivité (1 h).
// ============================================================

import { GLACON, chauffer, choixKevina, creerDuel } from "./potatoRules.js";
import { rngBossDe } from "./bossRng.js";
import { loadDuelConfig } from "./potatoDuel.js";

// Générateur d'une étape, avec le générateur propre au seuil de chaque manche
function rngEtape(graine, etape) {
  const rng = rngBossDe(graine, etape);
  rng.manche = (m) => rngBossDe(graine, `manche:${m}`);
  return rng;
}

// Récits (mêmes phrases que le duel, handlers/potatoDuel.js) : `S` sujet,
// `toi` deuxième personne ; seconde chauffe du Piment chez l'autre.
function phraseAction(x, S, toi) {
  const v = (tu, il) => (toi ? tu : il);
  const chez = toi ? "de son tour" : "de ton tour";
  const c = `+${x.chauffe} °C`;
  const ev = x.evenement?.type;
  if (x.gants) return `🧤 ${S} ${v("enfiles", "enfile")} les gants : la patate ${v("t'aurait", "lui aurait")} explosé dans les mains, elle passe brûlante (${c})`;
  if (ev === "glacon") return `🧊 ${S} ${v("reçois", "reçoit")} un glaçon (−${GLACON} °C), puis ${v("chauffes", "chauffe")} de ${c}`;
  if (ev === "thermo") return `🌡️ ${S} ${v("lis", "lit")} le thermomètre, puis ${v("chauffes", "chauffe")} de ${c}`;
  if (ev === "piment") return `🌶️ ${S} ${v("pimentes", "pimente")} la patate : ${c} maintenant, encore ${c} au début ${chez}`;
  if (ev === "gants") return `🧤 ${S} ${v("chauffes", "chauffe")} de ${c} avec les gants`;
  if (ev === "retour") return `🔁 ${S} ${v("chauffes", "chauffe")} de ${c}, et la patate ${v("te", "lui")} revient`;
  if (ev === "courant") return `🌬️ ${S} ${v("chauffes", "chauffe")} de ${c} dans un courant d'air`;
  if (ev === "impose") return `🎯 Chauffe imposée : ${toi ? "tu" : S} ${v("chauffes", "chauffe")} de ${c}`;
  return `${S} ${v("chauffes", "chauffe")} la patate de ${c}`;
}

const recit = (d) => `${d.dernier.id === "joueur" ? phraseAction(d.dernier, "Tu", true) : phraseAction(d.dernier, "Kévina", false)}.`;

// « 💥 La patate t'explose dans les mains à 115 °C : manche 2 pour Kévina »
function ligneManche(h, numero) {
  const temp = h.temp > h.seuil ? `à ${h.temp} °C (elle explosait dès ${h.seuil} °C)` : `à ${h.temp} °C`;
  const ou = h.perdant === "bot" ? `explose dans les mains de Kévina ${temp}` : `t'explose dans les mains ${temp}`;
  const sujet = h.renvoi ? "Renvoyée brûlante, la patate" : h.piment ? "Pimentée, la patate" : "La patate";
  return `💥 ${sujet} ${ou} : manche ${numero} pour ${h.gagnant === "bot" ? "Kévina" : "toi"}`;
}

// Lignes des manches closes depuis `avant` (nombre de manches jouées), puis
// annonce de la manche suivante si la partie continue.
function lignesManches(d, avant) {
  const lignes = d.historique.slice(avant).map((h, i) => ligneManche(h, avant + i + 1));
  if (lignes.length && !d.termine) lignes.push(`Manche ${d.numero} : ${d.actif === "joueur" ? "tu commences" : "Kévina commence"}.`);
  return lignes;
}

const MESSAGES = {
  termine: "La partie est terminée.",
  pasTonTour: "Ce n'est pas ton tour.",
  choix: "Choix impossible.",
  perime: "La patate a changé depuis : rejoue sur cette vue.",
  impose: "Chauffe imposée : +10 °C seulement.",
};

const erreur = (code) => ({ erreur: code, message: MESSAGES[code] ?? "Action impossible." });

export const BOSS_POTATO = {
  jeu: "potato",
  nom: "Potato",
  chargerConfig: loadDuelConfig,
  creer: ({ graine }) => {
    const d = creerDuel({ commence: "joueur", rng: rngEtape(graine, "evenement:1:0") });
    d.coupsJoueur = 0;
    return d;
  },
  // `action` : { k (chauffe n° 0, 1, 2), vue (d.vue affiché) }.
  jouer(d, { k, vue }, { graine, config }) {
    if (d.termine) return erreur("termine");
    if (vue !== d.vue) return erreur("perime");
    const avant = d.historique.length;
    const r = chauffer(d, "joueur", k, { rng: rngEtape(graine, `evenement:${d.numero}:${d.vue}`) });
    if (r.erreur) return erreur(r.erreur);
    d.coupsJoueur = (d.coupsJoueur ?? 0) + 1;
    const texte = [recit(d), ...lignesManches(d, avant)].join("\n");
    if (d.termine || d.actif === "joueur") return { texte, avantKevina: null, texteKevina: null };
    const avantKevina = structuredClone(d);
    const lignes = [];
    for (let n = 0; n < 50 && !d.termine && d.actif === "bot"; n++) {
      const h = d.historique.length;
      const etape = `${d.numero}:${d.vue}`;
      const c = choixKevina(d, "bot", { erreur: config.erreur_kevina, rng: rngBossDe(graine, `kevina:${etape}`) });
      chauffer(d, "bot", c, { rng: rngEtape(graine, `evenement:${etape}`) });
      lignes.push(recit(d), ...lignesManches(d, h));
    }
    return { texte, avantKevina, texteKevina: lignes.join("\n") };
  },
  resultat: (d) => (d.gagnant === "joueur" ? "victoire" : "defaite"),
  // Pas de nul possible (premier à 2 manches).
  // Victoire : 2-0 (120 à 139) > 2-1 (100 à 119) ; à manches égales, la
  // victoire la plus rapide (moins de chauffes du joueur, bonus 19 − coups).
  // Défaite ou inactivité : 25 par manche gagnée (1-2 : 25 à 49 > 0-2 : 0
  // à 24), puis plus on a tenu, mieux c'est (chauffes du joueur, ≤ 24).
  score(d, { inactif = false } = {}) {
    const coups = d.coupsJoueur ?? 0;
    const { joueur, bot } = d.manches;
    if (!inactif && d.termine && d.gagnant === "joueur") return 100 + (bot === 0 ? 20 : 0) + Math.max(0, 19 - coups);
    return Math.min(25 * Math.min(joueur, 1) + Math.min(coups, 24), 49);
  },
};
