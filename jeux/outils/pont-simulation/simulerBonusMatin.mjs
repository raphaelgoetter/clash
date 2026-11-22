// ============================================================
// Simulation : poids de la pièce bonus du matin (Vrai/Faux) au Pont du Troll.
// Règles : jeux/CONTRIBUTING.md, section « Pont du Troll ».
//
// Bonus : bonne réponse le matin = 1 pièce, gardée (+1 fixe, sans
// multiplicateur) si le joueur passe l'après-midi ; perdue s'il ne traverse
// pas ; s'il est attrapé, elle rejoint le butin partagé par l'autre pont
// (butin multiplié comme aujourd'hui).
//
// Usage : node --import @clash/commun/testing/registerFakeRedis.js \
//   jeux/outils/pont-simulation/simulerBonusMatin.mjs [parties=5000]
// ============================================================

import fs from "node:fs";
import { resoudreJour, PIERRE, CORDES, FINALE } from "../../services/pont.js";

const PARTIES = Number(process.argv[2]) || 5000;
const config = JSON.parse(
  fs.readFileSync(new URL("../../data/pont/pont.json", import.meta.url), "utf-8"),
);

// Générateur reproductible (mulberry32)
function rngDe(graine) {
  let a = graine >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Variantes de règles comparées sur les mêmes choix
const VARIANTES = {
  sans: "Sans bonus (règle actuelle)",
  butin: "Bonus, perdu au butin de l'autre pont (proposé)",
  perdu: "Bonus, simplement perdu si attrapé",
};

function resoudreAvecBonus(choix, bonus, cfg, variante) {
  const res = resoudreJour(choix, cfg);
  const gains = Object.fromEntries(res.resultats.map((r) => [r.discordId, r.gain]));
  if (variante === "sans") return gains;
  const { attrape, gagnant, personneAttrape, passants } = res;
  if (variante === "butin" && !personneAttrape && gagnant && passants[gagnant].length > 0) {
    const bonusAttrapes = passants[attrape].filter((id) => bonus.has(id)).length;
    const pot = passants[attrape].length + bonusAttrapes;
    const finale = cfg.evenement === FINALE ? 2 : 1;
    const gain = 100 * Math.ceil((cfg[gagnant] * finale * pot) / passants[gagnant].length);
    for (const id of passants[gagnant]) gains[id] = gain;
  }
  for (const r of res.resultats) if (r.passe && bonus.has(r.discordId)) gains[r.discordId] += 100;
  return gains;
}

// Scénarios de joueurs : taux de bonnes réponses au Vrai/Faux
const SCENARIOS = {
  "réponses à 65 %": () => 0.65,
  "un expert à 95 %, les autres à 60 %": (i) => (i === 0 ? 0.95 : 0.6),
};

function simuler(nomScenario, tauxDe) {
  const rng = rngDe(42);
  const stats = Object.fromEntries(
    Object.keys(VARIANTES).map((v) => [
      v,
      { total: 0, bonus: 0, exaequo: 0, memeVainqueur: 0, expertGagne: 0, meilleurQuizGagne: 0, ecartMoyen: 0 },
    ]),
  );
  for (let p = 0; p < PARTIES; p++) {
    const nb = 15 + Math.floor(rng() * 6);
    const joueurs = Array.from({ length: nb }, (_, i) => ({
      id: `j${i}`,
      taux: tauxDe(i),
      assiduite: 0.6 + rng() * 0.4, // probabilité de jouer l'après-midi
      matinal: 0.5 + rng() * 0.5, // probabilité de jouer le matin
    }));
    const points = Object.fromEntries(Object.keys(VARIANTES).map((v) => [v, {}]));
    const passes = {};
    const bonnes = {};
    for (const cfg of config.calendrier) {
      const choix = {};
      const bonus = new Set();
      for (const j of joueurs) {
        if (rng() < j.matinal && rng() < j.taux) {
          bonus.add(j.id);
          bonnes[j.id] = (bonnes[j.id] ?? 0) + 1;
        }
        if (rng() < j.assiduite) choix[j.id] = { cote: rng() < 0.5 ? PIERRE : CORDES };
      }
      const res = resoudreJour(choix, cfg);
      for (const r of res.resultats) if (r.passe) passes[r.discordId] = (passes[r.discordId] ?? 0) + 1;
      for (const v of Object.keys(VARIANTES)) {
        const gains = resoudreAvecBonus(choix, bonus, cfg, v);
        for (const [id, g] of Object.entries(gains)) {
          points[v][id] = (points[v][id] ?? 0) + g;
          stats[v].total += g;
        }
        if (v !== "sans")
          for (const r of res.resultats)
            if (r.passe && bonus.has(r.discordId)) stats[v].bonus += 100;
      }
    }
    // Classements (pièces, puis passages)
    const classement = (v) =>
      Object.keys(points[v]).sort(
        (a, b) => points[v][b] - points[v][a] || (passes[b] ?? 0) - (passes[a] ?? 0),
      );
    const vainqueurSans = classement("sans")[0];
    const maxQuiz = Math.max(0, ...Object.values(bonnes));
    for (const v of Object.keys(VARIANTES)) {
      const c = classement(v);
      if (c.length < 2) continue;
      const [a, b] = c;
      if (points[v][a] === points[v][b] && (passes[a] ?? 0) === (passes[b] ?? 0)) stats[v].exaequo++;
      if (c[0] === vainqueurSans) stats[v].memeVainqueur++;
      if (c[0] === "j0") stats[v].expertGagne++;
      if ((bonnes[c[0]] ?? 0) === maxQuiz) stats[v].meilleurQuizGagne++;
      stats[v].ecartMoyen += (points[v][a] - points[v][b]) / 100;
    }
  }
  const pct = (x) => `${((100 * x) / PARTIES).toFixed(1)} %`;
  console.log(`\n=== ${nomScenario} (${PARTIES} parties, 15 à 20 joueurs) ===`);
  for (const [v, nom] of Object.entries(VARIANTES)) {
    const s = stats[v];
    console.log(`\n${nom}`);
    console.log(`  pièces par partie et par joueur actif ≈ ${(s.total / 100 / PARTIES / 17.5).toFixed(1)}`);
    if (v !== "sans") console.log(`  part des bonus gardés dans le total : ${((100 * s.bonus) / s.total).toFixed(1)} %`);
    console.log(`  même vainqueur que sans bonus : ${pct(s.memeVainqueur)}`);
    console.log(`  vainqueur parmi les meilleurs au Vrai/Faux : ${pct(s.meilleurQuizGagne)}`);
    console.log(`  1re place ex aequo après départage : ${pct(s.exaequo)}`);
    console.log(`  écart moyen 1er-2e : ${(s.ecartMoyen / PARTIES).toFixed(2)} pièce`);
    if (nomScenario.includes("expert")) console.log(`  victoire de l'expert : ${pct(s.expertGagne)}`);
  }
}

for (const [nom, taux] of Object.entries(SCENARIOS)) simuler(nom, taux);
