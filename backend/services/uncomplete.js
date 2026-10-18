// ============================================================
// uncomplete.js — Helper for listing players who did not complete
// all counted decks (16, or fewer when the finish line was crossed before
// day 4) in the most recent River Race. Used by the clan analysis route.
// ============================================================

import { fetchRaceLog } from './clashApi.js';
import { filterWarBattles, expandDuelRounds } from './battleLogUtils.js';
import { warDayKey } from './dateUtils.js';
import { countedWarDaysFromRaceLog, DECKS_PER_WAR_DAY } from './warStandings.js';

/**
 * Return a list of players in the given clan who recorded fewer than the
 * counted decks (`maxDecks`) during the last completed River Race week.
 *
 * @param {string} clanTag  Clan tag (with or without '#')
 * @param {object[]} members  Array of clan member objects as returned by
 *                            /clans/:tag/members endpoint (contains role).
 * @param {Object<string,object[]>} [battleLogsByTag] Optional map of player
 *                            tags to their raw battle log (used to compute
 *                            per-day deck breakdown). If omitted, only the
 *                            total decks count will be included.
 * @returns {Promise<{ maxDecks: number, players: {name:string,tag:string,role:string,decks:number,inClan:boolean,daily?:object}[] }>}
 */
export async function computeUncomplete(clanTag, members, battleLogsByTag = {}, raceLog = null) {
  // utilise le raceLog fourni si disponible, sinon le charge (compatibilité)
  let races = raceLog;
  if (!races) {
    try {
      races = await fetchRaceLog(clanTag);
    } catch (err) {
      console.warn(`uncomplete: failed to fetch race log for ${clanTag}:`, err.message);
      return { players: [] };
    }
  }
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

  // Ligne d'arrivée franchie avant le J4 : les journées suivantes ne
  // rapportent aucun point et ne sont donc pas attendues (12 decks, etc.).
  const maxDecks =
    countedWarDaysFromRaceLog(standing.clan, lastRace.createdDate) *
    DECKS_PER_WAR_DAY;
  const participants = standing.clan.participants;
  const uncompletePlayers = participants
    .filter((p) => (p.decksUsed || 0) < maxDecks)
    .map((p) => {
      const member = members.find((m) => m.tag === p.tag);
      const base = {
        name: p.name || '',
        tag: p.tag,
        decks: p.decksUsed || 0,
        role: member ? member.role || 'member' : 'member',
        inClan: !!member,
      };
      // NOTE: daily breakdown is now provided exclusively by snapshots.
      // we intentionally ignore any battle log data to avoid misleading
      // figures. the snapshot override step in routes/clan.js will later
      // fill in `daily` when records are available (and mark
      // `dailySource` accordingly).
      // (battleLog argument is kept for compatibility but not used.)
      return base;
    });

  // Membres actuels du clan absents de standing.clan.participants : ils ont
  // rejoint trop tard pour que Supercell les inclue dans le participants[]
  // de cette semaine de course. Sans ce complément, ils seraient invisibles
  // des listes de fail/oublis alors qu'ils n'ont mécaniquement pas pu jouer.
  const participantTags = new Set(participants.map((p) => p.tag));
  const lateArrivals = members
    .filter((m) => m.tag && !participantTags.has(m.tag))
    .map((m) => ({
      name: m.name || '',
      tag: m.tag,
      decks: 0,
      role: m.role || 'member',
      inClan: true,
      lateArrival: true,
    }));

  return { maxDecks, players: [...uncompletePlayers, ...lateArrivals] };
}
