#!/usr/bin/env node
// Simulateur Monte Carlo de Robinson : rejoue des parties complètes avec les
// fonctions pures de jeux/services/robinson.js (resoudreNuit, météo,
// prévision) et la config réelle (jeux/data/robinson/robinson.json). À
// relancer après tout changement de météo, de rendements, de repas ou de
// planches (cibles : jeux/CONTRIBUTING.md, section Robinson).
//
// Usage : node jeux/outils/robinson-simulation/simuler.mjs [--n 3000] [--v 6,10,15,22]
//   [--fiab 0.75] [--soleil 45] [--planches 2]   (surcharges, la config n'est jamais modifiée)
//
// Modèle (tendance, pas prédiction) :
// - joueurs du jour = moyenne ± 3 (uniforme) ;
// - groupe « organisé » : plan décidé dans le salon avec les joueurs de la
//   veille (repas de la nuit + marge, Radeau au rythme qui le rend prêt à
//   l'échéance, le reste en réserve), les absents tombent au hasard, les
//   joueurs en plus vont à la ressource la moins couverte ; tout le monde
//   embarque dès que le Radeau est prêt. Meilleure politique d'une grille ;
// - « hors plan » : part des joueurs qui choisissent au hasard ;
// - « hasard » : tout le monde choisit au hasard.

import { tirerMeteo, prevoirMeteo, rendement, besoinNuit, planchesRequises, resoudreNuit } from "../../services/robinson.js";
import { readFileSync } from "node:fs";

const config = JSON.parse(readFileSync(new URL("../../data/robinson/robinson.json", import.meta.url), "utf8"));
const argv = process.argv.slice(2);
const opt = (nom, def) => {
  const i = argv.indexOf(nom);
  return i >= 0 ? argv[i + 1] : def;
};
if (opt("--fiab")) config.fiabilite_prevision = Number(opt("--fiab"));
if (opt("--planches")) config.planches_par_joueur = Number(opt("--planches"));
if (opt("--soleil")) config.meteos.soleil.poids = Number(opt("--soleil"));

const N = Number(opt("--n", 3000));
const VS = opt("--v", "6,10,15,22").split(",").map(Number);
const RES = ["poisson", "eau", "bois"];
const ACT = { poisson: "peche", eau: "eau", bois: "bois" };
const ACTIONS = ["peche", "eau", "bois", "radeau"];
const rnd = (n) => Math.floor(Math.random() * n);

function plan(stocks, meteo, Ve, planches, jour, p) {
  const b = besoinNuit(Ve, config);
  const nuitGratuite = jour === 1 && config.nuit1_gratuite;
  const res = { peche: 0, eau: 0, bois: 0, radeau: 0 };
  let libres = Ve;
  const rend = (r) => Math.max(1, rendement(config, meteo, ACT[r]));
  if (!nuitGratuite) {
    for (const m of [0, p.marge]) {
      for (const r of RES) {
        const manque = Math.max(0, Math.ceil(b[r] * (1 + m)) - stocks[r] - res[ACT[r]] * rend(r));
        const n = Math.min(libres, Math.ceil(manque / rend(r)));
        res[ACT[r]] += n;
        libres -= n;
      }
    }
  }
  const cible = Math.max(0, planchesRequises(Ve + p.margePlaces, config) - planches);
  const r = Math.min(libres, Math.ceil((cible / Math.max(1, p.echeance - jour)) * p.rythme));
  res.radeau = r;
  libres -= r;
  while (libres > 0) {
    const x = RES.reduce((a, c) => ((stocks[a] + res[ACT[a]] * rend(a)) / b[a] <= (stocks[c] + res[ACT[c]] * rend(c)) / b[c] ? a : c));
    res[ACT[x]]++;
    libres--;
  }
  return res;
}

function jouer(p, vMoyen) {
  let stocks = { poisson: 0, eau: 0, bois: 0 };
  let planches = 0;
  let vVeille = null;
  let meteo = tirerMeteo(config);
  let meteoSuivante = tirerMeteo(config);
  let nbABord = 0;
  for (let jour = 1; jour <= config.duree_jours; jour++) {
    const prevision = prevoirMeteo(meteoSuivante, config);
    const V = Math.max(3, Math.round(vMoyen + 3 * (Math.random() * 2 - 1)));
    const Ve = vVeille ?? vMoyen;
    let roles = [];
    if (p.mode === "plan") {
      const pl = plan(stocks, meteo, Ve, planches, jour, p);
      // Dernier jour, ou soleil annoncé et Radeau presque prêt : on pose tout
      if (jour === config.duree_jours || (config.meteos[prevision].depart && planches + Ve >= planchesRequises(Ve, config) && p.coup)) {
        roles = Array(Ve).fill("radeau");
      } else {
        for (const k of Object.keys(pl)) for (let i = 0; i < pl[k]; i++) roles.push(k);
      }
      roles.sort(() => Math.random() - 0.5);
    }
    const counts = {};
    for (let i = 0; i < V; i++) {
      let a;
      if (p.mode === "hasard" || Math.random() < (p.bruit ?? 0)) a = ACTIONS[rnd(4)];
      else a = roles[i] ?? ACT[RES.reduce((x, c) => (stocks[x] <= stocks[c] ? x : c))];
      counts[a] = (counts[a] || 0) + 1;
    }
    // Tout le monde embarque dès que le Radeau est prêt (geste gratuit)
    if (planches + (counts.radeau || 0) >= planchesRequises(V, config)) nbABord = Math.max(nbABord, 1);
    const res = resoudreNuit({ jour, stocks, planches, counts, V, vRepas: vVeille ?? 0, nbABord, meteo, meteoAube: meteoSuivante, config });
    if (res.issue) return { issue: res.issue, cause: res.cause, jour: res.issue === "victoire_radeau" ? jour + 1 : jour };
    stocks = res.stocks;
    planches = res.planches;
    meteo = meteoSuivante;
    meteoSuivante = tirerMeteo(config);
    vVeille = V;
  }
  return { issue: "defaite", cause: "pas_de_depart", jour: config.duree_jours };
}

const GRILLE = [];
for (const marge of [0, 0.25, 0.5]) for (const rythme of [0.8, 1, 1.3]) for (const margePlaces of [0, 2, 4]) for (const echeance of [4, 5, 6]) for (const coup of [false, true])
  GRILLE.push({ mode: "plan", marge, rythme, margePlaces, echeance, coup });

function evalue(p, v, n) {
  const c = { victoire: 0, famine: 0, pas_de_depart: 0 };
  const jours = {};
  for (let i = 0; i < n; i++) {
    const r = jouer(p, v);
    if (r.issue === "victoire_radeau") {
      c.victoire++;
      jours[r.jour] = (jours[r.jour] || 0) + 1;
    } else c[r.cause]++;
  }
  return { c, jours };
}

const pct = (x) => `${((100 * x) / N).toFixed(0).padStart(3)} %`;
console.log(`soleil ${config.meteos.soleil.poids}, prévision juste ${config.fiabilite_prevision * 100} %, ${config.planches_par_joueur} planches/joueur`);
for (const v of VS) {
  let best = null;
  for (const p of GRILLE) {
    const r = evalue(p, v, 200);
    if (!best || r.c.victoire > best.r.c.victoire) best = { p, r };
  }
  console.log(`\n=== ${v} joueurs (±3) ===`);
  for (const [nom, p] of [
    ["organisé, plan parfait", best.p],
    ["organisé, 15 % hors plan", { ...best.p, bruit: 0.15 }],
    ["organisé, 30 % hors plan", { ...best.p, bruit: 0.3 }],
    ["hasard", { mode: "hasard" }],
  ]) {
    const { c, jours } = evalue(p, v, N);
    const j = Object.entries(jours).map(([k, n]) => `J${k} ${pct(n).trim()}`).join(" ");
    console.log(`${nom.padEnd(26)} victoire ${pct(c.victoire)} | famine ${pct(c.famine)} | pas de départ ${pct(c.pas_de_depart)}${j ? ` | départs ${j}` : ""}`);
  }
}
