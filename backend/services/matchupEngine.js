// ============================================================
// services/matchupEngine.js — Moteur pur de calcul du %matchup deck-vs-deck.
//
// Calcul déterministe (sans appel LLM) : 4 layers additifs appliqués à une
// baseline 50/50, calculant scoreA = avantage du Deck A (0-100). Poids
// calibrés sur ~20 000 combats réels (cf. temp/matchup-calibration/).
//
// Fonctions pures et synchrones : le catalogue de win conditions/counters
// (chargé de façon async et potentiellement mutable, voir matchupCatalog.js)
// est toujours reçu en paramètre, jamais importé/rechargé ici.
// ============================================================

import { normLevel } from "./collectionConstants.js";

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

// Retourne le nom (tel qu'écrit dans le deck) de la première carte trouvée
// dans normalizedSet — utilisé pour nommer explicitement la carte qui
// déclenche une règle plutôt qu'un libellé d'archétype potentiellement
// trompeur (ex. Royal Hogs déclenche la règle "push agressif" bien que son
// archétype catalogue soit "Bridge Spam", pas "Split-Push").
function findMatchInSet(deckCards, normalizedSet, catalog) {
  for (const card of toArray(deckCards)) {
    if (normalizedSet.has(catalog.normalizeCardName(card?.name))) {
      return card?.name;
    }
  }
  return null;
}

function countMatchesAgainstNames(deckCards, rawNames, catalog) {
  const targetSet = new Set(
    rawNames.map((name) => catalog.normalizeCardName(name)),
  );
  return countMatchesInSet(deckCards, targetSet, catalog);
}

// Comme countMatchesAgainstNames, mais retourne les noms (tels qu'écrits
// dans le deck) de TOUTES les cartes trouvées plutôt qu'un simple compte —
// utilisé pour nommer explicitement les counters dans describeCounterLayer.
function findAllMatchesAgainstNames(deckCards, rawNames, catalog) {
  const targetSet = new Set(
    rawNames.map((name) => catalog.normalizeCardName(name)),
  );
  const found = [];
  for (const card of toArray(deckCards)) {
    if (targetSet.has(catalog.normalizeCardName(card?.name))) {
      found.push(card.name);
    }
  }
  return found;
}

// Une win condition avec `variants` (ex. Balloon) change d'archetype et de
// hard/soft-counters selon la carte compagne présente dans le MÊME deck
// (ex. Balloon + Lava Hound = profil "LavaLoon", Beatdown ; Balloon seul =
// profil "Cycle" par défaut). Retourne la première variante dont une des
// cartes `companion` est trouvée dans deckCards, sinon l'entrée de base.
function resolveWinConditionVariant(entry, deckCards, catalog) {
  if (!entry.variants || entry.variants.length === 0) return entry;
  for (const variant of entry.variants) {
    if (countMatchesAgainstNames(deckCards, variant.companion, catalog) > 0) {
      return {
        name: entry.name,
        archetype: variant.archetype,
        hardCounters: variant.hardCounters,
        softCounters: variant.softCounters,
      };
    }
  }
  return entry;
}

/**
 * Toutes les win conditions du catalogue présentes dans le deck (0, 1 ou plusieurs),
 * résolues à leur variante (cf. resolveWinConditionVariant) si applicable.
 * Si AUCUNE vraie win condition n'est trouvée, se rabat sur les pseudo win
 * conditions du catalogue (cartes à forts dégâts type P.E.K.K.A/Boss Bandit
 * — pas de vraie win condition au sens RoyaleAPI, mais souvent le vrai
 * moteur de pression du deck) pour éviter de neutraliser les Layers 1/2
 * ("win condition inconnue") sur des decks pourtant tout à fait identifiables.
 * Plusieurs pseudo win conditions trouvées → moyennées comme les vraies
 * (cf. computeArchetypeLayer/computeCounterLayer, aucun traitement spécial).
 * Marquées `pseudo: true` pour être signalées dans l'affichage (cf. plus bas).
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
      matches.push(resolveWinConditionVariant(entry, deckCards, catalog));
      seen.add(key);
    }
  }
  if (matches.length > 0) return matches;

  const pseudoWinConditionsByName = catalog.pseudoWinConditionsByName;
  if (!pseudoWinConditionsByName) return matches;
  const seenPseudo = new Set();
  for (const card of toArray(deckCards)) {
    const key = normalizeCardName(card?.name);
    if (!key || seenPseudo.has(key)) continue;
    const entry = pseudoWinConditionsByName.get(key);
    if (entry) {
      matches.push({ ...entry, pseudo: true });
      seenPseudo.add(key);
    }
  }
  return matches;
}

// ------------------------------------------------------------
// Calibrage des 4 layers : poids ajustés par régression logistique sur
// ~20 000 combats réels (Ladder/Ligue/GDC, octobre 2026, scripts dans
// temp/matchup-calibration/). Chaque point de layer vaut ~1 % de
// probabilité de défaite, d'où une lecture directe en % de difficulté.
// Constats qui ont guidé la répartition :
//   - l'écart de niveau est de loin le meilleur prédicteur (~2 %/point,
//     effet régulier jusqu'à ±20 points) ;
//   - le niveau des win conditions et les évolutions comptent en plus ;
//   - counters et structure ont un effet réel mais faible ;
//   - l'archétype (ancien Layer 1) n'avait aucun pouvoir prédictif : retiré.
// Répartition :
//   Counters directs   : ±6
//   Structure du deck  : ±10 (data/clash-royale-matchup-structure-rules.json)
//   Écart de niveau    : ±40 (cartes) + ±8 (win conditions)
//   Évolutions         : ±9
// Score final borné à [5, 95] : un deck seul ne garantit jamais l'issue.
// ------------------------------------------------------------

// Pénalité en échelle triangulaire : chaque unité au-delà de `baseline`
// coûte plus que la précédente (1, 2, 3, 4... points cumulés) — pas un
// simple palier fixe. Utilisée par le layer Structure (dispersion de deck, cf.
// utilityShiftFor).
function escalatingExcessPenalty(count, baseline, unitPoints) {
  const excess = Math.max(0, count - baseline);
  return (-unitPoints * (excess * (excess + 1))) / 2;
}

// LAYER — Win condition vs counters directs (±6%)
// Pénalité linéaire cumulée : chaque counter adverse pèse un poids fixe
// (hard 3, soft 1) depuis une baseline +3 (aucun counter), bornée à ±3 par
// win condition. Le layer vaut moyenne(A) - moyenne(B), soit ±6 au total.
const COUNTER_WC_BASELINE = 3;
const COUNTER_HARD_WEIGHT = 3;
const COUNTER_SOFT_WEIGHT = 1;
const COUNTER_LAYER_CLAMP = 6;

function counterShiftFor(winCondition, opponentDeckCards, catalog) {
  const hardHits = countMatchesAgainstNames(
    opponentDeckCards,
    winCondition.hardCounters,
    catalog,
  );
  const softHits = countMatchesAgainstNames(
    opponentDeckCards,
    winCondition.softCounters,
    catalog,
  );
  const penalty =
    COUNTER_HARD_WEIGHT * hardHits + COUNTER_SOFT_WEIGHT * softHits;
  return clampValue(
    COUNTER_WC_BASELINE - penalty,
    -COUNTER_WC_BASELINE,
    COUNTER_WC_BASELINE,
  );
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
  return clampValue(
    average(shiftsA) - average(shiftsB),
    -COUNTER_LAYER_CLAMP,
    COUNTER_LAYER_CLAMP,
  );
}

// LAYER — Intégrité structurelle / utilité (±clamp, ±10 par défaut)
// Interpréteur générique des règles de catalog.structureRules (compilées
// depuis data/clash-royale-matchup-structure-rules.json, cf. matchupCatalog.js
// buildStructureRules) — aucune règle métier n'est plus codée en dur ici,
// ce qui permet d'ajouter/ajuster une règle de structure sans redéploiement,
// comme pour le catalogue de counters.
// Scanne les cartes brutes du deck : reste actif même si l'un des deux
// decks n'a aucune win condition reconnue dans le catalogue.
// Retourne { shift, tags } — tags = [{ ruleId, label, shift }] des règles
// déclenchées, utilisés uniquement pour générer les mini-explications de
// l'embed Discord (cf. describeUtilityLayer) : une ligne par règle, attribuée
// au seul camp X qui en bénéficie/souffre, avec son effet chiffré. Le shift
// total seul alimente le score.
function formatRuleLabel(template, vars) {
  return String(template ?? "").replace(/\{(\w+)\}/g, (match, key) =>
    key in vars ? String(vars[key]) : match,
  );
}

function sumCardSets(deckCards, cardSetNames, structureRules, catalog) {
  let total = 0;
  for (const setName of cardSetNames) {
    total += countMatchesInSet(
      deckCards,
      structureRules.cardSets[setName] ?? new Set(),
      catalog,
    );
  }
  return total;
}

// Noms (tels qu'écrits dans le deck) des cartes présentes dans au moins un
// des cardSets — utilisé pour nommer les cartes adverses visées par une
// règle croisée ({watchCards}).
function findAllMatchesInCardSets(
  deckCards,
  cardSetNames,
  structureRules,
  catalog,
) {
  const found = [];
  for (const card of toArray(deckCards)) {
    const key = catalog.normalizeCardName(card?.name);
    if (
      cardSetNames.some((setName) => structureRules.cardSets[setName]?.has(key))
    ) {
      found.push(card.name);
    }
  }
  return found;
}

function thresholdMatches(op, count, value) {
  switch (op) {
    case "lt":
      return count < value;
    case "lte":
      return count <= value;
    case "gt":
      return count > value;
    case "gte":
      return count >= value;
    case "eq":
      return count === value;
    default:
      return false;
  }
}

export function utilityShiftFor(
  winConditionsX,
  deckXCards,
  deckYCards,
  catalog,
) {
  const structureRules = catalog.structureRules ?? {
    cardSets: {},
    crossRules: [],
    dispersionRules: [],
    selfRules: [],
    clamp: 10,
  };
  let shift = 0;
  const tags = [];

  // `exclusiveGroup` : au sein d'un même groupe, seule la première règle
  // déclenchée s'applique (ordre du JSON, la plus forte en premier) — évite
  // qu'une même menace adverse (ex. un seul Boss Bandit) soit comptée à la
  // fois par la règle hard-counter et la règle soft-counter du camp X.
  const triggeredGroups = new Set();
  for (const rule of structureRules.crossRules) {
    if (rule.exclusiveGroup && triggeredGroups.has(rule.exclusiveGroup)) {
      continue;
    }
    let triggerCard = true;
    if (rule.trigger?.type === "archetype") {
      if (!winConditionsX.some((wc) => wc.archetype === rule.trigger.value)) {
        continue;
      }
    } else if (rule.trigger?.type === "cardSet") {
      triggerCard = findMatchInSet(
        deckXCards,
        structureRules.cardSets[rule.trigger.value] ?? new Set(),
        catalog,
      );
      if (!triggerCard) continue;
    } else {
      continue;
    }

    const watchCardSets = rule.watch?.cardSets ?? [];
    const count = sumCardSets(
      deckYCards,
      watchCardSets,
      structureRules,
      catalog,
    );
    for (const threshold of rule.thresholds ?? []) {
      if (!thresholdMatches(threshold.op, count, threshold.value)) continue;
      shift += threshold.shift;
      tags.push({
        ruleId: `${rule.id}:${threshold.op}${threshold.value}`,
        label: formatRuleLabel(threshold.label, {
          count,
          triggerCard: typeof triggerCard === "string" ? triggerCard : "",
          watchCards: findAllMatchesInCardSets(
            deckYCards,
            watchCardSets,
            structureRules,
            catalog,
          ).join(", "),
        }),
        shift: threshold.shift,
      });
      if (rule.exclusiveGroup) triggeredGroups.add(rule.exclusiveGroup);
      break; // un seul palier déclenché par règle, par construction
    }
  }

  // Auto-pénalités "self" (indépendantes de deckYCards) : carence dans le
  // propre deck de X (0 ou 1 seule carte aérienne/anti-air/basse élixir, 0
  // bâtiment, 0 sort, 0 win condition reconnue) — mêmes thresholds
  // op/value/shift/label que les crossRules, mais comptés directement sur
  // deckXCards (ou winConditionsX.length via `metric: "winConditionCount"`,
  // même convention que dispersionRules), sans trigger ni watch côté
  // adverse.
  for (const rule of structureRules.selfRules ?? []) {
    const count =
      rule.metric === "winConditionCount"
        ? winConditionsX.length
        : sumCardSets(
            deckXCards,
            rule.watch?.cardSets ?? [],
            structureRules,
            catalog,
          );
    for (const threshold of rule.thresholds ?? []) {
      if (!thresholdMatches(threshold.op, count, threshold.value)) continue;
      shift += threshold.shift;
      tags.push({
        ruleId: `${rule.id}:${threshold.op}${threshold.value}`,
        label: formatRuleLabel(threshold.label, { count }),
        shift: threshold.shift,
      });
      break;
    }
  }

  // Auto-pénalités de dispersion (indépendantes de deckYCards) : trop de
  // win conditions, de sorts ou de bâtiments dénote un manque de focus —
  // défavorable pour X, en échelle triangulaire.
  for (const rule of structureRules.dispersionRules) {
    const count =
      rule.metric === "winConditionCount"
        ? winConditionsX.length
        : sumCardSets(deckXCards, rule.cardSets ?? [], structureRules, catalog);
    const penalty = escalatingExcessPenalty(
      count,
      rule.baseline,
      rule.unitPoints,
    );
    if (penalty !== 0) {
      shift += penalty;
      tags.push({
        ruleId: rule.id,
        label: formatRuleLabel(rule.label, { count }),
        shift: penalty,
      });
    }
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
  const clamp = catalog.structureRules?.clamp ?? 10;
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
  return clampValue(shiftA - shiftB, -clamp, clamp);
}

// LAYER — Différentiel de niveau (±40% cartes + ±8% win conditions)
// Utilise normLevel() (offset de rareté, cf. collectionConstants.js) : le
// niveau brut pénaliserait injustement les decks riches en légendaires/
// champions. Deux composantes :
//   - somme des 8 cartes : 2 % par point d'écart, effet mesuré régulier
//     jusqu'à ±20 points (d'où le plafond ±40) ;
//   - niveau moyen des win conditions : 4 % par niveau d'écart (±8), qui
//     pèse en plus du global — une WC sous-niveau perd ses interactions clés.
const LEVEL_POINT_WEIGHT = 2;
const LEVEL_CLAMP = 40;
const WC_LEVEL_WEIGHT = 4;
const WC_LEVEL_CLAMP = 8;

function sumNormLevels(cards) {
  return toArray(cards).reduce((total, card) => total + normLevel(card), 0);
}

// Niveau normalisé moyen des cartes du deck correspondant aux win
// conditions identifiées (vraies ou pseudo). null si aucune.
function winConditionLevel(deckCards, winConditions, catalog) {
  const names = new Set(
    winConditions.map((wc) => catalog.normalizeCardName(wc.name)),
  );
  const levels = toArray(deckCards)
    .filter((card) => names.has(catalog.normalizeCardName(card?.name)))
    .map(normLevel);
  return levels.length > 0 ? average(levels) : null;
}

function levelComponents(
  deckACards,
  deckBCards,
  winConditionsA,
  winConditionsB,
  catalog,
) {
  const sumA = sumNormLevels(deckACards);
  const sumB = sumNormLevels(deckBCards);
  const cards = clampValue(
    (sumA - sumB) * LEVEL_POINT_WEIGHT,
    -LEVEL_CLAMP,
    LEVEL_CLAMP,
  );
  const wcA = winConditionLevel(deckACards, winConditionsA, catalog);
  const wcB = winConditionLevel(deckBCards, winConditionsB, catalog);
  const wc =
    wcA !== null && wcB !== null
      ? clampValue(
          (wcA - wcB) * WC_LEVEL_WEIGHT,
          -WC_LEVEL_CLAMP,
          WC_LEVEL_CLAMP,
        )
      : 0;
  return { sumA, sumB, cards, wcA, wcB, wc };
}

export function computeLevelDifferentialLayer(
  deckACards,
  deckBCards,
  winConditionsA = [],
  winConditionsB = [],
  catalog = null,
) {
  if (!catalog) {
    return clampValue(
      (sumNormLevels(deckACards) - sumNormLevels(deckBCards)) *
        LEVEL_POINT_WEIGHT,
      -LEVEL_CLAMP,
      LEVEL_CLAMP,
    );
  }
  const { cards, wc } = levelComponents(
    deckACards,
    deckBCards,
    winConditionsA,
    winConditionsB,
    catalog,
  );
  return cards + wc;
}

// LAYER — Évolutions et héros (±9%, 3% par carte d'écart)
// `evolutionLevel` > 0 sur une carte du battle log = carte jouée évoluée (1)
// ou en héros (2) ; les deux sont comptés pareil, comme lors du calibrage.
const EVOLUTION_WEIGHT = 3;
const EVOLUTION_CLAMP = 9;

function evolvedCards(deckCards) {
  return toArray(deckCards).filter((card) => (card?.evolutionLevel ?? 0) > 0);
}

export function computeEvolutionLayer(deckACards, deckBCards) {
  const diff =
    evolvedCards(deckACards).length - evolvedCards(deckBCards).length;
  return clampValue(diff * EVOLUTION_WEIGHT, -EVOLUTION_CLAMP, EVOLUTION_CLAMP);
}

// ------------------------------------------------------------
// Mini-explications (breakdown.reasons) — courtes étiquettes sans phrase,
// affichées sous chaque layer dans l'embed Discord (une ligne par donnée,
// préfixée de l'emoji couronne du camp concerné). Chaque ligne qui pèse sur
// le score affiche son effet DANS LE SENS DE LA DIFFICULTÉ (comme le titre du
// layer dans l'embed) : positif = défavorable au joueur — la somme des lignes
// redonne le total du layer (hors arrondi/plafond). Ne participent pas au
// calcul du score, purement descriptif — seul consommateur : l'embed
// buildMatchupDetailEmbed (api/discord/interactions.js), d'où le couplage
// direct à des emoji Discord (pas de préoccupation de neutralité ici).
// ------------------------------------------------------------

export const CROWN_SELF = "<:crown:1518889526460682280>"; // "toi"
export const CROWN_OPPONENT = "<:crownred:1526218168320786514>"; // "lui"
const REASON_INDENT = "- ";

// shiftForA = effet en faveur du joueur (A) ; affiché inversé, en difficulté.
function formatDifficultyEffect(shiftForA) {
  const displayed = Math.round(-shiftForA);
  return `${displayed > 0 ? "+" : ""}${displayed}%`;
}

function clampNote(rawTotal, clamp) {
  return Math.abs(rawTotal) > clamp
    ? `\n${REASON_INDENT}total plafonné à ±${clamp}%`
    : "";
}

// Une ligne par win condition (et non un total agrégé par camp) : avec
// plusieurs win conditions d'un même côté, le score moyenne un shift PAR WC
// (cf. computeCounterLayer) — un total sommé masquerait qu'une WC totalement
// non-répondue (shift max) peut tirer la moyenne vers le haut malgré un
// total de counters identique côté adverse. Hard ET soft sont listés : les
// deux sont cumulés par counterShiftFor (échelle triangulaire), masquer les
// soft dès qu'un hard existe rendait l'écart de score inexplicable.
// shiftForA = contribution de cette WC au layer, du point de vue du joueur.
function describeCounterLayerLine(
  wc,
  opponentDeckCards,
  catalog,
  label,
  shiftForA,
) {
  const hardMatches = findAllMatchesAgainstNames(
    opponentDeckCards,
    wc.hardCounters,
    catalog,
  );
  const softMatches = findAllMatchesAgainstNames(
    opponentDeckCards,
    wc.softCounters,
    catalog,
  );
  const parts = [];
  if (hardMatches.length > 0) parts.push(`${hardMatches.join(", ")} (hard)`);
  if (softMatches.length > 0) parts.push(`${softMatches.join(", ")} (soft)`);
  const counters = parts.length > 0 ? parts.join(" + ") : "aucun counter";
  return `${REASON_INDENT}${label} ${wc.name} (${formatDifficultyEffect(shiftForA)}) : ${counters}`;
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
  // Même décomposition que computeCounterLayer : moyenne(A) - moyenne(B).
  let rawTotal = 0;
  const linesA = winConditionsA.map((wc) => {
    const shiftForA =
      counterShiftFor(wc, deckBCards, catalog) / winConditionsA.length;
    rawTotal += shiftForA;
    return describeCounterLayerLine(
      wc,
      deckBCards,
      catalog,
      CROWN_SELF,
      shiftForA,
    );
  });
  const linesB = winConditionsB.map((wc) => {
    const shiftForA =
      -counterShiftFor(wc, deckACards, catalog) / winConditionsB.length;
    rawTotal += shiftForA;
    return describeCounterLayerLine(
      wc,
      deckACards,
      catalog,
      CROWN_OPPONENT,
      shiftForA,
    );
  });
  return (
    [...linesA, ...linesB].join("\n") + clampNote(rawTotal, COUNTER_LAYER_CLAMP)
  );
}

function describeUtilityLayer(
  winConditionsA,
  deckACards,
  winConditionsB,
  deckBCards,
  catalog,
) {
  const clamp = catalog.structureRules?.clamp ?? 10;
  const { shift: shiftA, tags: tagsA } = utilityShiftFor(
    winConditionsA,
    deckACards,
    deckBCards,
    catalog,
  );
  const { shift: shiftB, tags: tagsB } = utilityShiftFor(
    winConditionsB,
    deckBCards,
    deckACards,
    catalog,
  );
  // Une règle favorable à l'adversaire (B) est défavorable au joueur : son
  // shift est inversé avant affichage, comme dans computeUtilityLayer.
  const lines = [
    ...tagsA.map(
      (tag) =>
        `${REASON_INDENT}${CROWN_SELF} ${tag.label} (${formatDifficultyEffect(tag.shift)})`,
    ),
    ...tagsB.map(
      (tag) =>
        `${REASON_INDENT}${CROWN_OPPONENT} ${tag.label} (${formatDifficultyEffect(-tag.shift)})`,
    ),
  ];
  return lines.length > 0
    ? lines.join("\n") + clampNote(shiftA - shiftB, clamp)
    : "aucune règle déclenchée";
}

// Niveau moyen arrondi à 0,1 (les win conditions peuvent être plusieurs)
function formatLevel(value) {
  return String(Math.round(value * 10) / 10).replace(".", ",");
}

function describeLevelDifferentialLayer(
  deckACards,
  deckBCards,
  winConditionsA,
  winConditionsB,
  catalog,
) {
  const { sumA, sumB, cards, wcA, wcB, wc } = levelComponents(
    deckACards,
    deckBCards,
    winConditionsA,
    winConditionsB,
    catalog,
  );
  const lines = [
    `${REASON_INDENT}Cartes : ${CROWN_SELF} ${sumA} vs ${CROWN_OPPONENT} ${sumB} (${formatDifficultyEffect(cards)})`,
  ];
  if (wcA !== null && wcB !== null) {
    lines.push(
      `${REASON_INDENT}Win conditions : ${CROWN_SELF} ${formatLevel(wcA)} vs ${CROWN_OPPONENT} ${formatLevel(wcB)} (${formatDifficultyEffect(wc)})`,
    );
  }
  return lines.join("\n");
}

function describeEvolutionLayer(deckACards, deckBCards) {
  const names = (cards) => {
    const evolved = evolvedCards(cards).map((card) => card.name);
    return evolved.length > 0 ? evolved.join(", ") : "aucune";
  };
  return [
    `${REASON_INDENT}${CROWN_SELF} ${names(deckACards)}`,
    `${REASON_INDENT}${CROWN_OPPONENT} ${names(deckBCards)}`,
  ].join("\n");
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
  // Win condition inconnue d'un des deux côtés : counters neutralisés pour
  // toute la bataille (pas seulement côté inconnu), pour éviter une
  // évaluation asymétrique.
  const bothKnown = winConditionsA.length > 0 && winConditionsB.length > 0;

  const counters = bothKnown
    ? computeCounterLayer(
        winConditionsA,
        deckACards,
        winConditionsB,
        deckBCards,
        catalog,
      )
    : 0;
  const structure = computeUtilityLayer(
    winConditionsA,
    deckACards,
    winConditionsB,
    deckBCards,
    catalog,
  );
  const level = computeLevelDifferentialLayer(
    deckACards,
    deckBCards,
    winConditionsA,
    winConditionsB,
    catalog,
  );
  const evolutions = computeEvolutionLayer(deckACards, deckBCards);

  const scoreA = clampValue(
    50 + counters + structure + level + evolutions,
    5,
    95,
  );

  return {
    scoreA,
    scoreB: 100 - scoreA,
    breakdown: { counters, structure, level, evolutions },
    reasons: {
      counters: describeCounterLayer(
        winConditionsA,
        deckACards,
        winConditionsB,
        deckBCards,
        catalog,
        bothKnown,
      ),
      structure: describeUtilityLayer(
        winConditionsA,
        deckACards,
        winConditionsB,
        deckBCards,
        catalog,
      ),
      level: describeLevelDifferentialLayer(
        deckACards,
        deckBCards,
        winConditionsA,
        winConditionsB,
        catalog,
      ),
      evolutions: describeEvolutionLayer(deckACards, deckBCards),
    },
    winConditionsA: winConditionsA.map((wc) =>
      wc.pseudo ? `${wc.name} (pseudo)` : wc.name,
    ),
    winConditionsB: winConditionsB.map((wc) =>
      wc.pseudo ? `${wc.name} (pseudo)` : wc.name,
    ),
  };
}
