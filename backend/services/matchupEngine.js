// ============================================================
// services/matchupEngine.js — Moteur pur de calcul du %matchup deck-vs-deck.
//
// Traduction déterministe (sans appel LLM) du system prompt fourni
// (temp/matchup-v2/gemini-code-1784305026864.md, v2.0) : 4 layers appliqués
// à une baseline 50/50, calculant scoreA = avantage du Deck A (0-100).
//
// Fonctions pures et synchrones : le catalogue de win conditions/counters
// (chargé de façon async et potentiellement mutable, voir matchupCatalog.js)
// est toujours reçu en paramètre, jamais importé/rechargé ici.
// ============================================================

import { normLevel } from "./collectionConstants.js";
import {
  ARCHETYPE_ADVANTAGE,
  SMALL_SPELLS_SET,
  BIG_SPELLS_SET,
  DEFENSIVE_BUILDINGS_SET,
  TANK_KILLERS_SET,
  HEAVY_BEATDOWN_WIN_CONDITIONS_SET,
  SPLIT_PUSH_TRIGGER_CARDS_SET,
} from "./matchupCatalog.js";

export function clampValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

function toArray(deckCards) {
  return Array.isArray(deckCards) ? deckCards : [];
}

function average(values) {
  if (values.length === 0) return 0;
  return values.reduce((sum, v) => sum + v, 0) / values.length;
}

function countMatchesInSet(deckCards, normalizedSet, catalog) {
  let count = 0;
  for (const card of toArray(deckCards)) {
    if (normalizedSet.has(catalog.normalizeCardName(card?.name))) count++;
  }
  return count;
}

function countMatchesAgainstNames(deckCards, rawNames, catalog) {
  const targetSet = new Set(
    rawNames.map((name) => catalog.normalizeCardName(name)),
  );
  return countMatchesInSet(deckCards, targetSet, catalog);
}

/**
 * Toutes les win conditions du catalogue présentes dans le deck (0, 1 ou plusieurs).
 */
export function identifyWinConditions(deckCards, catalog) {
  const { winConditionsByName, normalizeCardName } = catalog;
  const seen = new Set();
  const matches = [];
  for (const card of toArray(deckCards)) {
    const key = normalizeCardName(card?.name);
    if (!key || seen.has(key)) continue;
    const entry = winConditionsByName.get(key);
    if (entry) {
      matches.push(entry);
      seen.add(key);
    }
  }
  return matches;
}

// ------------------------------------------------------------
// LAYER 1 — Archétype macro-matchup (±15%, atteint ±10 par construction)
// ------------------------------------------------------------

function archetypeAdvantageShift(archetypeX, archetypeY) {
  if (!archetypeX || !archetypeY) return 0;
  if (ARCHETYPE_ADVANTAGE[archetypeX]?.includes(archetypeY)) return 10;
  if (ARCHETYPE_ADVANTAGE[archetypeY]?.includes(archetypeX)) return -10;
  return 0;
}

export function computeArchetypeLayer(winConditionsA, winConditionsB) {
  if (winConditionsA.length === 0 || winConditionsB.length === 0) return 0;
  const shifts = [];
  for (const wcA of winConditionsA) {
    for (const wcB of winConditionsB) {
      shifts.push(archetypeAdvantageShift(wcA.archetype, wcB.archetype));
    }
  }
  return clampValue(average(shifts), -15, 15);
}

// ------------------------------------------------------------
// LAYER 2 — Win condition vs counters directs (±25%)
// ------------------------------------------------------------

function counterShiftFor(winCondition, opponentDeckCards, catalog) {
  const hardHits = countMatchesAgainstNames(
    opponentDeckCards,
    winCondition.hardCounters,
    catalog,
  );
  if (hardHits > 0) return -15;
  const softHits = countMatchesAgainstNames(
    opponentDeckCards,
    winCondition.softCounters,
    catalog,
  );
  if (softHits >= 2) return -10;
  if (softHits === 0) return 15;
  // Exactement 1 soft counter : zone grise non couverte par le texte source
  // (qui ne traite que 0 counter et ≥2 soft counters) → neutre.
  return 0;
}

export function computeCounterLayer(
  winConditionsA,
  deckACards,
  winConditionsB,
  deckBCards,
  catalog,
) {
  if (winConditionsA.length === 0 || winConditionsB.length === 0) return 0;
  const shiftsA = winConditionsA.map((wc) =>
    counterShiftFor(wc, deckBCards, catalog),
  );
  const shiftsB = winConditionsB.map((wc) =>
    counterShiftFor(wc, deckACards, catalog),
  );
  return clampValue(average(shiftsA) - average(shiftsB), -25, 25);
}

// ------------------------------------------------------------
// LAYER 3 — Intégrité structurelle / utilité (±15%)
// Scanne les cartes brutes du deck : reste actif même si l'un des deux
// decks n'a aucune win condition reconnue dans le catalogue.
// ------------------------------------------------------------

function utilityShiftFor(winConditionsX, deckXCards, deckYCards, catalog) {
  let shift = 0;

  const runsBait = winConditionsX.some((wc) => wc.archetype === "Bait");
  if (runsBait) {
    const smallSpellsInY = countMatchesInSet(
      deckYCards,
      SMALL_SPELLS_SET,
      catalog,
    );
    if (smallSpellsInY < 1) shift += 10;
    else if (smallSpellsInY >= 2) shift -= 10;
  }

  const runsSplitPushTrigger =
    countMatchesInSet(deckXCards, SPLIT_PUSH_TRIGGER_CARDS_SET, catalog) > 0;
  if (runsSplitPushTrigger) {
    const bigSpellsInY = countMatchesInSet(deckYCards, BIG_SPELLS_SET, catalog);
    if (bigSpellsInY === 0) shift += 10;
  }

  const runsHeavyBeatdown =
    countMatchesInSet(deckXCards, HEAVY_BEATDOWN_WIN_CONDITIONS_SET, catalog) >
    0;
  if (runsHeavyBeatdown) {
    const tankKillersInY = countMatchesInSet(
      deckYCards,
      TANK_KILLERS_SET,
      catalog,
    );
    const defensiveBuildingsInY = countMatchesInSet(
      deckYCards,
      DEFENSIVE_BUILDINGS_SET,
      catalog,
    );
    if (tankKillersInY === 0 && defensiveBuildingsInY === 0) shift += 15;
  }

  return shift;
}

export function computeUtilityLayer(
  winConditionsA,
  deckACards,
  winConditionsB,
  deckBCards,
  catalog,
) {
  const shiftA = utilityShiftFor(winConditionsA, deckACards, deckBCards, catalog);
  const shiftB = utilityShiftFor(winConditionsB, deckBCards, deckACards, catalog);
  return clampValue(shiftA - shiftB, -15, 15);
}

// ------------------------------------------------------------
// LAYER 4 — Différentiel de niveau de cartes (±50%, 3%/point)
// Utilise normLevel() (offset de rareté, cf. collectionConstants.js) plutôt
// que le niveau brut 1-16 du texte source, pour rester cohérent avec le
// reste du codebase où toute comparaison de force de deck passe déjà par
// normLevel() — le niveau brut pénaliserait injustement les decks riches
// en légendaires/champions. Écart assumé par rapport au texte source.
//
// Poids (3%/point) et plafond (±50) ajustés sur demande explicite : un écart
// de niveau extrême doit pouvoir, à lui seul, faire basculer le score à 0
// ou 100 — symétrique avec les Layers 1+2+3 combinés, dont la somme des
// maxima atteint déjà ±50 (10 effectif pour L1 + 25 pour L2 + 15 pour L3).
// ------------------------------------------------------------

export function computeLevelDifferentialLayer(deckACards, deckBCards) {
  const sum = (cards) =>
    toArray(cards).reduce((total, card) => total + normLevel(card), 0);
  const diff = sum(deckACards) - sum(deckBCards);
  return clampValue(diff * 3, -50, 50);
}

// ------------------------------------------------------------
// Assemblage
// ------------------------------------------------------------

/**
 * @param {Array<{name:string, level:number, rarity?:string}>} deckACards
 * @param {Array<{name:string, level:number, rarity?:string}>} deckBCards
 * @param {{winConditionsByName: Map, normalizeCardName: Function}} catalog
 */
export function computeDeckMatchupScore(deckACards, deckBCards, catalog) {
  const winConditionsA = identifyWinConditions(deckACards, catalog);
  const winConditionsB = identifyWinConditions(deckBCards, catalog);
  // Win condition inconnue d'un des deux côtés : Layers 1 et 2 neutralisés
  // pour toute la bataille (pas seulement côté inconnu), pour éviter une
  // évaluation asymétrique — voir plan de refonte.
  const bothKnown = winConditionsA.length > 0 && winConditionsB.length > 0;

  const layer1 = bothKnown
    ? computeArchetypeLayer(winConditionsA, winConditionsB)
    : 0;
  const layer2 = bothKnown
    ? computeCounterLayer(winConditionsA, deckACards, winConditionsB, deckBCards, catalog)
    : 0;
  const layer3 = computeUtilityLayer(
    winConditionsA,
    deckACards,
    winConditionsB,
    deckBCards,
    catalog,
  );
  const layer4 = computeLevelDifferentialLayer(deckACards, deckBCards);

  const scoreA = clampValue(50 + layer1 + layer2 + layer3 + layer4, 0, 100);

  return {
    scoreA,
    scoreB: 100 - scoreA,
    breakdown: { layer1, layer2, layer3, layer4 },
    winConditionsA: winConditionsA.map((wc) => wc.name),
    winConditionsB: winConditionsB.map((wc) => wc.name),
  };
}
