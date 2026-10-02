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
// partie : chaque carte rapporte son coût en élixir + tous les objectifs
// atteints (cumulables).
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

// Carte mystère (remplace le Joker, jugé trop décisif, le 02/10) : à chaque
// manche paire, une des cartes aux enchères est cachée. Mise minimale fixe,
// révélée à l'achat, elle rapporte son vrai coût et compte pour les
// objectifs. Elle permet d'acheter à chaque manche quand l'élixir manque.
// Dans le deck : `mystery:<clé réelle>` ; dans les URL d'image, la clé
// réelle est masquée (`mystery`) pour ne rien révéler.
export const MYSTERY_MIN_BID = 2;
export const MYSTERY_KEY = "mystery";
const MYSTERY_PREFIX = `${MYSTERY_KEY}:`;

export const TYPES = ["troop", "flying", "spell", "building"];
export const FAMILIES = ["goblin", "skeleton", "human", "minion", null];
export const RARITIES = ["common", "rare", "epic", "legendary", "champion"];

export function isMysteryKey(key) {
  return key === MYSTERY_KEY || (typeof key === "string" && key.startsWith(MYSTERY_PREFIX));
}

// Clé réelle d'une carte mystère achetée (inchangée pour une carte normale)
export function revealKey(key) {
  return typeof key === "string" && key.startsWith(MYSTERY_PREFIX) ? key.slice(MYSTERY_PREFIX.length) : key;
}

// Clé affichable publiquement (URL d'image) : la carte mystère reste cachée
export function publicKey(key) {
  return isMysteryKey(key) ? MYSTERY_KEY : key;
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

// Résout une clé (carte normale ou mystère) en objet carte. `catalog` est
// une Map cardKey → entrée de cardNames.json. Une carte mystère n'expose
// rien de la carte réelle.
export function resolveCard(key, catalog) {
  if (isMysteryKey(key)) return { key, fr: "Carte mystère", mystery: true, minBid: MYSTERY_MIN_BID };
  const c = catalog.get(key);
  if (!c) return null;
  return {
    key,
    fr: c.fr || c.cardKey,
    mystery: false,
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

  // Manches paires : une des cartes tirées devient la carte mystère
  for (let m = 2; m <= totalManches; m += 2) {
    const keysOfManche = deck[m - 1];
    const i = Math.floor(rng() * keysOfManche.length);
    keysOfManche[i] = MYSTERY_PREFIX + keysOfManche[i];
  }
  return deck;
}

// ── Objectifs ───────────────────────────────────────────────────────
// Chaque objectif atteint rapporte ses points, tous sont cumulables.

// Nombre minimal de cartes d'un thème pour valider son objectif, quel que
// soit le format (barème de Raphaël, 01/10)
export const THEME_MIN = 3;

function averageElixir(cards) {
  if (cards.length < 3) return null;
  return cards.reduce((s, c) => s + c.elixir, 0) / cards.length;
}

// Progression d'un objectif de coût moyen (Journal) : tant que la moyenne
// des cartes actuelles respecte le seuil, chaque carte compte vers les 3
// requises ; sinon l'objectif est considéré hors d'atteinte (null).
function averageProgress(cards, ok) {
  if (!cards.length) return { have: 0, need: 3 };
  const avg = cards.reduce((s, c) => s + c.elixir, 0) / cards.length;
  return ok(avg) ? { have: Math.min(cards.length, 3), need: 3 } : null;
}

// Objectifs de thème : AU MOINS THEME_MIN cartes du thème, les autres
// cartes ne gênent pas (décision du 01/10 : un objectif « uniquement »
// obligeait à ne plus rien acheter pendant des manches entières).
function themeObjective(id, noun, points, predicate) {
  return {
    id,
    points,
    noun,
    label: `${THEME_MIN} ${noun}`,
    rulesLabel: `Au moins ${THEME_MIN} ${noun}`,
    test: (cards) => cards.filter(predicate).length >= THEME_MIN,
    progress: (cards) => ({ have: Math.min(cards.filter(predicate).length, THEME_MIN), need: THEME_MIN }),
  };
}

// Barème (01/10, cartes payées à leur coût) : un thème de 3 cartes doit
// rapporter à peu près autant au total (coût des cartes + bonus), qu'il soit
// bon marché (3 squelettes ≈ 9 élixir) ou cher (3 bâtiments ≈ 13). Les
// thèmes peu fournis dans le pool (gargouilles : 4 cartes) valent un peu
// plus, les très fournis (humains : 10 cartes) un peu moins.
export const OBJECTIVES = [
  themeObjective("humains", "humains", 4, (c) => c.family === "human"),
  themeObjective("sorts", "sorts", 8, (c) => c.type === "spell"),
  themeObjective("volants", "volants", 6, (c) => c.type === "flying"),
  themeObjective("batiments", "bâtiments", 6, (c) => c.type === "building"),
  themeObjective("gobelins", "gobelins", 8, (c) => c.family === "goblin"),
  themeObjective("squelettes", "squelettes", 10, (c) => c.family === "skeleton"),
  themeObjective("gargouilles", "gargouilles", 10, (c) => c.family === "minion"),
  themeObjective("champions", "champions", 6, (c) => c.rarity === "champion"),
  {
    id: "raretes",
    label: "Une carte de chaque rareté",
    points: 8,
    test: (cards) => RARITIES.every((r) => cards.some((c) => c.rarity === r)),
    progress: (cards) => ({ have: RARITIES.filter((r) => cards.some((c) => c.rarity === r)).length, need: RARITIES.length }),
  },
  {
    id: "trio",
    label: "Trio troupe + sort + bâtiment",
    points: 4,
    test: (cards) =>
      cards.some((c) => c.type === "troop" || c.type === "flying") &&
      cards.some((c) => c.type === "spell") &&
      cards.some((c) => c.type === "building"),
    progress: (cards) => ({
      have: [
        cards.some((c) => c.type === "troop" || c.type === "flying"),
        cards.some((c) => c.type === "spell"),
        cards.some((c) => c.type === "building"),
      ].filter(Boolean).length,
      need: 3,
    }),
  },
  {
    id: "cycle",
    label: "Deck cycle (coût moyen ≤ 3, 3+ cartes)",
    // Compense des cartes qui rapportent peu (et l'élixir perdu au plafond)
    points: 6,
    test: (cards) => {
      const avg = averageElixir(cards);
      return avg != null && avg <= 3;
    },
    progress: (cards) => averageProgress(cards, (avg) => avg <= 3),
  },
  {
    id: "lourd",
    label: "Deck lourd (coût moyen ≥ 5, 3+ cartes)",
    // Les cartes chères rapportent déjà leur coût : petit bonus seulement
    points: 3,
    test: (cards) => {
      const avg = averageElixir(cards);
      return avg != null && avg >= 5;
    },
    progress: (cards) => averageProgress(cards, (avg) => avg >= 5),
  },
];

// Journal : objectifs commencés et encore atteignables avec les cartes que
// le joueur peut encore remporter (une par manche restante), les plus
// avancés d'abord. `cards` = collection résolue (collectionToCards).
export function objectivesProgress(cards, manchesLeft) {
  return OBJECTIVES.map((o) => ({ id: o.id, label: o.label, points: o.points, ...o.progress(cards) }))
    .filter((p) => p.need != null && p.have >= 1 && p.need - p.have <= manchesLeft)
    .sort((a, b) => b.have / b.need - a.have / a.need || b.points - a.points);
}

// Majorités : strictement plus que CHAQUE adversaire (au moins 1).
export const MAJORITIES = [
  {
    id: "maj_champions",
    label: "Le plus de champions",
    points: 4,
    count: (cards) => cards.filter((c) => c.rarity === "champion").length,
  },
  {
    id: "maj_legendaires",
    label: "Le plus de légendaires",
    points: 4,
    count: (cards) => cards.filter((c) => c.rarity === "legendary").length,
  },
];

// Collection = cartes résolues (resolveCard), cartes mystère déjà révélées.
// `opponents` = collections des adversaires (pour les majorités).
export function scoreCollection(collection, opponents = [], ctx = { totalManches: 5 }) {
  const objectives = OBJECTIVES.filter((o) => o.test(collection, ctx));

  const majorities = MAJORITIES.filter((m) => {
    const mine = m.count(collection);
    return mine >= 1 && opponents.every((opp) => mine > m.count(opp));
  });

  const achieved = [...objectives, ...majorities].map(({ id, label, points }) => ({ id, label, points }));
  // Chaque carte rapporte son coût (pas la mise)
  const cardPoints = collection.reduce((s, c) => s + c.elixir, 0);
  const total = cardPoints + achieved.reduce((s, o) => s + o.points, 0);
  return { total, cardPoints, cardCount: collection.length, achieved };
}

// ── Résolution d'une manche ─────────────────────────────────────────

// cards   : cartes de la manche (resolveCard, spéciales comprises)
// offers  : { [id]: { card: index | null, bid } } (null = passe)
// Renvoie un résultat par carte : gagnant (ou null), prix payé, égalité.
export function resolveOffers(cards, offers) {
  return cards.map((card, index) => {
    const bidders = Object.entries(offers)
      .filter(([, o]) => o && o.card === index)
      .map(([id, o]) => ({ id, bid: o.bid }))
      .sort((a, b) => b.bid - a.bid);
    if (bidders.length === 0) return { index, key: card.key, winner: null, price: 0, tie: false, bidders };
    const top = bidders[0].bid;
    const tie = bidders.filter((b) => b.bid === top).length > 1;
    if (tie) return { index, key: card.key, winner: null, price: 0, tie: true, bidders };
    return { index, key: card.key, winner: bidders[0].id, price: bidders[0].bid, tie: false, bidders };
  });
}

// Applique les résultats : paiement, ajout à la collection (carte mystère
// révélée), puis recharge plafonnée pour la manche suivante.
// players : { [id]: { stock, collection: [clé] } }
export function applyResults(players, results, { regen = ELIXIR_PER_MANCHE, cap = ELIXIR_CAP } = {}) {
  const next = {};
  for (const [id, p] of Object.entries(players)) {
    next[id] = { ...p, collection: [...p.collection] };
  }
  for (const r of results) {
    if (!r.winner) continue;
    const p = next[r.winner];
    p.stock -= r.price;
    p.collection.push(revealKey(r.key));
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
  return keys.map((k) => resolveCard(revealKey(k), catalog)).filter(Boolean);
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

// Offre du bot : choisit la carte au meilleur rapport gain/prix, avec une
// mise d'autant plus haute que la carte l'intéresse, sans dépenser plus que
// sa part du budget restant (sauf à la dernière manche).
// me        : { stock, collection: [clé] }
// opponents : collections (clés) des adversaires
export function botOffer(cards, me, opponents, { manchesLeft, totalManches, catalog, aggressiveness = 1, regen = ELIXIR_PER_MANCHE }, rng = Math.random) {
  const myCards = collectionToCards(me.collection, catalog);
  const oppCards = opponents.map((c) => collectionToCards(c, catalog));
  const ctx = { totalManches };
  const base = scoreCollection(myCards, oppCards, ctx).total;
  // Élixir disponible d'ici la fin, recharges comprises, réparti par manche
  const future = me.stock + regen * (manchesLeft - 1);
  const perManche = future / Math.max(1, manchesLeft);

  const gainOf = (card) => scoreCollection([...myCards, card], oppCards, ctx).total - base;
  // Carte mystère : gain moyen sur les cartes du pool encore inconnues
  let mysteryGain = 0;
  if (cards.some((c) => c.mystery)) {
    const unknown = [...catalog.keys()]
      .filter((k) => !me.collection.includes(k) && !cards.some((c) => c.key === k))
      .map((k) => resolveCard(k, catalog));
    if (unknown.length) mysteryGain = unknown.reduce((s, c) => s + gainOf(c), 0) / unknown.length;
  }

  let best = null;
  cards.forEach((card, index) => {
    const gain = card.mystery ? mysteryGain : gainOf(card);
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
