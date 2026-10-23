// Simulation d'équilibrage de Meow (Risk simplifié, chats qui squattent une maison).
// Usage : node jeux/outils/meow-simulation/simulate.mjs [nbParties]
// Modèle : temps réel heure par heure (Paris), recharge par joueur, sieste 0 h-8 h,
// concours de regards = dés Risk (3 contre 2, égalité au défenseur), points chaque soir.

// ---------- Hasard reproductible ----------
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------- Carte ----------
const PIECES = {
  chambre: ["fenetre", "couette", "armoire", "carton"],
  grenier: ["malle", "chapeaux", "poutre", "lucarne"],
  salon: ["radiateur", "canape", "tapis", "biblio"],
  cuisine: ["evier", "frigo", "panier", "gamelle"],
  jardin: ["arbre", "perron", "potager", "cabane"],
};
const PORTES_IMAGE = [["carton", "canape"], ["malle", "evier"], ["biblio", "evier"], ["tapis", "perron"]];
const PORTES_PLUS = [...PORTES_IMAGE, ["carton", "malle"], ["gamelle", "cabane"]];

// `interieur` : liens géographiques dans les pièces (sinon tous les coins
// d'une pièce se touchent).
function construireCarte(portes, interieur = null) {
  const coins = Object.entries(PIECES).flatMap(([piece, ids]) => ids.map((id) => ({ id, piece })));
  const voisins = Object.fromEntries(coins.map((c) => [c.id, new Set()]));
  if (interieur) for (const [a, b] of interieur) (voisins[a].add(b), voisins[b].add(a));
  else for (const ids of Object.values(PIECES)) for (const a of ids) for (const b of ids) if (a !== b) voisins[a].add(b);
  for (const [a, b] of portes) {
    voisins[a].add(b);
    voisins[b].add(a);
  }
  const pieceDe = Object.fromEntries(coins.map((c) => [c.id, c.piece]));
  return { ids: coins.map((c) => c.id), voisins: Object.fromEntries(Object.entries(voisins).map(([k, v]) => [k, [...v]])), pieceDe };
}

// ---------- Combat (dés Risk) ----------
// Probabilités d'un round : [attaquant perd 2, perd 1 chacun, défenseur perd 2] etc.
const ROUND = {};
function calculerRounds() {
  for (const da of [1, 2, 3])
    for (const dd of [1, 2, 3]) {
      const res = {};
      const n = 6 ** (da + dd);
      for (let i = 0; i < n; i++) {
        let x = i;
        const a = [];
        const d = [];
        for (let k = 0; k < da; k++) (a.push((x % 6) + 1), (x = Math.floor(x / 6)));
        for (let k = 0; k < dd; k++) (d.push((x % 6) + 1), (x = Math.floor(x / 6)));
        a.sort((p, q) => q - p);
        d.sort((p, q) => q - p);
        let pa = 0;
        let pd = 0;
        for (let k = 0; k < Math.min(da, dd); k++) (a[k] > d[k] ? pd++ : pa++);
        const cle = `${pa},${pd}`;
        res[cle] = (res[cle] || 0) + 1 / n;
      }
      ROUND[`${da},${dd}`] = Object.entries(res).map(([k, p]) => [...k.split(",").map(Number), p]);
    }
}
calculerRounds();

let DES_DEF = 2;
let DETERMINISTE = false;
const memoVictoire = new Map();
// Probabilité que `a` chats attaquants (hors le chat qui reste) délogent `d` défenseurs.
function pVictoire(a, d) {
  if (DETERMINISTE) return a > d ? 1 : 0;
  if (d <= 0) return 1;
  if (a <= 0) return 0;
  const cle = a * 1000 + d;
  if (memoVictoire.has(cle)) return memoVictoire.get(cle);
  let p = 0;
  for (const [pa, pd, pr] of ROUND[`${Math.min(3, a)},${Math.min(DES_DEF, d)}`]) p += pr * pVictoire(a - pa, d - pd);
  memoVictoire.set(cle, p);
  return p;
}

function combat(a, d, r) {
  if (DETERMINISTE) return a > d ? { a: a - d, d: 0 } : { a: 0, d: Math.max(1, d - a) };
  while (a > 0 && d > 0) {
    const issues = ROUND[`${Math.min(3, a)},${Math.min(DES_DEF, d)}`];
    let x = r();
    for (const [pa, pd, pr] of issues) {
      if ((x -= pr) <= 0) {
        a -= pa;
        d -= pd;
        break;
      }
    }
    if (x > 0) {
      const [pa, pd] = issues[issues.length - 1];
      a -= pa;
      d -= pd;
    }
  }
  return { a, d };
}

// ---------- Profils d'activité ----------
const PROFILS = {
  assidu: { visites: 5 },
  regulier: { visites: 3 },
  occasionnel: { visites: 1 },
  abandon: { visites: 3, stopJour: 2 }, // joue J1-J2 puis disparaît
};
const MIX = [["assidu", 0.3], ["regulier", 0.4], ["occasionnel", 0.2], ["abandon", 0.1]];

function tirerProfil(r) {
  let x = r();
  for (const [p, w] of MIX) if ((x -= w) <= 0) return p;
  return "regulier";
}

// ---------- Partie ----------
const DEPARTS_DEFAUT = { 0: "chambre", 1: "cuisine", 2: "jardin" };
// Coin imprenable de chaque bande : 2e coin de sa pièce de départ

function jouerPartie(cfg, seed) {
  const r = rng(seed);
  const carte = cfg.carte;
  const NB = cfg.joueurs;
  // Joueurs répartis 3 bandes au tirage
  const ordre = [...Array(NB).keys()].sort(() => r() - 0.5);
  const joueurs = ordre.map((_, i) => ({
    bande: i % 3,
    profil: cfg.profilForce ? cfg.profilForce(i % 3, r) : tirerProfil(r),
    stock: 0,
    strategie: cfg.strategie ? cfg.strategie(i % 3) : "smart",
  }));
  const tailles = [0, 1, 2].map((b) => joueurs.filter((j) => j.bande === b).length);
  const tailleMax = Math.max(...tailles);

  // État : propriétaire (-1 = errants) et chats par coin
  const own = {};
  const chats = {};
  for (const id of carte.ids) {
    own[id] = -1;
    chats[id] = cfg.errants;
  }
  const DEPARTS = cfg.departs || DEPARTS_DEFAUT;
  const PANIERS = cfg.paniers || Object.values(DEPARTS).map((p) => PIECES[p][1]);
  for (const [b, piece] of Object.entries(DEPARTS)) {
    const bonus = cfg.compensation ? (tailleMax - tailles[b]) * cfg.compensation : 0;
    PIECES[piece].forEach((id, k) => {
      own[id] = Number(b);
      chats[id] = cfg.depart + (cfg.bonusDepart?.[b] || 0) + (k < bonus % 4 ? 1 : 0) + Math.floor(bonus / 4);
    });
  }

  const points = [0, 0, 0];
  const stats = { prises: [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]], occupation: {}, conquetes: Array(8).fill(0), chatsMoyens: [], pileMax: 0, leaderJ3: -1, pointsJ: [] };

  const placer = (id, n) => {
    const libre = cfg.plafondCoin ? Math.max(0, cfg.plafondCoin - chats[id]) : n;
    const k = Math.min(n, libre);
    chats[id] += k;
    return n - k;
  };

  const leader = () => points.indexOf(Math.max(...points));
  const piecesTenues = (b) => Object.entries(PIECES).filter(([, ids]) => ids.every((id) => own[id] === b)).map(([p]) => p);

  // Menace d'un coin : chats ennemis voisins (hors errants) - chats présents
  const menace = (id) => {
    const b = own[id];
    let m = 0;
    for (const v of carte.voisins[id]) if (own[v] !== b && own[v] !== -1) m = Math.max(m, chats[v] - 1);
    return m - chats[id];
  };
  const frontiere = (b) => carte.ids.filter((id) => own[id] === b && carte.voisins[id].some((v) => own[v] !== b));

  // Valeur d'une cible pour une bande (complète une pièce, casse une pièce adverse, vise le leader)
  const valeurCible = (b, t) => {
    let v = 1;
    const piece = carte.pieceDe[t];
    const ids = PIECES[piece];
    const autres = ids.filter((id) => id !== t);
    if (autres.every((id) => own[id] === b)) v += 3; // complète la pièce
    if (own[t] >= 0 && ids.every((id) => own[id] === own[t])) v += 2; // casse les croquettes adverses
    if (own[t] >= 0 && own[t] === leader() && own[t] !== b) v += cfg.antiLeader;
    return v;
  };

  const meilleureAttaque = (b, strat, seuil) => {
    let best = null;
    for (const s of carte.ids) {
      if (own[s] !== b || chats[s] < 2) continue;
      for (const t of carte.voisins[s]) {
        if (own[t] === b || (cfg.panier && PANIERS.includes(t))) continue;
        const a = chats[s] - 1;
        if (strat === "naif") {
          if (a > chats[t] && (!best || r() < 0.5)) best = { s, t, score: 1 };
          continue;
        }
        const p = pVictoire(a, chats[t]);
        if (p < seuil) continue;
        const score = p * valeurCible(b, t) + (cfg.bruit ? r() * 1e-3 : 0);
        if (!best || score > best.score) best = { s, t, score };
      }
    }
    return best;
  };

  const placerStock = (j) => {
    if (j.stock <= 0) return;
    const b = j.bande;
    const front = frontiere(b);
    if (!front.length) return;
    if (j.strategie === "naif") {
      while (j.stock > 0) {
        const id = front[Math.floor(r() * front.length)];
        j.stock = placer(id, 1) + j.stock - 1;
        if (cfg.plafondCoin && front.every((x) => chats[x] >= cfg.plafondCoin)) break;
      }
      return;
    }
    // Smart : défendre un coin très menacé, sinon tout concentrer derrière la meilleure attaque
    const menaces = front.map((id) => [id, menace(id) + (cfg.bruit ? r() * 1e-3 : 0)]).sort((x, y) => y[1] - x[1]);
    if (menaces[0][1] > 0 && carte.pieceDe[menaces[0][0]] && r() < 0.5) {
      j.stock = placer(menaces[0][0], j.stock);
    }
    if (j.stock <= 0) return;
    let best = null;
    for (const s of front)
      for (const t of carte.voisins[s]) {
        if (own[t] === b) continue;
        const score = valeurCible(b, t) / (chats[t] + 1) + chats[s] * 0.01 + (cfg.bruit ? r() * 1e-3 : 0);
        if (!best || score > best.score) best = { s, score };
      }
    j.stock = placer(best.s, j.stock);
    if (j.stock > 0) for (const id of front) if (j.stock > 0) j.stock = placer(id, j.stock);
  };

  const visite = (j, jour) => {
    j.presentJour = jour;
    placerStock(j);
    // Déplacement (1 chat par distribution) : vers le coin de la bande le plus
    // menacé, depuis un voisin de la bande qui a au moins 2 chats
    if (cfg.deplacement && j.strategie === "smart" && !j.depFait) {
      let best = null;
      for (const t of carte.ids) {
        if (own[t] !== j.bande || menace(t) <= 0) continue;
        for (const src of carte.voisins[t]) if (own[src] === j.bande && chats[src] >= 2 && (!best || menace(t) > best.m)) best = { src, t, m: menace(t) };
      }
      if (best) (chats[best.src]--, chats[best.t]++, (j.depFait = true));
    }
    for (let n = 0; n < cfg.attaquesMax; n++) {
      if (cfg.squatsParDistribution != null && (j.squatsFaits ?? 0) >= cfg.squatsParDistribution) break;
      const att = meilleureAttaque(j.bande, j.strategie, cfg.seuil);
      if (!att) break;
      const { s, t } = att;
      j.squatsFaits = (j.squatsFaits ?? 0) + 1;
      const res = combat(chats[s] - 1, chats[t], r);
      if (res.d <= 0) {
        const ancien = own[t];
        own[t] = j.bande;
        chats[t] = res.a;
        chats[s] = 1;
        stats.conquetes[jour]++;
        if (cfg.butin) j.stock = Math.min(cfg.stockMax + (cfg.butinHorsPlafond ? 99 : 0), j.stock + cfg.butin);
        if (cfg.pointsConquete) points[j.bande] += cfg.pointsConquete;
        stats.prises[j.bande][ancien + 1]++;
        // Bon sens : si la source reste exposée, laisser la moitié
        if (j.strategie === "smart" && menace(s) > 0 && res.a > 2) {
          const k = Math.floor(res.a / 2);
          chats[t] -= k;
          chats[s] += k;
        }
        void ancien;
      } else {
        chats[s] = 1 + res.a;
        chats[t] = res.d;
      }
    }
  };

  // Planning des visites : heures 8-23 tirées au hasard par joueur et par jour
  for (let jour = 1; jour <= 7; jour++) {
    const visitesParHeure = Array.from({ length: 24 }, () => []);
    for (const j of joueurs) {
      const p = PROFILS[j.profil];
      if (p.stopJour && jour > p.stopJour) continue;
      for (let k = 0; k < p.visites; k++) visitesParHeure[cfg.soir === j.bande ? 20 + Math.floor(r() * 4) : 8 + Math.floor(r() * 16)].push(j);
    }
    for (let h = 0; h < 24; h++) {
      const tAbs = (jour - 1) * 24 + h;
      // Recharge par joueur
      if (cfg.rechargeHeures ? cfg.rechargeHeures.includes(h) : tAbs % cfg.recharge === 0) {
        for (const j of joueurs) {
          let gain = cfg.gainDistribution ?? 1;
          if (cfg.equilibrage) {
            j.frac = (j.frac || 0) + (tailleMax / tailles[j.bande] - 1) * (cfg.gainDistribution ?? 1);
            while (j.frac >= 1) (gain++, j.frac--);
          }
          j.stock = Math.min(cfg.stockMax, j.stock + gain);
          j.depFait = false;
          j.squatsFaits = 0;
        }
        // Croquettes : chats bonus posés dans chaque pièce complète
        for (const b of [0, 1, 2])
          for (const piece of piecesTenues(b)) {
            const n = cfg.croquettes[piece] || 0;
            if (n > 0) {
              const cible = PIECES[piece].map((id) => [id, menace(id) + (cfg.bruit ? r() * 1e-3 : 0)]).sort((x, y) => y[1] - x[1])[0][0];
              placer(cible, n);
            }
          }
      }
      // Événement « mercenaires » : à 8h des jours choisis, la bande dernière
      // aux points reçoit des chats posés sur son territoire le plus menacé
      if (cfg.mercenaires && h === 8 && cfg.mercenaires.jours.includes(jour)) {
        const nbCoins = (b) => carte.ids.filter((id) => own[id] === b).length;
        const derniere = cfg.mercenaires.cible === "territoires"
          ? [0, 1, 2].sort((x, y) => nbCoins(x) - nbCoins(y) || points[x] - points[y])[0]
          : [0, 1, 2].sort((x, y) => points[x] - points[y] || x - y)[0];
        if (cfg.mercenaires.seuil != null && nbCoins(derniere) > cfg.mercenaires.seuil) { /* pas de bande en difficulté */ } else {
        const n = cfg.mercenaires.n * (cfg.mercenaires.parJoueur ? tailles[derniere] : 1);
        const front = frontiere(derniere);
        const cible = front.length ? front.sort((x, y) => menace(y) - menace(x))[0] : carte.ids.find((id) => own[id] === derniere);
        if (cible) chats[cible] += n;
        (stats.mercenaires ??= []).push({ jour, b: derniere });
        }
      }
      // Sieste : à 0 h, les chats non placés s'installent automatiquement
      if (h === 0) {
        for (const j of joueurs) {
          if (j.stock <= 0) continue;
          const front = frontiere(j.bande);
          if (!front.length) continue;
          const pire = front.sort((x, y) => menace(y) - menace(x))[0];
          // Jeu réel (16/10) : 1 seul chat posé à la sieste, le reste en réserve
          if (cfg.siesteUnChat) j.stock = placer(pire, 1) + j.stock - 1;
          else j.stock = placer(pire, j.stock);
        }
      }
      if (h >= 8) for (const j of visitesParHeure[h].sort(() => r() - 0.5)) visite(j, jour);
      if (cfg.releves && cfg.releves.includes(h) && h !== 23) {
        for (const b of [0, 1, 2]) points[b] += carte.ids.filter((id) => own[id] === b).length;
      }
      if (h === 23) {
        const duJour = [0, 1, 2].map((b) => carte.ids.filter((id) => own[id] === b).length + piecesTenues(b).length * cfg.pointsPiece);
        if (cfg.score === "rang") {
          const rangs = [0, 1, 2].sort((x, y) => duJour[y] - duJour[x]);
          [3, 2, 1].forEach((pt, k) => (points[rangs[k]] += pt + (k === 0 ? 0.01 * duJour[rangs[0]] : 0)));
        } else if (cfg.score === "progressif") {
          for (const b of [0, 1, 2]) points[b] += duJour[b] * jour;
        } else if (cfg.score === "final") {
          for (const b of [0, 1, 2]) points[b] = duJour[b];
        } else for (const b of [0, 1, 2]) points[b] += duJour[b];
        if (cfg.pointsPresence) for (const j of joueurs) if (j.presentJour === jour) points[j.bande] += cfg.pointsPresence;
        if (cfg.ennui) for (const id of carte.ids) if (own[id] >= 0 && chats[id] > cfg.ennui) chats[id] -= 1;
        stats.pointsJ.push([...points]);
        (stats.coinsJour ??= []).push([0, 1, 2].map((b) => carte.ids.filter((id) => own[id] === b).length));
        if (jour === 3) stats.leaderJ3 = leader();
        if (jour === 3 || jour === 7)
          stats.occupation[jour] = Object.fromEntries(Object.entries(PIECES).map(([p, ids]) => [p, [0, 1, 2].map((b) => ids.filter((id) => own[id] === b).length)]));
        const tenus = carte.ids.filter((id) => own[id] >= 0);
        stats.chatsMoyens[jour] = tenus.reduce((s, id) => s + chats[id], 0) / Math.max(1, tenus.length);
        stats.pileMax = Math.max(stats.pileMax, ...carte.ids.map((id) => chats[id]));
      }
    }
  }

  const activite = [0, 1, 2].map((b) =>
    joueurs.filter((j) => j.bande === b).reduce((s, j) => s + (PROFILS[j.profil].stopJour ? 6 : PROFILS[j.profil].visites * 7), 0)
  );
  const classement = [0, 1, 2].sort((x, y) => points[y] - points[x]);
  return { points, classement, activite, tailles, stats, eliminees: [0, 1, 2].filter((b) => !carte.ids.some((id) => own[id] === b)) };
}

// ---------- Batteries de tests ----------
function analyser(nom, cfg, n) {
  DES_DEF = cfg.desDefense || 2;
  DETERMINISTE = cfg.combat === "deterministe";
  memoVictoire.clear();
  const res = [];
  for (let i = 0; i < n; i++) res.push(jouerPartie(cfg, 1000 + i));
  const victoires = [0, 0, 0];
  let activiteGagne = 0;
  let leaderJ3Gagne = 0;
  let ecart = 0;
  let elim = 0;
  const conq = Array(8).fill(0);
  const chatsJ = Array(8).fill(0);
  let pile = 0;
  for (const g of res) {
    const w = g.classement[0];
    victoires[w]++;
    if (g.activite[w] === Math.max(...g.activite)) activiteGagne++;
    if (g.stats.leaderJ3 === w) leaderJ3Gagne++;
    ecart += (g.points[w] - g.points[g.classement[1]]) / g.points[w];
    elim += g.eliminees.length > 0 ? 1 : 0;
    for (let d = 1; d <= 7; d++) {
      conq[d] += g.stats.conquetes[d];
      chatsJ[d] += g.stats.chatsMoyens[d];
    }
    pile += g.stats.pileMax;
  }
  const pct = (x) => `${Math.round((100 * x) / n)} %`;
  console.log(`\n=== ${nom} (${n} parties) ===`);
  console.log(`Victoires Roux/Noirs/Chartreux : ${victoires.map(pct).join(" / ")}`);
  console.log(`Bande la plus active gagne : ${pct(activiteGagne)} | Leader J3 gagne : ${pct(leaderJ3Gagne)} | Écart 1er-2e : ${Math.round((100 * ecart) / n)} % | Bande éliminée : ${pct(elim)}`);
  console.log(`Conquêtes/jour J1..J7 : ${conq.slice(1).map((c) => (c / n).toFixed(1)).join(" ")}`);
  console.log(`Chats moyens/coin J1..J7 : ${chatsJ.slice(1).map((c) => (c / n).toFixed(1)).join(" ")} | Pile max moyenne : ${(pile / n).toFixed(0)}`);
  return res;
}

const N = Number(process.argv[2]) || 400;
const BASE = {
  bruit: true, // égalités des bots tranchées au hasard (sinon biais d'ordre des coins)
  carte: construireCarte(PORTES_IMAGE),
  joueurs: 18,
  recharge: 3,
  stockMax: 4,
  depart: 2,
  errants: 2,
  croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 2 },
  pointsPiece: 2,
  attaquesMax: 6,
  seuil: 0.6,
  antiLeader: 1,
  plafondCoin: 0,
  compensation: 0,
};

const scenario = process.argv[3] || "tout";
const run = (nom, delta) => analyser(nom, { ...BASE, ...delta }, N);
const IMG = construireCarte(PORTES_IMAGE);
const PLUS = construireCarte(PORTES_PLUS);
const ANTI = { panier: true, attaquesMax: 2 };

if (scenario === "tout" || scenario === "neige") {
  run("A. Base (image)", {});
  run("H. Panier imprenable", { panier: true });
  run("I. Panier + 2 squats max par visite", ANTI);
  run("J. Panier + 2 squats + score par rang du jour", { ...ANTI, score: "rang" });
  run("K. Panier + 2 squats + score progressif (jour × coins)", { ...ANTI, score: "progressif" });
  run("L. Panier + 2 squats + seul l'état final compte", { ...ANTI, score: "final" });
}
if (scenario === "tout" || scenario === "carte") {
  run("M. ANTI + rang, carte image", { ...ANTI, score: "rang", carte: IMG });
  run("N. ANTI + rang, +2 portes", { ...ANTI, score: "rang", carte: PLUS });
  run("O. ANTI + rang, +porte Carton-Malle seule", { ...ANTI, score: "rang", carte: construireCarte([...PORTES_IMAGE, ["carton", "malle"]]) });
  run("P. ANTI + rang, +porte Gamelle-Cabane seule", { ...ANTI, score: "rang", carte: construireCarte([...PORTES_IMAGE, ["gamelle", "cabane"]]) });
}

if (scenario === "recherche") {
  // Portes optionnelles plausibles sur l'image : mur Chambre/Grenier, chatière Cuisine/Jardin, fenêtre Salon/Jardin
  const OPTION = [["carton", "malle"], ["gamelle", "cabane"], ["radiateur", "arbre"]];
  const PIECES_NOMS = Object.keys(PIECES);
  const lignes = [];
  for (let m = 0; m < 8; m++) {
    const portes = [...PORTES_IMAGE, ...OPTION.filter((_, k) => m & (1 << k))];
    const carte = construireCarte(portes);
    for (let a = 0; a < 5; a++)
      for (let b = a + 1; b < 5; b++)
        for (let c = b + 1; c < 5; c++) {
          const departs = { 0: PIECES_NOMS[a], 1: PIECES_NOMS[b], 2: PIECES_NOMS[c] };
          // Panier = 2e coin de chaque pièce de départ
          const cfg = { ...BASE, ...ANTI, score: "rang", carte, departs };
          const v = [0, 0, 0];
          let lj3 = 0;
          for (let i = 0; i < N; i++) {
            const g = jouerPartie(cfg, 5000 + i);
            v[g.classement[0]]++;
            if (g.stats.leaderJ3 === g.classement[0]) lj3++;
          }
          const ecart = Math.max(...v.map((x) => Math.abs(x / N - 1 / 3)));
          lignes.push({ portes: OPTION.filter((_, k) => m & (1 << k)).map((p) => p.join("-")).join(" + ") || "(image seule)", departs: Object.values(departs).join("/"), v: v.map((x) => Math.round((100 * x) / N)), ecart, lj3: Math.round((100 * lj3) / N) });
        }
  }
  lignes.sort((x, y) => x.ecart - y.ecart);
  for (const l of lignes.slice(0, 12)) console.log(`${l.v.join("/").padEnd(10)} écart ${(l.ecart * 100).toFixed(0).padStart(2)} pts | leaderJ3 ${l.lj3} % | départs ${l.departs} | portes ${l.portes}`);
}

if (scenario === "equite") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"]]);
  const departs = { 0: "chambre", 1: "salon", 2: "cuisine" };
  const R = { ...BASE, ...ANTI, score: "rang", carte, departs };
  for (const bonusDepart of [[0, 0, 0], [0, 1, 0], [1, 1, 0], [0, 0, -1], [1, 2, 0]])
    run(`Départs Chambre/Salon/Cuisine, bonus départ ${bonusDepart.join("/")}`, { ...R, bonusDepart });
}

if (scenario === "verif") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"]]);
  const R = { ...BASE, ...ANTI, score: "rang", carte, departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, bonusDepart: [0, 0, -1] };
  const egal = () => "regulier";
  run("Réf. activité égale", { ...R, profilForce: egal });
  run("Roux naïfs, activité égale", { ...R, profilForce: egal, strategie: (b) => (b === 0 ? "naif" : "smart") });
  run("Roux jouent seulement 20h-23h, activité égale", { ...R, profilForce: egal, soir: 0 });
  run("Idem + score cumulé relevé à 11h/14h/17h/20h/23h", { ...R, profilForce: egal, soir: 0, score: "cumul", releves: [11, 14, 17, 20, 23] });
  run("Score cumulé multi-relevés (activité normale)", { ...R, score: "cumul", releves: [11, 14, 17, 20, 23] });
  run("10 joueurs", { ...R, joueurs: 10 });
  run("10 joueurs + compensation 2", { ...R, joueurs: 10, compensation: 2 });
  run("14 joueurs", { ...R, joueurs: 14 });
  run("Roux tous assidus, autres réguliers", { ...R, profilForce: (b) => (b === 0 ? "assidu" : "regulier") });
}

if (scenario === "final") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"]]);
  const R = { ...BASE, ...ANTI, score: "rang", carte, departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, bonusDepart: [0, 0, -1], equilibrage: true };
  const egal = () => "regulier";
  const naif = (b) => (b === 0 ? "naif" : "smart");
  run("10 joueurs + recharge équilibrée", { ...R, joueurs: 10 });
  run("14 joueurs + recharge équilibrée", { ...R, joueurs: 14 });
  run("18 joueurs (réf.)", R);
  for (const [nom, d] of [["dés 2 déf.", {}], ["3 dés en défense", { desDefense: 3 }], ["pièce complète = 4 pts", { pointsPiece: 4, croquettes: { chambre: 2, grenier: 2, jardin: 2, cuisine: 2, salon: 3 } }], ["3 dés déf. + pièce 4 pts", { desDefense: 3, pointsPiece: 4, croquettes: { chambre: 2, grenier: 2, jardin: 2, cuisine: 2, salon: 3 } }]]) {
    run(`${nom} | équité`, { ...R, ...d });
    run(`${nom} | Roux naïfs (activité égale)`, { ...R, ...d, profilForce: egal, strategie: naif });
    run(`${nom} | Roux assidus vs réguliers`, { ...R, ...d, profilForce: (b) => (b === 0 ? "assidu" : "regulier") });
  }
}

if (scenario === "def3") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"]]);
  const R = { ...BASE, ...ANTI, score: "rang", carte, departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, equilibrage: true, desDefense: 3 };
  const egal = () => "regulier";
  for (const [nom, d] of [
    ["déf3, départ 2/2/2, plafond 8", { bonusDepart: [0, 0, 0], plafondCoin: 8 }],
    ["déf3, départ 2/1/2, plafond 8", { bonusDepart: [0, -1, 0], plafondCoin: 8 }],
    ["déf3, départ 2/1/2, plafond 6", { bonusDepart: [0, -1, 0], plafondCoin: 6 }],
    ["déf3, départ 2/1/2, plafond 8, recharge 4h", { bonusDepart: [0, -1, 0], plafondCoin: 8, recharge: 4 }],
  ]) {
    run(`${nom} | équité`, { ...R, ...d });
    run(`${nom} | Roux naïfs`, { ...R, ...d, profilForce: egal, strategie: (b) => (b === 0 ? "naif" : "smart") });
    run(`${nom} | Roux assidus`, { ...R, ...d, profilForce: (b) => (b === 0 ? "assidu" : "regulier") });
    run(`${nom} | 10 joueurs`, { ...R, ...d, joueurs: 10 });
  }
}

if (scenario === "determ") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"]]);
  const R = { ...BASE, ...ANTI, score: "rang", carte, departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, bonusDepart: [0, 0, -1], equilibrage: true, combat: "deterministe" };
  const egal = () => "regulier";
  run("Sans hasard | équité", R);
  run("Sans hasard | Roux naïfs", { ...R, profilForce: egal, strategie: (b) => (b === 0 ? "naif" : "smart") });
  run("Sans hasard | Roux assidus", { ...R, profilForce: (b) => (b === 0 ? "assidu" : "regulier") });
  run("Sans hasard | 10 joueurs", { ...R, joueurs: 10 });
}

if (scenario === "paniers") {
  const portes = [...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"]];
  const carte = construireCarte(portes);
  const passages = new Set(portes.flat());
  const noms = Object.keys(PIECES);
  const lignes = [];
  for (let a = 0; a < 5; a++)
    for (let b = a + 1; b < 5; b++)
      for (let c = b + 1; c < 5; c++) {
        const pieces = [noms[a], noms[b], noms[c]];
        // Options de panier : coins hors passage, sinon tous les coins (Salon)
        const options = pieces.map((p) => {
          const libres = PIECES[p].filter((id) => !passages.has(id));
          return libres.length ? [libres[0]] : PIECES[p];
        });
        for (const p0 of options[0]) for (const p1 of options[1]) for (const p2 of options[2])
          for (let m = 0; m < 7; m++) {
            const bonusDepart = [0, 1, 2].map((k) => (m & (1 << k) ? -1 : 0));
            const cfg = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, departs: { 0: pieces[0], 1: pieces[1], 2: pieces[2] }, paniers: [p0, p1, p2], bonusDepart };
            const v = [0, 0, 0];
            let lj3 = 0;
            for (let i = 0; i < N; i++) {
              const g = jouerPartie(cfg, 9000 + i);
              v[g.classement[0]]++;
              if (g.stats.leaderJ3 === g.classement[0]) lj3++;
            }
            lignes.push({ pieces, paniers: [p0, p1, p2], bonusDepart, v: v.map((x) => Math.round((100 * x) / N)), ecart: Math.max(...v.map((x) => Math.abs(x / N - 1 / 3))), lj3: Math.round((100 * lj3) / N) });
          }
      }
  lignes.sort((x, y) => x.ecart - y.ecart);
  for (const l of lignes.slice(0, 15))
    console.log(`${l.v.join("/").padEnd(9)} écart ${(l.ecart * 100).toFixed(0).padStart(2)} | J3 ${l.lj3} % | ${l.pieces.join("/")} | paniers ${l.paniers.join("/")} | départ -1 : ${l.bonusDepart.map((x, k) => (x ? l.pieces[k] : "")).filter(Boolean).join(",") || "aucun"}`);
}

if (scenario === "valide") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"]]);
  const R = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, departs: { 0: "chambre", 1: "salon", 2: "cuisine" } };
  for (const salon of ["canape", "biblio", "tapis", "radiateur"]) run(`Paniers fenetre/${salon}/frigo, 18 joueurs`, { ...R, paniers: ["fenetre", salon, "frigo"] });
  const P = { ...R, paniers: ["fenetre", "canape", "frigo"] };
  run("Retenu, 14 joueurs", { ...P, joueurs: 14 });
  run("Retenu, 10 joueurs", { ...P, joueurs: 10 });
}

if (scenario === "valide2") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"]]);
  const P = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, paniers: ["fenetre", "canape", "frigo"], bonusDepart: [0, 0, -1] };
  for (const joueurs of [18, 14, 10]) run(`Retenu + Cuisine 1 chat/coin, ${joueurs} joueurs`, { ...P, joueurs });
}

if (scenario === "sansbonus") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"]]);
  const P = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, paniers: ["fenetre", "canape", "frigo"] };
  const SANS = { croquettes: {}, pointsPiece: 0 };
  const NEUTRES = { croquettes: { grenier: 1, jardin: 1 }, pointsPiece: 2, piecesBonus: ["grenier", "jardin"] };
  for (const [nom, d] of [["Avec bonus (actuel)", {}], ["Sans aucun bonus de pièce", SANS]]) {
    run(`${nom}, 18 joueurs`, { ...P, ...d });
    run(`${nom}, 10 joueurs`, { ...P, ...d, joueurs: 10 });
    run(`${nom}, Roux naïfs`, { ...P, ...d, profilForce: () => "regulier", strategie: (b) => (b === 0 ? "naif" : "smart") });
  }
  void NEUTRES;
}

if (scenario === "sansbonus2") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"]]);
  const P = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, paniers: ["fenetre", "canape", "frigo"], croquettes: {}, pointsPiece: 0 };
  for (const bonusDepart of [[0, 1, 0], [0, 1, -1], [0, 2, 0], [0, 2, -1], [1, 2, 0]]) {
    run(`Sans bonus, départ ${bonusDepart.map((x) => 2 + x).join("/")}, 18 j.`, { ...P, bonusDepart });
    run(`Sans bonus, départ ${bonusDepart.map((x) => 2 + x).join("/")}, 14 j.`, { ...P, bonusDepart, joueurs: 14 });
  }
}

if (scenario === "rythme") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["gamelle", "cabane"]]);
  const P = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, paniers: ["fenetre", "canape", "frigo"] };
  for (const [nom, d] of [
    ["Toutes les 3 h, jour et nuit (8/jour)", {}],
    ["Toutes les 4 h, jour et nuit (6/jour)", { recharge: 4 }],
    ["Toutes les 6 h, jour et nuit (4/jour)", { recharge: 6 }],
    ["8h/12h/16h/20h, pas la nuit (4/jour)", { rechargeHeures: [8, 12, 16, 20] }],
    ["8h/13h/18h, pas la nuit (3/jour), stock max 3", { rechargeHeures: [8, 13, 18], stockMax: 3 }],
  ]) {
    run(`${nom}, 18 j.`, { ...P, ...d });
    run(`${nom}, 10 j.`, { ...P, ...d, joueurs: 10 });
    run(`${nom}, Roux assidus`, { ...P, ...d, profilForce: (b) => (b === 0 ? "assidu" : "regulier") });
  }
}

if (scenario === "paniers2") {
  const portes = [...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["gamelle", "cabane"]];
  const carte = construireCarte(portes);
  const passages = new Set(portes.flat());
  const noms = Object.keys(PIECES);
  const lignes = [];
  for (let a = 0; a < 5; a++)
    for (let b = a + 1; b < 5; b++)
      for (let c = b + 1; c < 5; c++) {
        const pieces = [noms[a], noms[b], noms[c]];
        const options = pieces.map((p) => {
          const libres = PIECES[p].filter((id) => !passages.has(id));
          return libres.length ? [libres[0]] : PIECES[p];
        });
        for (const p0 of options[0]) for (const p1 of options[1]) for (const p2 of options[2])
          for (let m = 0; m < 8; m++) {
            const bonusDepart = [0, 1, 2].map((k) => (m & (1 << k) ? 1 : 0));
            const cfg = { ...BASE, ...ANTI, score: "rang", equilibrage: true, rechargeHeures: [8, 12, 16, 20], carte, departs: { 0: pieces[0], 1: pieces[1], 2: pieces[2] }, paniers: [p0, p1, p2], bonusDepart };
            const v = [0, 0, 0];
            for (let i = 0; i < N; i++) v[jouerPartie(cfg, 7000 + i).classement[0]]++;
            lignes.push({ pieces, paniers: [p0, p1, p2], bonusDepart, v: v.map((x) => Math.round((100 * x) / N)), ecart: Math.max(...v.map((x) => Math.abs(x / N - 1 / 3))) });
          }
      }
  lignes.sort((x, y) => x.ecart - y.ecart);
  for (const l of lignes.slice(0, 12))
    console.log(`${l.v.join("/").padEnd(9)} écart ${(l.ecart * 100).toFixed(0).padStart(2)} | ${l.pieces.join("/")} | paniers ${l.paniers.join("/")} | départ +1 : ${l.bonusDepart.map((x, k) => (x ? l.pieces[k] : "")).filter(Boolean).join(",") || "aucun"}`);
}

if (scenario === "valide3") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["gamelle", "cabane"]]);
  const P = { ...BASE, ...ANTI, score: "rang", equilibrage: true, rechargeHeures: [8, 12, 16, 20], carte, departs: { 0: "chambre", 1: "salon", 2: "cuisine" } };
  const C3 = { croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 3 } };
  for (const [nom, d] of [
    ["Paniers fenêtre/radiateur/frigo", { paniers: ["fenetre", "radiateur", "frigo"] }],
    ["Paniers fenêtre/radiateur/frigo + Salon 3 croquettes", { paniers: ["fenetre", "radiateur", "frigo"], ...C3 }],
    ["Paniers fenêtre/tapis/frigo + Salon 3 croquettes", { paniers: ["fenetre", "tapis", "frigo"], ...C3 }],
  ]) for (const joueurs of [18, 14, 10]) run(`${nom}, ${joueurs} j.`, { ...P, ...d, joueurs });
}

if (scenario === "jardin") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["gamelle", "cabane"]]);
  const R3 = { rechargeHeures: [8, 13, 18] };
  const lignes = [];
  const essai = (nom, cfg) => {
    const v = [0, 0, 0];
    for (let i = 0; i < N; i++) v[jouerPartie(cfg, 3000 + i).classement[0]]++;
    lignes.push({ nom, v: v.map((x) => Math.round((100 * x) / N)), ecart: Math.max(...v.map((x) => Math.abs(x / N - 1 / 3))) });
  };
  const base = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, ...R3 };
  essai("Réf. Chambre/Salon/Cuisine, paniers fenêtre/tapis/frigo, Salon +3", { ...base, departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, paniers: ["fenetre", "tapis", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 3 } });
  for (const pc of ["fenetre", "couette", "armoire"])
    for (const pk of ["frigo", "panier"])
      for (const salon of [1, 2, 3])
        for (let m = 0; m < 8; m++) {
          const bonusDepart = [0, 1, 2].map((k) => (m & (1 << k) ? 1 : 0));
          essai(`Chambre/Jardin/Cuisine, paniers ${pc}/potager/${pk}, Salon +${salon}, départ +1 : ${["chambre", "jardin", "cuisine"].filter((_, k) => bonusDepart[k]).join(",") || "aucun"}`,
            { ...base, departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: [pc, "potager", pk], bonusDepart, croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon } });
        }
  console.log("Réf. :", lignes[0].v.join("/"), "écart", Math.round(lignes[0].ecart * 100));
  lignes.sort((x, y) => x.ecart - y.ecart);
  for (const l of lignes.slice(0, 10)) console.log(`${l.v.join("/").padEnd(9)} écart ${Math.round(l.ecart * 100)} | ${l.nom}`);
}

if (scenario === "valide4") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["gamelle", "cabane"]]);
  const P = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, paniers: ["fenetre", "tapis", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 3 } };
  for (const joueurs of [18, 14, 10]) run(`3 recharges/jour, ${joueurs} j.`, { ...P, joueurs });
  for (const stockMax of [3]) run(`3 recharges/jour, stock max ${stockMax}, 18 j.`, { ...P, stockMax });
}

if (scenario === "salon3") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["gamelle", "cabane"]]);
  const base = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "salon", 2: "cuisine" } };
  const lignes = [];
  for (const ps of ["radiateur", "canape", "tapis", "biblio"])
    for (const salon of [3, 4, 5])
      for (const bs of [0, 1, 2]) {
        const cfg = { ...base, paniers: ["fenetre", ps, "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon }, bonusDepart: [0, bs, 0] };
        const v = [0, 0, 0];
        for (let i = 0; i < N; i++) v[jouerPartie(cfg, 4000 + i).classement[0]]++;
        lignes.push({ nom: `panier Salon ${ps}, croquettes Salon +${salon}, Salon ${2 + bs} chats/coin`, v: v.map((x) => Math.round((100 * x) / N)), ecart: Math.max(...v.map((x) => Math.abs(x / N - 1 / 3))) });
      }
  lignes.sort((x, y) => x.ecart - y.ecart);
  for (const l of lignes.slice(0, 8)) console.log(`${l.v.join("/").padEnd(9)} écart ${Math.round(l.ecart * 100)} | ${l.nom}`);
}

if (scenario === "valide5") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["gamelle", "cabane"]]);
  const P = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, paniers: ["fenetre", "tapis", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 4 }, bonusDepart: [0, 1, 0] };
  for (const joueurs of [18, 14, 10]) run(`Retenu 3 recharges, ${joueurs} j.`, { ...P, joueurs });
  run("Retenu, Roux naïfs", { ...P, profilForce: () => "regulier", strategie: (b) => (b === 0 ? "naif" : "smart") });
}

if (scenario === "valide6") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["gamelle", "cabane"]]);
  const P = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, paniers: ["fenetre", "tapis", "frigo"] };
  for (const salon of [4, 5]) for (const joueurs of [18, 14, 10]) run(`Salon +${salon}, départ 2 partout, ${joueurs} j.`, { ...P, croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon }, joueurs });
}

if (scenario === "pourquoi") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["gamelle", "cabane"]]);
  const base = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], joueurs: 16 };
  const configs = [
    ["Départ Salon (retenu)", { departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, paniers: ["fenetre", "tapis", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 4 } }],
    ["Départ Jardin", { departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 4 } }],
  ];
  const noms = ["Roux", "Noirs", "Chartreux"];
  for (const [nom, d] of configs) {
    const cfg = { ...base, ...d };
    const v = [0, 0, 0];
    const prises = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
    const occ = { 3: {}, 7: {} };
    for (let i = 0; i < N; i++) {
      const g = jouerPartie(cfg, 2000 + i);
      v[g.classement[0]]++;
      g.stats.prises.forEach((row, b) => row.forEach((x, k) => (prises[b][k] += x / N)));
      for (const j of [3, 7]) for (const [p, arr] of Object.entries(g.stats.occupation[j])) occ[j][p] = (occ[j][p] || [0, 0, 0]).map((x, k) => x + arr[k] / N);
    }
    console.log(`\n=== ${nom} (16 joueurs, ${N} parties) : victoires ${v.map((x) => Math.round((100 * x) / N) + " %").join(" / ")} ===`);
    console.log("Prises sur 7 jours (ligne = qui prend ; colonnes : errants / Roux / Noirs / Chartreux) :");
    prises.forEach((row, b) => console.log(`  ${noms[b].padEnd(10)} ${row.map((x) => x.toFixed(0).padStart(4)).join("")}`));
    for (const j of [3, 7]) {
      console.log(`Coins tenus fin J${j} (Roux/Noirs/Chartreux) :`);
      for (const [p, arr] of Object.entries(occ[j])) console.log(`  ${p.padEnd(8)} ${arr.map((x) => x.toFixed(1)).join(" / ")}`);
    }
  }
}

if (scenario === "effectifs") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["gamelle", "cabane"]]);
  const P = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, paniers: ["fenetre", "tapis", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 4 } };
  for (const joueurs of [12, 13, 14, 16, 17, 20]) run(`Retenu, ${joueurs} joueurs`, { ...P, joueurs });
}

if (scenario === "sansconflit") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"]]);
  const base = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, joueurs: 16 };
  const lignes = [];
  for (const pc of ["fenetre", "couette", "armoire"])
    for (const pj of ["potager", "cabane"])
      for (const pk of ["frigo", "panier"])
        for (const salon of [1, 2, 3, 4])
          for (const grenier of [1, 2])
            for (const bj of [0, 1]) {
              const cfg = { ...base, paniers: [pc, pj, pk], croquettes: { chambre: 1, grenier, jardin: 1, cuisine: 1, salon }, bonusDepart: [0, bj, 0] };
              const v = [0, 0, 0];
              for (let i = 0; i < N; i++) v[jouerPartie(cfg, 6000 + i).classement[0]]++;
              lignes.push({ cfg, nom: `paniers ${pc}/${pj}/${pk}, Salon +${salon}, Grenier +${grenier}, Jardin ${2 + bj} chats/coin`, v: v.map((x) => Math.round((100 * x) / N)), ecart: Math.max(...v.map((x) => Math.abs(x / N - 1 / 3))) });
            }
  lignes.sort((x, y) => x.ecart - y.ecart);
  for (const l of lignes.slice(0, 8)) console.log(`${l.v.join("/").padEnd(9)} écart ${Math.round(l.ecart * 100)} | ${l.nom}`);
  // Validation du meilleur sur 12-20 joueurs
  for (const joueurs of [12, 14, 16, 18, 20]) run(`Meilleur, ${joueurs} j.`, { ...lignes[0].cfg, joueurs });
}

if (scenario === "sansconflit2") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"]]);
  const base = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, joueurs: 16, paniers: ["couette", "cabane", "frigo"] };
  const lignes = [];
  for (const jardin of [0, 1]) for (const salon of [0, 1]) for (const grenier of [1, 2, 3]) for (const bj of [-1, 0]) for (const pp of [2, 1, 0]) {
    const cfg = { ...base, croquettes: { chambre: 1, grenier, jardin, cuisine: 1, salon }, bonusDepart: [0, bj, 0], pointsPiece: pp };
    const v = [0, 0, 0];
    for (let i = 0; i < N; i++) v[jouerPartie(cfg, 6100 + i).classement[0]]++;
    lignes.push({ nom: `croquettes Jardin +${jardin}, Salon +${salon}, Grenier +${grenier} | Jardin ${2 + bj} chats/coin | pièce ${pp} pts`, v: v.map((x) => Math.round((100 * x) / N)), ecart: Math.max(...v.map((x) => Math.abs(x / N - 1 / 3))) });
  }
  lignes.sort((x, y) => x.ecart - y.ecart);
  for (const l of lignes.slice(0, 6)) console.log(`${l.v.join("/").padEnd(9)} écart ${Math.round(l.ecart * 100)} | ${l.nom}`);
}

if (scenario === "symetrique") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["cabane", "lucarne"]]);
  const base = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, joueurs: 16 };
  const lignes = [];
  for (const pc of ["fenetre", "couette", "armoire"])
    for (const pk of ["frigo", "panier", "gamelle"])
      for (const salon of [1, 2]) for (const grenier of [1, 2]) for (const pp of [2, 0]) {
        const cfg = { ...base, paniers: [pc, "potager", pk], croquettes: { chambre: 1, grenier, jardin: 1, cuisine: 1, salon }, pointsPiece: pp };
        const v = [0, 0, 0];
        for (let i = 0; i < N; i++) v[jouerPartie(cfg, 6200 + i).classement[0]]++;
        lignes.push({ cfg, nom: `paniers ${pc}/potager/${pk}, Salon +${salon}, Grenier +${grenier}, pièce ${pp} pts`, v: v.map((x) => Math.round((100 * x) / N)), ecart: Math.max(...v.map((x) => Math.abs(x / N - 1 / 3))) });
      }
  const simple = lignes.find((l) => l.nom === "paniers fenetre/potager/frigo, Salon +1, Grenier +1, pièce 2 pts");
  console.log("Réglage le plus simple (tout à +1) :", simple.v.join("/"), "écart", Math.round(simple.ecart * 100));
  lignes.sort((x, y) => x.ecart - y.ecart);
  for (const l of lignes.slice(0, 6)) console.log(`${l.v.join("/").padEnd(9)} écart ${Math.round(l.ecart * 100)} | ${l.nom}`);
  for (const joueurs of [12, 14, 16, 18, 20]) run(`Meilleur, ${joueurs} j.`, { ...lignes[0].cfg, joueurs });
  for (const joueurs of [12, 16, 20]) run(`Tout à +1, ${joueurs} j.`, { ...simple.cfg, joueurs });
}

if (scenario === "symetrique2") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["cabane", "lucarne"]]);
  const base = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" } };
  const T = { paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 } };
  for (const joueurs of [12, 14, 16, 18, 20]) run(`Sans Radiateur-Arbre, tout à +1, ${joueurs} j.`, { ...base, ...T, joueurs });
  run("Idem, Roux naïfs (16 j.)", { ...base, ...T, joueurs: 16, profilForce: () => "regulier", strategie: (b) => (b === 0 ? "naif" : "smart") });
}

if (scenario === "pourquoi2") {
  const carte = construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["cabane", "lucarne"]]);
  const cfg = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, joueurs: 16, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 } };
  const noms = ["Roux", "Noirs", "Chartreux"];
  const prises = [[0, 0, 0, 0], [0, 0, 0, 0], [0, 0, 0, 0]];
  const occ = {};
  const pts = [0, 0, 0];
  for (let i = 0; i < N; i++) {
    const g = jouerPartie(cfg, 2000 + i);
    g.stats.prises.forEach((row, b) => row.forEach((x, k) => (prises[b][k] += x / N)));
    for (const [p, arr] of Object.entries(g.stats.occupation[7])) occ[p] = (occ[p] || [0, 0, 0]).map((x, k) => x + arr[k] / N);
    const fin = g.stats.pointsJ[6];
    fin.forEach((x, b) => (pts[b] += x / N));
  }
  console.log("Prises (ligne = qui prend ; colonnes errants/Roux/Noirs/Chartreux) :");
  prises.forEach((row, b) => console.log(`  ${noms[b].padEnd(10)} ${row.map((x) => x.toFixed(0).padStart(4)).join("")}`));
  console.log("Coins tenus fin J7 (Roux/Noirs/Chartreux) :");
  for (const [p, arr] of Object.entries(occ)) console.log(`  ${p.padEnd(8)} ${arr.map((x) => x.toFixed(1)).join(" / ")}`);
  console.log("Points finaux moyens :", pts.map((x) => x.toFixed(1)).join(" / "));
}

if (scenario === "symetrique3") {
  const portes = [["carton", "canape"], ["armoire", "malle"], ["malle", "evier"], ["gamelle", "biblio"], ["tapis", "perron"], ["cabane", "lucarne"]];
  const carte = construireCarte(portes);
  const base = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" } };
  // Paniers hors passages : Chambre fenêtre/couette, Jardin arbre/potager, Cuisine frigo/corbeille
  const lignes = [];
  for (const pc of ["fenetre", "couette"]) for (const pj of ["arbre", "potager"]) for (const pk of ["frigo", "panier"]) {
    const cfg = { ...base, joueurs: 16, paniers: [pc, pj, pk], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 } };
    const v = [0, 0, 0];
    for (let i = 0; i < N; i++) v[jouerPartie(cfg, 6300 + i).classement[0]]++;
    lignes.push({ cfg, nom: `paniers ${pc}/${pj}/${pk}`, v: v.map((x) => Math.round((100 * x) / N)), ecart: Math.max(...v.map((x) => Math.abs(x / N - 1 / 3))) });
  }
  lignes.sort((x, y) => x.ecart - y.ecart);
  for (const l of lignes) console.log(`${l.v.join("/").padEnd(9)} écart ${Math.round(l.ecart * 100)} | ${l.nom}`);
  for (const joueurs of [12, 14, 16, 18, 20]) run(`Symétrique, ${lignes[0].nom}, ${joueurs} j.`, { ...lignes[0].cfg, joueurs });
  run("Symétrique, Roux naïfs (16 j.)", { ...lignes[0].cfg, joueurs: 16, profilForce: () => "regulier", strategie: (b) => (b === 0 ? "naif" : "smart") });
}

if (scenario === "symetrique4" || scenario === "symetrique4b") {
  const BRUIT = scenario === "symetrique4b";
  const portes = [["carton", "canape"], ["armoire", "malle"], ["evier", "chapeaux"], ["gamelle", "biblio"], ["tapis", "perron"], ["cabane", "lucarne"]];
  const carte = construireCarte(portes);
  const base = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], joueurs: 16, croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 }, bruit: BRUIT };
  const PAN = { chambre: "fenetre", jardin: "potager", cuisine: "frigo" };
  for (const ordre of [["chambre", "jardin", "cuisine"], ["jardin", "cuisine", "chambre"], ["cuisine", "chambre", "jardin"]]) {
    const cfg = { ...base, departs: { 0: ordre[0], 1: ordre[1], 2: ordre[2] }, paniers: ordre.map((p) => PAN[p]) };
    const v = [0, 0, 0];
    for (let i = 0; i < N; i++) v[jouerPartie(cfg, 6400 + i).classement[0]]++;
    console.log(`bandes 0/1/2 = ${ordre.join("/")} → ${v.map((x) => Math.round((100 * x) / N) + " %").join(" / ")}`);
  }
}

if (scenario === "revue") {
  const C1 = { 1: 1 };
  void C1;
  const base = { ...BASE, ...ANTI, score: "rang", equilibrage: true, rechargeHeures: [8, 13, 18] };
  const tout1 = { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 };
  const configs = [
    ["Proposition : départ Jardin + Cabane-Lucarne (portes image + Carton-Malle + Radiateur-Arbre)", {
      carte: construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["cabane", "lucarne"]]),
      departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: tout1 }],
    ["Proposition sans Radiateur-Arbre", {
      carte: construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["cabane", "lucarne"]]),
      departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: tout1 }],
    ["Ancienne config (départ Salon, Gamelle-Cabane, Salon +4)", {
      carte: construireCarte([...PORTES_IMAGE, ["carton", "malle"], ["radiateur", "arbre"], ["gamelle", "cabane"]]),
      departs: { 0: "chambre", 1: "salon", 2: "cuisine" }, paniers: ["fenetre", "tapis", "frigo"], croquettes: { ...tout1, salon: 4 } }],
  ];
  for (const [nom, d] of configs) for (const joueurs of [12, 16, 20]) run(`${nom}, ${joueurs} j.`, { ...base, ...d, joueurs });
}

if (scenario === "symfinal") {
  const carte = construireCarte([["carton", "canape"], ["armoire", "malle"], ["evier", "chapeaux"], ["gamelle", "biblio"], ["tapis", "perron"], ["cabane", "lucarne"]]);
  const P = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 } };
  for (const joueurs of [12, 13, 14, 16, 17, 20]) run(`Symétrique, ${joueurs} j.`, { ...P, joueurs });
  run("Symétrique, Roux naïfs (16 j.)", { ...P, joueurs: 16, profilForce: () => "regulier", strategie: (b) => (b === 0 ? "naif" : "smart") });
}

if (scenario === "deplacement") {
  const carte = construireCarte([["carton", "canape"], ["armoire", "malle"], ["evier", "chapeaux"], ["gamelle", "biblio"], ["tapis", "perron"], ["cabane", "lucarne"]]);
  const P = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 } };
  for (const deplacement of [false, true]) for (const joueurs of [12, 16, 20]) run(`${deplacement ? "Avec" : "Sans"} déplacement, ${joueurs} j.`, { ...P, joueurs, deplacement });
  run("Avec déplacement, Roux naïfs (16 j.)", { ...P, joueurs: 16, deplacement: true, profilForce: () => "regulier", strategie: (b) => (b === 0 ? "naif" : "smart") });
}

if (scenario === "squats") {
  const carte = construireCarte([["carton", "canape"], ["armoire", "malle"], ["evier", "chapeaux"], ["gamelle", "biblio"], ["tapis", "perron"], ["cabane", "lucarne"]]);
  const P = { ...BASE, ...ANTI, score: "rang", equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 }, deplacement: true };
  for (const sq of [2, 1]) {
    for (const joueurs of [12, 16, 20]) run(`${sq} squat(s)/distribution, ${joueurs} j.`, { ...P, joueurs, squatsParDistribution: sq });
    run(`${sq} squat(s)/distribution, Roux naïfs (16 j.)`, { ...P, joueurs: 16, squatsParDistribution: sq, profilForce: () => "regulier", strategie: (b) => (b === 0 ? "naif" : "smart") });
  }
}

if (scenario === "bareme") {
  const carte = construireCarte([["carton", "canape"], ["armoire", "malle"], ["evier", "chapeaux"], ["gamelle", "biblio"], ["tapis", "perron"], ["cabane", "lucarne"]]);
  const P = { ...BASE, ...ANTI, equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 }, deplacement: true, squatsParDistribution: 1 };
  for (const [nom, d] of [
    ["Actuel : rang du soir 3/2/1 (territoires + 2 par pièce)", { score: "rang", pointsPiece: 2 }],
    ["Cumul : territoires + 2 par pièce chaque soir", { score: "cumul", pointsPiece: 2 }],
    ["Cumul : 1 pt par territoire chaque soir (pièces = croquettes seulement)", { score: "cumul", pointsPiece: 0 }],
  ]) {
    for (const joueurs of [12, 16, 20]) run(`${nom}, ${joueurs} j.`, { ...P, ...d, joueurs });
    run(`${nom}, Roux naïfs (16 j.)`, { ...P, ...d, joueurs: 16, profilForce: () => "regulier", strategie: (b) => (b === 0 ? "naif" : "smart") });
  }
}

const GEO = [
  ["fenetre", "couette"], ["couette", "armoire"], ["armoire", "carton"],
  ["malle", "chapeaux"], ["chapeaux", "poutre"], ["poutre", "lucarne"],
  ["radiateur", "canape"], ["radiateur", "tapis"], ["canape", "tapis"], ["canape", "biblio"], ["tapis", "biblio"],
  ["evier", "frigo"], ["frigo", "panier"], ["panier", "gamelle"],
  ["arbre", "perron"], ["perron", "potager"], ["potager", "cabane"],
];
const PORTES_SYM = [["carton", "canape"], ["armoire", "malle"], ["evier", "chapeaux"], ["gamelle", "biblio"], ["tapis", "perron"], ["cabane", "lucarne"]];

if (scenario === "geo") {
  const base = { ...BASE, ...ANTI, score: "cumul", pointsPiece: 0, equilibrage: true, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 }, deplacement: true, squatsParDistribution: 1 };
  const carteGeo = construireCarte(PORTES_SYM, GEO);
  run("Référence : pièces où tout se touche, 16 j.", { ...base, carte: construireCarte(PORTES_SYM), paniers: ["fenetre", "potager", "frigo"], joueurs: 16 });
  // Paniers hors passages dans chaque pièce de départ
  const lignes = [];
  for (const pc of ["fenetre", "couette"]) for (const pj of ["arbre", "potager"]) for (const pk of ["frigo", "panier"]) {
    const cfg = { ...base, carte: carteGeo, paniers: [pc, pj, pk], joueurs: 16 };
    const v = [0, 0, 0];
    for (let i = 0; i < N; i++) v[jouerPartie(cfg, 8800 + i).classement[0]]++;
    lignes.push({ cfg, nom: `paniers ${pc}/${pj}/${pk}`, v: v.map((x) => Math.round((100 * x) / N)), ecart: Math.max(...v.map((x) => Math.abs(x / N - 1 / 3))) });
  }
  lignes.sort((x, y) => x.ecart - y.ecart);
  for (const l of lignes) console.log(`${l.v.join("/").padEnd(9)} écart ${Math.round(l.ecart * 100)} | ${l.nom}`);
  const best = lignes[0].cfg;
  for (const joueurs of [12, 16, 20]) run(`Géographique, ${lignes[0].nom}, ${joueurs} j.`, { ...best, joueurs });
  run(`Géographique, ${lignes[0].nom}, Roux naïfs (16 j.)`, { ...best, profilForce: () => "regulier", strategie: (b) => (b === 0 ? "naif" : "smart") });
}

if (scenario === "geo2") {
  const base = { ...BASE, ...ANTI, score: "cumul", pointsPiece: 0, equilibrage: true, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 }, deplacement: true, squatsParDistribution: 1 };
  const portes = [["fenetre", "radiateur"], ["carton", "malle"], ["evier", "chapeaux"], ["gamelle", "biblio"], ["arbre", "tapis"], ["cabane", "lucarne"]];
  const carte = construireCarte(portes, GEO);
  const lignes = [];
  for (const pc of ["couette", "armoire"]) for (const pj of ["perron", "potager"]) for (const pk of ["frigo", "panier"]) {
    const cfg = { ...base, carte, paniers: [pc, pj, pk], joueurs: 16 };
    const v = [0, 0, 0];
    for (let i = 0; i < N; i++) v[jouerPartie(cfg, 8900 + i).classement[0]]++;
    lignes.push({ cfg, nom: `paniers ${pc}/${pj}/${pk}`, v: v.map((x) => Math.round((100 * x) / N)), ecart: Math.max(...v.map((x) => Math.abs(x / N - 1 / 3))) });
  }
  lignes.sort((x, y) => x.ecart - y.ecart);
  for (const l of lignes.slice(0, 4)) console.log(`${l.v.join("/").padEnd(9)} écart ${Math.round(l.ecart * 100)} | ${l.nom}`);
  for (const joueurs of [12, 16, 20]) run(`Géo, sorties aux bouts, ${lignes[0].nom}, ${joueurs} j.`, { ...lignes[0].cfg, joueurs });
  run(`Géo, sorties aux bouts, Roux naïfs (16 j.)`, { ...lignes[0].cfg, profilForce: () => "regulier", strategie: (b) => (b === 0 ? "naif" : "smart") });
}

if (scenario === "stock") {
  const carte = construireCarte(PORTES_SYM);
  const P = { ...BASE, ...ANTI, score: "cumul", pointsPiece: 0, equilibrage: true, carte, rechargeHeures: [8, 13, 18], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 }, deplacement: true, squatsParDistribution: 1 };
  for (const stockMax of [4, 3]) for (const joueurs of [12, 16, 20]) run(`Réserve max ${stockMax}, ${joueurs} j.`, { ...P, joueurs, stockMax });
}

if (scenario === "gain2") {
  const carte = construireCarte(PORTES_SYM);
  const P = { ...BASE, ...ANTI, score: "cumul", pointsPiece: 0, equilibrage: true, carte, rechargeHeures: [8, 13, 21], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 }, deplacement: true, squatsParDistribution: 1 };
  for (const [nom, d] of [["1 chat, réserve 3 (actuel)", { gainDistribution: 1, stockMax: 3 }], ["2 chats, réserve 3", { gainDistribution: 2, stockMax: 3 }], ["2 chats, réserve 4", { gainDistribution: 2, stockMax: 4 }], ["2 chats, réserve 6", { gainDistribution: 2, stockMax: 6 }]]) {
    for (const joueurs of [12, 16, 20]) run(`${nom}, ${joueurs} j.`, { ...P, ...d, joueurs });
    run(`${nom}, Roux naïfs (16 j.)`, { ...P, ...d, joueurs: 16, profilForce: () => "regulier", strategie: (b) => (b === 0 ? "naif" : "smart") });
  }
}

if (scenario === "blocage") {
  const carte = construireCarte(PORTES_SYM);
  const P = { ...BASE, ...ANTI, score: "cumul", pointsPiece: 0, equilibrage: true, carte, rechargeHeures: [8, 13, 21], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 }, deplacement: true, squatsParDistribution: 1, joueurs: 12 };
  // Bande 1 affaiblie : 1 joueur occasionnel, les autres réguliers (comme la partie de test)
  const faible = (b, r) => (b === 1 && r() < 0.25 ? "occasionnel" : "regulier");
  for (const [nom, d] of [["1 chat, réserve 3", { gainDistribution: 1, stockMax: 3 }], ["2 chats, réserve 4", { gainDistribution: 2, stockMax: 4 }]]) {
    for (const [cas, extra] of [["activité normale", {}], ["Chats noirs affaiblis", { profilForce: faible }]]) {
      const cfg = { ...P, ...d, ...extra };
      DES_DEF = 2; memoVictoire.clear();
      let blocages = 0, joursBloques = 0, bloqueeGagne = 0, victoiresNoirs = 0;
      for (let i = 0; i < N; i++) {
        const g = jouerPartie(cfg, 7700 + i);
        if (g.classement[0] === 1) victoiresNoirs++;
        const cj = g.stats.coinsJour;
        let partieBloquee = false;
        for (let b = 0; b < 3; b++) {
          let suite = 0, bloquee = false;
          for (const jour of cj) {
            if (jour[b] <= 2) { suite++; joursBloques++; } else suite = 0;
            if (suite >= 2) bloquee = true;
          }
          if (bloquee) { blocages++; partieBloquee = true; if (g.classement[0] === b) bloqueeGagne++; }
        }
        void partieBloquee;
      }
      console.log(`${nom.padEnd(18)} | ${cas.padEnd(22)} | bande bloquée (≤ 2 territoires 2 soirs de suite) : ${Math.round((100 * blocages) / N)} % des parties, ${(joursBloques / N).toFixed(2)} jour-bande bloqué en moyenne, une bande bloquée gagne ${blocages ? Math.round((100 * bloqueeGagne) / blocages) : 0} % du temps | victoires Noirs ${Math.round((100 * victoiresNoirs) / N)} %`);
    }
  }
}

if (scenario === "mercenaires") {
  const carte = construireCarte(PORTES_SYM);
  const P = { ...BASE, ...ANTI, score: "cumul", pointsPiece: 0, equilibrage: true, carte, rechargeHeures: [8, 13, 21], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 }, deplacement: true, squatsParDistribution: 1 };
  const variantes = process.argv[4] === "fin" ? [
    ["aucun", null],
    ["J3, +1 par joueur", { jours: [3], n: 1, parJoueur: true }],
    ["J3, +2 par joueur", { jours: [3], n: 2, parJoueur: true }],
    ["J3+J6, +1 par joueur", { jours: [3, 6], n: 1, parJoueur: true }],
    ["J3+J6, +2 par joueur", { jours: [3, 6], n: 2, parJoueur: true }],
    ["J4, +2 par joueur", { jours: [4], n: 2, parJoueur: true }],
  ] : [
    ["aucun", null],
    ["J3, +3 pour la bande", { jours: [3], n: 3 }],
    ["J3+J6, +3 pour la bande", { jours: [3, 6], n: 3 }],
    ["J3, +3 par joueur", { jours: [3], n: 3, parJoueur: true }],
    ["J3+J6, +3 par joueur", { jours: [3, 6], n: 3, parJoueur: true }],
  ];
  const gains = process.argv[4] === "fin" ? [["2 chats/res 4", { gainDistribution: 2, stockMax: 4 }]] : [["1 chat/res 3", { gainDistribution: 1, stockMax: 3 }], ["2 chats/res 4", { gainDistribution: 2, stockMax: 4 }]];
  for (const [gainNom, gain] of gains) {
    for (const [nom, merc] of variantes) {
      let derniereJ2Gagne = 0, n2 = 0, blocages = 0, joursBloques = 0, leaderJ3 = 0, v = [0, 0, 0], ecart = 0;
      for (const joueurs of [12, 16, 20]) {
        const cfg = { ...P, ...gain, joueurs, mercenaires: merc };
        DES_DEF = 2; memoVictoire.clear();
        for (let i = 0; i < N; i++) {
          const g = jouerPartie(cfg, 6600 + i);
          const w = g.classement[0];
          v[w]++;
          const pJ2 = g.stats.pointsJ[1];
          const dJ2 = [0, 1, 2].sort((x, y) => pJ2[x] - pJ2[y] || x - y)[0];
          n2++; if (w === dJ2) derniereJ2Gagne++;
          if (g.stats.leaderJ3 === w) leaderJ3++;
          ecart += (g.points[w] - g.points[g.classement[1]]) / g.points[w];
          for (let b = 0; b < 3; b++) {
            let suite = 0, bloquee = false;
            for (const jour of g.stats.coinsJour) { if (jour[b] <= 2) { suite++; joursBloques++; } else suite = 0; if (suite >= 2) bloquee = true; }
            if (bloquee) blocages++;
          }
        }
      }
      const T = 3 * N;
      console.log(`${gainNom.padEnd(13)} | ${nom.padEnd(24)} | bande dernière au J2 gagne ${String(Math.round((100 * derniereJ2Gagne) / n2)).padStart(2)} % | leader J3 gagne ${Math.round((100 * leaderJ3) / T)} % | blocages ${Math.round((100 * blocages) / T)} % (${(joursBloques / T).toFixed(2)} soir) | écart 1er-2e ${Math.round((100 * ecart) / T)} % | victoires ${v.map((x) => Math.round((100 * x) / T)).join("/")}`);
    }
  }
}

if (scenario === "deblocage") {
  const carte = construireCarte(PORTES_SYM);
  const P = { ...BASE, ...ANTI, score: "cumul", pointsPiece: 0, equilibrage: true, carte, rechargeHeures: [8, 13, 21], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 }, deplacement: true, squatsParDistribution: 1, gainDistribution: 2, stockMax: 4 };
  const T = (o) => ({ cible: "territoires", ...o });
  const variantes = [
    ["aucun", null],
    ["J3, dernière aux points, +2/joueur", { jours: [3], n: 2, parJoueur: true }],
    ["J3, moins de territoires, +2/joueur", T({ jours: [3], n: 2, parJoueur: true })],
    ["J3, moins de territoires, +3/joueur", T({ jours: [3], n: 3, parJoueur: true })],
    ["J3+J5, moins de territoires, +2/joueur", T({ jours: [3, 5], n: 2, parJoueur: true })],
    ["J3+J5, si ≤ 4 territoires, +3/joueur", T({ jours: [3, 5], n: 3, parJoueur: true, seuil: 4 })],
    ["J3+J5, si ≤ 4 territoires, +4/joueur", T({ jours: [3, 5], n: 4, parJoueur: true, seuil: 4 })],
  ];
  for (const [nom, merc] of variantes) {
    let moy = 0, soirsBloques = 0, nbBloqueesJ2 = 0, moyBloquee = 0, soirsBloquesB = 0, leader = 0, v = [0, 0, 0];
    for (const joueurs of [12, 16, 20]) {
      const cfg = { ...P, joueurs, mercenaires: merc };
      DES_DEF = 2; memoVictoire.clear();
      for (let i = 0; i < N; i++) {
        const g = jouerPartie(cfg, 5500 + i);
        v[g.classement[0]]++;
        if (g.stats.leaderJ3 === g.classement[0]) leader++;
        const cj = g.stats.coinsJour;
        const b = [0, 1, 2].sort((x, y) => cj[1][x] - cj[1][y])[0];
        const apres = cj.slice(2).map((j) => j[b]);
        moy += apres.reduce((t, x) => t + x, 0) / apres.length;
        soirsBloques += apres.filter((x) => x <= 2).length;
        if (cj[1][b] <= 3) { nbBloqueesJ2++; moyBloquee += apres.reduce((t, x) => t + x, 0) / apres.length; soirsBloquesB += apres.filter((x) => x <= 2).length; }
      }
    }
    const tot = 3 * N;
    console.log(`${nom.padEnd(40)} | dernière du J2 : ${(moy / tot).toFixed(1)} terr. J3-J7, ${(soirsBloques / tot).toFixed(2)} soir ≤2 | si ≤3 terr. au J2 (${Math.round((100 * nbBloqueesJ2) / tot)} % des parties) : ${(moyBloquee / Math.max(1, nbBloqueesJ2)).toFixed(1)} terr., ${(soirsBloquesB / Math.max(1, nbBloqueesJ2)).toFixed(2)} soir ≤2 | leader J3 ${Math.round((100 * leader) / tot)} % | victoires ${v.map((x) => Math.round((100 * x) / tot)).join("/")}`);
  }
}

// Poids stratégie / activité / hasard avec la config implémentée (17/10)
if (scenario === "poids") {
  const carte = construireCarte(PORTES_SYM);
  const P = { ...BASE, ...ANTI, score: "cumul", pointsPiece: 0, equilibrage: true, carte, rechargeHeures: [8, 13, 21], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 }, deplacement: true, squatsParDistribution: 1, gainDistribution: 2, stockMax: Number(process.argv[5]) || 3, mercenaires: { jours: [3], n: 1, parJoueur: true }, siesteUnChat: true, joueurs: Number(process.argv[4]) || 15 };
  const egal = () => "regulier";
  const naif = (b) => (b === 0 ? "naif" : "smart");
  run("Réf. activité normale (mix)", P);
  run("Tous réguliers (3 visites/j)", { ...P, profilForce: egal });
  run("Roux naïfs, activité égale", { ...P, profilForce: egal, strategie: naif });
  run("Roux assidus (5) vs réguliers (3)", { ...P, profilForce: (b) => (b === 0 ? "assidu" : "regulier") });
  run("Roux occasionnels (1) vs réguliers (3)", { ...P, profilForce: (b) => (b === 0 ? "occasionnel" : "regulier") });
  run("Roux : 1/3 des joueurs occasionnels", { ...P, profilForce: (b, r) => (b === 0 && r() < 1 / 3 ? "occasionnel" : "regulier") });
  run("Roux : 1/3 des joueurs abandonnent après J2", { ...P, profilForce: (b, r) => (b === 0 && r() < 1 / 3 ? "abandon" : "regulier") });
  run("Roux assidus mais naïfs", { ...P, profilForce: (b) => (b === 0 ? "assidu" : "regulier"), strategie: naif });
  run("Sans hasard (dés), tous réguliers, Roux naïfs", { ...P, profilForce: egal, strategie: naif, combat: "deterministe" });
}

// Mécaniques qui récompensent l'activité (17/10)
if (scenario === "actifs") {
  const carte = construireCarte(PORTES_SYM);
  const P = { ...BASE, ...ANTI, score: "cumul", pointsPiece: 0, equilibrage: true, carte, rechargeHeures: [8, 13, 21], departs: { 0: "chambre", 1: "jardin", 2: "cuisine" }, paniers: ["fenetre", "potager", "frigo"], croquettes: { chambre: 1, grenier: 1, jardin: 1, cuisine: 1, salon: 1 }, deplacement: true, squatsParDistribution: 1, gainDistribution: 2, stockMax: 4, mercenaires: { jours: [3], n: 1, parJoueur: true }, siesteUnChat: true, joueurs: 15 };
  const quiet = (nom, cfg) => {
    DES_DEF = 2; DETERMINISTE = false; memoVictoire.clear();
    let v = 0, leader = 0;
    for (let i = 0; i < N; i++) { const g = jouerPartie(cfg, 1000 + i); if (g.classement[0] === 0) v++; if (g.stats.leaderJ3 === g.classement[0]) leader++; }
    return [Math.round((100 * v) / N), Math.round((100 * leader) / N)];
  };
  const cas = [
    ["assidus 5 vs 3", { profilForce: (b) => (b === 0 ? "assidu" : "regulier") }],
    ["occasionnels 1 vs 3", { profilForce: (b) => (b === 0 ? "occasionnel" : "regulier") }],
    ["1/3 abandon J2", { profilForce: (b, r) => (b === 0 && r() < 1 / 3 ? "abandon" : "regulier") }],
    ["naïfs", { profilForce: () => "regulier", strategie: (b) => (b === 0 ? "naif" : "smart") }],
    ["mix normal", {}],
  ];
  const variantes = [
    ["actuel", {}],
    ["butin +1 chat/coin pris", { butin: 1 }],
    ["butin +2 chats/coin pris", { butin: 2 }],
    ["+1 pt par coin pris", { pointsConquete: 1 }],
    ["+2 pts par coin pris", { pointsConquete: 2 }],
    ["+1 pt/joueur présent/jour", { pointsPresence: 1 }],
    ["+2 pts/joueur présent/jour", { pointsPresence: 2 }],
    ["réserve max 2", { stockMax: 2 }],
    ["ennui : pile > 5 perd 1 chat/nuit", { ennui: 5 }],
    ["butin +1 et +1 pt/coin pris", { butin: 1, pointsConquete: 1 }],
    ["2 squats/distribution", { squatsParDistribution: 2 }],
  ].filter(([n]) => !process.argv[4] || n === "actuel" || n.startsWith("réserve") || n.startsWith("combo"));
  if (process.argv[4]) variantes.push(
    ["réserve max 3", { stockMax: 3 }],
    ["combo réserve 3 + butin +1", { stockMax: 3, butin: 1 }],
    ["combo réserve 2, 3 chats/distrib", { stockMax: 3, gainDistribution: 3 }],
    ["combo réserve 2 + butin +1", { stockMax: 2, butin: 1 }],
  );
  console.log("Victoires Roux (%) | " + cas.map(([n]) => n).join(" | ") + " | leader J3 (mix)");
  for (const [nom, d] of variantes) {
    const res = cas.map(([, c]) => quiet(nom, { ...P, ...d, ...c }));
    console.log(nom.padEnd(36) + " | " + res.map(([v]) => String(v).padStart(3)).join(" | ") + " | " + res.at(-1)[1]);
  }
}
