// Simulation d'équilibrage de Punto sur les vraies règles
// (jeux/services/puntoRules.js) : profils hasard ou kevina[d<defense>][p<prudence>][s<solidite>][m<marge>].
// Usage : node jeux/outils/punto/simulateDuel.mjs [parties] [profilJoueur] [profilBot]
// ex. : node jeux/outils/punto/simulateDuel.mjs 2000 kevinap1s0.5 kevinam10
// (« bon joueur » contre la Kévina de production). Le « joueur » commence
// toujours. Par défaut : defense 1, prudence 0, solidite 0, marge 0.
import { creerDuel, poser, choixKevina, choixHasard } from "../../services/puntoRules.js";

const PARTIES = Number(process.argv[2] || 2000);
const PROFILS = { joueur: process.argv[3] || "kevina", bot: process.argv[4] || "kevina" };

function choix(profil) {
  if (profil === "hasard") return (d, id) => choixHasard(d, id);
  const m = /^kevina(?:d([\d.]+))?(?:p([\d.]+))?(?:s([\d.]+))?(?:m([\d.]+))?$/.exec(profil);
  if (!m) throw new Error(`Profil inconnu : ${profil} (hasard, kevina[d<defense>][p<prudence>][s<solidite>][m<marge>])`);
  const reglages = { defense: Number(m[1] ?? 1), prudence: Number(m[2] ?? 0), solidite: Number(m[3] ?? 0), marge: Number(m[4] ?? 0) };
  return (d, id) => choixKevina(d, id, reglages);
}
const CHOIX = { joueur: choix(PROFILS.joueur), bot: choix(PROFILS.bot) };

const res = { joueur: 0, bot: 0, nul: 0 };
const coups = [];
const debut = Date.now();
for (let i = 0; i < PARTIES; i++) {
  const d = creerDuel();
  while (!d.termine) poser(d, d.actif, CHOIX[d.actif](d, d.actif));
  res[d.gagnant]++;
  coups.push(d.coups / 2);
}

coups.sort((a, b) => a - b);
const total = coups.reduce((a, b) => a + b, 0);
const pct = (n) => `${((100 * n) / PARTIES).toFixed(1)} %`;
console.log(`${PARTIES} parties, joueur (commence) = ${PROFILS.joueur}, bot = ${PROFILS.bot}`);
console.log(`Victoires joueur ${pct(res.joueur)} | bot ${pct(res.bot)} | nuls ${pct(res.nul)}`);
console.log(
  `Coups par joueur : moyenne ${(total / PARTIES).toFixed(1)}, médiane ${coups[PARTIES >> 1]}, 90e centile ${coups[Math.floor(PARTIES * 0.9)]}`,
);
console.log(`Temps moyen par coup ${((Date.now() - debut) / total / 2).toFixed(2)} ms`);
