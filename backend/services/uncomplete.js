// ============================================================
// uncomplete.js — Helper for listing players who did not complete
// 16 decks in the most recent River Race. Used by the clan analysis route.
// ============================================================

import { fetchRaceLog } from './clashApi.js';

/**
 * Return a list of players in the given clan who recorded fewer than 16
 * decks during the last completed River Race week.
 *
 * @param {string} clanTag  Clan tag (with or without '#')
 * @param {object[]} members  Array of clan member objects as returned by
 *                            /clans/:tag/members endpoint (contains role).
 * @returns {Promise<{ players: {name:string,tag:string,role:string,decks:number}[] }>} 
 */
export async function computeUncomplete(clanTag, members) {
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
      return {
        name: p.name || '',
        tag: p.tag,
        decks: p.decksUsed || 0,
        role: member ? member.role || 'member' : 'member',
      };
    });

  return { players: uncompletePlayers };
}
