// ============================================================
// battleLogUtils.js — Filtrages et catégorisations du battle log
// GDC, expansion des duels, helpers win/loss et activité quotidienne.
// ============================================================

import { parseClashDate, MS_PER_DAY, warDayKey } from "./dateUtils.js";

/**
 * Clan War battle types in the Clash Royale API.
 * Covers both current River Race format and legacy war format.
 * Tous les types en minuscules — la comparaison normalise b.type avec .toLowerCase()
 */
const WAR_BATTLE_TYPES = new Set([
  "riverracepvp",
  "riverraceduel",
  "riverraceduelcolosseum",
  "riverraceboat",
  "clanwarbattle",
]);

const DUEL_BATTLE_TYPES = new Set(["riverraceduel", "riverraceduelcolosseum"]);

/** Battle types considered as regular Ladder / Path of Legend. */
const LADDER_TYPES = new Set(["pvp", "pathoflegend", "ranked"]);

/** Battle types considered as challenge / tournament. */
const CHALLENGE_TYPES = new Set([
  "challenge",
  "grandchallenge",
  "classicchallenge",
  "challengetournament",
  "tournament",
]);

/** Battle types considered as friendly / training (not competitive). */
const FRIENDLY_TYPES = new Set([
  "training",
  "friendly",
  "clanmate",
  "casual2v2",
  "2v2",
]);

const COMPETITIVE_TYPES = new Set([
  ...WAR_BATTLE_TYPES,
  ...LADDER_TYPES,
  ...CHALLENGE_TYPES,
]);

/**
 * Filter a battle log to keep only Clan War battles.
 * @param {object[]} battleLog
 * @returns {object[]}
 */
export function filterWarBattles(battleLog) {
  return battleLog.filter((b) =>
    WAR_BATTLE_TYPES.has((b.type ?? "").toLowerCase()),
  );
}

/**
 * Filter a battle log to keep only competitive battles.
 * Includes War, Ladder, and Challenge modes.
 * @param {object[]} battleLog
 * @returns {object[]}
 */
export function filterCompetitiveBattles(battleLog) {
  return battleLog.filter((b) =>
    COMPETITIVE_TYPES.has((b.type ?? "").toLowerCase()),
  );
}

/**
 * Categorise all entries of a raw battle log into 4 buckets.
 * Returns counts per category + total entries.
 *
 * @param {object[]} rawBattleLog
 * @returns {{ total:number; gdc:number; ladder:number; challenge:number; friendly:number; other:number }}
 */
export function categorizeBattleLog(rawBattleLog) {
  let gdc = 0,
    ladder = 0,
    challenge = 0,
    friendly = 0,
    other = 0;
  for (const b of rawBattleLog) {
    const t = (b.type ?? "").toLowerCase();
    if (WAR_BATTLE_TYPES.has(t)) gdc++;
    else if (LADDER_TYPES.has(t)) ladder++;
    else if (CHALLENGE_TYPES.has(t)) challenge++;
    else if (FRIENDLY_TYPES.has(t)) friendly++;
    else other++;
  }
  return {
    total: rawBattleLog.length,
    gdc,
    ladder,
    challenge,
    friendly,
    other,
  };
}

/**
 * Flatten a war battle log so that duel entries are expanded into
 * individual rounds. Each round gets the timestamp of the parent duel.
 *
 * Rationale: a riverRaceDuel entry in the API represents a best-of-3
 * series but physically counts as multiple battles played. Expanding
 * rounds gives a more accurate per-day count.
 *
 * @param {object[]} warLog
 * @returns {object[]}
 */
export function expandDuelRounds(warLog) {
  const expanded = [];
  for (const battle of warLog) {
    const myEntry = battle.team?.[0];
    const oppEntry = battle.opponent?.[0];
    const battleType = (battle.type ?? "").toLowerCase();
    if (DUEL_BATTLE_TYPES.has(battleType) && Array.isArray(myEntry?.rounds)) {
      // One synthetic entry per round — store per-round crowns so win detection is accurate.
      // The parent crowns represent the duel total and must NOT be used per-round.
      myEntry.rounds.forEach((round, i) => {
        const oppRound = oppEntry?.rounds?.[i] ?? {};
        expanded.push({
          ...battle,
          _roundIndex: i,
          _roundCrownsMe: round.crowns ?? 0,
          _roundCrownsOpp: oppRound.crowns ?? 0,
        });
      });
    } else {
      expanded.push(battle);
    }
  }
  return expanded;
}

/**
 * Determine whether an (optionally expanded) battle entry is a win.
 * For rounds expanded from a riverRaceDuel, uses the per-round crowns
 * stored by expandDuelRounds rather than the parent duel total.
 * @param {object} b
 * @returns {boolean}
 */
export function isWarWin(b) {
  if (b._roundIndex !== undefined) {
    return (b._roundCrownsMe ?? 0) > (b._roundCrownsOpp ?? 0);
  }
  return (b.team?.[0]?.crowns ?? 0) > (b.opponent?.[0]?.crowns ?? 0);
}

/** Whether an (optionally expanded) battle entry is a loss. */
export function isWarLoss(b) {
  if (b._roundIndex !== undefined) {
    return (b._roundCrownsMe ?? 0) < (b._roundCrownsOpp ?? 0);
  }
  return (b.team?.[0]?.crowns ?? 0) < (b.opponent?.[0]?.crowns ?? 0);
}

/** Number of crowns scored by the player in an (optionally expanded) battle. */
export function getMyBattleCrowns(b) {
  if (b._roundIndex !== undefined) return b._roundCrownsMe ?? 0;
  return b.team?.[0]?.crowns ?? 0;
}

/**
 * Tell whether a battle log contains at least one duel battle for a given war day.
 * @param {object[]} battleLog
 * @param {string|null} clanTag
 * @param {string} realDay
 * @returns {boolean}
 */
export function hasDuelOnWarDay(battleLog, clanTag, realDay) {
  if (!realDay) return false;
  for (const battle of battleLog ?? []) {
    const type = (battle?.type ?? "").toLowerCase();
    if (!DUEL_BATTLE_TYPES.has(type)) continue;
    if (warDayKey(battle?.battleTime, clanTag) === realDay) return true;
  }
  return false;
}

function normalizeDeckStrength(deckCards) {
  if (!Array.isArray(deckCards)) return 0;
  return deckCards.reduce((acc, card) => {
    const level = Number(card?.level ?? card?.lvl ?? 0);
    if (!Number.isFinite(level) || level <= 0) return acc;
    return acc + level;
  }, 0);
}

function deckStrengthFromBattle(battle) {
  const playerCards = Array.isArray(battle?.team?.[0]?.cards)
    ? battle.team[0].cards
    : [];
  const opponentCards = Array.isArray(battle?.opponent?.[0]?.cards)
    ? battle.opponent[0].cards
    : [];
  return {
    player: normalizeDeckStrength(playerCards),
    opponent: normalizeDeckStrength(opponentCards),
  };
}

export function computeBattleTension(battle) {
  const playerCrowns = getMyBattleCrowns(battle);
  const opponentCrowns =
    battle._roundIndex !== undefined
      ? (battle._roundCrownsOpp ?? 0)
      : (battle.opponent?.[0]?.crowns ?? 0);
  const crownDiff = playerCrowns - opponentCrowns;
  const scoreFactor = Math.max(-3, Math.min(3, crownDiff));

  const { player, opponent } = deckStrengthFromBattle(battle);
  const strengthDiff = opponent - player;
  const strengthFactor = strengthDiff / Math.max(1, player + opponent);

  const battleType = (battle?.type ?? "").toLowerCase();
  const isTraining = FRIENDLY_TYPES.has(battleType);
  const trainingFactor = isTraining ? -0.15 : 0;

  const base =
    0.5 + strengthFactor * 0.25 - scoreFactor * 0.05 + trainingFactor;
  return Number(Math.max(0, Math.min(1, base)).toFixed(3));
}

export function computeTensionFromBattleLog(battleLog) {
  const battles = Array.isArray(battleLog) ? battleLog : [];
  if (battles.length === 0) return null;
  const warBattles = filterWarBattles(battles);
  const samples = warBattles.length > 0 ? warBattles : battles;

  const tensions = samples.map((battle) => computeBattleTension(battle));
  const total = tensions.reduce((sum, value) => sum + value, 0);
  return Number((total / tensions.length).toFixed(3));
}

/**
 * Build a battles-per-day map for the last `days` days.
 * Returns an array of { date: 'YYYY-MM-DD', count: number }.
 * @param {object[]} battleLog
 * @param {number} days
 * @returns {{ date: string; count: number }[]}
 */
export function buildDailyActivity(battleLog, days = 30) {
  const now = new Date();
  const map = {};

  // Pré-remplit chaque jour avec 0
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * MS_PER_DAY);
    const key = d.toISOString().slice(0, 10);
    map[key] = 0;
  }

  const cutoff = Date.now() - days * MS_PER_DAY;
  battleLog.forEach((b) => {
    const ts = parseClashDate(b.battleTime);
    if (ts.getTime() >= cutoff) {
      const key = ts.toISOString().slice(0, 10);
      if (key in map) map[key]++;
    }
  });

  return Object.entries(map).map(([date, count]) => ({ date, count }));
}

function chunkArray(items, size) {
  const chunks = [];
  for (let i = 0; i < items.length; i += size) {
    chunks.push(items.slice(i, i + size));
  }
  return chunks;
}

export function normalizeWarDeckCardId(card) {
  const rawId = card?.id ?? card?.name ?? card;
  if (rawId === null || rawId === undefined) return "";
  const normalized = String(rawId).trim();
  return normalized ? normalized.toUpperCase() : "";
}

function formatWarDeckCards(deckCards) {
  return deckCards
    .map((card) => String(card?.name ?? card?.id ?? "").trim())
    .filter(Boolean)
    .join(", ");
}

/**
 * Agrège les decks GDC visibles dans le battle log brut du joueur.
 * Le résultat est trié par nombre d'utilisations décroissant puis par ordre
 * d'apparition, pour faire ressortir les decks les plus joués.
 *
 * @param {object[]} battleLog
 * @param {number} [limit=4]
 * @param {string|null} [dayKey=null] Optionnel — limite aux combats du jour GDC indiqué (YYYY-MM-DD).
 * @returns {{ label:string; cards:string; plays:number; wins:number; winRate:number }[]}
 */
export function summarizeDecks(battleLog, limit = 4, dayKey = null) {
  const decks = new Map();
  const rawBattles = battleLog ?? [];

  rawBattles.forEach((battle, battleIndex) => {
    if (dayKey && warDayKey(battle?.battleTime) !== dayKey) return;
    const cards = Array.isArray(battle?.team?.[0]?.cards)
      ? battle.team[0].cards
      : [];
    const deckChunks = chunkArray(cards, 8).filter((chunk) => chunk.length > 0);
    if (!deckChunks.length) return;

    const duelRounds = Array.isArray(battle?.team?.[0]?.rounds)
      ? battle.team[0].rounds
      : null;
    const duelOppRounds = Array.isArray(battle?.opponent?.[0]?.rounds)
      ? battle.opponent[0].rounds
      : null;
    const battleWon = isWarWin(battle);
    deckChunks.forEach((deckCards, deckIndex) => {
      const signature = deckCards
        .map((card) => normalizeWarDeckCardId(card))
        .filter(Boolean)
        .sort()
        .join("-");
      if (!signature) return;

      const roundMe = duelRounds?.[deckIndex]?.crowns;
      const roundOpp = duelOppRounds?.[deckIndex]?.crowns;
      const deckWon =
        Number.isFinite(roundMe) && Number.isFinite(roundOpp)
          ? roundMe > roundOpp
          : battleWon;

      const cardNames = deckCards
        .map((card) => String(card?.name ?? card?.id ?? "").trim())
        .filter(Boolean);
      const cardIds = deckCards
        .map((card) => String(card?.id ?? "").trim())
        .filter(Boolean);
      const existing = decks.get(signature) ?? {
        cards: formatWarDeckCards(deckCards),
        cardNames,
        cardIds,
        signature,
        plays: 0,
        wins: 0,
        firstSeenIndex: battleIndex,
      };

      existing.plays += 1;
      if (deckWon) existing.wins += 1;
      if (battleIndex < existing.firstSeenIndex) {
        existing.firstSeenIndex = battleIndex;
      }

      decks.set(signature, existing);
    });
  });

  return [...decks.values()]
    .sort((a, b) => {
      if (b.plays !== a.plays) return b.plays - a.plays;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.firstSeenIndex - b.firstSeenIndex;
    })
    .slice(0, limit)
    .map((deck, index) => ({
      label: `Deck ${index + 1}`,
      signature: deck.signature,
      cards: deck.cards,
      cardNames: deck.cardNames,
      cardIds: deck.cardIds,
      plays: deck.plays,
      wins: deck.wins,
      winRate: deck.plays > 0 ? Math.round((deck.wins / deck.plays) * 100) : 0,
    }));
}

export function summarizeWarDecks(battleLog, limit = 4, dayKey = null) {
  const decks = new Map();
  const warBattles = filterWarBattles(battleLog ?? []);

  warBattles.forEach((battle, battleIndex) => {
    if (dayKey && warDayKey(battle?.battleTime) !== dayKey) return;
    const cards = Array.isArray(battle?.team?.[0]?.cards)
      ? battle.team[0].cards
      : [];
    const deckChunks = chunkArray(cards, 8).filter((chunk) => chunk.length > 0);
    if (!deckChunks.length) return;

    const duelRounds = Array.isArray(battle?.team?.[0]?.rounds)
      ? battle.team[0].rounds
      : null;
    const duelOppRounds = Array.isArray(battle?.opponent?.[0]?.rounds)
      ? battle.opponent[0].rounds
      : null;
    const battleWon = isWarWin(battle);
    const tension = computeBattleTension(battle);

    deckChunks.forEach((deckCards, deckIndex) => {
      const signature = deckCards
        .map((card) => normalizeWarDeckCardId(card))
        .filter(Boolean)
        .sort()
        .join("-");
      if (!signature) return;

      const roundMe = duelRounds?.[deckIndex]?.crowns;
      const roundOpp = duelOppRounds?.[deckIndex]?.crowns;
      const deckWon =
        Number.isFinite(roundMe) && Number.isFinite(roundOpp)
          ? roundMe > roundOpp
          : battleWon;

      const cardNames = deckCards
        .map((card) => String(card?.name ?? card?.id ?? "").trim())
        .filter(Boolean);
      const cardIds = deckCards
        .map((card) => String(card?.id ?? "").trim())
        .filter(Boolean);
      const existing = decks.get(signature) ?? {
        cards: formatWarDeckCards(deckCards),
        cardNames,
        cardIds,
        signature,
        plays: 0,
        wins: 0,
        tensionSum: 0,
        firstSeenIndex: battleIndex,
      };

      existing.plays += 1;
      existing.tensionSum += tension;
      if (deckWon) existing.wins += 1;
      if (battleIndex < existing.firstSeenIndex) {
        existing.firstSeenIndex = battleIndex;
      }

      decks.set(signature, existing);
    });
  });

  return [...decks.values()]
    .sort((a, b) => {
      if (b.plays !== a.plays) return b.plays - a.plays;
      if (b.wins !== a.wins) return b.wins - a.wins;
      return a.firstSeenIndex - b.firstSeenIndex;
    })
    .slice(0, limit)
    .map((deck, index) => ({
      label: `Deck ${index + 1}`,
      signature: deck.signature,
      cards: deck.cards,
      cardNames: deck.cardNames,
      cardIds: deck.cardIds,
      plays: deck.plays,
      wins: deck.wins,
      tension:
        deck.plays > 0 ? Number((deck.tensionSum / deck.plays).toFixed(3)) : 0,
      winRate: deck.plays > 0 ? Math.round((deck.wins / deck.plays) * 100) : 0,
    }));
}
