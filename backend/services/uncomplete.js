// ============================================================
// uncomplete.js — Helper for listing players who did not complete
// 16 decks in the most recent River Race. Used by the clan analysis route.
// ============================================================

import { fetchRaceLog } from './clashApi.js';
import { filterWarBattles, expandDuelRounds, warDayKey } from './analysisService.js';

/**
 * Return a list of players in the given clan who recorded fewer than 16
 * decks during the last completed River Race week.
 *
 * @param {string} clanTag  Clan tag (with or without '#')
 * @param {object[]} members  Array of clan member objects as returned by
 *                            /clans/:tag/members endpoint (contains role).
 * @param {Object<string,object[]>} [battleLogsByTag] Optional map of player
 *                            tags to their raw battle log (used to compute
 *                            per-day deck breakdown). If omitted, only the
 *                            total decks count will be included.
 * @returns {Promise<{ players: {name:string,tag:string,role:string,decks:number,inClan:boolean,daily?:object}[] }>} 
 */
export async function computeUncomplete(clanTag, members, battleLogsByTag = {}) {
  const races = await fetchRaceLog(clanTag);
  if (!Array.isArray(races) || races.length === 0) {
    return { players: [] };
  }

  const lastRace = races[0];
  if (!lastRace || !Array.isArray(lastRace.standings)) {
    return { players: [] };
  }

  const normalizedTag = clanTag.startsWith('#') ? clanTag : `#${clanTag}`;
  const standing = lastRace.standings.find((s) => s.clan?.tag === normalizedTag);
  if (!standing || !standing.clan?.participants) {
    return { players: [] };
  }

  const participants = standing.clan.participants;
  const uncompletePlayers = participants
    .filter((p) => (p.decksUsed || 0) < 16)
    .map((p) => {
      const member = members.find((m) => m.tag === p.tag);
      const base = {
        name: p.name || '',
        tag: p.tag,
        decks: p.decksUsed || 0,
        role: member ? member.role || 'member' : 'member',
        inClan: !!member,
      };
      // compute per-day counts if battle log available
      const log = battleLogsByTag[p.tag];
      if (log && Array.isArray(log)) {
        const warLog = expandDuelRounds(filterWarBattles(log));
        const counts = {};
        for (const b of warLog) {
          const key = warDayKey(b.battleTime);
          counts[key] = (counts[key] || 0) + 1;
        }
        // keep only 4 most recent war days and cap at 4 decks per day
        const keys = Object.keys(counts).sort((a,b)=> b.localeCompare(a));
        const kept = {};
        keys.slice(0,4).forEach((k) => {
          kept[k] = Math.min(counts[k], 4);
        });
        base.daily = kept;
      }
      return base;
    });

  return { players: uncompletePlayers };
}
