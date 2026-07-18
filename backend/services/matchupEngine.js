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
// Calibrage des 4 layers : la somme de leurs maxima doit valoir exactement
// 50 (la moitié de l'amplitude totale scoreA ∈ [0,100] depuis la baseline
// 50), pour que 0% et 100% ne soient atteints QUE si les 4 layers sont
// simultanément à leur maximum dans le même sens. Avec des maxima non
// calibrés (ex. la précédente version où leur somme valait 100), le score
// sature (clamp) dès que 2-3 layers s'alignent, bien avant que tous soient
// réellement extrêmes — deux combinaisons très différentes peuvent alors
// afficher exactement le même 0%/100%, perdant toute granularité.
// Répartition (proportionnelle aux poids du system prompt d'origine,
// L1:L2:L3:L4 = 10:25:15:50 → mise à l'échelle ×0.5 pour sommer à 50) :
//   L1 Archétype        : ±5   (effectif, cf. construction ci-dessous)
//   L2 Counters directs : ±12.5
//   L3 Structure du deck: ±7.5
//   L4 Écart de niveau  : ±25
// ------------------------------------------------------------

// LAYER 1 — Archétype macro-matchup (±5% effectif par construction)
function archetypeAdvantageShift(archetypeX, archetypeY) {
  if (!archetypeX || !archetypeY) return 0;
  if (ARCHETYPE_ADVANTAGE[archetypeX]?.includes(archetypeY)) return 5;
  if (ARCHETYPE_ADVANTAGE[archetypeY]?.includes(archetypeX)) return -5;
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
  return clampValue(average(shifts), -7.5, 7.5);
}

// LAYER 2 — Win condition vs counters directs (±12.5%)
function counterShiftFor(winCondition, opponentDeckCards, catalog) {
  const hardHits = countMatchesAgainstNames(
    opponentDeckCards,
    winCondition.hardCounters,
    catalog,
  );
  if (hardHits > 0) return -7.5;
  const softHits = countMatchesAgainstNames(
    opponentDeckCards,
    winCondition.softCounters,
    catalog,
  );
  if (softHits >= 2) return -5;
  if (softHits === 0) return 7.5;
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
  return clampValue(average(shiftsA) - average(shiftsB), -12.5, 12.5);
}

// Pénalité de dispersion en échelle triangulaire : chaque unité au-delà de
// `baseline` coûte plus que la précédente (1, 2, 3, 4... points cumulés),
// pour que 3 WC pique un peu, 4 WC pique nettement plus, 5 WC beaucoup plus
// — pas un simple palier fixe. Le clamp final de computeUtilityLayer (±7.5)
// absorbe les cas extrêmes, donc pas besoin de plafonner ici.
function escalatingExcessPenalty(count, baseline, unitPoints) {
  const excess = Math.max(0, count - baseline);
  return -unitPoints * (excess * (excess + 1)) / 2;
}

// LAYER 3 — Intégrité structurelle / utilité (±7.5%)
// Scanne les cartes brutes du deck : reste actif même si l'un des deux
// decks n'a aucune win condition reconnue dans le catalogue. Inclut aussi
// une auto-pénalité en échelle pour un deck trop "dispersé" (>2 win
// conditions, >3 sorts ou >2 bâtiments) — indépendante du deck adverse,
// contrairement aux règles Bait/Split-Push/Heavy Beatdown ci-dessus.
// Retourne { shift, tags } — tags = courtes étiquettes des règles
// déclenchées, utilisées uniquement pour générer les mini-explications de
// l'embed Discord (cf. describeUtilityLayer). Le shift seul alimente le score.
function utilityShiftFor(winConditionsX, deckXCards, deckYCards, catalog) {
  let shift = 0;
  const tags = [];

  const runsBait = winConditionsX.some((wc) => wc.archetype === "Bait");
  if (runsBait) {
    const smallSpellsInY = countMatchesInSet(
      deckYCards,
      SMALL_SPELLS_SET,
      catalog,
    );
    if (smallSpellsInY < 1) {
      shift += 5;
      tags.push("Bait: 0 petit sort adverse");
    } else if (smallSpellsInY >= 2) {
      shift -= 5;
      tags.push(`Bait: ${smallSpellsInY} petits sorts adverses`);
    }
  }

  const runsSplitPushTrigger =
    countMatchesInSet(deckXCards, SPLIT_PUSH_TRIGGER_CARDS_SET, catalog) > 0;
  if (runsSplitPushTrigger) {
    const bigSpellsInY = countMatchesInSet(deckYCards, BIG_SPELLS_SET, catalog);
    if (bigSpellsInY === 0) {
      shift += 5;
      tags.push("Split-push: 0 gros sort adverse");
    }
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
    if (tankKillersInY === 0 && defensiveBuildingsInY === 0) {
      shift += 7.5;
      tags.push("Gros tank: aucun tank killer/bâtiment adverse");
    }
  }

  // Deck trop "dispersé" (auto-pénalité, indépendante de deckYCards) : trop
  // de win conditions, de sorts ou de bâtiments dénote un manque de focus
  // (ou un sur-matching du catalogue) — défavorable pour X, en échelle.
  const wcPenalty = escalatingExcessPenalty(winConditionsX.length, 2, 2.5);
  if (wcPenalty !== 0) {
    shift += wcPenalty;
    tags.push(`${winConditionsX.length} WC: dispersion`);
  }

  const spellsInX =
    countMatchesInSet(deckXCards, SMALL_SPELLS_SET, catalog) +
    countMatchesInSet(deckXCards, BIG_SPELLS_SET, catalog);
  const spellPenalty = escalatingExcessPenalty(spellsInX, 3, 2.5);
  if (spellPenalty !== 0) {
    shift += spellPenalty;
    tags.push(`${spellsInX} sorts: dispersion`);
  }

  const buildingsInX = countMatchesInSet(
    deckXCards,
    DEFENSIVE_BUILDINGS_SET,
    catalog,
  );
  const buildingPenalty = escalatingExcessPenalty(buildingsInX, 2, 2.5);
  if (buildingPenalty !== 0) {
    shift += buildingPenalty;
    tags.push(`${buildingsInX} bâtiments: dispersion`);
  }

  return { shift, tags };
}

export function computeUtilityLayer(
  winConditionsA,
  deckACards,
  winConditionsB,
  deckBCards,
  catalog,
) {
  const { shift: shiftA } = utilityShiftFor(
    winConditionsA,
    deckACards,
    deckBCards,
    catalog,
  );
  const { shift: shiftB } = utilityShiftFor(
    winConditionsB,
    deckBCards,
    deckACards,
    catalog,
  );
  return clampValue(shiftA - shiftB, -7.5, 7.5);
}

// LAYER 4 — Différentiel de niveau de cartes (±25%, 1.5%/point)
// Utilise normLevel() (offset de rareté, cf. collectionConstants.js) plutôt
// que le niveau brut 1-16 du texte source, pour rester cohérent avec le
// reste du codebase où toute comparaison de force de deck passe déjà par
// normLevel() — le niveau brut pénaliserait injustement les decks riches
// en légendaires/champions. Écart assumé par rapport au texte source.
export function computeLevelDifferentialLayer(deckACards, deckBCards) {
  const sum = (cards) =>
    toArray(cards).reduce((total, card) => total + normLevel(card), 0);
  const diff = sum(deckACards) - sum(deckBCards);
  return clampValue(diff * 1.5, -25, 25);
}

// ------------------------------------------------------------
// Mini-explications (breakdown.reasons) — courtes étiquettes sans phrase,
// affichées entre parenthèses à côté de chaque layer dans l'embed Discord.
// Ne participent pas au calcul du score, purement descriptif.
// ------------------------------------------------------------

function describeArchetypeLayer(winConditionsA, winConditionsB, bothKnown) {
  if (!bothKnown) return "win condition inconnue";
  const archsA = [...new Set(winConditionsA.map((wc) => wc.archetype))].join(
    "+",
  );
  const archsB = [...new Set(winConditionsB.map((wc) => wc.archetype))].join(
    "+",
  );
  return `${archsA} vs ${archsB}`;
}

function describeCounterLayer(
  winConditionsA,
  deckACards,
  winConditionsB,
  deckBCards,
  catalog,
  bothKnown,
) {
  if (!bothKnown) return "win condition inconnue";
  const yourHardHit = winConditionsA.filter(
    (wc) => countMatchesAgainstNames(deckBCards, wc.hardCounters, catalog) > 0,
  ).length;
  const theirHardHit = winConditionsB.filter(
    (wc) => countMatchesAgainstNames(deckACards, wc.hardCounters, catalog) > 0,
  ).length;
  return `toi: ${yourHardHit}/${winConditionsA.length} contrée(s) dur, eux: ${theirHardHit}/${winConditionsB.length} contrée(s) dur`;
}

function describeUtilityLayer(
  winConditionsA,
  deckACards,
  winConditionsB,
  deckBCards,
  catalog,
) {
  const { tags: tagsA } = utilityShiftFor(
    winConditionsA,
    deckACards,
    deckBCards,
    catalog,
  );
  const { tags: tagsB } = utilityShiftFor(
    winConditionsB,
    deckBCards,
    deckACards,
    catalog,
  );
  const all = [
    ...tagsA.map((t) => `toi: ${t}`),
    ...tagsB.map((t) => `eux: ${t}`),
  ];
  return all.length > 0 ? all.join(" · ") : "aucune règle déclenchée";
}

function describeLevelDifferentialLayer(deckACards, deckBCards) {
  const sum = (cards) =>
    toArray(cards).reduce((total, card) => total + normLevel(card), 0);
  const diff = sum(deckACards) - sum(deckBCards);
  return `${diff > 0 ? "+" : ""}${diff} niveaux normalisés`;
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
    reasons: {
      layer1: describeArchetypeLayer(winConditionsA, winConditionsB, bothKnown),
      layer2: describeCounterLayer(
        winConditionsA,
        deckACards,
        winConditionsB,
        deckBCards,
        catalog,
        bothKnown,
      ),
      layer3: describeUtilityLayer(
        winConditionsA,
        deckACards,
        winConditionsB,
        deckBCards,
        catalog,
      ),
      layer4: describeLevelDifferentialLayer(deckACards, deckBCards),
    },
    winConditionsA: winConditionsA.map((wc) => wc.name),
    winConditionsB: winConditionsB.map((wc) => wc.name),
  };
}
