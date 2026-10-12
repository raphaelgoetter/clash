// Simulation de Qui est-ce ? v2 (sans prime ni Or, objet quotidien) avec les
// VRAIES règles (backend/services/quiestceRules.js) et des joueurs bots.
// A/B par objet : chaque joueur actif a le droit d'utiliser chaque type
// d'objet avec une chance sur deux ; on compare cartes découvertes, fois
// démasqué et victoires. Usage : node temp/quiestce-sim/sim-v2.mjs [parties]
import fs from "fs";
import * as R from "../../backend/services/quiestceRules.js";

const CONFIG = JSON.parse(fs.readFileSync("data/quiestce/quiestce.json", "utf8"));
if (process.env.TIRAGE) CONFIG.tirage_objets = JSON.parse(process.env.TIRAGE);
// Variantes : CHOIX=1 (cible choisie), BROUILLARD_FORT=1 (bloque aussi les accusations)
const CHOIX = !!process.env.CHOIX;
if (process.env.BROUILLARD_FORT) CONFIG.brouillard_bloque_accusation = true;

// Choix de cible des bots : d'abord celle sur laquelle on a des renseignements
// (Miroir), puis le meneur en points, puis au hasard
function choisir(p, id) {
  const j = p.joueurs[id];
  const dispo = R.ciblesDisponibles(p, id, { config: CONFIG });
  if (!dispo.length) return;
  const note = (c) => Object.keys(j.renseignements[c] ?? {}).length * 10 + R.points(p.joueurs[c]) - (p.joueurs[c].brouillard ? 5 : 0) + rng() * 0.5;
  const best = dispo.sort((a, b) => note(b) - note(a))[0];
  R.choisirCible(p, id, best, { config: CONFIG, rng });
}
// Sans cible (après un démasquage) : choix stratégique (CHOIX=1) ou au hasard
function prendreCible(p, id) {
  if (CHOIX) return choisir(p, id);
  const dispo = R.ciblesDisponibles(p, id, { config: CONFIG });
  if (dispo.length) R.choisirCible(p, id, dispo[Math.floor(rng() * dispo.length)], { config: CONFIG, rng });
}
const CARTES = R.completerCartes(JSON.parse(fs.readFileSync("data/cardNames.json", "utf8")), CONFIG.complements);
const OBJ = Object.keys(R.OBJETS);
const PARTIES = Number(process.argv[2] || 1500);

let seed = 99;
const rng = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const score = (cs, f) => { const m = {}; cs.forEach((c) => { const v = f(c); m[v] = (m[v] || 0) + 1; }); return Object.values(m).reduce((a, b) => a + b * b, 0); };

// Profils : seuil d'accusation (cartes restantes), activité quotidienne
const PROFILS = {
  optimal: { seuil: (j) => (j >= 7 ? 3 : 2), activite: 0.95 },
  prudent: { seuil: () => 1, activite: 0.9 },
  occasionnel: { seuil: (j) => (j >= 7 ? 2 : 1), activite: 0.6 },
};

function jouer(p, id, bot, jour) {
  R.debutAction(p, id, { config: CONFIG, rng });
  const j = p.joueurs[id];
  if (!j.cible) prendreCible(p, id);
  // Objet (bots heuristiques, seulement les types autorisés)
  const peut = (o) => bot.droits[o] && R.etatObjet(p, id, o, { config: CONFIG }).ok;
  const chasseursDeMoi = R.chasseurs(p, id);
  const menace = chasseursDeMoi.some((h) => p.joueurs[h].enquete.ordre.length >= 2);
  const cs0 = j.cible ? R.candidats(p, id).length : 0;
  let objet = null;
  if (peut("deguisement") && menace) objet = "deguisement";
  else if (peut("brouillard") && menace) objet = "brouillard";
  else if (peut("desamorcage") && j.cible && (p.joueurs[j.cible].brouillard || cs0 <= 4)) objet = "desamorcage";
  else if (peut("double") && cs0 >= 2 && cs0 <= 3) objet = "double";
  else if (peut("loupe") && cs0 > 2 && R.questionsRestantes(j, CONFIG) > 0) objet = "loupe";
  else if (peut("miroir") && chasseursDeMoi.length) objet = "miroir";
  if (objet && !R.utiliserObjet(p, id, objet, { config: CONFIG, rng }).erreur) bot.utilises[objet] = (bot.utilises[objet] || 0) + 1;
  // Questions (meilleure partition), puis accusation
  while (j.cible && R.questionsRestantes(j, CONFIG) > 0) {
    const cs = R.candidats(p, id);
    const qs = R.questionsPossibles(p, id, { config: CONFIG });
    if (!qs.length || cs.length <= 1) break;
    const q = bot.profil === "occasionnel" ? qs[Math.floor(rng() * qs.length)] : qs.map((x) => [x, score(cs, (k) => p.cartes[k].profil[x])]).sort((a, b) => a[1] - b[1])[0][0];
    R.poser(p, id, q, { config: CONFIG });
  }
  for (let k = 0; k < 2; k++) {
    const cs = R.candidats(p, id);
    if (!(j.cible && R.accusationsRestantes(j) > 0 && cs.length && cs.length <= PROFILS[bot.profil].seuil(jour))) break;
    const r = R.accuser(p, id, cs[Math.floor(rng() * cs.length)], { config: CONFIG, rng });
    if (r.correct) prendreCible(p, id);
  }
}

const ab = Object.fromEntries(OBJ.map((o) => [o, { oui: { n: 0, cartes: 0, demasque: 0, win: 0, u: 0 }, non: { n: 0, cartes: 0, demasque: 0, win: 0 } }]));
const parProfil = {};
let gagnant = 0, egalites = 0, cartesTot = 0, joueursTot = 0;
for (let g = 0; g < PARTIES; g++) {
  const n = 10 + Math.floor(rng() * 9);
  const p = R.creerPartie();
  const bots = {};
  for (let i = 0; i < n; i++) {
    const profil = i < n * 0.35 ? "optimal" : i < n * 0.65 ? "prudent" : "occasionnel";
    R.inscrire(p, `b${i}`, `b${i}`, { config: CONFIG });
    bots[`b${i}`] = { profil, droits: Object.fromEntries(OBJ.map((o) => [o, rng() < 0.5])), utilises: {} };
  }
  R.demarrer(p, { config: CONFIG, cartesData: CARTES, rng });
  for (let jour = 1; jour <= 7; jour++) {
    const ordre = Object.keys(bots).sort(() => rng() - 0.5);
    for (const id of ordre) if (rng() < PROFILS[bots[id].profil].activite) jouer(p, id, bots[id], jour);
    R.cloturer(p, { config: CONFIG });
  }
  const cl = R.classement(p);
  gagnant += cl[0].score;
  if (cl[1] && cl[1].score === cl[0].score && cl[1].decouvertes === cl[0].decouvertes) egalites++;
  for (const r of cl) {
    const b = bots[r.discordId];
    const pp = (parProfil[b.profil] ||= { n: 0, cartes: 0, demasque: 0, win: 0 });
    pp.n++; pp.cartes += r.decouvertes; pp.points = (pp.points || 0) + r.score; pp.demasque += r.nbDemasque; if (r.rang === 1) pp.win++;
    cartesTot += r.decouvertes; joueursTot++;
    for (const o of OBJ) {
      const a = ab[o][b.droits[o] ? "oui" : "non"];
      a.n++; a.cartes += r.decouvertes; a.points = (a.points || 0) + r.score; a.demasque += r.nbDemasque; if (r.rang === 1) a.win++;
      if (b.droits[o]) a.u += b.utilises[o] || 0;
    }
  }
}
console.log(`${PARTIES} parties, 10-18 joueurs : gagnant ${(gagnant / PARTIES).toFixed(1)} pts, moyenne ${(cartesTot / joueursTot).toFixed(2)} cartes/joueur, égalité points+découvertes en tête ${(100 * egalites / PARTIES).toFixed(0)}%`);
for (const [k, v] of Object.entries(parProfil)) console.log(`  ${k.padEnd(12)} ${(v.points / v.n).toFixed(2)} pts · ${(v.cartes / v.n).toFixed(2)} cartes · ${(v.demasque / v.n).toFixed(2)}× démasqué · victoire ${(100 * v.win / v.n).toFixed(1)}%`);
for (const o of OBJ) {
  const { oui, non } = ab[o];
  console.log(`  A/B ${o.padEnd(12)} utilisé ${(oui.u / oui.n).toFixed(2)}/partie | points ${(oui.points / oui.n).toFixed(2)} vs ${(non.points / non.n).toFixed(2)} | cartes ${(oui.cartes / oui.n).toFixed(2)} vs ${(non.cartes / non.n).toFixed(2)} | démasqué ${(oui.demasque / oui.n).toFixed(2)} vs ${(non.demasque / non.n).toFixed(2)} | victoire ${(100 * oui.win / oui.n).toFixed(1)}% vs ${(100 * non.win / non.n).toFixed(1)}%`);
}
