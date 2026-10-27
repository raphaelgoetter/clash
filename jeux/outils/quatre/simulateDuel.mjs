// Simulation d'équilibrage de Quatre à la suite sur les vraies règles
// (jeux/services/quatreRules.js) : profils hasard ou kevina<profondeur>.
// Usage : node jeux/outils/quatre/simulateDuel.mjs [parties] [profilJoueur] [profilBot]
// ex. : node jeux/outils/quatre/simulateDuel.mjs 2000 kevina2 kevina4
// Le « joueur » commence toujours.
import { creerDuel, poser, choixKevina, choixHasard } from "../../services/quatreRules.js";

const PARTIES = Number(process.argv[2] || 2000);
const PROFILS = { joueur: process.argv[3] || "kevina4", bot: process.argv[4] || "kevina4" };

function choix(profil) {
  if (profil === "hasard") return (d, id) => choixHasard(d, id);
  const m = /^kevina(\d)$/.exec(profil);
  if (!m) throw new Error(`Profil inconnu : ${profil} (hasard, kevina1 à kevina9)`);
  const profondeur = Number(m[1]);
  return (d, id) => choixKevina(d, id, { profondeur });
}
const CHOIX = { joueur: choix(PROFILS.joueur), bot: choix(PROFILS.bot) };

const res = { joueur: 0, bot: 0, nul: 0 };
let coups = 0;
const debut = Date.now();
for (let i = 0; i < PARTIES; i++) {
  const d = creerDuel();
  while (!d.termine) poser(d, d.actif, CHOIX[d.actif](d, d.actif));
  res[d.gagnant]++;
  coups += d.coups;
}

const pct = (n) => `${((100 * n) / PARTIES).toFixed(1)} %`;
console.log(`${PARTIES} parties, joueur (commence) = ${PROFILS.joueur}, bot = ${PROFILS.bot}`);
console.log(`Victoires joueur ${pct(res.joueur)} | bot ${pct(res.bot)} | nuls ${pct(res.nul)}`);
console.log(`Coups par partie ${(coups / PARTIES).toFixed(1)}`);
console.log(`Temps moyen par coup ${((Date.now() - debut) / coups).toFixed(2)} ms`);
