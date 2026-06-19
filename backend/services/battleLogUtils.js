// ============================================================
// battleLogUtils.js — Filtrages et catégorisations du battle log
// GDC, expansion des duels, helpers win/loss et activité quotidienne.
// ============================================================

import { parseClashDate, MS_PER_DAY, warDayKey } from "./dateUtils.js";
import {
  normLevel,
  countEvolved,
  countHeroes,
} from "./collectionConstants.js";

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
    const myEntry = getFirstEntry(battle.team);
    const oppEntry = getFirstEntry(battle.opponent);
    const battleType = (battle.type ?? "").toLowerCase();
    const myRounds = getRoundArray(myEntry, battle, false);
    const oppRounds = getRoundArray(oppEntry, battle, true);

    if (DUEL_BATTLE_TYPES.has(battleType) && myRounds.length > 0) {
      // One synthetic entry per round — store per-round crowns so win detection is accurate.
      // The parent crowns represent the duel total and must NOT be used per-round.
      myRounds.forEach((round, i) => {
        const oppRound = oppRounds?.[i] ?? null;
        const { myCrowns, oppCrowns } = getRoundScores(round, oppRound);
        expanded.push({
          ...battle,
          _roundIndex: i,
          _roundCrownsMe: myCrowns,
          _roundCrownsOpp: oppCrowns,
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
    return acc + normLevel(card);
  }, 0);
}

function computeTowerLevelFactor(playerTourLevel, opponentTourLevel) {
  if (
    !Number.isFinite(playerTourLevel) ||
    !Number.isFinite(opponentTourLevel)
  ) {
    return 0;
  }
  const towerDiff = Math.max(
    -3,
    Math.min(3, opponentTourLevel - playerTourLevel),
  );
  // Les écarts de niveau de tour doivent avoir un impact plus marqué,
  // pour que les adversaires nettement supérieurs puissent rendre le matchup extrême.
  return towerDiff > 0 ? towerDiff * 0.3 : towerDiff * 0.1;
}

function estimateTowerLevelFromHp(hp) {
  if (!Number.isFinite(hp) || hp <= 0) return null;
  if (hp >= 7728) return 16;
  if (hp >= 7032) return 15;
  if (hp >= 6408) return 14;
  if (hp >= 5832) return 13;
  if (hp >= 5234) return 12;
  if (hp >= 4565) return 11;
  return null;
}

function computeBattleTourLevel(entry) {
  const rounds = Array.isArray(entry?.rounds) ? entry.rounds : [];
  if (rounds.length > 0) {
    const maxHp = Math.max(
      ...rounds
        .map((r) => Number(r.kingTowerHitPoints ?? r.kingTowerHP ?? 0))
        .filter((hp) => Number.isFinite(hp) && hp > 0),
    );
    if (Number.isFinite(maxHp) && maxHp > 0) {
      const hpLevel = estimateTowerLevelFromHp(maxHp);
      if (hpLevel) return hpLevel;
    }
  }

  const kingTowerHp = Number(
    entry?.kingTowerHitPoints ?? entry?.kingTowerHP ?? 0,
  );
  const hpLevel = estimateTowerLevelFromHp(kingTowerHp);
  if (hpLevel) return hpLevel;

  return null;
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

export function clampValue(value, min, max) {
  return Math.max(min, Math.min(max, value));
}

export function computeBattleMatchup(battle, options = {}) {
  const {
    playerWinRate = null,
    opponentWinRate = null,
    playerCollectionLevel = null,
    opponentCollectionLevel = null,
    playerCw2Wins = null,
    opponentCw2Wins = null,
    playerTrophies = null,
    opponentTrophies = null,
  } = options;

  const { player, opponent } = deckStrengthFromBattle(battle);
  const deckScore = clampValue(opponent - player, -10, 10) * 1.5;

  const collectionScore =
    Number.isFinite(playerCollectionLevel) &&
    Number.isFinite(opponentCollectionLevel)
      ? clampValue(
          (opponentCollectionLevel - playerCollectionLevel) / 100,
          -1,
          1,
        ) * 10
      : 0;

  const cw2Score =
    Number.isFinite(playerCw2Wins) && Number.isFinite(opponentCw2Wins)
      ? clampValue(
          (opponentCw2Wins - playerCw2Wins) / Math.max(1, opponentCw2Wins),
          -0.5,
          0.5,
        ) * 10
      : 0;

  const normalizedPlayerWinRate = Number.isFinite(playerWinRate)
    ? playerWinRate > 1
      ? playerWinRate / 100
      : playerWinRate
    : null;
  const normalizedOpponentWinRate = Number.isFinite(opponentWinRate)
    ? opponentWinRate > 1
      ? opponentWinRate / 100
      : opponentWinRate
    : null;
  const winRateBaseline = Number.isFinite(normalizedOpponentWinRate)
    ? normalizedOpponentWinRate
    : 0.5;
  const winRateScore = Number.isFinite(normalizedPlayerWinRate)
    ? clampValue(winRateBaseline - normalizedPlayerWinRate, -0.5, 0.5) * 10
    : 0;

  const trophyScore =
    Number.isFinite(playerTrophies) && Number.isFinite(opponentTrophies)
      ? clampValue((opponentTrophies - playerTrophies) / 1000, -1, 1) * 15
      : 0;

  const totalScore =
    deckScore + collectionScore + cw2Score + winRateScore + trophyScore;
  const matchup = 0.5 + totalScore / 100;

  return Number(clampValue(matchup, 0, 1).toFixed(3));
}

export function computeMatchupFromBattleLog(battleLog, options = {}) {
  const battles = Array.isArray(battleLog) ? battleLog : [];
  if (battles.length === 0) return null;
  const warBattles = filterWarBattles(battles);
  const samples = warBattles.length > 0 ? warBattles : battles;

  const matchups = samples.map((battle) =>
    computeBattleMatchup(battle, options),
  );
  const total = matchups.reduce((sum, value) => sum + value, 0);
  return Number((total / matchups.length).toFixed(3));
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

function getFirstEntry(entry) {
  if (Array.isArray(entry)) return entry[0] || null;
  if (entry && typeof entry === "object") return entry;
  return null;
}

function normalizePlayerTag(tag) {
  if (!tag) return null;
  const raw = String(tag).trim().toUpperCase();
  return raw.startsWith("#") ? raw.slice(1) : raw;
}

function getOpponentTag(battle) {
  const oppEntry = getFirstEntry(battle.opponent);
  return normalizePlayerTag(oppEntry?.tag);
}

function getRoundArray(entry, battle, isOpponent = false) {
  if (Array.isArray(entry?.rounds)) return entry.rounds;
  if (Array.isArray(battle?.rounds)) return battle.rounds;
  return [];
}

function getRoundCrowns(round) {
  if (!round || typeof round !== "object") return null;
  const candidates = [
    round.crowns,
    round.crown,
    round.crownsMe,
    round.myCrowns,
    round.playerCrowns,
    round.player_crowns,
    round.player?.crowns,
  ];
  for (const value of candidates) {
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function getOppRoundCrowns(round) {
  if (!round || typeof round !== "object") return null;
  const candidates = [
    round.crownsOpp,
    round.opponentCrowns,
    round.crownsOpponent,
    round.oppCrowns,
    round.enemyCrowns,
    round.opponent_crowns,
    round.opponent?.crownsOpp,
    round.opponent?.opponentCrowns,
    round.opponent?.crowns,
    round.enemy?.crowns,
  ];
  for (const value of candidates) {
    if (Number.isFinite(Number(value))) return Number(value);
  }
  return null;
}

function getRoundScores(myRound, oppRound) {
  const myCrowns = getRoundCrowns(myRound);
  let oppCrowns = getOppRoundCrowns(oppRound);
  if (oppCrowns === null) {
    oppCrowns = getOppRoundCrowns(myRound);
  }
  if (oppCrowns === null && oppRound) {
    oppCrowns = getRoundCrowns(oppRound);
  }
  return {
    myCrowns: Number.isFinite(myCrowns) ? myCrowns : 0,
    oppCrowns: Number.isFinite(oppCrowns) ? oppCrowns : 0,
  };
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

function getDeckChunksForBattle(battle) {
  const cards = Array.isArray(battle?.team?.[0]?.cards)
    ? battle.team[0].cards
    : [];
  const deckChunks = chunkArray(cards, 8).filter((chunk) => chunk.length > 0);
  if (battle?._roundIndex !== undefined) {
    const roundChunk = deckChunks[battle._roundIndex];
    return roundChunk ? [roundChunk] : deckChunks;
  }
  return deckChunks;
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

export function summarizeWarDecksForMatchup(
  battleLog,
  limit = 64,
  dayKey = null,
  clanTag = null,
  options = {},
) {
  const warBattles = expandDuelRounds(filterWarBattles(battleLog ?? []));
  const entries = [];
  let deckIndex = 0;
  const dayDeckCounts = new Map();

  for (const battle of warBattles) {
    const teamEntry = getFirstEntry(battle.team);
    const oppEntry = getFirstEntry(battle.opponent);
    const battleClanTag =
      clanTag ?? teamEntry?.clan?.tag ?? oppEntry?.clan?.tag ?? null;
    const effectiveDayKey = warDayKey(battle?.battleTime, battleClanTag);
    if (dayKey && effectiveDayKey !== dayKey) continue;
    if (deckIndex >= limit) break;

    const deckChunks = getDeckChunksForBattle(battle);
    if (!deckChunks.length) continue;

    const opponentTag = getOpponentTag(battle);
    const opponentMeta = opponentTag
      ? (options.opponentStatsByTag?.get?.(opponentTag) ??
        options.opponentStatsByTag?.[opponentTag] ??
        null)
      : null;
    const opponentTourLevel = computeBattleTourLevel(oppEntry);
    const matchupOptions = { ...options, opponentTourLevel };
    if (opponentMeta) {
      matchupOptions.opponentWinRate =
        opponentMeta.activityIndicators?.winRate ??
        opponentMeta.playerWinRate ??
        matchupOptions.opponentWinRate;
      matchupOptions.opponentCollectionLevel =
        opponentMeta.overview?.collectionLevel ??
        opponentMeta.playerCollectionLevel ??
        matchupOptions.opponentCollectionLevel;
      matchupOptions.opponentCw2Wins =
        opponentMeta.overview?.clanWarWins ??
        opponentMeta.playerCw2Wins ??
        matchupOptions.opponentCw2Wins;
      matchupOptions.opponentTrophies =
        opponentMeta.overview?.trophies ??
        opponentMeta.playerTrophies ??
        matchupOptions.opponentTrophies;
    }
    const matchup = computeBattleMatchup(battle, matchupOptions);
    const opponentName = String(oppEntry?.name ?? oppEntry?.tag ?? "?").trim();
    const myCrowns = getMyBattleCrowns(battle);
    const oppCrowns =
      battle._roundIndex !== undefined
        ? (battle._roundCrownsOpp ?? 0)
        : (battle.opponent?.[0]?.crowns ?? 0);
    const score = `${myCrowns}-${oppCrowns}`;
    const result = isWarWin(battle) ? "win" : "loss";
    const deckWon = Number.isFinite(battle?.team?.[0]?.crowns)
      ? undefined
      : result === "win";

    for (const chunk of deckChunks) {
      if (deckIndex >= limit) break;
      deckIndex += 1;
      const dayDeckLabel = `Deck ${
        (dayDeckCounts.get(effectiveDayKey) ?? 0) + 1
      }`;

      const signature = chunk
        .map((card) => normalizeWarDeckCardId(card))
        .filter(Boolean)
        .sort()
        .join("-");
      if (!signature) continue;

      const cardNames = chunk
        .map((card) => String(card?.name ?? card?.id ?? "").trim())
        .filter(Boolean);
      const cardIds = chunk
        .map((card) => String(card?.id ?? "").trim())
        .filter(Boolean);

      const displayLabel = dayDeckLabel;
      dayDeckCounts.set(
        effectiveDayKey,
        (dayDeckCounts.get(effectiveDayKey) ?? 0) + 1,
      );

      entries.push({
        label: displayLabel,
        signature,
        cards: formatWarDeckCards(chunk),
        cardNames,
        cardIds,
        plays: 1,
        wins:
          deckWon === undefined ? (result === "win" ? 1 : 0) : deckWon ? 1 : 0,
        matchup,
        winRate: result === "win" ? 100 : 0,
        matches: [
          {
            opponentName,
            opponentTourLevel,
            score,
            myCrowns,
            oppCrowns,
            result,
            matchup,
            dayKey: effectiveDayKey,
            type: battle.type ?? null,
          },
        ],
      });
    }
  }

  return entries;
}

export function summarizeWarDecks(battleLog, limit = 4, dayKey = null) {
  const decks = new Map();
  const warBattles = expandDuelRounds(filterWarBattles(battleLog ?? []));

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
    const matchup = computeBattleMatchup(battle);

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
      const opponentName = String(
        battle.opponent?.[0]?.name ?? battle.opponent?.[0]?.tag ?? "?",
      ).trim();
      const opponentTourLevel = computeBattleTourLevel(battle.opponent?.[0]);
      const myCrowns = getMyBattleCrowns(battle);
      const oppCrowns =
        battle._roundIndex !== undefined
          ? (battle._roundCrownsOpp ?? 0)
          : (battle.opponent?.[0]?.crowns ?? 0);
      const score = `${myCrowns}-${oppCrowns}`;
      const result = isWarWin(battle) ? "win" : "loss";
      const existing = decks.get(signature) ?? {
        cards: formatWarDeckCards(deckCards),
        cardNames,
        cardIds,
        signature,
        plays: 0,
        wins: 0,
        matchupSum: 0,
        matches: [],
        firstSeenIndex: battleIndex,
      };

      existing.plays += 1;
      existing.matchupSum += matchup;
      if (deckWon) existing.wins += 1;
      existing.matches.push({
        opponentName,
        opponentTourLevel,
        score,
        myCrowns,
        oppCrowns,
        result,
        matchup,
        dayKey: warDayKey(battle?.battleTime),
      });
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
      matchup:
        deck.plays > 0 ? Number((deck.matchupSum / deck.plays).toFixed(3)) : 0,
      winRate: deck.plays > 0 ? Math.round((deck.wins / deck.plays) * 100) : 0,
      matches: deck.matches ?? [],
    }));
}
