// Simulation d'équilibrage de Tourneboule sur les vraies règles
// (jeux/services/tourneboulRules.js) : profils hasard ou
// kevina[p<profondeur>][e<erreur>][m<marge>] (recherche à <profondeur>
// coups, erreur = probabilité de jouer un coup à <marge> pions du meilleur).
// Usage : node jeux/outils/tourneboule/simulateDuel.mjs [parties] [profilJoueur] [profilBot]
// ex. : node jeux/outils/tourneboule/simulateDuel.mjs 200 kevinap4 kevinap3e0.2
// (« bon joueur » contre la Kévina de production). Le « joueur » commence
// toujours. Par défaut : profondeur 3, sans erreur, marge 2.
import { creerDuel, poser, choixKevina, choixHasard } from "../../services/tourneboulRules.js";

const PARTIES = Number(process.argv[2] || 200);
const PROFILS = { joueur: process.argv[3] || "kevina", bot: process.argv[4] || "kevina" };

function choix(profil) {
  if (profil === "hasard") return (d) => choixHasard(d);
  const m = /^kevina(?:p(\d+))?(?:e([\d.]+))?(?:m([\d.]+))?$/.exec(profil);
  if (!m) throw new Error(`Profil inconnu : ${profil} (hasard, kevina[p<profondeur>][e<erreur>][m<marge>])`);
  const reglages = { profondeur: Number(m[1] ?? 3), erreur: Number(m[2] ?? 0), marge: Number(m[3] ?? 2) };
  return (d, id) => choixKevina(d, id, reglages);
}
const CHOIX = { joueur: choix(PROFILS.joueur), bot: choix(PROFILS.bot) };

const res = { joueur: 0, bot: 0, nul: 0 };
const fins = {};
let retournes = 0;
const debut = Date.now();
let coups = 0;
for (let i = 0; i < PARTIES; i++) {
  const d = creerDuel();
  while (!d.termine) {
    poser(d, d.actif, CHOIX[d.actif](d, d.actif));
    retournes += d.dernier.retournes.length;
  }
  res[d.gagnant]++;
  fins[d.fin] = (fins[d.fin] ?? 0) + 1;
  coups += d.coups;
}

const pct = (n) => `${((100 * n) / PARTIES).toFixed(1)} %`;
console.log(`${PARTIES} parties, joueur (commence) = ${PROFILS.joueur}, bot = ${PROFILS.bot}`);
console.log(`Victoires joueur ${pct(res.joueur)} | bot ${pct(res.bot)} | nuls ${pct(res.nul)}`);
console.log(`Par partie : ${(retournes / PARTIES).toFixed(1)} pions retournés ; départages : coins ${fins.coins ?? 0}, dernier retournement ${fins.retournement ?? 0}`);
console.log(`Temps moyen par coup ${((Date.now() - debut) / Math.max(1, coups)).toFixed(1)} ms`);
