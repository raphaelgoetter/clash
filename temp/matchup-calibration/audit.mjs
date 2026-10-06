// Audit du catalogue de counters et des règles de structure du %matchup sur
// des combats réels (usage local uniquement). Entrée : fichier de collect.mjs.
//
// Principe : pour chaque combat, vu de chaque camp X (contre Y), on calcule
// un résidu = victoire réelle - probabilité attendue d'après le niveau et
// les évolutions seuls (cf. layers calibrés du moteur). L'effet d'un counter
// (ou d'une règle) = résidu moyen quand il est présent - résidu moyen quand
// il est absent, donc net de l'écart de niveau.
//
// Usage : node temp/matchup-calibration/audit.mjs <battles.json>
import "dotenv/config";
import fs from "node:fs";
import {
  identifyWinConditions,
  computeLevelDifferentialLayer,
  computeEvolutionLayer,
  computeCounterLayer,
  utilityShiftFor,
} from "../../backend/services/matchupEngine.js";
import { getWinConditionsCatalog } from "../../backend/services/matchupCatalog.js";
import { loadSamples } from "./samples.mjs";

const raw = JSON.parse(fs.readFileSync(process.argv[2], "utf8"));
const catalog = await getWinConditionsCatalog();
const norm = catalog.normalizeCardName;
const samples = loadSamples(raw);

const MIN_WC = 300; // perspectives minimales pour auditer une win condition
const MIN_PAIR = 80; // présences minimales d'un counter pour conclure
const Z_SUGGEST = 3; // seuil strict : ~4 000 tests, beaucoup de faux positifs à 2

const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const pct = (v) => `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}%`;

// stats[wc] = { n, sum, cards: Map<carte, { n, sum }> }
const wcStats = new Map();
// ruleStats[ruleId] = { n, sum, shift (configuré), label }
const ruleStats = new Map();
let structTotal = { n: 0, sum: 0 };

for (const s of samples) {
  for (const [X, Y, win] of [
    [s.cardsA, s.cardsB, s.win],
    [s.cardsB, s.cardsA, 1 - s.win],
  ]) {
    const wcX = identifyWinConditions(X, catalog);
    const wcY = identifyWinConditions(Y, catalog);
    const base =
      computeLevelDifferentialLayer(X, Y, wcX, wcY, catalog) +
      computeEvolutionLayer(X, Y);
    const resid = win - clamp(0.5 + base / 100, 0.05, 0.95);

    // ── Counters : par vraie win condition de X, chaque carte distincte de Y
    const cardsY = [...new Set(Y.map((c) => norm(c.name)))];
    for (const wc of wcX) {
      if (wc.pseudo) continue;
      if (!wcStats.has(wc.name)) {
        wcStats.set(wc.name, { n: 0, sum: 0, cards: new Map(), wc });
      }
      const st = wcStats.get(wc.name);
      st.n++;
      st.sum += resid;
      for (const card of cardsY) {
        const cs = st.cards.get(card) ?? { n: 0, sum: 0 };
        cs.n++;
        cs.sum += resid;
        st.cards.set(card, cs);
      }
    }

    // ── Structure : résidu net aussi des counters
    const bothKnown = wcX.length > 0 && wcY.length > 0;
    const counters = bothKnown
      ? computeCounterLayer(wcX, X, wcY, Y, catalog)
      : 0;
    const resid2 =
      win - clamp(0.5 + (base + counters) / 100, 0.05, 0.95);
    structTotal.n++;
    structTotal.sum += resid2;
    const { tags } = utilityShiftFor(wcX, X, Y, catalog);
    for (const tag of new Map(tags.map((t) => [t.ruleId, t])).values()) {
      const rs = ruleStats.get(tag.ruleId) ?? {
        n: 0,
        sum: 0,
        shifts: 0,
        label: tag.label,
      };
      rs.n++;
      rs.sum += resid2;
      rs.shifts += tag.shift;
      ruleStats.set(tag.ruleId, rs);
    }
  }
}

// Effet présent vs absent, avec z approché (variance binomiale ≈ 0,25)
function effect(present, total) {
  const absentN = total.n - present.n;
  if (present.n === 0 || absentN === 0) return null;
  const diff = present.sum / present.n - (total.sum - present.sum) / absentN;
  const se = Math.sqrt(0.25 / present.n + 0.25 / absentN);
  return { diff, z: diff / se, n: present.n };
}

const out = [];
const log = (line = "") => {
  out.push(line);
  console.log(line);
};

log(`Combats : ${samples.length} (${samples.length * 2} perspectives)`);
log(
  "Effet = écart de taux de victoire de la win condition quand la carte est en face, net du niveau et des évolutions (négatif = la carte la contre).",
);

// ── Rapport counters ──
log("\n════════ COUNTERS ════════");
const summary = { useless: [], strong: [], missing: [] };
const sortedWc = [...wcStats.values()].sort((a, b) => b.n - a.n);
for (const st of sortedWc) {
  if (st.n < MIN_WC) continue;
  const { wc } = st;
  log(`\n▶ ${wc.name} (${st.n} combats)`);
  const describe = (names, kind) => {
    for (const name of names) {
      const cs = st.cards.get(norm(name));
      const e = cs ? effect(cs, st) : null;
      if (!e || e.n < MIN_PAIR) {
        log(`   ${kind} ${name.padEnd(20)} échantillon insuffisant (${e?.n ?? 0})`);
        continue;
      }
      let flag = "";
      if (e.diff >= 0 && e.z > -1) {
        flag = "  ⚠ aucun effet";
        summary.useless.push(`${wc.name} ← ${name} (${kind}, ${pct(e.diff)}, n=${e.n})`);
      } else if (kind === "soft" && e.z <= -Z_SUGGEST && e.diff <= -0.06) {
        flag = "  ↑ mériterait hard";
        summary.strong.push(`${wc.name} ← ${name} (soft → hard ?, ${pct(e.diff)}, n=${e.n})`);
      }
      log(
        `   ${kind} ${name.padEnd(20)} ${pct(e.diff).padStart(7)}  z ${e.z.toFixed(1).padStart(5)}  n=${e.n}${flag}`,
      );
    }
  };
  describe(wc.hardCounters ?? [], "hard");
  describe(wc.softCounters ?? [], "soft");

  const listed = new Set(
    [...(wc.hardCounters ?? []), ...(wc.softCounters ?? [])].map(norm),
  );
  const candidates = [...st.cards.entries()]
    .filter(([card, cs]) => !listed.has(card) && card !== norm(wc.name) && cs.n >= MIN_PAIR)
    .map(([card, cs]) => ({ card, ...effect(cs, st) }))
    .filter((e) => e.z <= -Z_SUGGEST)
    .sort((a, b) => a.diff - b.diff)
    .slice(0, 5);
  for (const c of candidates) {
    log(`   ? ${c.card.padEnd(22)} ${pct(c.diff).padStart(7)}  z ${c.z.toFixed(1).padStart(5)}  n=${c.n}  (non listé)`);
    summary.missing.push(`${wc.name} ← ${c.card} (${pct(c.diff)}, n=${c.n})`);
  }
}

// ── Rapport structure ──
log("\n════════ RÈGLES DE STRUCTURE ════════");
log("(effet observé vs effet configuré, en % de victoire pour le camp concerné)");
for (const [id, rs] of [...ruleStats.entries()].sort((a, b) => b[1].n - a[1].n)) {
  const e = effect(rs, structTotal);
  const configured = rs.shifts / rs.n / 100;
  let verdict = "cohérent";
  if (Math.abs(e.z) < 2) verdict = "aucun effet mesurable";
  else if (Math.sign(e.diff) !== Math.sign(configured)) verdict = "⚠ effet INVERSE";
  else if (Math.abs(e.diff) > 2 * Math.abs(configured)) verdict = "sous-pondérée";
  else if (Math.abs(e.diff) < Math.abs(configured) / 2) verdict = "sur-pondérée";
  log(
    `  ${id.padEnd(28)} n=${String(rs.n).padStart(6)}  observé ${pct(e.diff).padStart(7)} (z ${e.z.toFixed(1).padStart(5)})  configuré ${pct(configured).padStart(6)}  → ${verdict}`,
  );
}

// Bilan agrégé (robuste au bruit des paires individuelles) : effet moyen,
// pondéré par le nombre de combats, des counters hard, soft et non listés.
const agg = { hard: { n: 0, sum: 0 }, soft: { n: 0, sum: 0 }, autre: { n: 0, sum: 0 } };
for (const st of wcStats.values()) {
  if (st.n < MIN_WC) continue;
  const hard = new Set((st.wc.hardCounters ?? []).map(norm));
  const soft = new Set((st.wc.softCounters ?? []).map(norm));
  for (const [card, cs] of st.cards) {
    if (card === norm(st.wc.name)) continue;
    const e = effect(cs, st);
    if (!e) continue;
    const bucket = hard.has(card) ? agg.hard : soft.has(card) ? agg.soft : agg.autre;
    bucket.n += cs.n;
    bucket.sum += e.diff * cs.n;
  }
}
log("\n════════ BILAN AGRÉGÉ COUNTERS ════════");
for (const [k, v] of Object.entries(agg)) {
  log(`  ${k.padEnd(6)} effet moyen ${pct(v.sum / v.n).padStart(7)}  (${v.n} présences)`);
}

log("\n════════ SYNTHÈSE COUNTERS ════════");
log(`\nCounters listés sans effet mesurable (${summary.useless.length}) :`);
summary.useless.forEach((l) => log(`  - ${l}`));
log(`\nSoft-counters qui pèsent comme des hard (${summary.strong.length}) :`);
summary.strong.forEach((l) => log(`  - ${l}`));
log(`\nCounters manquants probables (${summary.missing.length}) :`);
summary.missing.forEach((l) => log(`  - ${l}`));

if (process.argv[3]) fs.writeFileSync(process.argv[3], out.join("\n"));
