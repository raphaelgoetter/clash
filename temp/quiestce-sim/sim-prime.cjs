// Simulateur "Qui est-ce ?" variante Prime (usage local uniquement)
// Cibles choisies avec limite de chasseurs par cible, prime croissante, questions ouvertes,
// accusation le jour même. node temp/quiestce-sim/sim-prime.cjs
const fs = require('fs');
const path = require('path');

const CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/cardNames.json'), 'utf8'))
  .filter(c => c.elixir != null);

const QSET = process.env.QSET || 'exact';
const QUESTIONS = QSET === 'D' ? [
  ['rareté', c => c.rarity === 'champion' ? 'legendary' : c.rarity],
  ['élixir', c => c.elixir <= 2 ? '1-2' : c.elixir === 3 ? '3' : c.elixir === 4 ? '4' : '5+'],
  ['type', c => c.type],
  ['portée', c => (c.range && c.range.kind) || 'aucune'],
  ['famille', c => c.family || 'aucune'],
  ['PV', c => !c.hp ? 'aucun' : c.hp < 500 ? '<500' : c.hp <= 1500 ? '500-1500' : '>1500'],
] : [
  ['rareté', c => c.rarity],
  ['élixir', c => c.elixir],
  ['type', c => c.type],
  ['portée', c => (c.range && c.range.kind) || 'aucune'],
  ['famille', c => c.family || 'aucune'],
];

let seed = 777;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };

function drawGrid(size) {
  for (;;) {
    const g = shuffle(CARDS).slice(0, size);
    const n = t => g.filter(c => c.type === t).length;
    const champ = g.filter(c => c.rarity === 'champion').length;
    const twins = process.env.NOTWINS && new Set(g.map(c => QUESTIONS.map(q => q[1](c)).join('|'))).size < g.length;
    if (!twins && n('spell') >= 4 && n('building') >= 2 && n('flying') >= 3 && champ >= 1 && champ <= 2) return g;
  }
}

// Profils : seuil d'accusation (nb de candidats) et seuil de changement de cible (écart de prime)
const PROFILES = {
  optimal: { accuse: (k, d) => k <= 1 || (k === 2 && d >= 4) || (d === 7 && k <= 3), switchGap: 4, smartQ: true, choose: 'value' },
  parieur: { accuse: (k, d) => k <= 2 || (d === 7 && k <= 4), switchGap: 3, smartQ: true, choose: 'prime' },
  prudent: { accuse: k => k <= 1, switchGap: 7, smartQ: true, choose: 'value' },
  occasionnel: { accuse: (k, d) => k <= 1 || (d === 7 && k <= 2), switchGap: Infinity, smartQ: false, choose: 'random' },
  passif: null,
};
const mix = N => shuffle(['passif', ...Array.from({ length: N - 1 }, (_, i) => {
  const r = i / (N - 1); return r < 0.25 ? 'optimal' : r < 0.45 ? 'prudent' : r < 0.65 ? 'parieur' : 'occasionnel';
})]);

function playGame(R, N) {
  const grid = drawGrid(R.gridSize);
  const deck = shuffle(grid);
  let free = deck.slice(N);
  const P = mix(N).map((s, i) => ({
    id: i, strat: s, prof: PROFILES[s], card: deck[i], score: 0, prime: 0,
    activity: s === 'passif' ? 0 : s === 'occasionnel' ? 0.55 + rnd() * 0.3 : 0.8 + rnd() * 0.2,
    target: null, know: null, found: 0, timesFound: 0, foundToday: false, switches: 0,
    noSwitch: R.switchAB ? rnd() < 0.5 : false,
    knownCards: new Map(), // id -> carte connue (démasquage secret)
    history: [],
  }));
  // mêmes profils suivis avec ou sans collusion (point de comparaison)
  const watched = [P.find(p => p.strat === 'optimal'), P.find(p => p.strat === 'parieur')];
  const team = R.collusion ? watched : [];
  const isTeam = p => team.includes(p);
  const hunters = t => P.filter(h => h.target === t.id).length;
  let maxHunters = 0;

  // Carte déjà connue de moi (ou de mon complice) et encore valable
  const knownCard = (me, t) => {
    const srcs = isTeam(me) ? team : [me];
    for (const s of srcs) { const c = s.knownCards.get(t.id); if (c && c === t.card) return c; }
    return null;
  };

  const chooseTarget = (me, day) => {
    const avail = P.filter(t => t !== me && !(isTeam(me) && isTeam(t)) && hunters(t) < R.cap
      && (R.swapOnFound || !me.knownCards.has(t.id) || R.allowRehunt));
    if (!avail.length) { me.target = null; return; }
    let t;
    const known = avail.filter(x => knownCard(me, x));
    if (known.length && (R.allowRehunt || isTeam(me))) t = known.sort((a, b) => b.prime - a.prime)[0];
    else if (me.prof.choose === 'random') t = pick(avail);
    else {
      // 'prime' : la plus grosse prime ; 'value' : prime pondérée par la difficulté estimée (fraîche = égale)
      t = avail.slice().sort((a, b) => b.prime - a.prime || rnd() - 0.5)[0];
    }
    me.target = t.id; me.know = grid.slice();
    maxHunters = Math.max(maxHunters, hunters(t));
  };

  for (let day = 1; day <= 7; day++) {
    const gain = R.base(day);
    P.forEach(p => { p.foundToday = false; });
    for (const me of shuffle(P)) {
      if (!me.prof || rnd() > me.activity) continue;
      if (me.target == null) chooseTarget(me, day);
      if (me.target == null) continue;
      let target = P[me.target];

      // Changer de cible (coûte l'action du jour)
      if (!me.noSwitch && R.allowSwitch) {
        const cs0 = me.know.filter(c => c !== me.card);
        const best = P.filter(t => t !== me && t !== target && hunters(t) < R.cap && !(isTeam(me) && isTeam(t))
          && (R.swapOnFound || !me.knownCards.has(t.id))).sort((a, b) => b.prime - a.prime)[0];
        if (best && cs0.length > 3 && best.prime - target.prime >= me.prof.switchGap) {
          me.target = best.id; me.know = grid.slice(); me.switches++;
          maxHunters = Math.max(maxHunters, hunters(best));
          continue;
        }
      }

      const accuse = (guess) => {
        if (guess === target.card) {
          me.score += gain + target.prime;
          me.found++; me.prime += R.primeOnFind; target.timesFound++; target.foundToday = true;
          target.prime = 0;
          me.knownCards.set(target.id, target.card);
          if (R.swapOnFound) {
            const nc = pick(free); free = free.filter(c => c !== nc).concat([target.card]); target.card = nc;
            P.forEach(h => { if (h.target === target.id && h !== me) h.know = grid.slice(); });
          }
          chooseTarget(me, day);
          return true;
        }
        me.score -= R.penalty; me.know = me.know.filter(c => c !== guess);
        return false;
      };

      // Carte déjà connue (re-chasse ou info du complice) : accusation directe
      const kc = knownCard(me, target);
      if (kc) { accuse(kc); continue; }

      // Question
      const excl = new Set([me.card, ...(isTeam(me) ? team.map(t => t.card) : [])]);
      let cs = me.know.filter(c => !excl.has(c));
      let q;
      if (!me.prof.smartQ) q = pick(QUESTIONS);
      else {
        const sc = QUESTIONS.map(qq => { const m = {}; cs.forEach(c => { const v = qq[1](c); m[v] = (m[v] || 0) + 1; }); return [qq, Object.values(m).reduce((a, b) => a + b * b, 0)]; }).sort((a, b) => a[1] - b[1]);
        q = (me.strat === 'optimal' ? sc[0] : pick(sc.slice(0, 3)))[0];
      }
      const ans = q[1](target.card);
      me.know = me.know.filter(c => q[1](c) === ans);
      cs = me.know.filter(c => !excl.has(c));
      if (cs.length && me.prof.accuse(cs.length, day)) accuse(pick(cs));
    }
    // Fin de journée : +1 de prime pour qui n'a pas été démasqué
    P.forEach(p => { if (!p.foundToday) p.prime += R.primePerDay; });
  }
  return { P, team: watched, maxHunters };
}

function run(name, R, games = 3000) {
  const st = {}; const byFound = {}; let players = 0, le0 = 0, ties = 0, winFound = 0, winTimes = 0, maxH = 0, sumMaxH = 0;
  const ab = { switch: { n: 0, s: 0, used: 0 }, nosw: { n: 0, s: 0, used: 0 } }; let teamRank = 0, winnerScore = 0, spread = 0;
  for (let g = 0; g < games; g++) {
    const N = 15 + Math.floor(rnd() * 6);
    const { P, team, maxHunters } = playGame(R, N);
    const sorted = P.slice().sort((a, b) => b.score - a.score);
    const rankOf = p => sorted.findIndex(x => x.score === p.score) + 1;
    if (sorted[1].score === sorted[0].score) ties++;
    winFound += sorted[0].found; winTimes += sorted[0].timesFound; winnerScore += sorted[0].score;
    spread += sorted[0].score - sorted[Math.floor(N / 2)].score;
    sumMaxH += maxHunters; maxH = Math.max(maxH, maxHunters);
    for (const p of P) {
      const s = st[p.strat] ||= { n: 0, score: 0, win: 0, found: 0, times: 0 };
      s.n++; s.score += p.score; s.found += p.found; s.times += p.timesFound; if (rankOf(p) === 1) s.win++;
      const b = byFound[Math.min(p.found, 4)] ||= { n: 0, times: 0, score: 0 };
      b.n++; b.times += p.timesFound; b.score += p.score;
      if (p.score <= 0) le0++; players++;
      if (R.switchAB && ['optimal', 'parieur', 'prudent'].includes(p.strat)) {
        const a = ab[p.noSwitch ? 'nosw' : 'switch']; a.n++; a.s += p.score; if (p.switches) a.used++;
      }
    }
    if (team.length) teamRank += team.reduce((a, p) => a + rankOf(p) / N, 0) / team.length;
  }
  console.log(`\n=== ${name} ===`);
  console.log(`score gagnant ${(winnerScore / games).toFixed(1)} | écart 1er-médian ${(spread / games).toFixed(1)} | égalités ${(100 * ties / games).toFixed(0)}% | joueurs <= 0 : ${(100 * le0 / players).toFixed(0)}% | chasseurs max sur une cible : moy ${(sumMaxH / games).toFixed(1)}, max ${maxH}`);
  console.log(`gagnant : ${(winFound / games).toFixed(1)} démasquages réalisés, démasqué ${(winTimes / games).toFixed(1)} fois`);
  for (const [k, s] of Object.entries(st)) console.log(`  ${k.padEnd(12)} score ${(s.score / s.n).toFixed(1).padStart(5)} | victoire ${(100 * s.win / s.n).toFixed(1).padStart(5)}% | démasque ${(s.found / s.n).toFixed(2)} | démasqué ${(s.times / s.n).toFixed(2)}`);
  console.log('  leader écrasé ? (selon nb de démasquages réalisés) ' + Object.entries(byFound).map(([k, b]) => `${k}${k === '4' ? '+' : ''} → démasqué ${(b.times / b.n).toFixed(2)} fois, score ${(b.score / b.n).toFixed(0)} (${(100 * b.n / players).toFixed(0)}%)`).join(' | '));
  if (R.switchAB) for (const [k, a] of Object.entries(ab)) console.log(`  A/B ${k === 'switch' ? 'peut changer' : 'ne change pas'} : score ${(a.s / a.n).toFixed(1)} | a changé au moins 1 fois ${(100 * a.used / a.n).toFixed(0)}%`);
  console.log(`  binôme ${R.collusion ? 'COMPLICE' : 'témoin (sans triche)'} : rang relatif moyen ${(100 * teamRank / games).toFixed(0)}% (50% = neutre)`);
}

const BASE = { gridSize: 30, base: d => 12 - d, penalty: 1, primePerDay: 1, primeOnFind: 3, cap: 2, allowSwitch: true, switchAB: true, swapOnFound: false };
run(`Limite 2, questions ${QSET}${process.env.NOTWINS ? ', sans jumelles' : ''}`, BASE);
