// Simulation d'équilibrage d'Arène sur les vraies règles
// (jeux/services/areneRules.js) : profils hasard ou glouton (Kévina).
// Usage : node jeux/outils/arene/simulateDuel.mjs [parties] [profilJoueur] [profilBot]
// ex. : node jeux/outils/arene/simulateDuel.mjs 20000 hasard glouton
// Le « joueur » commence toujours.
import { creerDuel, poser, scoreGrille, choixGlouton, choixHasard } from "../../services/areneRules.js";

const PARTIES = Number(process.argv[2] || 20000);
const PROFILS = { joueur: process.argv[3] || "glouton", bot: process.argv[4] || "glouton" };
const CHOIX = { hasard: (d, id) => choixHasard(d, id), glouton: choixGlouton };
for (const p of Object.values(PROFILS)) {
  if (!CHOIX[p]) throw new Error(`Profil inconnu : ${p} (hasard, glouton)`);
}

const res = { joueur: 0, bot: 0, nul: 0 };
let coups = 0, scores = 0, ecarts = 0, maxScore = 0;
for (let i = 0; i < PARTIES; i++) {
  const d = creerDuel();
  while (!d.termine) poser(d, d.actif, CHOIX[PROFILS[d.actif]](d, d.actif));
  res[d.gagnant]++;
  coups += d.coups;
  const sj = scoreGrille(d.grilles.joueur), sb = scoreGrille(d.grilles.bot);
  scores += sj + sb;
  ecarts += Math.abs(sj - sb);
  maxScore = Math.max(maxScore, sj, sb);
}

const pct = (n) => `${((100 * n) / PARTIES).toFixed(1)} %`;
console.log(`${PARTIES} parties, joueur (commence) = ${PROFILS.joueur}, bot = ${PROFILS.bot}`);
console.log(`Victoires joueur ${pct(res.joueur)} | bot ${pct(res.bot)} | nuls ${pct(res.nul)}`);
console.log(`Coups par partie ${(coups / PARTIES).toFixed(1)} (soit ~${(coups / PARTIES / 2).toFixed(1)} par joueur)`);
console.log(`Score moyen ${(scores / PARTIES / 2).toFixed(1)} | écart moyen ${(ecarts / PARTIES).toFixed(1)} | record ${maxScore}`);
