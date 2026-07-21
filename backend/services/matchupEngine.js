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
import { ARCHETYPE_ADVANTAGE } from "./matchupCatalog.js";

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
// Calibrage des 4 layers : la somme de leurs maxima doit valoir exactement
// 50 (la moitié de l'amplitude totale scoreA ∈ [0,100] depuis la baseline
// 50), pour que 0% et 100% ne soient atteints QUE si les 4 layers sont
// simultanément à leur maximum dans le même sens. Avec des maxima non
// calibrés, le score sature (clamp) dès que 2-3 layers s'alignent, bien
// avant que tous soient réellement extrêmes — deux combinaisons très
// différentes peuvent alors afficher exactement le même 0%/100%, perdant
// toute granularité.
// Répartition (ajustée manuellement, somme = 50) :
//   L1 Archétype        : ±5   (effectif, cf. construction ci-dessous)
//   L2 Counters directs : ±25
//   L3 Structure du deck: ±10
//   L4 Écart de niveau  : ±10
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

// Pénalité en échelle triangulaire : chaque unité au-delà de `baseline`
// coûte plus que la précédente (1, 2, 3, 4... points cumulés) — pas un
// simple palier fixe. Utilisée par Layer 2 (counters, cf. counterShiftFor)
// et Layer 3 (dispersion de deck, cf. utilityShiftFor).
function escalatingExcessPenalty(count, baseline, unitPoints) {
  const excess = Math.max(0, count - baseline);
  return (-unitPoints * (excess * (excess + 1))) / 2;
}

// LAYER 2 — Win condition vs counters directs (±25%)
// Échelle triangulaire (comme la dispersion du Layer 3) plutôt qu'un seuil
// binaire : l'ancien design (hardHits>0 → shift fixe, quel que soit le
// nombre, et soft-counters ignorés dès qu'un seul hard-counter existe)
// notait pareil "1 hard-counter" et "1 hard + 4 soft-counters" — contre-
// intuitif quand le deck adverse répond nettement plus largement. Un
// hard-counter pèse plus lourd qu'un soft (poids 14 vs 5) mais aucun des
// deux ne sature plus immédiatement à lui seul : l'accumulation continue
// de compter. Baseline/clamp par WC (±15) et poids mis à l'échelle
// proportionnellement au clamp final (±25 vs l'ancien ±15, ×5/3).
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
    escalatingExcessPenalty(hardHits, 0, 14) +
    escalatingExcessPenalty(softHits, 0, 5);
  return clampValue(15 + penalty, -15, 15);
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

// LAYER 3 — Intégrité structurelle / utilité (±clamp, ±10 par défaut)
// Interpréteur générique des règles de catalog.structureRules (compilées
// depuis data/clash-royale-matchup-structure-rules.json, cf. matchupCatalog.js
// buildStructureRules) — aucune règle métier n'est plus codée en dur ici,
// ce qui permet d'ajouter/ajuster une règle Layer 3 sans redéploiement,
// comme pour le catalogue de counters.
// Scanne les cartes brutes du deck : reste actif même si l'un des deux
// decks n'a aucune win condition reconnue dans le catalogue.
// Retourne { shift, tags } — tags = courtes étiquettes des règles
// déclenchées, utilisées uniquement pour générer les mini-explications de
// l'embed Discord (cf. describeUtilityLayer). Le shift seul alimente le score.
// xLabel/yLabel ("toi"/"lui") résolvent {self}/{opponent} dans les templates
// `label` des règles — une règle croisée (Bait, Split-Push, Heavy Beatdown)
// implique toujours deux faits sur deux decks différents (ex. "toi: 0 gros
// sort, lui: Split-push"), donc un seul préfixe global ne suffit pas.
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

function utilityShiftFor(
  winConditionsX,
  deckXCards,
  deckYCards,
  catalog,
  xLabel = "toi",
  yLabel = "lui",
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

  for (const rule of structureRules.crossRules) {
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

    const count = sumCardSets(
      deckYCards,
      rule.watch?.cardSets ?? [],
      structureRules,
      catalog,
    );
    for (const threshold of rule.thresholds ?? []) {
      if (!thresholdMatches(threshold.op, count, threshold.value)) continue;
      shift += threshold.shift;
      tags.push(
        formatRuleLabel(threshold.label, {
          self: xLabel,
          opponent: yLabel,
          count,
          triggerCard: typeof triggerCard === "string" ? triggerCard : "",
        }),
      );
      break; // un seul palier déclenché par règle, par construction
    }
  }

  // Auto-pénalités "self" (indépendantes de deckYCards) : carence dans le
  // propre deck de X (0 ou 1 seule carte aérienne/anti-air/basse élixir, 0
  // bâtiment, 0 sort, 0 win condition reconnue) — mêmes thresholds
  // op/value/shift/label que les crossRules, mais comptés directement sur
  // deckXCards (ou winConditionsX.length via `metric: "winConditionCount"`,
  // même convention que dispersionRules), sans trigger ni watch côté
  // adverse. Fait unilatéral : pas de yLabel ici.
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
      tags.push(
        formatRuleLabel(threshold.label, { self: xLabel, count }),
      );
      break;
    }
  }

  // Auto-pénalités de dispersion (indépendantes de deckYCards) : trop de
  // win conditions, de sorts ou de bâtiments dénote un manque de focus —
  // défavorable pour X, en échelle triangulaire. Fait unilatéral (ne
  // concerne que X) : pas de yLabel ici.
  for (const rule of structureRules.dispersionRules) {
    const count =
      rule.metric === "winConditionCount"
        ? winConditionsX.length
        : sumCardSets(
            deckXCards,
            rule.cardSets ?? [],
            structureRules,
            catalog,
          );
    const penalty = escalatingExcessPenalty(count, rule.baseline, rule.unitPoints);
    if (penalty !== 0) {
      shift += penalty;
      tags.push(formatRuleLabel(rule.label, { self: xLabel, count }));
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

// LAYER 4 — Différentiel de niveau de cartes (±10%, 2%/point)
// Utilise normLevel() (offset de rareté, cf. collectionConstants.js) plutôt
// que le niveau brut 1-16 du texte source, pour rester cohérent avec le
// reste du codebase où toute comparaison de force de deck passe déjà par
// normLevel() — le niveau brut pénaliserait injustement les decks riches
// en légendaires/champions. Écart assumé par rapport au texte source.
// Plafond atteint dès un écart cumulé de 5 points normalisés (10/2).
export function computeLevelDifferentialLayer(deckACards, deckBCards) {
  const sum = (cards) =>
    toArray(cards).reduce((total, card) => total + normLevel(card), 0);
  const diff = sum(deckACards) - sum(deckBCards);
  return clampValue(diff * 2, -10, 10);
}

// ------------------------------------------------------------
// Mini-explications (breakdown.reasons) — courtes étiquettes sans phrase,
// affichées sous chaque layer dans l'embed Discord (une ligne par donnée,
// préfixée de l'emoji couronne du camp concerné). Ne participent pas au
// calcul du score, purement descriptif — seul consommateur : l'embed
// buildMatchupDetailEmbed (api/discord/interactions.js), d'où le couplage
// direct à des emoji Discord (pas de préoccupation de neutralité ici).
// ------------------------------------------------------------

export const CROWN_SELF = "<:crown:1518889526460682280>"; // "toi"
export const CROWN_OPPONENT = "<:crownred:1526218168320786514>"; // "lui"
const REASON_INDENT = "- ";

function describeArchetypeLayer(winConditionsA, winConditionsB, bothKnown) {
  if (!bothKnown) return "win condition inconnue";
  const archsA = [...new Set(winConditionsA.map((wc) => wc.archetype))].join(
    "+",
  );
  const archsB = [...new Set(winConditionsB.map((wc) => wc.archetype))].join(
    "+",
  );
  return [
    `${REASON_INDENT}${CROWN_SELF} ${archsA}`,
    `${REASON_INDENT}${CROWN_OPPONENT} ${archsB}`,
  ].join("\n");
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
  // Nombre de cartes-counters trouvées chez l'adversaire pour CHAQUE win
  // condition du camp évalué (une win condition peut cumuler plusieurs
  // counters présents à la fois) : CROWN_SELF = ce que tu subis (leurs
  // counters à ta/tes WC), CROWN_OPPONENT = ce qu'il subit (tes counters
  // à sa/ses WC).
  const sumMatches = (winConditions, opponentDeck, field) =>
    winConditions.reduce(
      (sum, wc) =>
        sum + countMatchesAgainstNames(opponentDeck, wc[field], catalog),
      0,
    );
  const yourHard = sumMatches(winConditionsA, deckBCards, "hardCounters");
  const yourSoft = sumMatches(winConditionsA, deckBCards, "softCounters");
  const theirHard = sumMatches(winConditionsB, deckACards, "hardCounters");
  const theirSoft = sumMatches(winConditionsB, deckACards, "softCounters");
  return [
    `${REASON_INDENT}${CROWN_SELF} ${yourHard} hard-counter(s), ${yourSoft} soft-counter(s) subi(s)`,
    `${REASON_INDENT}${CROWN_OPPONENT} ${theirHard} hard-counter(s), ${theirSoft} soft-counter(s) subi(s)`,
  ].join("\n");
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
    CROWN_SELF,
    CROWN_OPPONENT,
  );
  const { tags: tagsB } = utilityShiftFor(
    winConditionsB,
    deckBCards,
    deckACards,
    catalog,
    CROWN_OPPONENT,
    CROWN_SELF,
  );
  const all = [...tagsA, ...tagsB];
  return all.length > 0
    ? all.map((tag) => `${REASON_INDENT}${tag}`).join("\n")
    : "aucune règle déclenchée";
}

function describeLevelDifferentialLayer(deckACards, deckBCards) {
  const sum = (cards) =>
    toArray(cards).reduce((total, card) => total + normLevel(card), 0);
  const sumA = sum(deckACards);
  const sumB = sum(deckBCards);
  const diff = sumA - sumB;
  return [
    `${REASON_INDENT}${CROWN_SELF} ${sumA}`,
    `${REASON_INDENT}${CROWN_OPPONENT} ${sumB} (${diff > 0 ? "+" : ""}${diff})`,
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
  // Win condition inconnue d'un des deux côtés : Layers 1 et 2 neutralisés
  // pour toute la bataille (pas seulement côté inconnu), pour éviter une
  // évaluation asymétrique — voir plan de refonte.
  const bothKnown = winConditionsA.length > 0 && winConditionsB.length > 0;

  const layer1 = bothKnown
    ? computeArchetypeLayer(winConditionsA, winConditionsB)
    : 0;
  const layer2 = bothKnown
    ? computeCounterLayer(
        winConditionsA,
        deckACards,
        winConditionsB,
        deckBCards,
        catalog,
      )
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
    winConditionsA: winConditionsA.map((wc) =>
      wc.pseudo ? `${wc.name} (pseudo)` : wc.name,
    ),
    winConditionsB: winConditionsB.map((wc) =>
      wc.pseudo ? `${wc.name} (pseudo)` : wc.name,
    ),
  };
}
