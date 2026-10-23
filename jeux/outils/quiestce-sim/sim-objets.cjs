// Simulateur "Qui est-ce ?" : Prime + pool de questions par jour + objets (usage local uniquement)
// node jeux/outils/quiestce-sim/sim-objets.cjs
const fs = require('fs');
const path = require('path');

const CARDS = JSON.parse(fs.readFileSync(path.join(__dirname, '../../data/cardNames.json'), 'utf8'))
  .filter(c => c.elixir != null);

const Q = {
  rareté: c => c.rarity === 'champion' ? 'legendary' : c.rarity,
  élixir: c => c.elixir <= 2 ? '1-2' : c.elixir === 3 ? '3' : c.elixir === 4 ? '4' : '5+',
  type: c => c.type,
  portée: c => (c.range && c.range.kind) || 'aucune',
  famille: c => c.family || 'aucune',
  PV: c => !c.hp ? 'aucun' : c.hp < 500 ? '<500' : c.hp <= 1500 ? '500-1500' : '>1500',
};
const QK = Object.keys(Q);

// Calendrier fixe : 3 questions par jour, chaque question 3 à 4 fois sur la semaine
const POOL = {
  1: ['rareté', 'élixir', 'type'],
  2: ['portée', 'famille', 'PV'],
  3: ['rareté', 'type', 'PV'],
  4: ['élixir', 'portée', 'famille'],
  5: ['rareté', 'élixir', 'portée'],
  6: ['type', 'famille', 'PV'],
  7: ['rareté', 'élixir', 'PV'],
};

let seed = 4242;
const rnd = () => { seed |= 0; seed = seed + 0x6D2B79F5 | 0; let t = Math.imul(seed ^ seed >>> 15, 1 | seed); t = t + Math.imul(t ^ t >>> 7, 61 | t) ^ t; return ((t ^ t >>> 14) >>> 0) / 4294967296; };
const pick = a => a[Math.floor(rnd() * a.length)];
const shuffle = a => { const b = [...a]; for (let i = b.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [b[i], b[j]] = [b[j], b[i]]; } return b; };
const sig = c => QK.map(k => Q[k](c)).join('|');

function drawGrid(size) {
  for (;;) {
    const g = shuffle(CARDS).slice(0, size);
    const n = t => g.filter(c => c.type === t).length;
    const champ = g.filter(c => c.rarity === 'champion').length;
    if (new Set(g.map(sig)).size === g.length && n('spell') >= 4 && n('building') >= 2 && n('flying') >= 3 && champ >= 1 && champ <= 2) return g;
  }
}

const PROFILES = {
  optimal: { accuse: (k, d) => k <= 1 || (k === 2 && d >= 4) || (d === 7 && k <= 3), smartQ: true },
  parieur: { accuse: (k, d) => k <= 2 || (d === 7 && k <= 4), smartQ: true },
  prudent: { accuse: k => k <= 1, smartQ: true },
  occasionnel: { accuse: (k, d) => k <= 1 || (d === 7 && k <= 2), smartQ: false },
  passif: null,
};
const SMART = ['optimal', 'parieur', 'prudent'];
const mix = N => shuffle(['passif', ...Array.from({ length: N - 1 }, (_, i) => {
  const r = i / (N - 1); return r < 0.25 ? 'optimal' : r < 0.45 ? 'prudent' : r < 0.65 ? 'parieur' : 'occasionnel';
})]);

const OBJ = ['projecteur', 'vol', 'brouillage', 'double', 'usurpation'];

function playGame(R, N) {
  const grid = drawGrid(R.gridSize || 30);
  const deck = shuffle(grid);
  const P = mix(N).map((s, i) => ({
    id: i, strat: s, prof: PROFILES[s], card: deck[i], score: 0, prime: 0, or: 0,
    activity: s === 'passif' ? 0 : s === 'occasionnel' ? 0.55 + rnd() * 0.3 : 0.8 + rnd() * 0.2,
    target: null, know: null, asked: new Set(), found: 0, timesFound: 0, foundToday: false,
    foundIds: new Set(), knownCards: new Map(), blockedDay: 0, usurped: false, forbid: new Set(),
    allowed: Object.fromEntries(OBJ.map(o => [o, R.objects.includes(o) && SMART.includes(s) && (R.ab ? rnd() < 0.5 : true)])),
    used: Object.fromEntries(OBJ.map(o => [o, 0])), stuck: 0,
  }));
  const hunters = t => P.filter(h => h.target === t.id);
  const candsOf = me => me.know.filter(c => c !== me.card && !(R.excludeKnown && [...me.knownCards.values()].includes(c)));

  const resetHuntersOf = t => hunters(t).forEach(h => { h.know = grid.slice(); h.asked = new Set(); });

  const chooseTarget = me => {
    const avail = P.filter(t => t !== me && hunters(t).length < R.cap && !me.foundIds.has(t.id) && !me.forbid.has(t.id));
    if (!avail.length) { me.target = null; return; }
    let t;
    if (R.auto === 'random') t = pick(avail);
    else if (R.auto === 'maxPrime') t = avail.sort((a, b) => b.prime - a.prime || rnd() - 0.5)[0];
    else t = me.strat === 'occasionnel' ? pick(avail) : avail.sort((a, b) => b.prime - a.prime || rnd() - 0.5)[0];
    me.target = t.id; me.know = grid.slice(); me.asked = new Set();
    if (R.freeClue) { const k = pick(QK); me.know = me.know.filter(c => Q[k](c) === Q[k](t.card)); me.asked.add(k); }
  };

  const askBest = (me, target, day) => {
    let pool = (R.pool ? POOL[day] : QK).filter(k => !me.asked.has(k));
    // Pool du jour épuisé sur cette cible : choix libre parmi les questions restantes
    if (!pool.length) { me.stuck++; pool = QK.filter(k => !me.asked.has(k)); }
    if (!pool.length) return false;
    const cs = candsOf(me);
    let k;
    if (!me.prof.smartQ) k = pick(pool);
    else {
      const sc = pool.map(qk => { const m = {}; cs.forEach(c => { const v = Q[qk](c); m[v] = (m[v] || 0) + 1; }); return [qk, Object.values(m).reduce((a, b) => a + b * b, 0)]; }).sort((a, b) => a[1] - b[1]);
      k = (me.strat === 'optimal' ? sc[0] : pick(sc.slice(0, 2)))[0];
    }
    const ans = Q[k](target.card);
    me.know = me.know.filter(c => Q[k](c) === ans); me.asked.add(k);
    return true;
  };

  // Première cible attribuée : cercle aléatoire (1 chasseur par cible)
  if (R.initialCycle) {
    const ring = shuffle(P.map(p => p.id));
    ring.forEach((id, i) => { const me = P[id]; me.target = ring[(i + 1) % ring.length]; me.know = grid.slice(); me.asked = new Set(); });
  }
  let maxH1 = 0;
  for (let day = 1; day <= 7; day++) {
    const gain = 12 - day;
    P.forEach(p => { p.foundToday = false; });
    let order = 0;
    for (const me of shuffle(P)) {
      order++;
      if (!me.prof || rnd() > me.activity) continue;
      me.or += R.orPerDay;
      if (me.target == null) chooseTarget(me);
      if (me.target == null) continue;
      let target = P[me.target];

      // ---- Objets (1 max par jour, en plus de l'action) ----
      let usedObj = false;
      const can = (o, cost) => !usedObj && me.allowed[o] && me.or >= cost;
      const pay = (o, cost) => { me.or -= cost; me.used[o]++; usedObj = true; };
      const myHunters = hunters(me);
      // Usurpation : mon chasseur est avancé et j'ai démasqué quelqu'un
      if (can('usurpation', R.cost.usurpation) && !me.usurped && me.foundIds.size && myHunters.some(h => h.asked.size >= 2)) {
        const victim = P.find(v => me.foundIds.has(v.id) && v.card === me.knownCards.get(v.id));
        if (victim) {
          [me.card, victim.card] = [victim.card, me.card];
          resetHuntersOf(me); resetHuntersOf(victim); victim.forbid.add(me.id);
          me.usurped = true; pay('usurpation', R.cost.usurpation);
        }
      }
      // Brouillage : un rival sur ma cible est plus avancé que moi, ou mon chasseur est proche
      if (can('brouillage', R.cost.brouillage)) {
        const rival = hunters(target).find(h => h !== me && h.asked.size > me.asked.size && h.asked.size >= 2);
        const close = myHunters.find(h => h.asked.size >= 2);
        const v = R.brouillageRivalOnly ? rival : (rival || close);
        if (v) { v.blockedDay = day + 1; pay('brouillage', R.cost.brouillage); }
      }
      // Vol de piste : copie des déductions d'un rival sur la même cible
      if (can('vol', R.cost.vol)) {
        const rival = hunters(target).find(h => h !== me && h.asked.size > me.asked.size);
        if (rival && !(R.volOnce && me.used.vol)) {
          if (R.volMode === 'last') {
            const k = [...rival.asked].reverse().find(x => !me.asked.has(x));
            if (k) { me.know = me.know.filter(c => Q[k](c) === Q[k](target.card)); me.asked.add(k); pay('vol', R.cost.vol); }
          } else { me.know = me.know.filter(c => rival.know.includes(c)); rival.asked.forEach(k => me.asked.add(k)); pay('vol', R.cost.vol); }
        }
      }
      // Projecteur : ma cible est le leader en prime, révèle publiquement un attribut du pool du jour
      if (can('projecteur', R.cost.projecteur) && target.prime === Math.max(...P.map(p => p.prime)) && candsOf(me).length > 2) {
        const pool = (R.pool ? POOL[day] : QK);
        const k = pool.find(x => !me.asked.has(x)) || pool[0];
        const v = Q[k](target.card);
        hunters(target).forEach(h => { h.know = h.know.filter(c => Q[k](c) === v); h.asked.add(k); });
        pay('projecteur', R.cost.projecteur);
      }

      if (me.blockedDay === day) { me.blocked = (me.blocked || 0) + 1; }
      else {
        askBest(me, target, day);
        if (can('double', R.cost.double) && !(R.doubleOnce && me.used.double) && candsOf(me).length > 2 && askBest(me, target, day)) pay('double', R.cost.double);
      }

      // ---- Accusation ----
      const cs = candsOf(me);
      if (cs.length && me.prof.accuse(cs.length, day)) {
        const guess = pick(cs);
        if (guess === target.card) {
          me.primeCash = (me.primeCash || 0) + target.prime; me.score += gain + target.prime; me.or += R.orOnFind; me.lastGain = day * 100 + order;
          me.found++; me.prime += 3; target.timesFound++; target.foundToday = true; target.prime = 0;
          me.foundIds.add(target.id); me.knownCards.set(target.id, target.card);
          chooseTarget(me);
          if (R.chain && me.target != null) {
            const nt = P[me.target]; askBest(me, nt, day);
          }
        } else {
          me.score -= 1; me.wrong = (me.wrong || 0) + 1; me.lastGain = day * 100 + order; me.know = me.know.filter(c => c !== guess);
        }
      }
    }
    if (day === 1) maxH1 = Math.max(...P.map(t => hunters(t).length));
    P.forEach(p => { if (!p.foundToday) p.prime += 1; });
  }
  P.maxH1 = maxH1;
  return P;
}

function run(name, R, games = 3000) {
  const st = {}; let players = 0, le0 = 0, ties = 0, winnerScore = 0, winFound = 0, stuck = 0, smartN = 0;
  const tb = { found: 0, wrong: 0, times: 0, first: 0, chain: 0 }; let tieGames = 0, orLeft = 0, h1 = 0, untargeted = 0; const lead = { 0: [0, 0], 3: [0, 0] }; let primeCash = 0, objUse = 0; const objHist = {};
  const ab = Object.fromEntries(OBJ.map(o => [o, { yes: { n: 0, s: 0, w: 0, u: 0 }, no: { n: 0, s: 0, w: 0 } }]));
  for (let g = 0; g < games; g++) {
    const N = 15 + Math.floor(rnd() * 6);
    const P = playGame(R, N); h1 += P.maxH1; untargeted += P.filter(t => !P.some(h => h.target === t.id)).length / N;
    const sorted = P.slice().sort((a, b) => b.score - a.score);
    const win = p => p.score === sorted[0].score;
    if (sorted[1].score === sorted[0].score) {
      ties++; tieGames++;
      const T = sorted.filter(p => p.score === sorted[0].score);
      const breaks = f => { const v = T.map(f); const best = Math.min(...v); return v.filter(x => x === best).length === 1; };
      if (breaks(p => -p.found)) tb.found++;
      if (breaks(p => p.wrong || 0)) tb.wrong++;
      if (breaks(p => p.timesFound)) tb.times++;
      if (breaks(p => p.lastGain || 0)) tb.first++;
      // chaîne : moins d'accusations fausses, puis moins démasqué, puis premier à atteindre le score
      if (breaks(p => (p.wrong || 0) * 1e6 + p.timesFound * 1e4 + (p.lastGain || 0))) tb.chain++;
    }
    winnerScore += sorted[0].score; winFound += sorted[0].found;
    for (const p of P) {
      const s = st[p.strat] ||= { n: 0, score: 0, win: 0, found: 0 };
      s.n++; s.score += p.score; s.found += p.found; if (win(p)) s.win++;
      if (p.score <= 0) le0++; players++;
      if (p.found === 0) { lead[0][0]++; lead[0][1] += p.timesFound; } if (p.found >= 3) { lead[3][0]++; lead[3][1] += p.timesFound; }
      if (SMART.includes(p.strat)) { primeCash += p.primeCash || 0; objUse += Object.values(p.used).reduce((a, b) => a + b, 0); }
      if (SMART.includes(p.strat)) {
        smartN++; stuck += p.stuck; orLeft += p.or;
        const nObj = Object.values(p.used).reduce((a, b) => a + b, 0); objHist[nObj] = (objHist[nObj] || 0) + 1;
        for (const o of R.objects) {
          const a = ab[o][p.allowed[o] ? 'yes' : 'no']; a.n++; a.s += p.score; if (win(p)) a.w++; if (p.allowed[o]) a.u += p.used[o];
        }
      }
    }
  }
  console.log(`\n=== ${name} ===`);
  console.log(`score gagnant ${(winnerScore / games).toFixed(1)} (${(winFound / games).toFixed(1)} démasquages) | égalités ${(100 * ties / games).toFixed(0)}% | joueurs <= 0 : ${(100 * le0 / players).toFixed(0)}% | jours sans question utile (pool) : ${(stuck / smartN).toFixed(2)}/joueur`);
  console.log(`  rattrapage : démasqué ${(lead[0][1] / lead[0][0]).toFixed(2)} fois (0 démasquage) vs ${(lead[3][1] / lead[3][0]).toFixed(2)} (3+) | prime encaissée/joueur actif ${(primeCash / smartN).toFixed(1)} | objets/joueur actif ${(objUse / smartN).toFixed(2)}`);
  console.log(`  fin J1 : chasseurs max sur une cible ${(h1 / games).toFixed(1)} | joueurs sans chasseur en fin de partie ${(100 * untargeted / games).toFixed(0)}%`);
  if (tieGames) console.log(`  départage des égalités : nb démasquages ${(100 * tb.found / tieGames).toFixed(0)}% | moins d'accusations fausses ${(100 * tb.wrong / tieGames).toFixed(0)}% | moins démasqué ${(100 * tb.times / tieGames).toFixed(0)}% | premier à atteindre le score ${(100 * tb.first / tieGames).toFixed(0)}% | chaîne fausses>démasqué>premier ${(100 * tb.chain / tieGames).toFixed(0)}%`);
  if (R.objects.length) console.log(`  Or restant en fin de partie : ${(orLeft / smartN).toFixed(1)}`);
  if (R.objects.length) console.log(`  objets utilisés par joueur actif : ${Object.entries(objHist).sort((a, b) => a[0] - b[0]).map(([k, v]) => `${k}:${(100 * v / smartN).toFixed(0)}%`).join(' ')}`);
  for (const [k, s] of Object.entries(st)) console.log(`  ${k.padEnd(12)} score ${(s.score / s.n).toFixed(1).padStart(5)} | victoire ${(100 * s.win / s.n).toFixed(1).padStart(5)}% | démasque ${(s.found / s.n).toFixed(2)}`);
  for (const o of R.objects) {
    const a = ab[o];
    if (!a.no.n) { console.log(`  ${o.padEnd(11)} utilisations ${(a.yes.u / a.yes.n).toFixed(2)}/joueur`); continue; }
    const d = a.yes.s / a.yes.n - a.no.s / a.no.n;
    console.log(`  A/B ${o.padEnd(11)} utilisations ${(a.yes.u / a.yes.n).toFixed(2)}/joueur | score avec ${(a.yes.s / a.yes.n).toFixed(1)} vs sans ${(a.no.s / a.no.n).toFixed(1)} (${d >= 0 ? '+' : ''}${d.toFixed(1)}) | victoire ${(100 * a.yes.w / a.yes.n).toFixed(1)}% vs ${(100 * a.no.w / a.no.n).toFixed(1)}%`);
  }
}

const COST = { projecteur: 3, vol: 3, brouillage: 2, double: 4, usurpation: 5 };
const BASE = { cap: 2, pool: false, objects: [], orPerDay: 1, orOnFind: 2, cost: COST };
const REC = { ...BASE, pool: true, objects: ['projecteur', 'vol', 'double'], doubleOnce: true };
const R0 = { ...REC, excludeKnown: true, ab: true };
const costs = (p, v, d) => ({ ...COST, projecteur: p, vol: v, double: d });
const FINAL = { ...R0, ab: false, cost: costs(3, 2, 4), volMode: 'last' };
run('Règles actuelles', { ...FINAL, initialCycle: true });
run('Règles actuelles + indice de départ au hasard', { ...FINAL, initialCycle: true, freeClue: true });
