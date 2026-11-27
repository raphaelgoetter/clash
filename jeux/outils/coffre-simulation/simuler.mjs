// ============================================================
// simuler.mjs — Simulation d'équilibrage du Coffre (Mastermind collectif).
// Code du jour : K symboles distincts parmi S ; E essais par joueur ;
// 1 indice privé par joueur, publiable (bonus fixe B).
// Usage : node jeux/outils/coffre-simulation/simuler.mjs [parties=300]
// ============================================================

const PARTIES = Number(process.argv[2] ?? 300);

// ── Aléatoire reproductible ──────────────────────────────────
let graine = 12345;
const rnd = () => ((graine = (graine * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
const pioche = (t) => t[Math.floor(rnd() * t.length)];
const melange = (t) => { const c = [...t]; for (let i = c.length - 1; i > 0; i--) { const j = Math.floor(rnd() * (i + 1)); [c[i], c[j]] = [c[j], c[i]]; } return c; };

// ── Codes ────────────────────────────────────────────────────
// `doublons` : un symbole peut apparaître plusieurs fois (S^K codes)
function tousLesCodes(S, K, doublons = false) {
  const res = [];
  const rec = (pref) => {
    if (pref.length === K) return res.push(pref);
    for (let s = 0; s < S; s++) if (doublons || !pref.includes(s)) rec([...pref, s]);
  };
  rec([]);
  return res;
}
// Réponse Mastermind classique (gère les doublons) : [bien placés, mal placés]
function reponse(code, essai) {
  let b = 0;
  const restC = {}, restE = {};
  for (let i = 0; i < essai.length; i++) {
    if (essai[i] === code[i]) b++;
    else { restC[code[i]] = (restC[code[i]] ?? 0) + 1; restE[essai[i]] = (restE[essai[i]] ?? 0) + 1; }
  }
  let m = 0;
  for (const k in restE) m += Math.min(restE[k], restC[k] ?? 0);
  return [b, m];
}

// ── Indices ──────────────────────────────────────────────────
// Types : absent, position (X en p), presentAilleurs (X présent, pas en p), pasEn (p n'est pas X)
const POIDS_INDICES = [["absent", 3], ["position", 2], ["presentAilleurs", 3], ["pasEn", 2]];
function tirerIndice(code, S) {
  const total = POIDS_INDICES.reduce((a, [, p]) => a + p, 0);
  let r = rnd() * total, type = POIDS_INDICES[0][0];
  for (const [t, p] of POIDS_INDICES) { if ((r -= p) < 0) { type = t; break; } }
  const K = code.length;
  const absents = [...Array(S).keys()].filter((s) => !code.includes(s));
  if (type === "absent" && absents.length) return { type, s: pioche(absents) };
  if (type === "position") { const p = Math.floor(rnd() * K); return { type, s: code[p], p }; }
  if (type === "presentAilleurs") {
    const i = Math.floor(rnd() * K);
    const p = pioche([...Array(K).keys()].filter((q) => q !== i));
    return { type, s: code[i], p };
  }
  // pasEn : un symbole qui n'est pas en p (présent ailleurs ou absent)
  const p = Math.floor(rnd() * K);
  const s = pioche([...Array(S).keys()].filter((x) => x !== code[p]));
  return { type: "pasEn", s, p };
}
function respecte(c, ind) {
  switch (ind.type) {
    case "absent": return !c.includes(ind.s);
    case "position": return c[ind.p] === ind.s;
    case "presentAilleurs": return c.includes(ind.s) && c[ind.p] !== ind.s;
    case "pasEn": return c[ind.p] !== ind.s;
  }
}

// ── Joueur bot ───────────────────────────────────────────────
// niveau "fort" : joue un code compatible avec tout ce qu'il sait ;
// niveau "moyen" : oublie parfois une contrainte (erreur humaine) ;
// niveau "faible" : n'utilise que les indices et le dernier essai.
function jouerJour(code, codes, E, indicesConnus, niveau) {
  const hist = [];
  for (let e = 1; e <= E; e++) {
    let contraintes = hist;
    if (niveau === "moyen") contraintes = hist.filter(() => rnd() > 0.2);
    if (niveau === "faible") contraintes = hist.slice(-1);
    const ind = niveau === "faible" ? indicesConnus.filter(() => rnd() > 0.3) : indicesConnus;
    const candidats = codes.filter((c) => ind.every((i) => respecte(c, i)) && contraintes.every(([g, r]) => {
      const x = reponse(c, g); return x[0] === r[0] && x[1] === r[1];
    }));
    const essai = pioche(candidats.length ? candidats : codes);
    const r = reponse(code, essai);
    if (r[0] === code.length) return e;
    hist.push([essai, r]);
  }
  return 0; // pas ouvert
}

const POINTS = (e, E) => (e === 0 ? 0 : E + 1 - e); // E points en 1 essai → 1 point au dernier

// ── Une semaine ──────────────────────────────────────────────
// regime.pub : probabilité de publier son indice à l'arrivée ;
// regime.bonus : points fixes de l'informateur
function semaine({ N, S, K, E, pub, bonus, codes, phases = false, aveugle = false }) {
  const joueurs = Array.from({ length: N }, (_, i) => ({
    id: i,
    heure: rnd(), // chronotype : tôt (0) ou tard (1)
    niveau: rnd() < 0.3 ? "fort" : rnd() < 0.6 ? "moyen" : "faible",
    assiduite: 0.6 + rnd() * 0.4,
    pts: 0, essais: 0, ouverts: 0,
  }));
  const stats = { role: { pub: [0, 0], prof: [0, 0] }, jourJoueur: 0, ouverts: 0, essaisOuverts: 0, ptsTot: [0, 0], nTot: [0, 0], pubVisibles: 0 };
  for (let jour = 1; jour <= 7; jour++) {
    const code = pioche(codes);
    const presents = joueurs.filter((j) => rnd() < j.assiduite)
      .map((j) => ({ j, t: Math.min(1, Math.max(0, j.heure + (rnd() - 0.5) * 0.3)) }))
      .sort((a, b) => a.t - b.t);
    const publies = [];
    // Mode phases : tous les indices sont tirés et publiés le matin (8h30-14h),
    // puis chacun joue l'après-midi en voyant tous les indices publiés
    const miens = presents.map(({ j }) => {
      const ind = tirerIndice(code, S);
      const p = rnd() < pub;
      if (phases && p) { publies.push(ind); j.pts += bonus; }
      return { ind, p };
    });
    presents.forEach(({ j }, rang) => {
      const mien = miens[rang].ind;
      // Mode aveugle : celui qui publie ne voit pas les indices des autres
      const visibles = aveugle && miens[rang].p ? [] : phases ? publies.filter((x) => x !== mien) : [...publies];
      if (!phases && miens[rang].p) { publies.push(mien); j.pts += bonus; }
      const e = jouerJour(code, codes, E, [mien, ...visibles], j.niveau);
      const p = POINTS(e, E);
      j.pts += p; j.essais += e || E; if (e) j.ouverts++;
      stats.jourJoueur++; stats.pubVisibles += visibles.length;
      if (e) { stats.ouverts++; stats.essaisOuverts += e; }
      const moitie = rang < presents.length / 2 ? 0 : 1;
      stats.ptsTot[moitie] += p; stats.nTot[moitie]++;
      const r = stats.role[miens[rang].p ? "pub" : "prof"]; r[0] += p; r[1]++;
    });
  }
  // Vainqueur : points, puis moins d'essais
  const classement = [...joueurs].sort((a, b) => b.pts - a.pts || a.essais - b.essais);
  return { stats, joueurs, vainqueur: classement[0], ex: classement[0].pts === classement[1].pts };
}

function regime(nom, cfg) {
  const codes = tousLesCodes(cfg.S, cfg.K, cfg.doublons);
  const agg = { jourJoueur: 0, ouverts: 0, essaisOuverts: 0, ptsTot: [0, 0], nTot: [0, 0], pubVisibles: 0 };
  const vict = { tot: 0, tard: 0, fort: 0, moyen: 0, faible: 0, ex: 0 };
  for (let p = 0; p < PARTIES; p++) {
    const N = 12 + Math.floor(rnd() * 9);
    const { stats, vainqueur, ex } = semaine({ ...cfg, N, codes });
    for (const k of ["jourJoueur", "ouverts", "essaisOuverts", "pubVisibles"]) agg[k] += stats[k];
    for (const i of [0, 1]) { agg.ptsTot[i] += stats.ptsTot[i]; agg.nTot[i] += stats.nTot[i]; }
    vict[vainqueur.heure < 0.5 ? "tot" : "tard"]++; vict[vainqueur.niveau]++; if (ex) vict.ex++;
  }
  const pct = (x) => `${Math.round((100 * x) / PARTIES)} %`;
  console.log(`\n▶ ${nom}  (${cfg.K} parmi ${cfg.S}, ${cfg.E} essais, publication ${Math.round(cfg.pub * 100)} %, bonus ${cfg.bonus})`);
  console.log(`  ouverture ${Math.round((100 * agg.ouverts) / agg.jourJoueur)} % · essais moyens si ouvert ${(agg.essaisOuverts / agg.ouverts).toFixed(2)} · indices publiés visibles en moyenne ${(agg.pubVisibles / agg.jourJoueur).toFixed(1)}`);
  console.log(`  pts/jour (hors bonus) : 1re moitié des arrivants ${(agg.ptsTot[0] / agg.nTot[0]).toFixed(2)} · 2e moitié ${(agg.ptsTot[1] / agg.nTot[1]).toFixed(2)}`);
  console.log(`  vainqueurs : lève-tôt ${pct(vict.tot)} / tardifs ${pct(vict.tard)} · fort ${pct(vict.fort)} moyen ${pct(vict.moyen)} faible ${pct(vict.faible)} · ex aequo ${pct(vict.ex)}`);
}

const base = { S: 6, K: 4, E: 4 };
const MODE = process.argv[3] ?? "aveugle";
if (MODE === "phases") {
  regime("Phases, personne ne publie", { ...base, pub: 0, bonus: 0, phases: true });
  regime("Phases, 30 % publient", { ...base, pub: 0.3, bonus: 1, phases: true });
  regime("Phases, 60 % publient", { ...base, pub: 0.6, bonus: 1, phases: true });
  regime("Phases, tous publient", { ...base, pub: 1, bonus: 1, phases: true });
  regime("Phases 5/7, 30 % publient", { S: 7, K: 5, E: 4, pub: 0.3, bonus: 1, phases: true });
  regime("Phases 5/7, 60 % publient", { S: 7, K: 5, E: 4, pub: 0.6, bonus: 1, phases: true });
  regime("Phases 5/7, tous publient", { S: 7, K: 5, E: 4, pub: 1, bonus: 1, phases: true });
}
// Partager OU profiter : gain moyen par rôle selon le taux de publication
if (MODE === "aveugle") {
  for (const cfg of [{ S: 6, K: 4, E: 4 }, { S: 7, K: 4, E: 4 }, { S: 7, K: 5, E: 4 }]) {
    const codes = tousLesCodes(cfg.S, cfg.K);
    console.log(`\n▶ ${cfg.K} parmi ${cfg.S}, ${cfg.E} essais (partager OU profiter)`);
    for (const pub of [0.1, 0.25, 0.4, 0.55, 0.7, 0.85]) {
      const role = { pub: [0, 0], prof: [0, 0] };
      let ouv = 0, jj = 0;
      for (let p = 0; p < PARTIES / 2; p++) {
        const N = 12 + Math.floor(rnd() * 9);
        const { stats } = semaine({ ...cfg, N, codes, pub, bonus: 0, phases: true, aveugle: true });
        for (const k of ["pub", "prof"]) { role[k][0] += stats.role[k][0]; role[k][1] += stats.role[k][1]; }
        ouv += stats.ouverts; jj += stats.jourJoueur;
      }
      const a = role.pub[0] / role.pub[1], b = role.prof[0] / role.prof[1];
      console.log(`  ${Math.round(pub * 100)} % publient : informateur ${a.toFixed(2)} pts · profiteur ${b.toFixed(2)} pts · écart ${(b - a).toFixed(2)} · ouverture ${Math.round((100 * ouv) / jj)} %`);
    }
  }
}
// Sans publication : chacun garde son indice
if (MODE === "solo") {
  regime("Solo 4/6, 4 essais", { S: 6, K: 4, E: 4, pub: 0, bonus: 0 });
  regime("Solo 4/6, 5 essais", { S: 6, K: 4, E: 5, pub: 0, bonus: 0 });
  regime("Solo 4/7, 5 essais", { S: 7, K: 4, E: 5, pub: 0, bonus: 0 });
}
if (MODE === "doublons") {
  regime("Distincts 4/6, 5 essais", { S: 6, K: 4, E: 5, pub: 0, bonus: 0 });
  regime("Doublons 4/6, 5 essais", { S: 6, K: 4, E: 5, pub: 0, bonus: 0, doublons: true });
  regime("Doublons 4/6, 6 essais", { S: 6, K: 4, E: 6, pub: 0, bonus: 0, doublons: true });
  regime("Doublons 4/5, 5 essais", { S: 5, K: 4, E: 5, pub: 0, bonus: 0, doublons: true });
}
