#!/usr/bin/env node
// simuler.mjs — Difficulté de Pile Poil (jeux/CONTRIBUTING.md, « Pile Poil »).
// Joueur « parfait » : chaque essai est une égalité encore compatible avec
// ses retours (au hasard parmi elles). Stratégies comparées : essais justes
// seulement, puis une ou deux « sondes » fausses au départ (essais libres).
//
// Usage : node jeux/outils/pilepoil/simuler.mjs [parties=2000]

import { toutes, toutesLesEgalites, signeDe, retour, gagne, compatibles, chiffresDe } from "../../services/pilepoilRules.js";

const N = Number(process.argv[2]) || 2000;
const ESSAIS = 6;
const pick = (a) => a[Math.floor(Math.random() * a.length)];

function jouer(solution, sondes) {
  const candidats = toutesLesEgalites(signeDe(solution));
  const essais = [];
  for (let n = 1; n <= ESSAIS; n++) {
    const chiffres = sondes[n - 1] ?? chiffresDe(pick(compatibles(candidats, essais)));
    const r = retour(chiffres, solution);
    if (gagne(r)) return n;
    essais.push({ chiffres, retour: r });
  }
  return null;
}

const STRATEGIES = [
  ["Essais justes seulement", []],
  ["1 sonde (123456)", ["123456"]],
  ["2 sondes (123456, 789012)", ["123456", "789012"]],
];

for (const [nom, sondes] of STRATEGIES) {
  let total = 0;
  let echecs = 0;
  const repartition = {};
  for (let k = 0; k < N; k++) {
    const n = jouer(pick(toutes()), sondes);
    if (n === null) echecs += 1;
    else {
      total += n;
      repartition[n] = (repartition[n] ?? 0) + 1;
    }
  }
  const moyenne = (total / (N - echecs)).toFixed(2);
  console.log(`${nom.padEnd(28)} moyenne ${moyenne} essais · échecs ${((100 * echecs) / N).toFixed(1)} % · ${JSON.stringify(repartition)}`);
}
