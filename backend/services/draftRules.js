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

// Carte du quadruplé (ou null).
export function carteDuCarre(main, config) {
  for (const [k, n] of compterCartes(main)) if (n >= config.taille_main) return k;
  return null;
}

// Points d'une main en fin de manche : `points_vedette` pour un quadruplé
// d'une carte vedette, `points_carre` pour un autre quadruplé, sinon le
// nombre d'exemplaires identiques (1, 2 ou 3).
export function pointsMain(main, config, vedettes = []) {
  const carte = carteDuCarre(main, config);
  if (carte) return vedettes.includes(carte) ? config.points_vedette : config.points_carre;
  return plusGrandGroupe(main);
}

// Une carte vedette pour `joueurs_par_vedette` joueurs (au moins une).
export function nbVedettes(nbJoueurs, config) {
  return Math.max(1, Math.ceil(nbJoueurs / config.joueurs_par_vedette));
}

// Cartes vedettes d'une donne : `nb` cartes en jeu tirées au hasard, en
// évitant si possible celles de la donne précédente, et en gardant
// `gardees` (vedettes déjà annoncées dans la donne en cours).
export function choisirVedettes(familles, nb, { precedentes = [], gardees = [] } = {}, rng = Math.random) {
  const vedettes = gardees.filter((k) => familles.includes(k)).slice(0, nb);
  const libres = familles.filter((k) => !vedettes.includes(k));
  const neuves = shuffle(libres.filter((k) => !precedentes.includes(k)), rng);
  const anciennes = shuffle(libres.filter((k) => precedentes.includes(k)), rng);
  return [...vedettes, ...neuves, ...anciennes].slice(0, Math.min(nb, familles.length));
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

// ── Joker ────────────────────────────────────────────────────────────
// Un tour se joue par un échange au marché et/ou un bonus Joker. Points
// Joker : +`joker.gain_tour` par tour joué, plus `joker.gain_perte` à
// chaque carte disputée manquée ; ils ne baissent que par les achats et
// les points restants s'ajoutent au score final. Ils départagent les
// disputes (points restants après achat, avant les gains du tour).
//   - Bonus du tour (un seul, payé et résolu à la clôture) : Priorité
//     (servi en premier si la carte prise est disputée) ou Geler une
//     carte du marché (personne ne peut la prendre ce tour-ci).
//   - Espionner (instantané, une fois par tour, en plus du bonus) : voir
//     tout de suite la main d'un joueur.

export const JOKER_ACTIONS = ["priorite", "geler"];

export function jokerCout(type, config) {
  return config.joker.couts[type] ?? null;
}

// Valeur du menu « Bonus du tour » : "aucun", "priorite" ou
// "geler:<carte>". Renvoie { joker } (null = aucun) ou { erreur }.
export function lireBonus(valeur, { id, joueurs, marche, config }) {
  if (!valeur || valeur === "aucun") return { joker: null };
  const [type, carte] = valeur.split(":");
  if (!JOKER_ACTIONS.includes(type)) return { erreur: "inconnue" };
  if ((joueurs[id]?.joker || 0) < jokerCout(type, config)) return { erreur: "points" };
  if (type === "geler" && !marche.includes(carte)) return { erreur: "carte" };
  return { joker: type === "geler" ? { type, carte } : { type } };
}

// Bonus complet et payable. Priorité n'a de sens qu'avec un échange valide,
// Geler qu'avec une carte encore au marché.
export function jokerValide(joker, id, joueurs, config, { echangeOk = true, marche = null } = {}) {
  if (!joker?.type || !JOKER_ACTIONS.includes(joker.type)) return false;
  if ((joueurs[id]?.joker || 0) < jokerCout(joker.type, config)) return false;
  if (joker.type === "priorite") return echangeOk;
  return !!joker.carte && (!marche || marche.includes(joker.carte));
}

// Espionner (pure) : instantané, payé tout de suite, une fois par tour.
// Renvoie { erreur } ou { vu: { cible, main } }.
export function voirMain({ id, cible, joueurs, actions, config }) {
  const moi = joueurs[id];
  if (!moi) return { erreur: "inconnue" };
  if (actions[id]?.vu) return { erreur: "deja" };
  if ((moi.joker || 0) < jokerCout("espionner", config)) return { erreur: "points" };
  if (!cible || cible === id || !joueurs[cible]) return { erreur: "cible" };
  return { vu: { cible, main: [...joueurs[cible].main] } };
}

// Résolution simultanée des échanges. `joueurs` : copies mutables
// { main, joker }. Une carte gelée ne peut être prise par personne
// (échange annulé). Une carte demandée par plus de joueurs qu'il n'y a
// d'exemplaires au marché est disputée : les joueurs en Priorité sont
// servis d'abord, puis les points Joker départagent (tirage au sort entre
// ex aequo). Les perdants gardent leur carte (pas d'échange) et gagnent des
// points Joker. Les cartes déposées par les gagnants rejoignent le marché.
export function resoudreEchanges({ joueurs, actions, marche, config, priorites = new Set(), gelees = new Set(), rng = Math.random }) {
  const reste = [...marche];
  const lignes = [];
  const acteurs = Object.keys(joueurs).filter((id) => echangeValide(actions[id], joueurs[id].main, marche));

  const demandes = new Map();
  for (const id of shuffle(acteurs, rng)) {
    const key = actions[id].prise;
    if (gelees.has(key)) {
      lignes.push({ type: "gelee", discordId: id, voulue: key, depot: actions[id].depot });
      continue;
    }
    demandes.set(key, [...(demandes.get(key) || []), id]);
  }

  const depots = [];
  const obtient = (id, key, disputee) => {
    const j = joueurs[id];
    const { depot } = actions[id];
    retirerUne(j.main, depot);
    retirerUne(reste, key);
    j.main.push(key);
    depots.push(depot);
    lignes.push({ type: "prise", discordId: id, key, disputee, depot, priorite: priorites.has(id) });
  };
  for (const [key, ids] of demandes) {
    const copies = marche.filter((k) => k === key).length;
    if (ids.length <= copies) {
      for (const id of ids) obtient(id, key, false);
      continue;
    }
    // Tri stable : l'ordre déjà mélangé départage les ex aequo
    const ordre = [...ids].sort((a, b) => priorites.has(b) - priorites.has(a) || (joueurs[b].joker || 0) - (joueurs[a].joker || 0));
    ordre.forEach((id, i) => {
      if (i < copies) return obtient(id, key, true);
      joueurs[id].joker = (joueurs[id].joker || 0) + config.joker.gain_perte;
      lignes.push({ type: "perdue", discordId: id, voulue: key, depot: actions[id].depot, gain: config.joker.gain_perte });
    });
  }
  return { marche: [...reste, ...depots], lignes };
}

// Fin de tour (jour ou manche) : paiement des bonus, échanges, puis
// décompte si au moins un joueur a un quadruplé ou si c'est le dernier
// tour. Après un quadruplé (hors dernier tour), toutes les cartes sont
// redistribuées. `joueursAvant` : { id: { main, joker, points, carres, ... } }
// (non muté). `actions[id]` : { prise, depot, joker?, vu? }.
export function computeTour({ joueursAvant, actions, marche, reserve = [], familles, vedettes = [], config, dernier, rng = Math.random }) {
  const joueurs = {};
  for (const [id, j] of Object.entries(joueursAvant)) joueurs[id] = { ...j, main: [...(j.main || [])] };

  // Paiement d'abord : les disputes se départagent sur les points restants
  const jokers = {};
  for (const id of Object.keys(joueurs)) {
    const joker = actions[id]?.joker;
    if (!jokerValide(joker, id, joueurs, config, { echangeOk: echangeValide(actions[id], joueurs[id].main, marche), marche })) continue;
    joueurs[id].joker -= jokerCout(joker.type, config);
    jokers[id] = joker;
  }
  // Tour joué (échange au marché ou bonus) : +gain_tour, après le départage
  const joues = Object.keys(joueurs).filter((id) => jokers[id] || echangeValide(actions[id], joueurs[id].main, marche));
  const priorites = new Set(Object.keys(jokers).filter((id) => jokers[id].type === "priorite"));
  const gelees = new Set(Object.values(jokers).filter((j) => j.type === "geler").map((j) => j.carte));

  const echanges = resoudreEchanges({ joueurs, actions, marche, config, priorites, gelees, rng });
  for (const id of joues) joueurs[id].joker = (joueurs[id].joker || 0) + config.joker.gain_tour;
  const lignes = [...echanges.lignes];
  for (const [id, j] of Object.entries(jokers)) {
    if (j.type === "geler") lignes.push({ type: "joker", action: "geler", discordId: id, carte: j.carte });
  }
  // Espionnages de la journée (déjà résolus) : mentionnés au bilan
  for (const [id, a] of Object.entries(actions)) {
    if (a?.vu) lignes.push({ type: "joker", action: "espionner", discordId: id, cible: a.vu.cible });
  }

  const carres = Object.keys(joueurs).filter((id) => aUnCarre(joueurs[id].main, config));
  const decompte = carres.length > 0 || dernier;

  let scores = null;
  if (decompte) {
    scores = Object.entries(joueurs).map(([id, j]) => {
      const points = pointsMain(j.main, config, vedettes);
      const carre = aUnCarre(j.main, config);
      j.points = (j.points || 0) + points;
      if (carre) j.carres = (j.carres || 0) + 1;
      return { discordId: id, points, carre, vedette: carre && vedettes.includes(carteDuCarre(j.main, config)), main: [...j.main] };
    });
  }

  let newMarche = echanges.marche;
  let newReserve = reserve;
  let newVedettes = vedettes;
  const redistribution = carres.length > 0 && !dernier;
  if (redistribution) {
    const donne = distribuer({ familles, joueurIds: Object.keys(joueurs), config, rng });
    for (const [id, main] of Object.entries(donne.mains)) joueurs[id].main = main;
    newMarche = donne.marche;
    newReserve = donne.reserve;
    newVedettes = choisirVedettes(familles, nbVedettes(Object.keys(joueurs).length, config), { precedentes: vedettes }, rng);
  }
  return { joueurs, marche: newMarche, reserve: newReserve, vedettes: newVedettes, lignes, carres, scores, redistribution };
}

// Classement final : points des décomptes + points Joker restants, puis
// nombre de quadruplés, puis ordre d'arrivée.
export function classement(joueurs) {
  return Object.entries(joueurs)
    .map(([discordId, j]) => ({
      discordId,
      username: j.username,
      score: (j.points || 0) + (j.joker || 0),
      pointsCartes: j.points || 0,
      carres: j.carres || 0,
      joker: j.joker || 0,
      arrivee: j.arrivee ?? 0,
    }))
    .sort((a, b) => b.score - a.score || b.carres - a.carres || a.arrivee - b.arrivee);
}

// ── Stratégie gloutonne (bot du duel, bots de test, simulations) ──────

// Valeur d'une main : taille des groupes, les plus gros d'abord, un groupe
// d'une carte vedette comptant un peu plus.
function valeur(main, vedettes) {
  const groupes = [...compterCartes(main)].map(([k, n]) => n * 10 + (vedettes.includes(k) ? 5 : 0)).sort((a, b) => b - a);
  return groupes[0] + (groupes[1] || 0) / 10;
}

// Échange qui maximise la main obtenue (si la carte voulue est obtenue),
// tirage au sort entre ex aequo.
export function choixGlouton(main, marche, rng = Math.random, vedettes = []) {
  let best = [];
  let bestValeur = -1;
  for (const prise of new Set(marche)) {
    for (const depot of new Set(main)) {
      // Prendre et déposer la même carte ne change rien
      if (depot === prise) continue;
      const apres = [...main];
      retirerUne(apres, depot);
      apres.push(prise);
      const v = valeur(apres, vedettes);
      if (v > bestValeur) {
        bestValeur = v;
        best = [];
      }
      if (v === bestValeur) best.push({ prise, depot });
    }
  }
  return best.length ? best[Math.floor(rng() * best.length)] : null;
}

// Bonus d'un bot (sans jamais regarder les autres mains) : Priorité quand
// sa prise peut compléter un quadruplé.
export function jokerDuBot(id, joueurs, prise, config) {
  const moi = joueurs[id];
  if (!prise || (moi?.joker || 0) < jokerCout("priorite", config)) return null;
  return compterCartes(moi.main).get(prise) === config.taille_main - 1 ? { type: "priorite" } : null;
}
