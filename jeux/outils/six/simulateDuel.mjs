// Simulation d'équilibrage de Six sur les vraies règles
// (jeux/services/sixRules.js) : profils hasard, simple (bon sens : le moins
// de points perdus) ou kevina[m<marge>].
// Usage : node jeux/outils/six/simulateDuel.mjs [parties] [profilJoueur] [profilBot]
// ex. : node jeux/outils/six/simulateDuel.mjs 4000 kevina kevinam1
// (« bon joueur » contre la Kévina de production). Le « joueur » commence
// toujours. Par défaut : marge 0.
import { creerDuel, jouer, choixKevina, choixSimple, choixHasard } from "../../services/sixRules.js";

const PARTIES = Number(process.argv[2] || 2000);
const PROFILS = { joueur: process.argv[3] || "kevina", bot: process.argv[4] || "kevina" };

function choix(profil) {
  if (profil === "hasard") return (d) => choixHasard(d);
  if (profil === "simple") return (d) => choixSimple(d);
  const m = /^kevina(?:m([\d.]+))?$/.exec(profil);
  if (!m) throw new Error(`Profil inconnu : ${profil} (hasard, simple, kevina[m<marge>])`);
  const reglages = { marge: Number(m[1] ?? 0) };
  return (d, id) => choixKevina(d, id, reglages);
}
const CHOIX = { joueur: choix(PROFILS.joueur), bot: choix(PROFILS.bot) };

const res = { joueur: 0, bot: 0, nul: 0 };
const types = {};
const fins = {};
let coups = 0;
let points = 0;
const debut = Date.now();
for (let i = 0; i < PARTIES; i++) {
  const d = creerDuel();
  while (!d.termine) {
    jouer(d, d.actif, CHOIX[d.actif](d, d.actif));
    types[d.dernier.type] = (types[d.dernier.type] ?? 0) + 1;
  }
  res[d.gagnant]++;
  fins[d.fin] = (fins[d.fin] ?? 0) + 1;
  coups += d.coups;
  points += d.points.joueur + d.points.bot;
}

const pct = (n) => `${((100 * n) / PARTIES).toFixed(1)} %`;
const parPartie = (n) => ((n ?? 0) / PARTIES).toFixed(1);
console.log(`${PARTIES} parties, joueur (commence) = ${PROFILS.joueur}, bot = ${PROFILS.bot}`);
console.log(`Victoires joueur ${pct(res.joueur)} | bot ${pct(res.bot)} | nuls ${pct(res.nul)}`);
console.log(
  `Par partie : ${parPartie(types.sixieme)} ramassages à la 6e carte, ${parPartie(types.libre)} poses libres, ${(points / PARTIES / 2).toFixed(1)} points par joueur`,
);
console.log(`${(coups / PARTIES / 2).toFixed(1)} coups par joueur, ${pct(fins.seuil ?? 0)} des parties finies au seuil de points`);
console.log(`Temps moyen par partie ${((Date.now() - debut) / PARTIES).toFixed(1)} ms`);
