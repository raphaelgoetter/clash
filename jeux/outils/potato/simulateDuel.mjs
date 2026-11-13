// Simulation d'équilibrage de Potato sur les vraies règles
// (jeux/services/potatoRules.js) : profils hasard, prudent (toujours la plus
// petite chauffe), gourmand (toujours la plus grande), instinct (grande
// chauffe tant que la patate est froide, petite sinon, maximum avec les
// Gants) ou kevina[e<erreur>] (seuils possibles, erreur = probabilité d'une
// chauffe au hasard).
// Usage : node jeux/outils/potato/simulateDuel.mjs [parties] [profilJoueur] [profilBot]
// ex. : node jeux/outils/potato/simulateDuel.mjs 5000 kevina kevinae0.3
// Le premier joueur de la partie alterne.
import { choixKevina, creerDuel, chauffer, etatPatate, evenementDe } from "../../services/potatoRules.js";

const PARTIES = Number(process.argv[2] || 2000);
const PROFILS = { joueur: process.argv[3] || "kevina", bot: process.argv[4] || "kevina" };

function profil(nom) {
  if (nom === "hasard") return () => Math.floor(Math.random() * 3);
  if (nom === "prudent") return () => 0;
  if (nom === "gourmand") return () => 2;
  if (nom === "instinct") {
    return (d, id) => {
      const ev = evenementDe(d, id);
      if (ev?.type === "gants") return 2;
      if (ev?.type === "thermo") return [2, 1, 0].find((k) => d.temp + [5, 10, 15][k] < d.seuil) ?? 0;
      return etatPatate(d) === "froide" ? 2 : 0;
    };
  }
  const m = /^kevina(?:e([\d.]+))?$/.exec(nom);
  if (!m) throw new Error(`Profil inconnu : ${nom} (hasard, prudent, gourmand, instinct, kevina[e<erreur>])`);
  const erreur = Number(m[1] ?? 0);
  return (d, id) => choixKevina(d, id, { erreur });
}
const P = { joueur: profil(PROFILS.joueur), bot: profil(PROFILS.bot) };

const res = { joueur: 0, bot: 0 };
let manches = 0;
let tours = 0;
let belles = 0;
const debut = Date.now();
for (let i = 0; i < PARTIES; i++) {
  const d = creerDuel({ commence: i % 2 ? "bot" : "joueur" });
  while (!d.termine) {
    const r = chauffer(d, d.actif, P[d.actif](d, d.actif));
    if (r.erreur) throw new Error(`Chauffe refusée : ${r.erreur}`);
    tours++;
  }
  res[d.gagnant]++;
  manches += d.historique.length;
  if (d.historique.length === 3) belles++;
}

const pct = (n, t = PARTIES) => `${((100 * n) / t).toFixed(1)} %`;
console.log(`${PARTIES} parties, joueur = ${PROFILS.joueur}, bot = ${PROFILS.bot}`);
console.log(`Victoires joueur ${pct(res.joueur)} | bot ${pct(res.bot)}`);
console.log(`${(tours / manches).toFixed(1)} tours par manche, ${(manches / PARTIES).toFixed(2)} manches par partie, belle ${pct(belles)}`);
console.log(`Temps moyen par partie ${((Date.now() - debut) / PARTIES).toFixed(2)} ms`);
