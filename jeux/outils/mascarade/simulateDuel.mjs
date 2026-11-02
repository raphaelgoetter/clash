// Simulation d'équilibrage de Mascarade sur les vraies règles
// (jeux/services/mascaradeRules.js) : profils hasard, prudent (joue sa carte
// la moins chère, garde la plus chère) ou kevina[m<mondes>][e<erreur>]
// (recherche par mondes possibles, erreur = probabilité d'un coup au hasard).
// Usage : node jeux/outils/mascarade/simulateDuel.mjs [parties] [profilJoueur] [profilBot]
// ex. : node jeux/outils/mascarade/simulateDuel.mjs 200 kevinam40 kevinam40e0.3
// (« bon joueur » contre une Kévina qui se trompe 30 % du temps). Le premier
// joueur de la partie alterne. Statistiques des manches : fins, cartes
// jouées quand tenues.
import { CARTES, choisir, choixAttenteKevina, choixHasard, choixKevina, cout, creerDuel, jouer, cartesJouables } from "../../services/mascaradeRules.js";

const PARTIES = Number(process.argv[2] || 200);
const PROFILS = { joueur: process.argv[3] || "kevina", bot: process.argv[4] || "kevina" };

function profil(nom) {
  if (nom === "hasard") return { coup: (d, id) => choixHasard(d, id), attente: (d) => (d.attente.type === "squelettes" ? "laisser" : 0) };
  if (nom === "prudent") {
    return {
      coup: (d, id) => {
        const cs = cartesJouables(d, id);
        const carte = cs.reduce((a, b) => (cout(b) < cout(a) ? b : a));
        return { carte, cible: carte === "bdf" ? 4 : null };
      },
      attente: (d) => (d.attente.type === "squelettes" ? "laisser" : cout(d.attente.cartes[1]) > cout(d.attente.cartes[0]) ? 1 : 0),
    };
  }
  const m = /^kevina(?:m(\d+))?(?:e([\d.]+))?$/.exec(nom);
  if (!m) throw new Error(`Profil inconnu : ${nom} (hasard, prudent, kevina[m<mondes>][e<erreur>])`);
  const reglages = { mondes: Number(m[1] ?? 40), erreur: Number(m[2] ?? 0) };
  return { coup: (d, id) => choixKevina(d, id, reglages), attente: (d, id) => choixAttenteKevina(d, id, reglages) };
}
const P = { joueur: profil(PROFILS.joueur), bot: profil(PROFILS.bot) };

const res = { joueur: 0, bot: 0 };
const fins = {};
const joue = {};
const tenue = {};
let manches = 0;
const debut = Date.now();
for (let i = 0; i < PARTIES; i++) {
  const d = creerDuel({ commence: i % 2 ? "bot" : "joueur" });
  while (!d.termine) {
    if (d.attente) {
      choisir(d, d.attente.id, P[d.attente.id].attente(d, d.attente.id));
      continue;
    }
    const id = d.actif;
    for (const c of new Set(d.main[id])) tenue[c] = (tenue[c] ?? 0) + 1;
    const c = P[id].coup(d, id);
    joue[c.carte] = (joue[c.carte] ?? 0) + 1;
    const r = jouer(d, id, c.carte, { cible: c.cible });
    if (r.erreur) throw new Error(`Coup refusé : ${r.erreur}`);
  }
  res[d.gagnant]++;
  for (const h of d.historique) fins[h.fin] = (fins[h.fin] ?? 0) + 1;
  manches += d.historique.length;
}

const pct = (n, t = PARTIES) => `${((100 * n) / t).toFixed(1)} %`;
console.log(`${PARTIES} parties (${manches} manches), joueur = ${PROFILS.joueur}, bot = ${PROFILS.bot}`);
console.log(`Victoires joueur ${pct(res.joueur)} | bot ${pct(res.bot)}`);
console.log(`Fins de manche : ${Object.entries(fins).map(([k, v]) => `${k} ${pct(v, manches)}`).join(", ")}`);
console.log(`Jouée quand tenue : ${Object.keys(CARTES).map((c) => `${c} ${tenue[c] ? Math.round((100 * (joue[c] ?? 0)) / tenue[c]) : "-"} %`).join(", ")}`);
console.log(`Temps moyen par partie ${((Date.now() - debut) / PARTIES).toFixed(0)} ms`);
