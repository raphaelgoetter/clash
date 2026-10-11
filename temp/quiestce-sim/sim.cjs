// Simulateur "Qui est-ce ?" jeu spécial 7 jours (usage local uniquement)
// node temp/quiestce-sim/sim.cjs
const fs = require('fs');
const path = require('path');

const CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/cardNames.json'), 'utf8'))
  .filter(c => c.elixir != null);
const RAR = { common: 0, rare: 1, epic: 2, legendary: 3, champion: 4 };

// Questions à seuils fixes (attribut absent => "non")
const QUESTIONS = [
  ['rare ou plus', c => RAR[c.rarity] >= 1],
  ['épique ou plus', c => RAR[c.rarity] >= 2],
  ['légendaire ou plus', c => RAR[c.rarity] >= 3],
  ['champion', c => c.rarity === 'champion'],
  ...[2, 3, 4, 5, 6, 7].map(k => [`${k}+ élixir`, c => c.elixir >= k]),
  ['troupe terrestre', c => c.type === 'troop'],
  ['aérienne', c => c.type === 'flying'],
  ['sort', c => c.type === 'spell'],
  ['bâtiment', c => c.type === 'building'],
  ['à distance', c => c.range && c.range.kind === 'ranged'],
  ['humain', c => c.family === 'human'],
  ['gobelin', c => c.family === 'goblin'],
  ['squelette', c => c.family === 'skeleton'],
  ['PV > 1000', c => (c.hp || 0) > 1000],
  ['PV > 2000', c => (c.hp || 0) > 2000],
  ['dégâts > 200', c => (c.damage || 0) > 200],
  ['dégâts > 400', c => (c.damage || 0) > 400],
  ['nom A-M', c => c.fr.normalize('NFD').toUpperCase()[0] <= 'M'],
];

const OPEN_QUESTIONS = [
  ['rareté ?', c => c.rarity],
  ['élixir ?', c => c.elixir],
  ['type ?', c => c.type],
  ['portée ?', c => (c.range && c.range.kind) || 'aucune'],
  ['famille ?', c => c.family || 'aucune'],
];

let seed = 12345;
// mulberry32 (entiers 32 bits, pas de perte de précision)
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

function drawGrid(size) {
  for (;;) {
    const g = shuffle(CARDS).slice(0, size);
    const n = t => g.filter(c => c.type === t).length;
    const champ = g.filter(c => c.rarity === 'champion').length;
    if (n('spell') >= 4 && n('building') >= 2 && n('flying') >= 3 && champ >= 1 && champ <= 2) return g;
  }
}

const cardKind = c => (c.type === 'spell' || c.type === 'building') ? 'sort/bât' : c.type === 'flying' ? 'aérien' : 'troupe';

function playGame(R, N) {
  const grid = drawGrid(R.gridSize);
  const deck = shuffle(grid);
  const strategies = R.mix(N);
  const P = strategies.map((s, i) => ({
    id: i, strat: s, card: deck[i], score: 0, revealedDay: null, hidden: false,
    activity: s === 'passif' ? 1 : s === 'occasionnel' ? 0.55 + rnd() * 0.3 : 0.8 + rnd() * 0.2,
    know: {},           // targetId -> liste de cartes candidates
    correct: 0, wrong: 0, askedBy: [], // [{day, by}]
    timesFound: 0, noHide: R.hideAB ? rnd() < 0.5 : false,
  }));
  if (R.assigned) {
    const order = shuffle(P.map(p => p.id));
    order.forEach((id, i) => { P[id].target = order[(i + 1) % order.length]; P[id].found = new Set(); });
  }
  let wasted = 0;
  const team = R.collusion ? [0, 1] : null; // 2 joueurs qui partagent leurs infos
  let free = deck.slice(N);
  const revealedCards = () => R.assigned ? [] : P.filter(p => p.revealedDay != null).map(p => p.card);

  const cands = (me, t) => {
    if (!me.know[t.id]) me.know[t.id] = grid.slice();
    const excl = new Set([me.card, ...revealedCards()]);
    if (team && team.includes(me.id)) team.forEach(o => excl.add(P[o].card));
    return me.know[t.id].filter(c => !excl.has(c));
  };
  const setKnow = (me, t, list) => {
    me.know[t.id] = list;
    if (team && team.includes(me.id)) team.forEach(o => { P[o].know[t.id] = list.slice(); });
  };

  for (let day = 1; day <= 7; day++) {
    const gain = R.gain(day);
    for (const me of shuffle(P)) {
      if (me.strat === 'passif' || rnd() > me.activity) continue;
      const others = R.assigned ? [P[me.target]] : P.filter(t => t.id !== me.id && t.revealedDay == null && !(team && team.includes(me.id) && team.includes(t.id)));
      if (!others.length) continue;

      // Se cacher : >= 2 interrogateurs distincts sur les 2 derniers jours
      if (R.hideCost != null && !me.noHide && !me.hidden && (R.assigned || me.revealedDay == null) && me.strat !== 'occasionnel') {
        const recent = new Set(me.askedBy.filter(a => a.day >= day - 1).map(a => a.by));
        // 'close' : un même chasseur a posé >= 2 questions depuis la dernière réinitialisation
        const per = {}; me.askedBy.filter(a => a.day > (me.resetDay || 0)).forEach(a => { per[a.by] = (per[a.by] || 0) + 1; });
        const trig = R.hideTrigger === 'close' ? Math.max(0, ...Object.values(per)) >= 2 : recent.size >= 2;
        if (trig) {
          const nc = pick(free);
          free = free.filter(c => c !== nc).concat([me.card]);
          me.card = nc; me.hidden = true; me.hideDay = day; me.score -= R.hideCost;
          P.forEach(o => { delete o.know[me.id]; }); // journal public : déductions invalidées
          me.resetDay = day;
          if (!R.hideFree) continue;
        }
      }

      // Choix de la cible
      let target;
      if (me.strat === 'occasionnel') target = me.lastTarget && others.includes(me.lastTarget) && rnd() < 0.7 ? me.lastTarget : pick(others);
      else target = others.slice().sort((a, b) => cands(me, a).length - cands(me, b).length || rnd() - 0.5)[0];
      me.lastTarget = target;
      const cs = cands(me, target);
      const k = cs.length;
      const success = () => {
        me.score += gain; me.correct++;
        if (target.revealedDay == null) target.revealedDay = day;
        if (R.assigned) {
          target.score -= R.victimPenalty || 0; target.timesFound++;
          me.found.add(target.id); delete me.know[target.id];
          const pool = P.filter(t => t.id !== me.id && !me.found.has(t.id));
          if (pool.length) {
            const hunters = t => P.filter(h => h.target === t.id).length;
            const m = Math.min(...pool.map(hunters));
            me.target = pick(pool.filter(t => hunters(t) === m)).id;
          }
        } else {
          // enquêtes des autres joueurs sur cette cible perdues
          P.forEach(o => { if (o !== me && o.know[target.id] && o.know[target.id].length < grid.length) wasted++; });
        }
      };

      const tryAccuse = (cs) => {
        const k = cs.length;
        const threshold = { optimal: k <= 1 || (k === 2 && day >= 4) || (day === 7 && k <= 3),
          prudent: k <= 1, parieur: k <= 2 || (day === 7 && k <= 4),
          occasionnel: k <= 1 || (day === 7 && k <= 2) }[me.strat];
        if (!(threshold && k > 0)) return false;
        const guess = pick(cs);
        if (guess === target.card) success();
        else { me.score -= R.penalty; me.wrong++; setKnow(me, target, cs.filter(c => c !== guess)); }
        return true;
      };
      // Accusation ?
      const threshold = { optimal: k <= 1 || (k === 2 && day >= 4) || (day === 7 && k <= 3),
        prudent: k <= 1, parieur: k <= 2 || (day === 7 && k <= 4),
        occasionnel: k <= 1 || (day === 7 && k <= 2) }[me.strat];
      if (threshold && k > 0) {
        const guess = pick(cs);
        if (guess === target.card) {
          success();
        } else {
          me.score -= R.penalty; me.wrong++;
          setKnow(me, target, cs.filter(c => c !== guess));
        }
        continue;
      }

      // Question
      let q;
      const QS = R.open ? OPEN_QUESTIONS : QUESTIONS;
      if (me.strat === 'occasionnel') q = pick(QS);
      else if (R.open) {
        const best = QS.map(qq => { const m = {}; cs.forEach(c => { const v = qq[1](c); m[v] = (m[v] || 0) + 1; }); return [qq, Object.values(m).reduce((a, b) => a + b * b, 0)]; }).sort((a, b) => a[1] - b[1]);
        q = (me.strat === 'optimal' ? best[0] : pick(best.slice(0, 3)))[0];
      }
      else {
        const best = QUESTIONS.map(qq => [qq, Math.abs(cs.filter(qq[1]).length - k / 2)]).sort((a, b) => a[1] - b[1]);
        q = (me.strat === 'optimal' ? best[0] : pick(best.slice(0, 4)))[0];
      }
      const ans = q[1](target.card);
      setKnow(me, target, cs.filter(c => q[1](c) === ans));
      target.askedBy.push({ day, by: me.id });
      if (R.sameDayAccuse) tryAccuse(cands(me, target));
    }
  }

  // Bonus de fin
  for (const p of P) {
    if (p.revealedDay == null && R.bonus(p)) p.score += R.bonusPts;
  }
  return { P, team, wasted };
}

function run(name, R, games = 3000) {
  const st = {}; const kinds = {}; let revealedTotal = 0, players = 0, wrongTot = 0, accTot = 0;
  const dayHist = Array(8).fill(0); let passiveRank = 0, passiveGames = 0, teamRank = 0, ties = 0;
  const ab = { hide: { n: 0, score: 0, found: 0, used: 0 }, nohide: { n: 0, score: 0, found: 0, used: 0 } };
  const winnersScore = []; let wastedTot = 0, le0 = 0, hides = 0, hideDaySum = 0, multiHit = 0, corrHist = {};
  for (let g = 0; g < games; g++) {
    const N = 15 + Math.floor(rnd() * 6);
    const { P, team, wasted } = playGame(R, N); wastedTot += wasted;
    const sorted = P.slice().sort((a, b) => b.score - a.score);
    winnersScore.push(sorted[0].score);
    if (sorted[1].score === sorted[0].score) ties++;
    const rankOf = p => sorted.findIndex(x => x.score === p.score) + 1;
    for (const p of P) {
      const s = st[p.strat] ||= { n: 0, score: 0, win: 0, rev: 0 };
      s.n++; s.score += p.score; if (rankOf(p) === 1) s.win++; if (p.revealedDay != null) s.rev++;
      const kd = kinds[cardKind(p.card)] ||= { n: 0, rev: 0, day: 0 };
      kd.n++; if (p.revealedDay != null) { kd.rev++; kd.day += p.revealedDay; dayHist[p.revealedDay]++; revealedTotal++; }
      if (p.score <= 0) le0++; if (p.hidden) { hides++; hideDaySum += p.hideDay; }
      corrHist[p.correct] = (corrHist[p.correct] || 0) + 1;
      if (R.hideAB && ['optimal', 'prudent', 'parieur'].includes(p.strat)) {
        const a = ab[p.noHide ? 'nohide' : 'hide']; a.n++; a.score += p.score; a.found += p.timesFound; if (p.hidden) a.used++;
      }
      players++; wrongTot += p.wrong; accTot += p.wrong + p.correct;
      if (p.strat === 'passif') { passiveRank += rankOf(p) / N; passiveGames++; }
    }
    if (team) teamRank += (rankOf(P[0]) + rankOf(P[1])) / 2 / N;
  }
  console.log(`\n=== ${name} ===`);
  console.log(`démasqués : ${(100 * revealedTotal / players).toFixed(0)}% | jour : ${dayHist.slice(1).map((v, i) => `J${i + 1} ${(100 * v / revealedTotal).toFixed(0)}%`).join(' ')}`);
  console.log(`accusations fausses : ${(100 * wrongTot / accTot).toFixed(0)}% | score gagnant moyen ${(winnersScore.reduce((a, b) => a + b, 0) / games).toFixed(1)} | égalités en tête ${(100 * ties / games).toFixed(0)}%`);
  if (!R.assigned) console.log(`enquêtes perdues (cible démasquée par un autre) : ${(wastedTot / players).toFixed(2)} par joueur`);
  console.log(`joueurs à <= 0 pt : ${(100 * le0 / players).toFixed(0)}% | se cachent : ${(100 * hides / players).toFixed(0)}% (jour moyen ${(hideDaySum / hides).toFixed(1)}) | nb démasquages réussis/joueur : ${Object.entries(corrHist).map(([k, v]) => `${k}:${(100 * v / players).toFixed(0)}%`).join(' ')}`);
  for (const [k, s] of Object.entries(st)) console.log(`  ${k.padEnd(12)} score ${(s.score / s.n).toFixed(1).padStart(5)} | victoire ${(100 * s.win / s.n).toFixed(1).padStart(5)}% | démasqué ${(100 * s.rev / s.n).toFixed(0)}%`);
  for (const [k, s] of Object.entries(kinds)) console.log(`  carte ${k.padEnd(9)} démasquée ${(100 * s.rev / s.n).toFixed(0)}% (jour moyen ${(s.day / s.rev).toFixed(1)})`);
  if (R.hideAB) for (const [k, a] of Object.entries(ab)) console.log(`  A/B ${k.padEnd(7)} score ${(a.score / a.n).toFixed(1)} | fois démasqué ${(a.found / a.n).toFixed(2)} | s'est caché ${(100 * a.used / a.n).toFixed(0)}%`);
  if (passiveGames) console.log(`  passif : rang relatif moyen ${(100 * passiveRank / passiveGames).toFixed(0)}% (0% = 1er)`);
  if (R.collusion) console.log(`  binôme complice : rang relatif moyen ${(100 * teamRank / games).toFixed(0)}%`);
}

// Répartition réaliste : 1 passif, ~25% optimal, 20% prudent, 20% parieur, reste occasionnel
const mix = N => shuffle(['passif', ...Array.from({ length: N - 1 }, (_, i) => {
  const r = i / (N - 1); return r < 0.25 ? 'optimal' : r < 0.45 ? 'prudent' : r < 0.65 ? 'parieur' : 'occasionnel';
})]);

const BASE = { gridSize: 24, mix, gain: d => 12 - d, penalty: 3, hideCost: 2, bonusPts: 5, bonus: () => true };
const V = process.argv[2] || 'all';
const B2 = { ...BASE, bonus: p => p.correct > 0 };
const O = { ...B2, sameDayAccuse: true, open: true, gridSize: 30, penalty: 1 };
const A = { ...O, assigned: true, victimPenalty: 2, hideAB: true };
run('A/B cacher : déclencheur 2 interrogateurs, coût 2 + action', A);
run('A/B cacher : déclencheur chasseur proche, coût 2 + action', { ...A, hideTrigger: 'close' });
run('A/B cacher : chasseur proche, gratuit + action', { ...A, hideTrigger: 'close', hideCost: 0 });
run('A/B cacher : chasseur proche, coût 2, sans perdre l action', { ...A, hideTrigger: 'close', hideFree: true });
run('A/B cacher : chasseur proche, coût 0, sans perdre l action', { ...A, hideTrigger: 'close', hideFree: true, hideCost: 0 });
