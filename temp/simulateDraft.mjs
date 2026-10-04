// Simulation d'équilibrage du jeu spécial « Draft » (7 jours, deck de 8 cartes)
import fs from "fs";
import { filterCardPool } from "../backend/services/elixirRules.js";
const raw = JSON.parse(fs.readFileSync("data/cardNames.json", "utf8"));
const POOL = filterCardPool(Array.isArray(raw) ? raw : Object.values(raw)).map((c) => ({ key: c.cardKey, fr: c.fr, elixir: c.elixir, rarity: c.rarity, type: c.type, family: c.family ?? null }));

const N = Number(process.env.N || 30), GAMES = Number(process.env.GAMES || 1000);
const POP_CAP = 5;
const MULTS = (process.env.MULTS || "2,2,1.5,1.5,1.25,1.25,1").split(",").map(Number); // index = jour - 1
// Barème : [points à 3 cartes, points à 5 cartes]
const THEMES = [
  ["humains", (c) => c.family === "human", 2, 4],
  ["sorts", (c) => c.type === "spell", 5, 10],
  ["volants", (c) => c.type === "flying", 6, 12],
  ["batiments", (c) => c.type === "building", 7, 14],
  ["gobelins", (c) => c.family === "goblin", 6, 12],
  ["squelettes", (c) => c.family === "skeleton", 6, 12],
];
const CONTRATS_LIST = THEMES.flatMap((t, ti) => [3, 4].map((tier) => ({ ti, tier, pts: tier === 4 ? t[3] : t[2] })));
const COPIES = Number(process.env.COPIES || Infinity); // joueurs max par carte déposée
const PENALITE = Number(process.env.PENALITE || 0); // fraction des points perdue si contrat raté
const RARITIES = ["common", "rare", "epic", "legendary", "champion"];
const MAJ = [["champions", "champion", 12], ["legendaires", "legendary", 10], ["epiques", "epic", 8]];
const BONUS = [
  ["raretes", (h) => RARITIES.every((r) => h.some((c) => c.rarity === r)), 4],
  ["trio", (h) => h.some((c) => c.type === "troop" || c.type === "flying") && h.some((c) => c.type === "spell") && h.some((c) => c.type === "building"), 2],
  ["cycle", (h) => h.length >= 3 && avg(h) <= 3, 4],
  ["lourd", (h) => h.length >= 3 && avg(h) >= 5, 4],
];
const avg = (h) => h.reduce((s, c) => s + c.elixir, 0) / h.length;

function deckScore(h) {
  const got = [];
  for (const [id, f, p3, p5] of THEMES) { const n = h.filter(f).length; if (n >= 4) got.push([id + "4", p5]); else if (n >= 3) got.push([id + "3", p3]); }
  for (const [id, f, p] of BONUS) if (f(h)) got.push([id, p]);
  return got;
}
// Valeur heuristique pour décider (majorités approximées, crédit partiel)
function contratBonus(h, ct) {
  if (!ct) return 0;
  const n = h.filter(THEMES[ct.ti][1]).length;
  return n >= ct.tier ? ct.pts * (ct.mult - 1) : -Math.round(ct.pts * PENALITE);
}
function value(h, ct = null) {
  let v = contratBonus(h, ct);
  if (ct) { const n = h.filter(THEMES[ct.ti][1]).length; if (n < ct.tier) v += (ct.pts * (ct.mult - 1) + ct.pts * PENALITE) * (n / ct.tier) * 0.7; }
  v += deckScore(h).reduce((s, [, p]) => s + p, 0);
  for (const [, f, p3] of THEMES) { const n = h.filter(f).length; if (n < 3) v += p3 * (n / 3) * 0.6; }
  v += 4 * h.filter((c) => c.rarity === "champion").length + 1.5 * h.filter((c) => c.rarity === "legendary").length + 0.6 * h.filter((c) => c.rarity === "epic").length;
  return v;
}
const rnd = (a) => a[Math.floor(Math.random() * a.length)];
function draw(h) { const owned = new Set(h.map((c) => c.key)); return rnd(POOL.filter((c) => !owned.has(c.key))); }
function worst(h, ct = null) { let bi = 0, bv = Infinity; h.forEach((c, i) => { const v = value(h.filter((_, j) => j !== i), ct); const loss = value(h, ct) - v; if (loss < bv) { bv = loss; bi = i; } }); return bi; }

function game() {
  // stratégies : actif (marché + recyclage réfléchis), pioche (aucune autre action), hasard (actions au hasard)
  const P = Array.from({ length: N }, (_, i) => ({ strat: i < N / 2 ? "actif" : i < (3 * N) / 4 ? "pioche" : "hasard", hand: [], contrat: null, depot: null, pop: 0 }));
  for (const p of P) { p.hand.push(draw(p.hand)); p.hand.push(draw(p.hand)); }
  let market = [];
  for (let day = 1; day <= 7; day++) {
    const deposits = [];
    for (const [idx, p] of P.entries()) {
      // 2) pioche
      p.hand.push(draw(p.hand));
      // 3) contrat (signature ou changement)
      if (p.strat === "actif") {
        const left = 7 - day; // cartes encore gagnables ~ 2 par jour restant
        const prog = (ct) => p.hand.filter(THEMES[ct.ti][1]).length;
        const cur = p.contrat ? prog(p.contrat) : 0;
        const hopeless = p.contrat && cur + 2 * left < p.contrat.tier;
        if (!p.contrat || hopeless) {
          const best = CONTRATS_LIST.map((ct) => ({ ...ct, mult: MULTS[day - 1] }))
            .filter((ct) => prog(ct) + 2 * left >= ct.tier)
            .sort((a, b) => b.pts * (b.mult - 1) * (prog(b) / b.tier) ** 2 - a.pts * (a.mult - 1) * (prog(a) / a.tier) ** 2)[0];
          if (best && best.mult > 1) { p.contrat = best; p.signatures = (p.signatures || 0) + 1; }
        }
      } else if (p.strat === "hasard" && day === 1) p.contrat = { ...rnd(CONTRATS_LIST), mult: MULTS[0] };
      // 4) vœux sur le marché de la veille (si dépôt la veille)
      if (p.depot) {
        const owned = new Set(p.hand.map((c) => c.key));
        const choix = [...new Map(market.filter((m) => m.owner !== idx && !owned.has(m.card.key)).map((m) => [m.card.key, m.card])).values()];
        p.voeux = p.strat === "actif"
          ? choix.map((c) => [c, value([...p.hand, c], p.contrat)]).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([c]) => c)
          : [...choix].sort(() => Math.random() - 0.5).slice(0, 3);
        p.depotRecu = p.depot; p.depot = null;
      }
      // 5) dépôt facultatif (J1-J6)
      if (day <= 6 && p.strat !== "pioche" && p.hand.length > 1) {
        const i = p.strat === "actif" ? worst(p.hand, p.contrat) : Math.floor(Math.random() * p.hand.length);
        const [c] = p.hand.splice(i, 1); p.depot = c; deposits.push({ card: c, owner: idx });
      }
    }
    // clôture : résolution des vœux, servis par popularité décroissante puis au hasard
    const stock = new Map();
    for (const m of market) stock.set(m.card.key, (stock.get(m.card.key) || 0) + COPIES);
    const ordre = P.map((p, i) => [p, i, Math.random()]).filter(([p]) => p.depotRecu).sort((a, b) => b[0].pop - a[0].pop || a[2] - b[2]);
    for (const [p] of ordre) {
      const owned = new Set(p.hand.map((c) => c.key));
      const recu = p.voeux.find((c) => (stock.get(c.key) || 0) > 0 && !owned.has(c.key));
      if (recu) {
        stock.set(recu.key, stock.get(recu.key) - 1);
        p.hand.push(recu);
        const owners = market.filter((m) => m.card.key === recu.key).map((m) => m.owner);
        const o = P[owners[Math.floor(Math.random() * owners.length)]];
        o.pop = Math.min(POP_CAP, o.pop + 1); o.popBrute = (o.popBrute || 0) + 1;
        p.voeuxOk = (p.voeuxOk || 0) + 1;
      } else { p.hand.push(p.depotRecu); p.voeuxKo = (p.voeuxKo || 0) + 1; }
      p.depotRecu = null; p.voeux = null;
    }
    market = deposits;
    // J7 : garder les 8 meilleures
    if (day === 7) for (const p of P) while (p.hand.length > 8) p.hand.splice(p.strat === "actif" ? worst(p.hand, p.contrat) : Math.floor(Math.random() * p.hand.length), 1);
  }
  // score final
  const res = P.map((p) => ({ strat: p.strat, n: p.hand.length, got: deckScore(p.hand), pop: p.pop, hand: p.hand, contrat: p.contrat, ctBonus: contratBonus(p.hand, p.contrat), signatures: p.signatures || 0, voeuxOk: p.voeuxOk || 0, voeuxKo: p.voeuxKo || 0 }));
  for (const [id, r, pts] of MAJ) {
    const counts = res.map((x) => x.hand.filter((c) => c.rarity === r).length); const max = Math.max(...counts);
    if (max >= 1) res.forEach((x, i) => { if (counts[i] === max) x.got.push(["maj_" + id, pts]); });
  }
  for (const x of res) { x.score = x.got.reduce((s, [, p]) => s + p, 0) + x.pop + x.ctBonus; x.majPts = x.got.filter(([id]) => id.startsWith("maj_")).reduce((s, [, p]) => s + p, 0); }
  return res;
}

const agg = { strat: {}, obj: {}, wins: {}, ties: 0, majShareWinner: 0, top: [], majWinners: {}, ct: {}, ctWinner: 0, voeux: {} };
for (let g = 0; g < GAMES; g++) {
  const res = game(); const max = Math.max(...res.map((x) => x.score)); const winners = res.filter((x) => x.score === max);
  if (winners.length > 1) agg.ties++;
  for (const w of winners) agg.wins[w.strat] = (agg.wins[w.strat] || 0) + 1 / winners.length;
  agg.majShareWinner += winners[0].majPts / max; agg.ctWinner += winners[0].ctBonus / max; agg.top.push(max);
  for (const [id] of MAJ) agg.majWinners[id] = (agg.majWinners[id] || 0) + res.filter((x) => x.got.some(([k]) => k === "maj_" + id)).length;
  for (const x of res) {
    (agg.strat[x.strat] ??= []).push(x.score);
    if (x.contrat) { const k = x.strat; (agg.ct[k] ??= { n: 0, ok: 0, pts: 0, sig: 0 }); agg.ct[k].n++; agg.ct[k].ok += x.ctBonus > 0; agg.ct[k].pts += x.ctBonus; agg.ct[k].sig += x.signatures; }
    (agg.voeux[x.strat] ??= [0, 0]); agg.voeux[x.strat][0] += x.voeuxOk; agg.voeux[x.strat][1] += x.voeuxKo;
    if (x.strat === "actif") for (const [id] of x.got) agg.obj[id] = (agg.obj[id] || 0) + 1;
  }
}
const mean = (a) => (a.reduce((s, v) => s + v, 0) / a.length).toFixed(1);
console.log(`N=${N} joueurs, ${GAMES} parties, multiplicateurs ${MULTS.join("/")}, copies ${COPIES}, pénalité ${PENALITE}`);
for (const [k, [ok, ko]] of Object.entries(agg.voeux)) if (ok + ko) console.log(`  vœux ${k}: servis ${Math.round((100 * ok) / (ok + ko))}%`);
for (const [s, a] of Object.entries(agg.strat)) console.log(`  ${s.padEnd(7)} score moyen ${mean(a)}  victoires ${((100 * (agg.wins[s] || 0)) / GAMES).toFixed(1)}%`);
console.log(`  score gagnant moyen ${mean(agg.top)}, égalités en tête ${((100 * agg.ties) / GAMES).toFixed(1)}%, part des majorités chez le gagnant ${((100 * agg.majShareWinner) / GAMES).toFixed(0)}%`);
console.log("  joueurs récompensés par majorité (moy./partie):", Object.fromEntries(Object.entries(agg.majWinners).map(([k, v]) => [k, (v / GAMES).toFixed(1)])));
for (const [k, c] of Object.entries(agg.ct)) console.log(`  contrat ${k}: réussi ${Math.round((100 * c.ok) / c.n)}%, bonus moyen ${(c.pts / c.n).toFixed(1)}, signatures ${(c.sig / c.n).toFixed(2)}`);
console.log(`  part du contrat dans le score du gagnant ${Math.round((100 * agg.ctWinner) / GAMES)}%`);
const nAct = (N / 2) * GAMES;
console.log("  objectifs atteints (joueurs actifs):", Object.fromEntries(Object.entries(agg.obj).filter(([k]) => !k.startsWith("maj")).sort((a, b) => b[1] - a[1]).map(([k, v]) => [k, Math.round((100 * v) / nAct) + "%"])));
