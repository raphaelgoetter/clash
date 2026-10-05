// Simulation d'équilibrage du Draft (carré de 4 cartes identiques) : nombre de
// carrés par partie, carrés simultanés, part des cartes disputées perdues.
// Joueurs gloutons (choixGlouton), cartes en jeu = ⌈5N / 4⌉ à 4 exemplaires.
// Usage : node temp/simulateDraft.mjs
import fs from "fs";
import { distribuer, computeTour, choixGlouton, choisirFamilles, nbFamilles, classement } from "../backend/services/draftRules.js";

const config = JSON.parse(fs.readFileSync("data/draftroyale/draftroyale.json", "utf8"));
const catalog = new Map([...config.cartes, ...Array.from({ length: 20 }, (_, i) => `x${i}`)].map((k) => [k, {}]));

function partie(P, tours, participation) {
  const familles = choisirFamilles(nbFamilles(P, config), config, catalog);
  const ids = Array.from({ length: P }, (_, i) => `p${i}`);
  const d = distribuer({ familles, joueurIds: ids, config });
  let joueurs = Object.fromEntries(ids.map((id, i) => [id, { main: d.mains[id], popularite: 0, points: 0, carres: 0, arrivee: i }]));
  let { marche, reserve } = d;
  let decomptes = 0, multi = 0, perdues = 0, echanges = 0;
  for (let t = 1; t <= tours; t++) {
    const actions = {};
    for (const id of ids) if (Math.random() < participation) actions[id] = choixGlouton(joueurs[id].main, marche);
    const r = computeTour({ joueursAvant: joueurs, actions, marche, reserve, familles, config, dernier: t === tours });
    ({ joueurs, marche, reserve } = r);
    echanges += r.lignes.length;
    perdues += r.lignes.filter((l) => l.type === "perdue").length;
    if (r.carres.length) decomptes++;
    if (r.carres.length > 1) multi++;
  }
  const c = classement(joueurs);
  return { decomptes, multi: decomptes ? multi / decomptes : 0, perdues: perdues / Math.max(1, echanges), top: c[0].score };
}

for (const [P, part] of [[3, 1], [8, 0.7], [15, 0.7], [20, 0.7]]) {
  const N = 1000;
  const acc = { decomptes: 0, multi: 0, perdues: 0, top: 0 };
  for (let i = 0; i < N; i++) {
    const r = partie(P, 7, part);
    for (const k in acc) acc[k] += r[k] / N;
  }
  console.log(`P=${P} participation ${part} (${nbFamilles(P, config)} cartes, marché ${P}) : ${acc.decomptes.toFixed(2)} tours à carré, ${Math.round(acc.multi * 100)}% à plusieurs carrés, ${Math.round(acc.perdues * 100)}% d'échanges perdus, vainqueur ${acc.top.toFixed(1)} pts`);
}
