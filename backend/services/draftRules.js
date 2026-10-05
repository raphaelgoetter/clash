// ============================================================
// draftRules.js — Règles PURES du Draft (jeu spécial Draft Royale et duel
// /draft), inspirées du « Kilo de merde » : chaque carte en jeu existe en
// `exemplaires` (4) exemplaires, chaque joueur a `taille_main` (4) cartes
// en main et le marché contient une carte par joueur, toujours visible. Les
// exemplaires en trop restent à l'écart (« réserve », face cachée) jusqu'à
// la prochaine donne. À chaque tour, un
// joueur prend une carte du marché et y dépose une carte de sa main. Le but
// est de réunir 4 exemplaires d'une même carte (un « carré »).
//
// Aucune I/O ici : `rng` injectable partout, appelé par draftroyale.js
// (Redis, jours) et draftDuel.js (Redis, manches).
//
// ⚠️ Toute modification de règle doit suivre CONTRIBUTING.md (section
// Draft Royale), source de vérité.
// ============================================================

export function shuffle(array, rng = Math.random) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// ── Mains ────────────────────────────────────────────────────────────

export function compterCartes(main) {
  const counts = new Map();
  for (const k of main || []) counts.set(k, (counts.get(k) || 0) + 1);
  return counts;
}

// Nombre d'exemplaires de la carte la plus présente dans la main.
export function plusGrandGroupe(main) {
  return Math.max(0, ...compterCartes(main).values());
}

export function aUnCarre(main, config) {
  return plusGrandGroupe(main) >= config.taille_main;
}

// Points d'une main en fin de manche : `points_carre` pour un carré, sinon
// le nombre d'exemplaires identiques (1, 2 ou 3).
export function pointsMain(main, config) {
  return aUnCarre(main, config) ? config.points_carre : plusGrandGroupe(main);
}

// Main triée par groupes (les plus gros d'abord), pour l'affichage.
export function trierMain(main) {
  const counts = compterCartes(main);
  return [...(main || [])].sort((a, b) => counts.get(b) - counts.get(a) || a.localeCompare(b));
}

// ── Cartes en jeu ────────────────────────────────────────────────────

// Nombre de cartes différentes en jeu : assez d'exemplaires pour les mains
// et un marché d'une carte par joueur (5 cartes par joueur avec des mains
// de 4), soit ⌈5N / 4⌉ cartes à 4 exemplaires pour N joueurs.
export function nbFamilles(nbJoueurs, config) {
  return Math.ceil((nbJoueurs * (config.taille_main + 1)) / config.exemplaires);
}

// Prochaines cartes à entrer en jeu : la liste `config.cartes` dans
// l'ordre, puis des cartes du catalogue au hasard si elle est épuisée.
export function choisirFamilles(nb, config, catalog, exclues = [], rng = Math.random) {
  const interdites = new Set(exclues);
  const prioritaires = (config.cartes || []).filter((k) => catalog.has(k) && !interdites.has(k));
  const autres = shuffle(
    [...catalog.keys()].filter((k) => !interdites.has(k) && !prioritaires.includes(k)),
    rng,
  );
  return [...prioritaires, ...autres].slice(0, nb);
}

export function paquet(familles, config) {
  return familles.flatMap((k) => Array(config.exemplaires).fill(k));
}

// Tire une main de `taille_main` cartes au hasard dans `tas`, jamais un
// carré d'emblée (sauf impossibilité). Renvoie la main et le reste.
export function tirerMain(tas, config, rng = Math.random) {
  let tirage = null;
  for (let essai = 0; essai < 50; essai++) {
    const melange = shuffle(tas, rng);
    tirage = { main: melange.slice(0, config.taille_main), reste: melange.slice(config.taille_main) };
    if (!aUnCarre(tirage.main, config)) break;
  }
  return tirage;
}

// Distribution complète (début de partie ou nouvelle donne après un
// carré) : toutes les cartes sont mélangées, `taille_main` par joueur, une
// carte par joueur au marché, le reste en réserve. Aucune main ne commence
// par un carré.
export function distribuer({ familles, joueurIds, config, rng = Math.random }) {
  let tas = shuffle(paquet(familles, config), rng);
  const mains = {};
  for (const id of joueurIds) {
    const tirage = tirerMain(tas, config, rng);
    mains[id] = tirage.main;
    tas = tirage.reste;
  }
  return { mains, marche: tas.slice(0, joueurIds.length), reserve: tas.slice(joueurIds.length) };
}

// Arrivée d'un joueur : de nouvelles cartes entrent en jeu si besoin (leurs
// exemplaires vont en réserve), le joueur tire sa main dans la réserve,
// puis la réserve complète le marché d'une carte. Le marché existant n'est
// jamais touché (les échanges déjà prévus restent valides).
export function ajouterJoueur({ familles, marche, reserve, nbJoueursAvant, config, catalog, rng = Math.random }) {
  const nbJoueurs = nbJoueursAvant + 1;
  const nouvelles = choisirFamilles(Math.max(0, nbFamilles(nbJoueurs, config) - familles.length), config, catalog, familles, rng);
  let tas = [...(reserve || []), ...paquet(nouvelles, config)];
  let newMarche = [...marche];
  // Réserve insuffisante (ne devrait pas arriver) : on puise dans le marché
  if (tas.length < config.taille_main) {
    tas = [...tas, ...newMarche];
    newMarche = [];
  }
  const tirage = tirerMain(tas, config, rng);
  const reste = shuffle(tirage.reste, rng);
  while (newMarche.length < nbJoueurs && reste.length) newMarche.push(reste.shift());
  return { familles: [...familles, ...nouvelles], marche: newMarche, reserve: reste, main: tirage.main };
}

// ── Échanges ─────────────────────────────────────────────────────────

function retirerUne(liste, key) {
  const i = liste.indexOf(key);
  if (i < 0) return false;
  liste.splice(i, 1);
  return true;
}

// Un échange compte s'il est complet : une carte du marché à prendre et
// une carte de la main à déposer.
export function echangeValide(action, main, marche) {
  return !!action?.prise && !!action?.depot && (main || []).includes(action.depot) && marche.includes(action.prise);
}

// Résolution simultanée des échanges. `joueurs` : copies mutables
// { main, popularite }. Une carte demandée par plus de joueurs qu'il n'y a
// d'exemplaires au marché est disputée : le plus populaire l'emporte
// (tirage au sort entre ex aequo) et sa popularité retombe à 0 ; les
// perdants gagnent +1 popularité et reçoivent au hasard une autre carte
// restée au marché. Les cartes déposées rejoignent ensuite le marché.
export function resoudreEchanges({ joueurs, actions, marche, rng = Math.random }) {
  const reste = [...marche];
  const lignes = [];
  const acteurs = Object.keys(joueurs).filter((id) => echangeValide(actions[id], joueurs[id].main, marche));

  const demandes = new Map();
  for (const id of shuffle(acteurs, rng)) {
    const key = actions[id].prise;
    demandes.set(key, [...(demandes.get(key) || []), id]);
  }

  const obtenu = {};
  const perdants = [];
  for (const [key, ids] of demandes) {
    const copies = marche.filter((k) => k === key).length;
    if (ids.length <= copies) {
      for (const id of ids) obtenu[id] = { key, disputee: false };
      continue;
    }
    // Tri stable : l'ordre déjà mélangé départage les ex aequo
    const ordre = [...ids].sort((a, b) => (joueurs[b].popularite || 0) - (joueurs[a].popularite || 0));
    ordre.forEach((id, i) => {
      if (i < copies) obtenu[id] = { key, disputee: true };
      else perdants.push({ id, voulue: key });
    });
  }
  for (const { key } of Object.values(obtenu)) retirerUne(reste, key);

  const restants = shuffle(reste, rng);
  for (const p of perdants) obtenu[p.id] = { key: restants.shift(), disputee: true, perdue: p.voulue };

  const depots = [];
  for (const id of acteurs) {
    const j = joueurs[id];
    const { depot } = actions[id];
    const o = obtenu[id];
    // Marché épuisé (ne devrait pas arriver : il garde au moins autant de
    // cartes que de joueurs) : l'échange est annulé
    if (!o.key) continue;
    retirerUne(j.main, depot);
    j.main.push(o.key);
    depots.push(depot);
    if (o.perdue) {
      j.popularite = (j.popularite || 0) + 1;
      lignes.push({ type: "perdue", discordId: id, voulue: o.perdue, key: o.key, depot });
    } else {
      if (o.disputee) j.popularite = 0;
      lignes.push({ type: "prise", discordId: id, key: o.key, disputee: o.disputee, depot });
    }
  }
  return { marche: [...restants, ...depots], lignes };
}

// Fin de tour (jour ou manche) : échanges, puis décompte si au moins un
// joueur a un carré ou si c'est le dernier tour. Après un carré (hors
// dernier tour), toutes les cartes sont redistribuées. `joueursAvant` :
// { id: { main, popularite, points, carres, ... } } (non muté).
export function computeTour({ joueursAvant, actions, marche, reserve = [], familles, config, dernier, rng = Math.random }) {
  const joueurs = {};
  for (const [id, j] of Object.entries(joueursAvant)) joueurs[id] = { ...j, main: [...(j.main || [])] };

  const echanges = resoudreEchanges({ joueurs, actions, marche, rng });
  const carres = Object.keys(joueurs).filter((id) => aUnCarre(joueurs[id].main, config));
  const decompte = carres.length > 0 || dernier;

  let scores = null;
  if (decompte) {
    scores = Object.entries(joueurs).map(([id, j]) => {
      const points = pointsMain(j.main, config);
      const carre = aUnCarre(j.main, config);
      j.points = (j.points || 0) + points;
      if (carre) j.carres = (j.carres || 0) + 1;
      return { discordId: id, points, carre, main: [...j.main] };
    });
  }

  let newMarche = echanges.marche;
  let newReserve = reserve;
  const redistribution = carres.length > 0 && !dernier;
  if (redistribution) {
    const donne = distribuer({ familles, joueurIds: Object.keys(joueurs), config, rng });
    for (const [id, main] of Object.entries(donne.mains)) joueurs[id].main = main;
    newMarche = donne.marche;
    newReserve = donne.reserve;
  }
  return { joueurs, marche: newMarche, reserve: newReserve, lignes: echanges.lignes, carres, scores, redistribution };
}

// Classement : points, puis nombre de carrés, puis ordre d'arrivée.
export function classement(joueurs) {
  return Object.entries(joueurs)
    .map(([discordId, j]) => ({
      discordId,
      username: j.username,
      score: j.points || 0,
      carres: j.carres || 0,
      popularite: j.popularite || 0,
      arrivee: j.arrivee ?? 0,
    }))
    .sort((a, b) => b.score - a.score || b.carres - a.carres || a.arrivee - b.arrivee);
}

// ── Stratégie gloutonne (bot du duel, bots de test, simulations) ──────

// Valeur d'une main : taille des groupes, les plus gros d'abord.
function valeur(main) {
  const groupes = [...compterCartes(main).values()].sort((a, b) => b - a);
  return groupes[0] * 10 + (groupes[1] || 0);
}

// Échange qui maximise la main obtenue (si la carte voulue est obtenue),
// tirage au sort entre ex aequo.
export function choixGlouton(main, marche, rng = Math.random) {
  let best = [];
  let bestValeur = -1;
  for (const prise of new Set(marche)) {
    for (const depot of new Set(main)) {
      const apres = [...main];
      retirerUne(apres, depot);
      apres.push(prise);
      const v = valeur(apres);
      if (v > bestValeur) {
        bestValeur = v;
        best = [];
      }
      if (v === bestValeur) best.push({ prise, depot });
    }
  }
  return best.length ? best[Math.floor(rng() * best.length)] : null;
}
