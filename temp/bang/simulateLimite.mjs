// Effet d'un plafond de cartes jouées par jour (bots qui jouent tout ce
// qu'ils peuvent, jusqu'au plafond). Usage : node temp/bang/simulateLimite.mjs [joueurs] [parties] [plafond]
import fs from "fs";
import { creerPartie, ajouterJoueur, piocherClic, placer, jouer, cloturer, vivants } from "../../backend/services/bangRules.js";

const N = Number(process.argv[2] || 15);
const PARTIES = Number(process.argv[3] || 2000);
const PLAFOND = Number(process.argv[4] || Infinity);
const config = JSON.parse(fs.readFileSync(new URL("../../data/bang/bang.json", import.meta.url)));
const rng = Math.random;
const ORDRE = ["moine", "sarbacane", "malediction", "voleuse", "gang", "fut"];

let joueesParTour = [], mainFin = [], survivants = [], finAvant = 0, maxJouees = 0, attaquesSurUnMeme = 0;
function botTour(p, id) {
  const j = p.joueurs[id];
  let jouees = 0;
  const adv = () => vivants(p).map(([x]) => x).filter((x) => x !== id);
  // Cible privilégiée du jour (acharnement) : la même pour toutes les attaques
  const cible = adv()[Math.floor(rng() * adv().length)];
  let surCible = 0;
  for (const c of ORDRE) {
    while (j.main.includes(c) && jouees < PLAFOND && j.vivant && !p.termine && adv().length) {
      if (c === "moine" && j.moine) break;
      const t = c === "fut" ? "pioche" : ["sarbacane", "moine"].includes(c) ? null : p.joueurs[cible]?.vivant ? cible : adv()[0];
      const r = jouer(p, id, c, t, { config, rng });
      if (r.erreur) break;
      jouees++;
      if (t === cible) surCible++;
    }
  }
  attaquesSurUnMeme = Math.max(attaquesSurUnMeme, surCible);
  joueesParTour.push(jouees);
  maxJouees = Math.max(maxJouees, jouees);
  const nb = 1 + (rng() < 0.4 ? 1 : 0);
  for (let k = 0; k < nb && j.vivant && !p.termine; k++) {
    const r = piocherClic(p, id, { config });
    if (r.erreur) break;
    if (j.enAttente) placer(p, id, "hasard", { rng });
  }
}
for (let g = 0; g < PARTIES; g++) {
  const p = creerPartie();
  for (let i = 0; i < N; i++) ajouterJoueur(p, `j${i}`, `j${i}`, { config, rng });
  for (let jour = 1; jour <= config.duree_jours && !p.termine; jour++) {
    for (const [id] of vivants(p)) if (!p.termine && rng() < 0.75) botTour(p, id);
    if (!p.termine) cloturer(p, { config, rng });
  }
  if (p.termine) finAvant++;
  else survivants.push(vivants(p).length);
  for (const [, j] of vivants(p)) mainFin.push(j.main.filter((c) => ORDRE.includes(c)).length);
}
const moy = (a) => (a.reduce((x, y) => x + y, 0) / Math.max(1, a.length)).toFixed(2);
const pct = (k) => ((joueesParTour.filter((x) => x >= k).length / joueesParTour.length) * 100).toFixed(0);
console.log(`plafond ${PLAFOND} : cartes jouées/tour ${moy(joueesParTour)} (≥3 : ${pct(3)} %, ≥4 : ${pct(4)} %, max ${maxJouees}, max d'attaques sur un même joueur ${attaquesSurUnMeme}) · survivants J7 ${moy(survivants)} · fin avant J7 ${((finAvant / PARTIES) * 100).toFixed(0)} % · cartes d'action en main en fin ${moy(mainFin)}`);
