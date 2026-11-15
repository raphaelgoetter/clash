#!/usr/bin/env node
// Simulateur Monte Carlo de Robinson : rejoue des parties complètes avec les
// fonctions pures de jeux/services/robinson.js et la config réelle
// (jeux/data/robinson/robinson.json), pour plusieurs profils de groupe et
// plusieurs mobilisations moyennes. À relancer après tout changement de
// barème, de stocks, de coûts, d'épuisement ou d'événements (voir la section
// Robinson de jeux/CONTRIBUTING.md pour les cibles de calibrage).
//
// Usage : node jeux/outils/robinson-simulation/simuler.mjs [--n 8000] [--v 6,10,14,18,22]
//   Surcharges de calibrage (la config n'est jamais modifiée) :
//   [--appauvrissement 0,0,1,1,2,2,2] [--points-section 6] [--stocks 14,14,10]
//
// Modèle (volontairement simple, à lire comme une tendance) :
// - V par jour = V moyen ± 3 (uniforme) ; les votants jouent l'un après
//   l'autre en voyant les stocks en direct ;
// - Chefs présents 70 % du temps ;
// - « glouton » : récolte la ressource la plus en retard sur le besoin de la
//   nuit ; « zones » : tient compte de l'épuisement et d'Explorer ;
//   « stratège » : prépare en plus l'événement annoncé et bâtit Filet et
//   Citerne aux Jours 1-2, puis l'Atelier ; tous tentent le Radeau au
//   dernier jour seulement s'il est atteignable ;
// - « Radeau prudent » : stratège qui bâtit l'Atelier tôt et vote Radeau
//   jusqu'au plafond quand les stocks couvrent déjà la nuit (et l'événement
//   annoncé) ;
// - « rush Atelier » : Atelier au Jour 1, puis Radeau jusqu'au plafond
//   quotidien chaque jour ouvert, le reste du groupe joue en stratège.
// Aucun accès Redis : uniquement des fonctions pures.

import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import * as R from "../../services/robinson.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const config = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../../data/robinson/robinson.json"), "utf8"));
const argv = process.argv.slice(2);
const opt = (nom) => { const i = argv.indexOf(nom); return i >= 0 ? argv[i + 1] : null; };
if (opt("--appauvrissement")) config.appauvrissement = opt("--appauvrissement").split(",").map(Number);
if (opt("--points-section")) config.points_par_section = Number(opt("--points-section"));
if (opt("--stocks")) { const [poisson, eau, bois] = opt("--stocks").split(",").map(Number); config.stocks_initiaux = { poisson, eau, bois }; }
const RES = ["poisson", "eau", "bois"];
const ACT = { poisson: "peche", eau: "eau", bois: "bois" };
const RES_OF = { peche: "poisson", eau: "eau", bois: "bois" };
const rnd = (n) => Math.floor(Math.random() * n);
const OBJECTIF_RADEAU = config.points_par_section * config.radeau_sections_max;
const CONSTR = config.constructions ?? {};
const PLAFOND_JOUR = R.computeRadeauPlafondJour(config);

export const PROFILS = {
  aléatoire: { bruit: 1, charp: 0.5 },
  "glouton myope": { bruit: 0, charp: 1, explore: 0, allIn: true },
  "glouton + zones": { bruit: 0, charp: 1, explore: 1, zones: true, allIn: true },
  stratège: { bruit: 0, charp: 1, explore: 1, zones: true, prevision: true, bati: 1, batiJusquA: 2, allIn: true },
  "Radeau prudent": { bruit: 0, charp: 1, explore: 1, zones: true, prevision: true, bati: 1, batiJusquA: 2, allIn: true, prudent: true },
  "rush Atelier": { bruit: 0, charp: 1, explore: 1, zones: true, prevision: true, bati: 1, batiJusquA: 2, allIn: true, rush: true },
  "réaliste (30 % bruit)": { bruit: 0.3, charp: 0.7, explore: 0.6, zones: true, prevision: true, bati: 0.5, batiJusquA: 2, allIn: true },
};

function jouer(p, vMoyen) {
  const stocks = { ...config.stocks_initiaux };
  const bati = Object.fromEntries(Object.keys(CONSTR).map((id) => [id, 0]));
  const fini = (id) => R.isConstructionDone(bati[id], CONSTR[id]);
  const programme = R.drawEventProgramme(config.evenements, config.duree_jours);
  let radeau = 0, streaks = { poisson: 0, eau: 0, bois: 0 }, event = null, vVeille = null;
  for (let jour = 1; ; jour++) {
    const V = Math.max(3, Math.round(vMoyen + 3 * (Math.random() * 2 - 1)));
    const palier = R.computeEpuisementPalier(vVeille, config.epuisement);
    const appauv = R.computeAppauvrissement(jour, config);
    const maxRecolte = R.harvestMaxForDay(jour, config);
    const zones = { peche: 0, eau: 0, bois: 0, explorer: 0 };
    let radeauJour = 0;
    const gagner = (gain) => { const g = R.clipRaftGain(gain, radeauJour, PLAFOND_JOUR); radeauJour += g; radeau += g; return g; };
    const demain = jour < config.duree_jours ? R.forecastForDay(jour + 1, config.evenements, programme) : null;
    const radeauOk = !R.isRadeauDisabled(jour, config.radeau_verrouille);
    const explOk = !R.isExplorerDisabled(event);
    const chef = jour > 1 && Math.random() < 0.7;
    const charp = jour > 1 && radeauOk && Math.random() < 0.7;
    const besoin = R.computeDailyConsumption(vVeille ?? R.computeDay1ConsumptionVoters(V, config.consommation_jour1_ratio));
    for (let id = 0; id < V; id++) {
      const estChef = chef && id === 0, estCharp = charp && id === 1;
      const malus = (a) => R.computeEpuisementMalus(zones[a] + 1, palier);
      const bonus = (a) => R.constructionHarvestBonus(a, bati, CONSTR);
      const plafonne = (a) => R.harvestCapForEvent(event, a);
      const esperance = (a) => Math.max(0, (plafonne(a) ? (event.id === "canicule" ? 1 : 1.5) : maxRecolte / 2) - malus(a)) + bonus(a) + (estChef ? 1 : 0);
      const pool = ["peche", "eau", "bois"];
      if (explOk) pool.push("explorer");
      if (radeauOk) pool.push("radeau");
      for (const k of Object.keys(CONSTR)) if (!fini(k)) pool.push(k);
      let a;
      if (estCharp && Math.random() < p.charp && radeauJour < PLAFOND_JOUR) a = "radeau";
      else if (p.rush && jour === 1 && CONSTR.atelier && !fini("atelier")) a = "atelier";
      else if (p.rush && radeauOk && radeauJour < PLAFOND_JOUR && stocks.bois >= 1 && radeau < OBJECTIF_RADEAU) a = "radeau";
      else if (Math.random() < p.bruit) a = pool[rnd(pool.length)];
      else {
        const cible = { poisson: besoin.poisson + 2, eau: besoin.eau + 2, bois: besoin.bois + 2 };
        if (event?.id === "gobelins") cible.bois += 5;
        if (p.prevision && demain) {
          if (demain.famille === "eau_limitee") cible.eau += Math.round(V * 0.8);
          if (demain.id === "ouragan") { cible.poisson += Math.round(V * 0.6); cible.bois += Math.round(V * 0.4); }
          if (demain.id === "gobelins") cible.bois += 5;
          if (demain.id === "poissons_pourris") cible.poisson += 6;
        }
        const w = {};
        for (const r of RES) w[r] = Math.max(0, cible[r] - stocks[r]) / cible[r];
        const options = ["peche", "eau", "bois"].map((act) => [act, (p.zones ? esperance(act) : 2.5 + bonus(act)) * (w[RES_OF[act]] + 0.05)]);
        if (explOk && p.explore) options.push(["explorer", (p.zones ? R.computeExplorerAmount(malus("explorer") + appauv, config.epuisement?.explorer_min) : 3) * ((w.poisson + w.eau + w.bois) / 3 + 0.05) * p.explore]);
        if (p.bati) {
          for (const k of ["filet", "citerne"]) if (CONSTR[k] && !fini(k) && jour <= p.batiJusquA && stocks.bois > besoin.bois + 2) options.push([k, 0.9 * p.bati]);
          if (CONSTR.atelier && !fini("atelier") && jour >= 4 && radeauOk && stocks.bois > besoin.bois + 2) options.push(["atelier", p.bati]);
        }
        if (p.prudent && radeauOk && radeauJour < PLAFOND_JOUR && radeau < OBJECTIF_RADEAU && w.poisson === 0 && w.eau === 0 && stocks.bois > cible.bois) {
          options.push(["radeau", 50]);
        }
        if (p.prudent && CONSTR.atelier && !fini("atelier") && stocks.bois > besoin.bois + 2) options.push(["atelier", 0.95]);
        if (radeauOk && stocks.bois >= 1 && radeau < OBJECTIF_RADEAU && jour === config.duree_jours && p.allIn) {
          const parVote = R.raftPointsPerVote(bati, CONSTR);
          const atteignable = Math.min(Math.min(stocks.bois, V - id) * parVote, PLAFOND_JOUR - radeauJour);
          if (radeau + atteignable >= OBJECTIF_RADEAU) options.push(["radeau", 99]);
        }
        options.sort((x, y) => y[1] - x[1]);
        a = options[0][0];
      }
      if (a === "radeau") {
        if (radeauJour >= PLAFOND_JOUR) a = "peche";
        else if (estCharp) gagner(R.rollCharpentierRadeauPoints());
        else if (stocks.bois >= 1) { stocks.bois--; gagner(R.raftPointsPerVote(bati, CONSTR)); }
        else a = "peche";
      } else if (CONSTR[a]) {
        if (stocks.bois >= 1 && !fini(a)) { stocks.bois--; bati[a]++; } else a = "bois";
      }
      if (a === "explorer") {
        const tirage = R.rollExplorerYield();
        const r = RES.find((x) => tirage[x] > 0);
        stocks[r] += R.computeExplorerAmount(malus("explorer") + appauv, config.epuisement?.explorer_min);
        zones.explorer++;
      } else if (a in RES_OF) {
        const base = plafonne(a) ? R.rollEventCappedAmount(event) : R.rollHarvestAmount(Math.random, maxRecolte);
        stocks[RES_OF[a]] += R.computeHarvestAmount({ baseRoll: base, malus: malus(a), isChef: estChef, bonusConstruction: bonus(a) });
        zones[a]++;
      }
    }
    // Clôture, dans l'ordre de postRobinson()
    if (R.isRaftVictory(radeau, config)) return { issue: "radeau", jour, bati };
    const conso = R.computeDailyConsumption(vVeille ?? R.computeDay1ConsumptionVoters(V, config.consommation_jour1_ratio));
    for (const r of RES) stocks[r] = Math.max(0, stocks[r] - conso[r]);
    if (event?.id === "gobelins" && R.computeGobelinsTheft(stocks.bois)) stocks.poisson = Math.max(0, stocks.poisson - 5);
    if (R.isSurvivalVictory(jour + 1, config.duree_jours)) {
      return R.hasEmptyResource(stocks) ? { issue: "defaite", jour, bati } : { issue: "survie", jour: jour + 1, bati };
    }
    event = R.eventForDay(jour + 1, config.evenements, V, programme);
    if (event?.id === "epave") stocks.bois += R.computeEpaveBoisBonus(event, V);
    if (event?.id === "poissons_pourris") stocks.poisson = Math.max(0, stocks.poisson - R.computePoissonsPourrisLoss(V, event.condition_votants_veille_max));
    const u = R.updateZeroStreaks(streaks, stocks);
    streaks = u.streaks;
    if (u.defeated) return { issue: "defaite", jour, bati };
    vVeille = V;
  }
}

const arg = (nom, defaut) => opt(nom) ?? defaut;
const N = Number(arg("--n", 8000));
const VS = arg("--v", "6,10,14,18,22").split(",").map(Number);
const pct = (x) => `${((100 * x) / N).toFixed(0).padStart(3)} %`;
for (const vMoyen of VS) {
  console.log(`\n=== V moyen ${vMoyen} (±3) ===`);
  for (const [nom, p] of Object.entries(PROFILS)) {
    const c = { radeau: 0, survie: 0, defaite: 0 };
    const joursRadeau = {};
    const bati = Object.fromEntries(Object.keys(CONSTR).map((id) => [id, 0]));
    for (let i = 0; i < N; i++) {
      const r = jouer(p, vMoyen);
      c[r.issue]++;
      if (r.issue === "radeau") joursRadeau[r.jour] = (joursRadeau[r.jour] || 0) + 1;
      for (const id of Object.keys(CONSTR)) bati[id] += R.isConstructionDone(r.bati[id], CONSTR[id]);
    }
    const constr = Object.keys(CONSTR).map((id) => `${id} ${pct(bati[id])}`).join(", ");
    const jr = Object.entries(joursRadeau).map(([j, n]) => `J${j} ${pct(n).trim()}`).join(" ");
    console.log(`${nom.padEnd(24)} radeau ${pct(c.radeau)}  survie ${pct(c.survie)}  défaite ${pct(c.defaite)}  | ${constr}${jr ? `  | Radeau : ${jr}` : ""}`);
  }
}
