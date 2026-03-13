// ============================================================
// topplayers.js — Helper for computing high‑fame performers in the
// most recent River Race. Used by the clan analysis route.
// ============================================================

import { fetchRaceLog } from './clashApi.js';

/**
 * Return a map of players in the given clan who exceeded various fame
 * thresholds during the last completed River Race week.
 *
 * The result is an object of the shape:
 *   {
 *     quotas: [2400,2600,2800],          // copy of the thresholds array
 *     playersByQuota: {
 *        '2400': [ { name, tag, fame, role }, ... ],
 *        '2600': [...],
 *        '2800': [...]
 *     }
 *   }
 *
 * The clan member list is used to look up the role for each participant
 * (race log entries don't contain roles).
 *
 * @param {string} clanTag  Clan tag (with or without '#')
 * @param {object[]} members  Array of clan member objects as returned by
 *                            /clans/:tag/members endpoint (contains role).
 * @param {number[]} quotas   Fame thresholds to evaluate (defaults to
 *                            [2400,2600,2800]).
 * @returns {Promise<{quotas:number[],playersByQuota:Record<string,object[]>}>}
 */
export async function computeTopPlayers(clanTag, members, quotas = [2400, 2600, 2800], raceLog = null) {
  // utilise le raceLog fourni si disponible, sinon le charge (compatibilité)
  let races = raceLog;
  if (!races) {
    try {
      races = await fetchRaceLog(clanTag);
    } catch (err) {
      console.warn(`topPlayers: failed to fetch race log for ${clanTag}:`, err.message);
      return { quotas, playersByQuota: {} };
    }
  }
  if (!Array.isArray(races) || races.length === 0) {
    return { quotas, playersByQuota: {} };
  }

  const lastRace = races[0];
  if (!lastRace || !Array.isArray(lastRace.standings)) {
    return { quotas, playersByQuota: {} };
  }

  const standing = lastRace.standings.find((s) => s.clan?.tag === (clanTag.startsWith('#') ? clanTag : `#${clanTag}`));
  if (!standing || !standing.clan?.participants) {
    return { quotas, playersByQuota: {} };
  }

  const participants = standing.clan.participants;
  const playersByQuota = {};
  quotas.forEach((q) => {
    playersByQuota[q] = participants
      .filter((p) => (p.fame || 0) >= q)
      .map((p) => {
        const member = members.find((m) => m.tag === p.tag);
        return {
          name: p.name || '',
          tag: p.tag,
          fame: p.fame || 0,
          role: member ? member.role || 'member' : 'member',
        };
      });
  });

  return { quotas, playersByQuota };
}
