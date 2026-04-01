// ============================================================
// battleLogUtils.js — Filtrages et catégorisations du battle log
// GDC, expansion des duels, helpers win/loss et activité quotidienne.
// ============================================================

import { parseClashDate, MS_PER_DAY } from './dateUtils.js';

/**
 * Clan War battle types in the Clash Royale API.
 * Covers both current River Race format and legacy war format.
 * Tous les types en minuscules — la comparaison normalise b.type avec .toLowerCase()
 */
const WAR_BATTLE_TYPES = new Set([
  'riverracepvp',
  'riverraceduel',
  'riverraceduelscolosseum',
  'riverraceboat',
  'clanwarbattle',
]);

/** Battle types considered as regular Ladder / Path of Legend. */
const LADDER_TYPES = new Set(['pvp', 'pathoflegend', 'ranked']);

/** Battle types considered as challenge / tournament. */
const CHALLENGE_TYPES = new Set([
  'challenge', 'grandchallenge', 'classicchallenge',
  'challengetournament', 'tournament',
]);

/** Battle types considered as friendly / training (not competitive). */
const FRIENDLY_TYPES = new Set(['training', 'friendly', 'clanmate', 'casual2v2', '2v2']);

/**
 * Filter a battle log to keep only Clan War battles.
 * @param {object[]} battleLog
 * @returns {object[]}
 */
export function filterWarBattles(battleLog) {
  return battleLog.filter((b) => WAR_BATTLE_TYPES.has((b.type ?? '').toLowerCase()));
}

/**
 * Categorise all entries of a raw battle log into 4 buckets.
 * Returns counts per category + total entries.
 *
 * @param {object[]} rawBattleLog
 * @returns {{ total:number; gdc:number; ladder:number; challenge:number; friendly:number; other:number }}
 */
export function categorizeBattleLog(rawBattleLog) {
  let gdc = 0, ladder = 0, challenge = 0, friendly = 0, other = 0;
  for (const b of rawBattleLog) {
    const t = (b.type ?? '').toLowerCase();
    if (WAR_BATTLE_TYPES.has(t))      gdc++;
    else if (LADDER_TYPES.has(t))     ladder++;
    else if (CHALLENGE_TYPES.has(t))  challenge++;
    else if (FRIENDLY_TYPES.has(t))   friendly++;
    else other++;
  }
  return { total: rawBattleLog.length, gdc, ladder, challenge, friendly, other };
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
    const myEntry  = battle.team?.[0];
    const oppEntry = battle.opponent?.[0];
    if (battle.type === 'riverRaceDuel' && Array.isArray(myEntry?.rounds)) {
      // One synthetic entry per round — store per-round crowns so win detection is accurate.
      // The parent crowns represent the duel total and must NOT be used per-round.
      myEntry.rounds.forEach((round, i) => {
        const oppRound = oppEntry?.rounds?.[i] ?? {};
        expanded.push({
          ...battle,
          _roundIndex:     i,
          _roundCrownsMe:  round.crowns   ?? 0,
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
