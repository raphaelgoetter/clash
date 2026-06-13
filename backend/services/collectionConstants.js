// Constantes et fonctions partagées du système de Collection Clash Royale.
// Source de vérité unique — importée par playerAnalysis.js, interactions.js
// et exposée dans la réponse /api/player/:tag/analysis (collection.totals).

export const TOTAL_CARDS = 125; // 121 cartes standard + 4 troupes de tour
export const TOTAL_EVOLUTIONS = 40;
export const TOTAL_HEROES = 13;

export const RARITY_OFFSET = {
  common: 0,
  rare: 2,
  epic: 5,
  legendary: 8,
  champion: 10,
};

export const TOUR_REQ = [
  null,
  null,
  { cards: 9, level: 1 },
  { cards: 9, level: 2 },
  { cards: 9, level: 3 },
  { cards: 9, level: 4 },
  { cards: 10, level: 5 },
  { cards: 10, level: 6 },
  { cards: 10, level: 7 },
  { cards: 10, level: 8 },
  { cards: 10, level: 9 },
  { cards: 10, level: 10 },
  { cards: 11, level: 11 },
  { cards: 11, level: 12 },
  { cards: 12, level: 13 },
  { cards: 13, level: 14 },
  { cards: 14, level: 15 },
];

/** Niveau normalisé d'une carte (niveau + offset de rareté). */
export const normLevel = (c) => {
  if (!c || !Number.isFinite(c.level)) return 0;
  return c.level + (RARITY_OFFSET[c.rarity] ?? 0);
};

export function computeTourLevel(allCardsCol) {
  const cards = Array.isArray(allCardsCol) ? allCardsCol : [];
  let tourLevel = 1;
  for (let lvl = 2; lvl < TOUR_REQ.length; lvl++) {
    const req = TOUR_REQ[lvl];
    if (!req) break;
    if (cards.filter((c) => normLevel(c) >= req.level).length >= req.cards) {
      tourLevel = lvl;
    } else {
      break;
    }
  }
  return tourLevel;
}

/**
 * Compte les cartes évoluées parmi les cartes de base (tower troops exclus).
 * Règle : icône evolutionMedium présente ET evoLevel > 0.
 * Exception : carte "en transition héros" (heroMedium ET evoLevel >= 2 mais pas encore maxée)
 * → comptée uniquement dans les héros, pas dans les évolutions (comportement du jeu).
 * Une carte maxée (evoLevel === maxEvolutionLevel) compte dans les deux.
 */
export function countEvolved(baseCards) {
  return baseCards.filter(
    (c) =>
      !!c.iconUrls?.evolutionMedium &&
      (c.evolutionLevel ?? 0) > 0 &&
      !(
        !!c.iconUrls?.heroMedium &&
        (c.evolutionLevel ?? 0) >= 2 &&
        (c.evolutionLevel ?? 0) < c.maxEvolutionLevel
      ),
  ).length;
}

/**
 * Compte les cartes héros parmi les cartes de base (tower troops exclus).
 * Règle : icône heroMedium présente ET evoLevel >= 2.
 */
export function countHeroes(baseCards) {
  return baseCards.filter(
    (c) => !!c.iconUrls?.heroMedium && (c.evolutionLevel ?? 0) >= 2,
  ).length;
}
