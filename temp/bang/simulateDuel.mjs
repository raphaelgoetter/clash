// Simulation d'équilibrage de Bang! Duel sur les vraies règles
// (backend/services/bangDuelRules.js) : stratège (jouerBot) ou naïf.
// Usage : node temp/bang/simulateDuel.mjs [parties] [profilJoueur] [profilBot] [cle=valeur ...]
// ex. : node temp/bang/simulateDuel.mjs 20000 stratege stratege bombes=3 paquet.gobelin=8
import fs from "fs";
import { creerDuel, piocher, placer, jouer, voler, jouerBot } from "../../backend/services/bangDuelRules.js";

const PARTIES = Number(process.argv[2] || 20000);
const PROFILS = { joueur: process.argv[3] || "stratege", bot: process.argv[4] || "stratege" };
const config = JSON.parse(fs.readFileSync(new URL("../../data/bang/duel.json", import.meta.url)));
for (const kv of process.argv.slice(5)) {
  const [k, v] = kv.split("=");
  const path = k.split(".");
  let o = config;
  while (path.length > 1) o = o[path.shift()];
  o[path[0]] = Number(v);
}
const rng = Math.random;

// Naïf : Voleuse une fois sur deux (carte au hasard), pioche une fois (et
// ses pioches dues), Gang au hasard, Gobelin explosif caché au hasard
function tourNaif(d, id) {
  const j = d.joueurs[id];
  if (j.main.includes("voleuse") && rng() < 0.5) {
    const r = jouer(d, id, "voleuse", { config, rng });
    if (r.choix) voler(d, id, r.choix[Math.floor(rng() * r.choix.length)]);
  }
  if (j.main.includes("gang") && rng() < 0.3 && !jouer(d, id, "gang", { config, rng }).erreur && d.actif !== id) return;
  for (let k = 0; k < 10 && !d.termine && d.actif === id; k++) {
    const r = piocher(d, id, { config });
    if (r.erreur) break;
    if (r.bang === "sauve") placer(d, id, "hasard", { config, rng });
  }
}

const r = { nul: 0, joueur: 0, bot: 0, t5: 0, tours: [] };
for (let g = 0; g < PARTIES; g++) {
  const d = creerDuel(config, { rng });
  while (!d.termine) {
    if (PROFILS[d.actif] === "naif") tourNaif(d, d.actif);
    else jouerBot(d, d.actif, { config, rng });
  }
  if (d.gagnant) r[d.gagnant]++;
  else r.nul++;
  if (!d.gagnant || d.tour >= 5) r.t5++;
  if (d.gagnant) r.tours.push(d.tour);
}
const pc = (x) => `${((x / PARTIES) * 100).toFixed(0)} %`;
const moy = (a) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(1);
const taille = Object.values(config.paquet).reduce((a, b) => a + b, 0) - 2 * config.main_depart + config.esprits_pioche + config.bombes;
console.log(`${PROFILS.joueur} (joueur, commence) contre ${PROFILS.bot} (bot) : ${config.bombes} bombes, pioche de départ ${taille} cartes`);
console.log(`  Victoires joueur ${pc(r.joueur)}, bot ${pc(r.bot)}, nuls ${pc(r.nul)} ; tour 5 atteint ${pc(r.t5)}, tour moyen de fin ${moy(r.tours)}`);
