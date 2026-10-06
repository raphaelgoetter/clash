// Calibration du %matchup sur des combats réels (usage local uniquement).
// Entrée : fichier produit par collect.mjs.
//
// Usage : node temp/matchup-calibration/analyze.mjs <battles.json>
import "dotenv/config";
import fs from "node:fs";
import { computeDeckMatchupScore } from "../../backend/services/matchupEngine.js";
import { getWinConditionsCatalog } from "../../backend/services/matchupCatalog.js";
import { normLevel } from "../../backend/services/collectionConstants.js";
import { loadSamples } from "./samples.mjs";

const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const catalog = await getWinConditionsCatalog();

const samples = loadSamples(raw);

// ── Features ──

const sumBy = (cards, fn) => cards.reduce((t, c) => t + fn(c), 0);
const avg = (arr) => (arr.length ? arr.reduce((t, v) => t + v, 0) / arr.length : 0);
const isEvo = (c) => (c.evolutionLevel ?? 0) > 0;

function wcLevelAvg(cards, wcNames) {
  const set = new Set(wcNames.map((n) => catalog.normalizeCardName(n.replace(/ \(pseudo\)$/, ""))));
  return avg(cards.filter((c) => set.has(catalog.normalizeCardName(c.name))).map(normLevel));
}

for (const s of samples) {
  const r = computeDeckMatchupScore(s.cardsA, s.cardsB, catalog);
  s.difficulty = (100 - r.scoreA) / 100;
  // Les layers sont exprimés en avantage du joueur A (signe moteur)
  Object.assign(s, r.breakdown);
  s.rawLevelDiff = sumBy(s.cardsA, normLevel) - sumBy(s.cardsB, normLevel);
  s.evoDiff = s.cardsA.filter(isEvo).length - s.cardsB.filter(isEvo).length;
  s.elixirDiff =
    avg(s.cardsA.map((c) => c.elixirCost ?? 0)) - avg(s.cardsB.map((c) => c.elixirCost ?? 0));
  const wcA = wcLevelAvg(s.cardsA, r.winConditionsA);
  const wcB = wcLevelAvg(s.cardsB, r.winConditionsB);
  s.wcLevelDiff = wcA && wcB ? wcA - wcB : 0;
}

// ── Outils statistiques ──

function sigmoid(z) {
  return 1 / (1 + Math.exp(-z));
}

function solve(M, v) {
  // Élimination de Gauss avec pivot partiel
  const n = v.length;
  const A = M.map((row, i) => [...row, v[i]]);
  for (let c = 0; c < n; c++) {
    let p = c;
    for (let r = c + 1; r < n; r++) if (Math.abs(A[r][c]) > Math.abs(A[p][c])) p = r;
    [A[c], A[p]] = [A[p], A[c]];
    for (let r = 0; r < n; r++) {
      if (r === c) continue;
      const f = A[r][c] / A[c][c];
      for (let k = c; k <= n; k++) A[r][k] -= f * A[c][k];
    }
  }
  return A.map((row, i) => row[n] / row[i]);
}

function invert(M) {
  const n = M.length;
  return M.map((_, j) => solve(M, M.map((__, i) => (i === j ? 1 : 0)))).map((col, j, cols) =>
    cols.map((c) => c[j]),
  );
}

// Régression logistique (Newton-Raphson) avec ordonnée à l'origine.
function logistic(rows, allFeatureNames) {
  const featureNames = allFeatureNames.filter(
    (f) => new Set(rows.map((s) => s[f] ?? 0)).size > 1,
  );
  const X = rows.map((s) => [1, ...featureNames.map((f) => s[f] ?? 0)]);
  const y = rows.map((s) => s.win);
  const k = X[0].length;
  let beta = new Array(k).fill(0);
  let H;
  for (let iter = 0; iter < 30; iter++) {
    const g = new Array(k).fill(0);
    H = Array.from({ length: k }, () => new Array(k).fill(0));
    for (let i = 0; i < X.length; i++) {
      const p = sigmoid(X[i].reduce((t, x, j) => t + x * beta[j], 0));
      const w = p * (1 - p);
      for (let a = 0; a < k; a++) {
        g[a] += (y[i] - p) * X[i][a];
        for (let b = 0; b < k; b++) H[a][b] += w * X[i][a] * X[i][b];
      }
    }
    const step = solve(H, g);
    beta = beta.map((b, j) => b + step[j]);
    if (Math.max(...step.map(Math.abs)) < 1e-8) break;
  }
  const cov = invert(H);
  const se = cov.map((row, i) => Math.sqrt(row[i]));
  let ll = 0;
  for (let i = 0; i < X.length; i++) {
    const p = sigmoid(X[i].reduce((t, x, j) => t + x * beta[j], 0));
    ll += y[i] ? Math.log(p) : Math.log(1 - p);
  }
  return { beta, se, ll, names: ["(constante)", ...featureNames] };
}

// AUC : probabilité qu'une victoire ait un score plus élevé qu'une défaite
function auc(rows, scoreFn) {
  const sorted = rows.map((s) => [scoreFn(s), s.win]).sort((a, b) => a[0] - b[0]);
  let rankSum = 0;
  let pos = 0;
  let i = 0;
  while (i < sorted.length) {
    let j = i;
    while (j < sorted.length && sorted[j][0] === sorted[i][0]) j++;
    const avgRank = (i + j + 1) / 2;
    for (let k = i; k < j; k++) if (sorted[k][1]) { rankSum += avgRank; pos++; }
    i = j;
  }
  const neg = sorted.length - pos;
  return (rankSum - (pos * (pos + 1)) / 2) / (pos * neg);
}

const brier = (rows, pFn) => avg(rows.map((s) => (pFn(s) - s.win) ** 2));
const pct = (v) => `${(v * 100).toFixed(1)}%`;
const fx = (v, d = 3) => (v >= 0 ? " " : "") + v.toFixed(d);

// ── Rapport ──

function report(rows, title) {
  console.log(`\n══════ ${title} : ${rows.length} combats ══════`);

  console.log("\nCalibration (difficulté prédite → victoire réelle) :");
  const buckets = [0, 0.2, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 0.8, 1.01];
  for (let i = 0; i < buckets.length - 1; i++) {
    const inB = rows.filter((s) => s.difficulty >= buckets[i] && s.difficulty < buckets[i + 1]);
    if (inB.length < 30) continue;
    const exp = 1 - avg(inB.map((s) => s.difficulty));
    const act = avg(inB.map((s) => s.win));
    console.log(
      `  ${String(Math.round(buckets[i] * 100)).padStart(3)}-${String(Math.min(100, Math.round(buckets[i + 1] * 100))).padStart(3)}%  n=${String(inB.length).padStart(5)}  victoire attendue ${pct(exp).padStart(6)}  réelle ${pct(act).padStart(6)}`,
    );
  }

  console.log(
    `\nBrier : modèle ${brier(rows, (s) => 1 - s.difficulty).toFixed(4)} vs pile ou face 0.2500 (plus bas = mieux)`,
  );

  console.log("\nPouvoir prédictif isolé (AUC, 0.5 = aucun) :");
  const feats = {
    "Score total": (s) => -s.difficulty,
    "Counters": (s) => s.counters,
    "Structure": (s) => s.structure,
    "Niveau (layer)": (s) => s.level,
    "Évolutions/héros (layer)": (s) => s.evolutions,
    "Écart de niveau brut": (s) => s.rawLevelDiff,
    "Écart de niveau des WC": (s) => s.wcLevelDiff,
    "Écart d'évolutions": (s) => s.evoDiff,
    "Écart d'élixir moyen": (s) => s.elixirDiff,
    "Écart tour (troupe)": (s) => s.towerDiff,
  };
  for (const [name, fn] of Object.entries(feats)) {
    console.log(`  ${name.padEnd(26)} ${auc(rows, fn).toFixed(3)}`);
  }

  // Régression sur les layers actuels : un coefficient par point de layer.
  // Si les poids actuels étaient bien calibrés, les 4 coefficients seraient
  // proches les uns des autres (1 point = 1 point, quelle que soit l'étape).
  const fit = logistic(rows, ["counters", "structure", "level", "evolutions"]);
  console.log("\nRégression logistique sur les 4 layers (coef par point, z = significativité) :");
  const ref = avg(fit.beta.slice(1).map(Math.abs)) || 1;
  fit.names.forEach((n, i) => {
    const z = fit.beta[i] / fit.se[i];
    const mult = i === 0 ? "" : `  poids relatif ×${(fit.beta[i] / ref).toFixed(2)}`;
    console.log(`  ${n.padEnd(14)} coef ${fx(fit.beta[i], 4)}  z ${fx(z, 1)}${mult}`);
  });

  // Modèle étendu : layers + idées candidates
  const ext = ["counters", "structure", "rawLevelDiff", "wcLevelDiff", "evoDiff", "elixirDiff", "towerDiff"];
  const fit2 = logistic(rows, ext);
  console.log("\nModèle étendu (idées candidates, unités brutes) :");
  fit2.names.forEach((n, i) => {
    console.log(`  ${n.padEnd(14)} coef ${fx(fit2.beta[i], 4)}  z ${fx(fit2.beta[i] / fit2.se[i], 1)}`);
  });
  const p2 = (s) => sigmoid([1, ...fit2.names.slice(1).map((f) => s[f])].reduce((t, x, j) => t + x * fit2.beta[j], 0));
  console.log(
    `  log-vraisemblance : 4 layers ${fit.ll.toFixed(1)} → étendu ${fit2.ll.toFixed(1)} ; Brier étendu ${brier(rows, p2).toFixed(4)}`,
  );
}

report(samples, "Tous modes");
for (const mode of ["Ladder", "Ligue", "GDC"]) {
  report(samples.filter((s) => s.mode === mode), mode);
}

// Contrôle du niveau de jeu (Ladder) : le poids du deck survit-il à
// l'écart de trophées (proxy du niveau du joueur) ?
const withTrophies = samples.filter((s) => s.trophyDiff !== null);
const fitT = logistic(withTrophies, ["counters", "structure", "level", "evolutions", "trophyDiff"]);
console.log(`\n══════ Ladder avec écart de trophées : ${withTrophies.length} combats ══════`);
fitT.names.forEach((n, i) => {
  console.log(`  ${n.padEnd(14)} coef ${fx(fitT.beta[i], 5)}  z ${fx(fitT.beta[i] / fitT.se[i], 1)}`);
});

// ── Forme des effets ──

function curve(rows, key, edges, title) {
  console.log(`\n${title}`);
  for (let i = 0; i < edges.length - 1; i++) {
    const inB = rows.filter((s) => s[key] >= edges[i] && s[key] < edges[i + 1]);
    if (inB.length < 40) continue;
    console.log(
      `  [${edges[i]}, ${edges[i + 1]})  n=${String(inB.length).padStart(5)}  victoire ${pct(avg(inB.map((s) => s.win)))}`,
    );
  }
}
curve(samples, "rawLevelDiff", [-99, -20, -15, -10, -7, -4, -2, 0, 1, 3, 5, 8, 11, 16, 21, 99], "Victoire selon l'écart de niveau brut (somme normLevel A - B) :");
curve(samples, "evoDiff", [-3, -2, -1, 0, 1, 2, 3], "Victoire selon l'écart d'évolutions :");
curve(samples, "counters", [-7, -4, -2, -1, 1, 2, 4, 7], "Victoire selon le layer Counters (avantage A) :");

// ── Barème proposé, validé hors échantillon ──
// Moitié "entraînement" (ajustement des coefficients), moitié "test"
// (mesure honnête), découpage déterministe.
const train = samples.filter((_, i) => i % 2 === 0);
const test = samples.filter((_, i) => i % 2 === 1);
// Écart de niveau sur une échelle plafonnée douce (cf. courbe ci-dessus)
for (const s of samples) {
  s.levelSoft = Math.sign(s.rawLevelDiff) * Math.min(Math.abs(s.rawLevelDiff), 20);
}
const propFeatures = ["counters", "structure", "levelSoft", "wcLevelDiff", "evoDiff"];
const fitP = logistic(train, propFeatures);
console.log("\n══════ Barème proposé (ajusté sur 50 %, testé sur l'autre moitié) ══════");
fitP.names.forEach((n, i) => {
  const perUnit = i === 0 ? "" : `  ≈ ${(25 * fitP.beta[i]).toFixed(2)} % de difficulté par unité`;
  console.log(`  ${n.padEnd(14)} coef ${fx(fitP.beta[i], 4)}  z ${fx(fitP.beta[i] / fitP.se[i], 1)}${perUnit}`);
});
const zP = (s) => [1, ...fitP.names.slice(1).map((f) => s[f])].reduce((t, x, j) => t + x * fitP.beta[j], 0);
// Version additive (lisible) : 50 % ± somme des contributions linéaires
for (const s of test) {
  s.difficultyNew = Math.min(0.95, Math.max(0.05, 0.5 - 0.25 * zP(s)));
}
console.log(`  Brier test : actuel ${brier(test, (s) => 1 - s.difficulty).toFixed(4)} → proposé additif ${brier(test, (s) => 1 - s.difficultyNew).toFixed(4)} → proposé sigmoïde ${brier(test, (s) => sigmoid(zP(s))).toFixed(4)}`);
console.log(`  AUC test   : actuel ${auc(test, (s) => -s.difficulty).toFixed(3)} → proposé ${auc(test, (s) => -s.difficultyNew).toFixed(3)}`);
console.log("  Calibration test (proposé additif) :");
const b2 = [0, 0.3, 0.4, 0.45, 0.5, 0.55, 0.6, 0.7, 1.01];
for (let i = 0; i < b2.length - 1; i++) {
  const inB = test.filter((s) => s.difficultyNew >= b2[i] && s.difficultyNew < b2[i + 1]);
  if (inB.length < 30) continue;
  console.log(
    `    ${String(Math.round(b2[i] * 100)).padStart(3)}-${String(Math.min(100, Math.round(b2[i + 1] * 100))).padStart(3)}%  n=${String(inB.length).padStart(5)}  attendue ${pct(1 - avg(inB.map((s) => s.difficultyNew))).padStart(6)}  réelle ${pct(avg(inB.map((s) => s.win))).padStart(6)}`,
  );
}
const spread = (arr) => { const v = arr.map((s) => s).sort((a, b) => a - b); return `p5 ${pct(v[Math.floor(v.length * 0.05)])} · p50 ${pct(v[Math.floor(v.length / 2)])} · p95 ${pct(v[Math.floor(v.length * 0.95)])}`; };
console.log(`  Dispersion actuelle : ${spread(test.map((s) => s.difficulty))}`);
console.log(`  Dispersion proposée : ${spread(test.map((s) => s.difficultyNew))}`);
