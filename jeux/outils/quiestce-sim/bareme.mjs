// Comparaison de barèmes de points pour Qui est-ce ? sur les MÊMES parties
// (vraies règles, bots de sim-v2 + profil « absent »). Chaque barème est
// recalculé à partir des stats brutes de chaque joueur.
// Usage : node jeux/outils/quiestce-sim/bareme.mjs [parties]
import fs from "fs";
import * as R from "../../services/quiestceRules.js";

const CONFIG = JSON.parse(fs.readFileSync("jeux/data/quiestce/quiestce.json", "utf8"));
CONFIG.brouillard_bloque_accusation = true;
const CARTES = R.completerCartes(JSON.parse(fs.readFileSync("jeux/data/cardNames.json", "utf8")), CONFIG.complements);
const PARTIES = Number(process.argv[2] || 1500);
let seed = 7;
const rng = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const score = (cs, f) => { const m = {}; cs.forEach((c) => { const v = f(c); m[v] = (m[v] || 0) + 1; }); return Object.values(m).reduce((a, b) => a + b * b, 0); };

const PROFILS = {
  optimal: { seuil: (j) => (j >= 7 ? 3 : 2), activite: 0.95 },
  prudent: { seuil: () => 1, activite: 0.9 },
  occasionnel: { seuil: (j) => (j >= 7 ? 2 : 1), activite: 0.6 },
  absent: { seuil: () => 1, activite: 0.15 },
};

// Barèmes : d = carte découverte, s = survie/jour, actif = survie seulement
// les jours joués, m = malus par démasquage (le bonus d'efficacité reste [3,2,1])
const BAREMES = {
  "actuel (1 / survie 1 / −1)": { d: 1, s: 1, actif: false, m: 1 },
  "proposé (3 / survie active 1 / −2)": { d: 3, s: 1, actif: true, m: 2 },
  "2 / survie active 1 / −2": { d: 2, s: 1, actif: true, m: 2 },
  "3 / sans survie / −2": { d: 3, s: 0, actif: true, m: 2 },
  "3 / survie 1 pour tous / −2": { d: 3, s: 1, actif: false, m: 2 },
};

function choisir(p, id) {
  const j = p.joueurs[id];
  const dispo = R.ciblesDisponibles(p, id, { config: CONFIG });
  if (!dispo.length) return;
  const note = (c) => Object.keys(j.renseignements[c] ?? {}).length * 10 + R.points(p.joueurs[c]) - (p.joueurs[c].brouillard ? 5 : 0) + rng() * 0.5;
  R.choisirCible(p, id, dispo.sort((a, b) => note(b) - note(a))[0], { config: CONFIG, rng });
}

function jouer(p, id, bot, jour) {
  R.debutAction(p, id, { config: CONFIG, rng });
  const j = p.joueurs[id];
  if (!j.cible) choisir(p, id);
  const peut = (o) => R.etatObjet(p, id, o, { config: CONFIG }).ok;
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
  if (objet) R.utiliserObjet(p, id, objet, { config: CONFIG, rng });
  while (j.cible && R.questionsRestantes(j, CONFIG) > 0) {
    const cs = R.candidats(p, id);
    const qs = R.questionsPossibles(p, id, { config: CONFIG });
    if (!qs.length || cs.length <= 1) break;
    const q = bot.profil === "occasionnel" || bot.profil === "absent" ? qs[Math.floor(rng() * qs.length)] : qs.map((x) => [x, score(cs, (k) => p.cartes[k].profil[x])]).sort((a, b) => a[1] - b[1])[0][0];
    R.poser(p, id, q, { config: CONFIG });
  }
  for (let k = 0; k < 2; k++) {
    const cs = R.candidats(p, id);
    if (!(j.cible && R.accusationsRestantes(j) > 0 && cs.length && cs.length <= PROFILS[bot.profil].seuil(jour))) break;
    if (R.accuser(p, id, cs[Math.floor(rng() * cs.length)], { config: CONFIG, rng }).correct) choisir(p, id);
  }
}

const stats = Object.fromEntries(Object.keys(BAREMES).map((b) => [b, { gagnant: 0, podium: 0, med: 0, et: 0, egal: 0, distincts: 0, prof: {} }]));
for (let g = 0; g < PARTIES; g++) {
  const n = 10 + Math.floor(rng() * 9);
  const p = R.creerPartie();
  const bots = {};
  for (let i = 0; i < n; i++) {
    const profil = i < n * 0.3 ? "optimal" : i < n * 0.55 ? "prudent" : i < n * 0.85 ? "occasionnel" : "absent";
    R.inscrire(p, `b${i}`, `b${i}`, { config: CONFIG });
    bots[`b${i}`] = { profil, survieTous: 0, survieActif: 0 };
  }
  R.demarrer(p, { config: CONFIG, cartesData: CARTES, rng });
  for (let jour = 1; jour <= 7; jour++) {
    const actifs = new Set();
    for (const id of Object.keys(bots).sort(() => rng() - 0.5)) if (rng() < PROFILS[bots[id].profil].activite) { actifs.add(id); jouer(p, id, bots[id], jour); }
    for (const [id, b] of Object.entries(bots)) if (!p.joueurs[id].demasqueJour) { b.survieTous++; if (actifs.has(id)) b.survieActif++; }
    R.cloturer(p, { config: CONFIG });
  }
  for (const [nom, B] of Object.entries(BAREMES)) {
    const cl = Object.entries(p.joueurs).map(([id, j]) => ({
      id, d: j.demasques.length, e: j.erreurs,
      pts: B.d * j.demasques.length + (j.bonus ?? 0) + B.s * (B.actif ? bots[id].survieActif : bots[id].survieTous) - B.m * j.nbDemasque,
    })).sort((a, b) => b.pts - a.pts || b.d - a.d || a.e - b.e);
    const sc = cl.map((r) => r.pts);
    const moy = sc.reduce((a, b) => a + b, 0) / sc.length;
    const S = stats[nom];
    S.gagnant += sc[0]; S.podium += sc[0] - sc[2]; S.med += sc[0] - sc[Math.floor(sc.length / 2)];
    S.et += Math.sqrt(sc.reduce((a, b) => a + (b - moy) ** 2, 0) / sc.length);
    S.distincts += new Set(sc).size / sc.length;
    if (sc[1] === sc[0]) S.egal++;
    cl.forEach((r, i) => { const pp = (S.prof[bots[r.id].profil] ||= { n: 0, pts: 0, win: 0 }); pp.n++; pp.pts += r.pts; if (i === 0) pp.win++; });
  }
}
const f = (x) => (x / PARTIES).toFixed(1);
for (const [nom, S] of Object.entries(stats)) {
  console.log(`\n${nom}`);
  console.log(`  gagnant ${f(S.gagnant)} pts | écart 1er-3e ${f(S.podium)} | 1er-médian ${f(S.med)} | écart-type ${f(S.et)} | égalité de points en tête ${(100 * S.egal / PARTIES).toFixed(0)}% | scores distincts ${(100 * S.distincts / PARTIES).toFixed(0)}%`);
  console.log("  " + Object.entries(S.prof).map(([k, v]) => `${k} ${(v.pts / v.n).toFixed(1)} pts (${(100 * v.win / v.n).toFixed(0)}% vict.)`).join(" · "));
}
