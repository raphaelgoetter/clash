// ============================================================
// elixirRules.js — Règles PURES du jeu Duel « Élixir » (/elixir).
//
// Aucune I/O ici (ni Redis, ni fichier) : le catalogue de cartes est passé
// en paramètre (chargé par elixirDuel.js depuis data/cardNames.json), et
// tout l'aléatoire passe par un `rng` injectable (Math.random par défaut),
// ce qui permet de tester et de simuler (temp/simulateElixir.js) sans état.
//
// Principe : à chaque manche, des cartes sont mises aux enchères secrètes.
// Chaque joueur fait UNE offre (une carte + une mise ≥ coût de la carte) ou
// passe. Pour chaque carte, la meilleure offre l'emporte et SEUL le gagnant
// paie ; en cas d'égalité la carte est défaussée et personne ne paie. Le
// budget d'élixir est fixe pour toute la partie (aucune recharge). En fin de
// partie : 1 pt par carte + tous les objectifs atteints (cumulables).
// ============================================================

// ── Paramètres de partie ────────────────────────────────────────────

// Économie d'élixir, comme en jeu : un stock de départ, une recharge au
// début de chaque manche suivante, et un plafond (le surplus est perdu)
export const STARTING_ELIXIR = 10;
export const ELIXIR_PER_MANCHE = 4;
export const ELIXIR_CAP = 10;

// Cartes du catalogue exclues du jeu : coût variable (Miroir) ou nature
// ambiguë troupe/sort, volante/au sol (Impératrice spirituelle)
export const EXCLUDED_CARDS = new Set(["Mirror", "Spirit Empress"]);

// Première manche où une carte spéciale peut apparaître
const SPECIAL_FIRST_MANCHE = 4;

// Cartes spéciales : mises aux enchères comme les autres, en PLUS des cartes
// normales de leur manche
export const SPECIALS = {
  collecteur: {
    key: "special:collecteur",
    fr: "Collecteur d'élixir",
    minBid: 2,
    description: "+5 élixirs immédiatement.",
    // Inutile à la dernière manche (l'élixir restant ne rapporte rien)
    lastMancheAllowed: false,
  },
  rage: {
    key: "special:rage",
    fr: "Rage",
    minBid: 2,
    description: "Ta mise de la manche suivante compte double (tu ne paies que ta vraie mise).",
    lastMancheAllowed: false,
  },
  joker: {
    key: "special:joker",
    fr: "Joker",
    minBid: 3,
    description: "Compte comme une carte de n'importe quel type, famille et rareté pour les objectifs.",
    lastMancheAllowed: true,
  },
};

const COLLECTEUR_BONUS = 5;

export const TYPES = ["troop", "flying", "spell", "building"];
export const FAMILIES = ["goblin", "skeleton", "human", "minion", null];
export const RARITIES = ["common", "rare", "epic", "legendary", "champion"];

export function isSpecialKey(key) {
  return typeof key === "string" && key.startsWith("special:");
}

export function specialFromKey(key) {
  return Object.values(SPECIALS).find((s) => s.key === key) || null;
}

// ── Catalogue ───────────────────────────────────────────────────────

// Garde les cartes jouables du catalogue brut (data/cardNames.json). Le
// pool est une liste choisie à la main (data/elixir/pool.json, environ 6
// cartes par thème) : avec tout le catalogue, les troupes sans famille et
// les humains noyaient les objectifs de niche, et un filtre par thème
// laissait des thèmes très déséquilibrés (21 sorts pour 4 gargouilles).
// `poolKeys` = clés de pool.json (toutes les cartes si absent).
export function filterCardPool(allCards, poolKeys = null) {
  const allowed = poolKeys ? new Set(poolKeys) : null;
  return allCards.filter(
    (c) =>
      (!allowed || allowed.has(c.cardKey)) &&
      !EXCLUDED_CARDS.has(c.cardKey) &&
      c.elixir != null &&
      TYPES.includes(c.type) &&
      RARITIES.includes(c.rarity),
  );
}

// Clés de cartes d'un pool.json (objet thème → liste de clés)
export function poolKeysFrom(poolJson) {
  return Object.values(poolJson).flat();
}

// Résout une clé (carte normale ou spéciale) en objet carte. `catalog` est
// une Map cardKey → entrée de cardNames.json.
export function resolveCard(key, catalog) {
  const special = specialFromKey(key);
  if (special) return { key, fr: special.fr, special: true, minBid: special.minBid };
  const c = catalog.get(key);
  if (!c) return null;
  return {
    key,
    fr: c.fr || c.cardKey,
    special: false,
    minBid: c.elixir,
    elixir: c.elixir,
    rarity: c.rarity,
    type: c.type,
    family: c.family ?? null,
  };
}

export function minBidFor(card) {
  return card.minBid;
}

// ── Tirage de la partie ─────────────────────────────────────────────

function shuffle(array, rng) {
  const a = [...array];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

export function specialCountFor(totalManches) {
  return totalManches >= 10 ? 2 : 1;
}

// Tire toutes les cartes de la partie d'un coup (aperçu de la manche
// suivante possible, aucun doublon). deck[i] = clés de la manche i+1.
// Cartes par manche = participants + 1 : toujours une carte de plus que de
// joueurs qui misent. En solo, le bot mise aussi, il compte donc comme un
// joueur (3 cartes, comme à 2 joueurs).
export function participantsCount(maxPlayers) {
  return maxPlayers === 1 ? 2 : maxPlayers;
}

export function buildDeck(pool, { totalManches, maxPlayers }, rng = Math.random) {
  const perManche = participantsCount(maxPlayers) + 1;
  const keys = shuffle(
    pool.map((c) => c.cardKey),
    rng,
  ).slice(0, perManche * totalManches);
  const deck = [];
  for (let m = 0; m < totalManches; m++) {
    deck.push(keys.slice(m * perManche, (m + 1) * perManche));
  }

  // Manches des cartes spéciales : distinctes, à partir de la manche 4
  const candidates = [];
  for (let m = SPECIAL_FIRST_MANCHE; m <= totalManches; m++) candidates.push(m);
  const specialManches = shuffle(candidates, rng).slice(0, specialCountFor(totalManches));

  // Type tiré indépendamment pour chaque spéciale (deux identiques
  // possibles), seul le Joker est autorisé à la dernière manche
  for (const manche of specialManches) {
    const isLast = manche === totalManches;
    const allowed = Object.keys(SPECIALS).filter((id) => !isLast || SPECIALS[id].lastMancheAllowed);
    const id = allowed[Math.floor(rng() * allowed.length)];
    deck[manche - 1].push(SPECIALS[id].key);
  }
  return deck;
}

// ── Objectifs ───────────────────────────────────────────────────────
// Évalués sur des "profils" concrets (un Joker a déjà reçu un type, une
// famille et une rareté, voir scoreCollection). Chaque objectif atteint
// rapporte ses points, tous sont cumulables.

// Nombre minimal de cartes d'un thème pour valider son objectif : 2 en 5
// manches, 3 en 10 manches (une carte au plus par manche et par joueur)
export function themeMin(totalManches) {
  return totalManches >= 10 ? 3 : 2;
}

function averageElixir(cards) {
  const real = cards.filter((c) => !c.joker);
  if (real.length < 3) return null;
  return real.reduce((s, c) => s + c.elixir, 0) / real.length;
}

// Objectifs de thème : AU MOINS N cartes du thème, les autres cartes ne
// gênent pas (décision du 01/10 : un objectif « uniquement » obligeait à
// ne plus rien acheter pendant des manches entières en 10 manches).
// `fixedMin` : seuil indépendant du format (thèmes de 4 à 6 cartes
// seulement dans le pool).
function themeObjective(id, noun, points, predicate, fixedMin = null) {
  const min = (ctx) => fixedMin ?? themeMin(ctx.totalManches);
  return {
    id,
    points,
    label: (ctx) => `${min(ctx)} ${noun}`,
    rulesLabel: fixedMin ? `Au moins ${fixedMin} ${noun}` : `Au moins ${themeMin(5)} ${noun} (${themeMin(10)} en 10 manches)`,
    test: (cards, ctx) => cards.filter(predicate).length >= min(ctx),
  };
}

export const OBJECTIVES = [
  themeObjective("humains", "humains", 4, (c) => c.family === "human"),
  themeObjective("sorts", "sorts", 6, (c) => c.type === "spell"),
  themeObjective("volants", "volants", 6, (c) => c.type === "flying"),
  themeObjective("batiments", "bâtiments", 6, (c) => c.type === "building"),
  themeObjective("gobelins", "gobelins", 6, (c) => c.family === "goblin"),
  themeObjective("squelettes", "squelettes", 6, (c) => c.family === "skeleton"),
  themeObjective("gargouilles", "gargouilles", 6, (c) => c.family === "minion", 2),
  themeObjective("champions", "champions", 4, (c) => c.rarity === "champion", 2),
  {
    id: "raretes",
    label: "Une carte de chaque rareté",
    points: 6,
    test: (cards) => RARITIES.every((r) => cards.some((c) => c.rarity === r)),
  },
  {
    id: "trio",
    label: "Trio troupe + sort + bâtiment",
    points: 3,
    test: (cards) =>
      cards.some((c) => c.type === "troop" || c.type === "flying") &&
      cards.some((c) => c.type === "spell") &&
      cards.some((c) => c.type === "building"),
  },
  {
    id: "cycle",
    label: "Deck cycle (coût moyen ≤ 3, 3+ cartes)",
    points: 3,
    test: (cards) => {
      const avg = averageElixir(cards);
      return avg != null && avg <= 3;
    },
  },
  {
    id: "lourd",
    label: "Deck lourd (coût moyen ≥ 5, 3+ cartes)",
    points: 4,
    test: (cards) => {
      const avg = averageElixir(cards);
      return avg != null && avg >= 5;
    },
  },
];

// Majorités : strictement plus que CHAQUE adversaire (au moins 1). Les
// Jokers n'y comptent pas, sauf pour "le plus de cartes".
export const MAJORITIES = [
  {
    id: "maj_champions",
    label: "Le plus de champions",
    points: 3,
    count: (cards) => cards.filter((c) => !c.joker && c.rarity === "champion").length,
  },
  {
    id: "maj_legendaires",
    label: "Le plus de légendaires",
    points: 3,
    count: (cards) => cards.filter((c) => !c.joker && c.rarity === "legendary").length,
  },
  { id: "maj_cartes", label: "Le plus de cartes", points: 3, count: (cards) => cards.length },
];

// Toutes les formes possibles d'un Joker
const JOKER_PROFILES = [];
for (const type of TYPES) {
  for (const family of FAMILIES) {
    for (const rarity of RARITIES) JOKER_PROFILES.push({ type, family, rarity, joker: true });
  }
}

function evaluateObjectives(cards, ctx) {
  const achieved = OBJECTIVES.filter((o) => o.test(cards, ctx));
  return { achieved, points: achieved.reduce((s, o) => s + o.points, 0) };
}

// Collection = cartes normales résolues (resolveCard) + Jokers
// (`{ joker: true }`). Les Jokers prennent la forme la plus avantageuse
// (énumération exhaustive, au plus 2 Jokers par partie).
// `opponents` = collections des adversaires (pour les majorités).
// `ctx.totalManches` fixe le seuil des objectifs de thème.
export function scoreCollection(collection, opponents = [], ctx = { totalManches: 5 }) {
  const real = collection.filter((c) => !c.joker);
  const jokerCount = collection.length - real.length;

  let best = evaluateObjectives(real, ctx);
  if (jokerCount > 0) {
    const explore = (current, remaining) => {
      if (remaining === 0) {
        const res = evaluateObjectives(current, ctx);
        if (res.points > best.points) best = res;
        return;
      }
      for (const profile of JOKER_PROFILES) explore([...current, profile], remaining - 1);
    };
    best = { achieved: [], points: -1 };
    explore(real, jokerCount);
  }

  const majorities = MAJORITIES.filter((m) => {
    const mine = m.count(collection);
    return mine >= 1 && opponents.every((opp) => mine > m.count(opp));
  });

  const achieved = [...best.achieved, ...majorities].map(({ id, label, points }) => ({
    id,
    label: typeof label === "function" ? label(ctx) : label,
    points,
  }));
  const cardPoints = collection.length;
  const total = cardPoints + achieved.reduce((s, o) => s + o.points, 0);
  return { total, cardPoints, achieved };
}

// ── Résolution d'une manche ─────────────────────────────────────────

// cards   : cartes de la manche (resolveCard, spéciales comprises)
// offers  : { [id]: { card: index | null, bid } } (null = passe)
// players : { [id]: { stock, rageNext } }
// Renvoie un résultat par carte : gagnant (ou null), prix payé, égalité.
export function resolveOffers(cards, offers, players) {
  return cards.map((card, index) => {
    const bidders = Object.entries(offers)
      .filter(([, o]) => o && o.card === index)
      .map(([id, o]) => ({ id, bid: o.bid, effective: o.bid * (players[id]?.rageNext ? 2 : 1) }))
      .sort((a, b) => b.effective - a.effective);
    if (bidders.length === 0) return { index, key: card.key, winner: null, price: 0, tie: false, bidders };
    const top = bidders[0].effective;
    const tie = bidders.filter((b) => b.effective === top).length > 1;
    if (tie) return { index, key: card.key, winner: null, price: 0, tie: true, bidders };
    return { index, key: card.key, winner: bidders[0].id, price: bidders[0].bid, tie: false, bidders };
  });
}

// Applique les résultats : paiement, ajout à la collection, effets des
// spéciales, puis recharge pour la manche suivante (plafonnée, le Collecteur
// aussi). La Rage de la manche résolue est consommée, celle gagnée pendant
// cette manche s'applique à la suivante.
// players : { [id]: { stock, collection: [clé], rageNext } }
export function applyResults(players, results, { regen = ELIXIR_PER_MANCHE, cap = ELIXIR_CAP } = {}) {
  const next = {};
  for (const [id, p] of Object.entries(players)) {
    next[id] = { ...p, collection: [...p.collection], rageNext: false };
  }
  for (const r of results) {
    if (!r.winner) continue;
    const p = next[r.winner];
    p.stock -= r.price;
    if (r.key === SPECIALS.collecteur.key) p.stock += COLLECTEUR_BONUS;
    else if (r.key === SPECIALS.rage.key) p.rageNext = true;
    else p.collection.push(r.key);
  }
  for (const p of Object.values(next)) p.stock = Math.min(cap, p.stock + regen);
  return next;
}

// Valide une offre (carte existante, mise ≥ coût, mise ≤ stock)
export function isValidOffer(cards, offer, stock) {
  if (!offer || offer.card == null) return true;
  const card = cards[offer.card];
  if (!card) return false;
  return Number.isInteger(offer.bid) && offer.bid >= card.minBid && offer.bid <= stock;
}

// ── Collections résolues (clés → objets pour scoreCollection) ───────

export function collectionToCards(keys, catalog) {
  return keys.map((k) => (k === SPECIALS.joker.key ? { joker: true } : resolveCard(k, catalog))).filter(Boolean);
}

// Score final de chaque joueur, puis classement : total décroissant, puis
// élixir restant (départage), puis ordre d'arrivée.
// players : { [id]: { username, stock, collection: [clé] } }
export function computeFinalScores(players, catalog, totalManches) {
  const ids = Object.keys(players);
  const cardsById = Object.fromEntries(ids.map((id) => [id, collectionToCards(players[id].collection, catalog)]));
  return ids
    .map((id, order) => {
      const opponents = ids.filter((x) => x !== id).map((x) => cardsById[x]);
      return { id, order, username: players[id].username, stock: players[id].stock, ...scoreCollection(cardsById[id], opponents, { totalManches }) };
    })
    .sort((a, b) => b.total - a.total || b.stock - a.stock || a.order - b.order);
}

// ── Bot (mode solo, et simulation) ──────────────────────────────────

// Valeur estimée (en points) d'une spéciale pour le bot
const SPECIAL_VALUE = { collecteur: 2, rage: 1.5 };

// Offre du bot : choisit la carte au meilleur rapport gain/prix, avec une
// mise d'autant plus haute que la carte l'intéresse, sans dépenser plus que
// sa part du budget restant (sauf à la dernière manche).
// me        : { stock, collection: [clé], rageNext }
// opponents : collections (clés) des adversaires
export function botOffer(cards, me, opponents, { manchesLeft, totalManches, catalog, aggressiveness = 1, regen = ELIXIR_PER_MANCHE }, rng = Math.random) {
  const myCards = collectionToCards(me.collection, catalog);
  const oppCards = opponents.map((c) => collectionToCards(c, catalog));
  const ctx = { totalManches };
  const base = scoreCollection(myCards, oppCards, ctx).total;
  // Élixir disponible d'ici la fin, recharges comprises, réparti par manche
  const future = me.stock + regen * (manchesLeft - 1);
  const perManche = future / Math.max(1, manchesLeft);

  let best = null;
  cards.forEach((card, index) => {
    let gain;
    if (card.key === SPECIALS.collecteur.key) gain = manchesLeft > 1 ? SPECIAL_VALUE.collecteur : 0;
    else if (card.key === SPECIALS.rage.key) gain = manchesLeft > 1 ? SPECIAL_VALUE.rage : 0;
    else {
      const added = card.key === SPECIALS.joker.key ? { joker: true } : card;
      gain = scoreCollection([...myCards, added], oppCards, ctx).total - base;
    }
    if (gain <= 0) return;

    const cap = manchesLeft <= 1 ? me.stock : Math.min(me.stock, Math.round(perManche * (1 + gain / 4) * aggressiveness));
    if (card.minBid > cap) return;
    const jitter = Math.floor(rng() * 3) - 1;
    const bid = Math.max(card.minBid, Math.min(cap, card.minBid + Math.round(gain * 0.5 * aggressiveness) + jitter));
    const value = gain - 0.3 * bid;
    if (!best || value > best.value) best = { card: index, bid, value };
  });

  return best ? { card: best.card, bid: best.bid } : { card: null, bid: 0 };
}
