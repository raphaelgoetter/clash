// Simulation d'équilibrage de Bang! (bots heuristiques).
// Usage : node temp/bang/simulateBang.mjs [joueurs] [parties] [actifs] [cle=valeur ...]
import fs from "fs";
import { creerPartie, ajouterJoueur, piocher, placer, jouer, cloturer, vivants, nbBombes, classement } from "../../backend/services/bangRules.js";

const N = Number(process.argv[2] || 15);
const PARTIES = Number(process.argv[3] || 2000);
const ACTIF = Number(process.argv[4] || 0.75);
const config = JSON.parse(fs.readFileSync(new URL("../../data/bang/bang.json", import.meta.url)));
for (const kv of process.argv.slice(5)) {
  const [k, v] = kv.split("=");
  const path = k.split(".");
  let o = config;
  while (path.length > 1) o = o[path.shift()];
  o[path[0]] = Number(v);
}
const rng = Math.random;

function botTour(p, id) {
  const j = p.joueurs[id];
  const adversaires = () => vivants(p).map(([x]) => x).filter((x) => x !== id);
  const cibleAu = () => adversaires()[Math.floor(rng() * adversaires().length)];
  if (j.main.includes("moine") && !j.moine) jouer(p, id, "moine", null, { config, rng });
  let connuBombeEnHaut = null;
  if (j.main.includes("sarbacane") && rng() < 0.7) {
    const r = jouer(p, id, "sarbacane", null, { config, rng });
    connuBombeEnHaut = r.revelation?.[0] === "bombe";
  }
  if (j.main.includes("malediction") && rng() < 0.5 && adversaires().length) jouer(p, id, "malediction", cibleAu(), { config, rng });
  if (j.main.includes("voleuse") && rng() < 0.6 && adversaires().length) jouer(p, id, "voleuse", cibleAu(), { config, rng });
  // Pioche (dette comprise), esquive si bombe repérée au sommet
  const nb = Math.max(j.dette, 1) + (rng() < 0.4 ? 1 : 0);
  for (let k = 0; k < nb && j.vivant && !p.termine; k++) {
    if (connuBombeEnHaut && (j.main.includes("gang") || j.main.includes("fut"))) {
      if (j.main.includes("gang") && adversaires().length) { jouer(p, id, "gang", cibleAu(), { config, rng }); connuBombeEnHaut = false; break; }
      jouer(p, id, "fut", "pioche", { config, rng }); connuBombeEnHaut = false; continue;
    }
    const r = piocher(p, id);
    if (r.erreur) break;
    connuBombeEnHaut = false;
    if (r.bang === "sauve") placer(p, id, rng() < 0.5 ? "1" : "hasard", { rng });
  }
  if (j.vivant && j.main.includes("gang") && rng() < 0.4 && adversaires().length) jouer(p, id, "gang", cibleAu(), { config, rng });
}

const stats = { finAvantJ7: 0, jourFin: [], survivantsJ7: [], elimParJour: Array(config.duree_jours + 1).fill(0), piocheRestante: [], bombesRestantes: [], piocheVide: 0, taillePioche: [] };
for (let g = 0; g < PARTIES; g++) {
  const p = creerPartie();
  const ids = Array.from({ length: N }, (_, i) => `j${i}`);
  // 70 % arrivent J1, le reste J2
  const tard = ids.filter(() => rng() < 0.3);
  for (const id of ids.filter((x) => !tard.includes(x))) ajouterJoueur(p, id, id, { config, rng });
  stats.taillePioche.push(p.pioche.length);
  let jourFin = null;
  for (let jour = 1; jour <= config.duree_jours && !p.termine; jour++) {
    if (jour === 2) for (const id of tard) ajouterJoueur(p, id, id, { config, rng });
    const avant = p.elimines;
    for (const [id] of vivants(p).sort(() => rng() - 0.5)) if (!p.termine && rng() < ACTIF) botTour(p, id);
    if (!p.termine) cloturer(p, { config, rng, dernier: jour === config.duree_jours });
    if (!p.pioche.length) stats.piocheVide++;
    stats.elimParJour[jour] += p.elimines - avant;
    if (p.termine) jourFin = jour;
  }
  if (jourFin) { stats.finAvantJ7++; stats.jourFin.push(jourFin); }
  else stats.survivantsJ7.push(vivants(p).length);
  stats.piocheRestante.push(p.pioche.length);
  stats.bombesRestantes.push(nbBombes(p));
  classement(p);
}
const moy = (a) => (a.length ? (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1) : "-");
console.log(`${N} joueurs, ${PARTIES} parties, ${ACTIF * 100} % actifs/jour`);
console.log(`Pioche initiale (J1) : ${moy(stats.taillePioche)} cartes`);
console.log(`Fin avant J7 (dernier survivant) : ${((stats.finAvantJ7 / PARTIES) * 100).toFixed(0)} % (jour moyen ${moy(stats.jourFin)})`);
console.log(`Survivants au J7 sinon : ${moy(stats.survivantsJ7)}`);
console.log(`Éliminations moyennes par jour : ${stats.elimParJour.slice(1).map((x) => (x / PARTIES).toFixed(1)).join(" / ")}`);
console.log(`Pioche restante en fin : ${moy(stats.piocheRestante)} (vide : ${stats.piocheVide} jours-parties), bombes restantes ${moy(stats.bombesRestantes)}`);
