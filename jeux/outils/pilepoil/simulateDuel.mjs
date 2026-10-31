// Simulation d'équilibrage de Pile-Poil sur les vraies règles
// (jeux/services/pilepoilRules.js) : profils hasard ou
// kevina[p<profondeur>][e<erreur>][m<marge>] (recherche à <profondeur>
// coups, erreur = probabilité de jouer un coup à <marge> centièmes de point
// du meilleur).
// Usage : node jeux/outils/pilepoil/simulateDuel.mjs [parties] [profilJoueur] [profilBot]
// ex. : node jeux/outils/pilepoil/simulateDuel.mjs 200 kevinap4 kevinap2
// (« bon joueur » contre la Kévina de production). Le « joueur » commence
// toujours. Par défaut : profondeur 2, sans erreur, marge 100.
import { creerDuel, jouer, choisirValeur, choixKevina, choixHasard } from "../../services/pilepoilRules.js";

const PARTIES = Number(process.argv[2] || 200);
const PROFILS = { joueur: process.argv[3] || "kevina", bot: process.argv[4] || "kevina" };

function choix(profil) {
  if (profil === "hasard") return (d) => choixHasard(d);
  const m = /^kevina(?:p(\d+))?(?:e([\d.]+))?(?:m([\d.]+))?$/.exec(profil);
  if (!m) throw new Error(`Profil inconnu : ${profil} (hasard, kevina[p<profondeur>][e<erreur>][m<marge>])`);
  const reglages = { profondeur: Number(m[1] ?? 2), erreur: Number(m[2] ?? 0), marge: Number(m[3] ?? 100) };
  return (d, id) => choixKevina(d, id, reglages);
}
const CHOIX = { joueur: choix(PROFILS.joueur), bot: choix(PROFILS.bot) };

const res = { joueur: 0, bot: 0 };
let coups = 0;
let explosions = 0;
let sautees = 0;
const debut = Date.now();
for (let i = 0; i < PARTIES; i++) {
  const d = creerDuel();
  while (!d.termine) {
    const { v, k } = CHOIX[d.actif](d, d.actif);
    choisirValeur(d, d.actif, v);
    jouer(d, d.actif, k);
    explosions += d.dernier.explosions.length;
    if (d.dernier.type === "sautee") sautees++;
  }
  res[d.gagnant]++;
  coups += d.coups;
}

const pct = (n) => `${((100 * n) / PARTIES).toFixed(1)} %`;
const parPartie = (n) => (n / PARTIES).toFixed(1);
console.log(`${PARTIES} parties, joueur (commence) = ${PROFILS.joueur}, bot = ${PROFILS.bot}`);
console.log(`Victoires joueur ${pct(res.joueur)} | bot ${pct(res.bot)}`);
console.log(`Par partie : ${parPartie(explosions)} explosions, ${parPartie(sautees)} piles sautées faute de coup, ${(coups / PARTIES / 2).toFixed(1)} coups par joueur`);
console.log(`Temps moyen par coup ${((Date.now() - debut) / Math.max(1, coups)).toFixed(1)} ms`);
