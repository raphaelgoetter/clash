// ============================================================
// warHistory.js — Construction de l'historique hebdomadaire de
// River Race depuis les logs de course (clan + famille).
// ============================================================

import { getOrSet } from "./cache.js";
import { fetchRaceLog } from "./clashApi.js";
import { estimateWinsFromFame } from "./warScoring.js";
import { computeCurrentWeekId } from "./dateUtils.js";

const CLAN_RACELOG_CONCURRENCY = 3;
const CLAN_RACELOG_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes
export const FAMILY_CLAN_TAGS = ["Y8JUPC9C", "LRQP20V9", "QU9UQJRL"];

// ── Helpers privés ────────────────────────────────────────────

async function fetchRaceLogCached(clanTag) {
  if (!clanTag) throw new Error("clanTag is required");
  const normalized = clanTag.replace(/^#/, "").toUpperCase();
  const key = `raceLog:${normalized}`;
  const { value } = await getOrSet(
    key,
    () => fetchRaceLog(normalized),
    CLAN_RACELOG_CACHE_TTL_MS,
  );
  return value;
}

async function fetchRaceLogsForClans(clanTags) {
  const normalizedTags = [
    ...new Set(
      (Array.isArray(clanTags) ? clanTags : [...(clanTags || [])])
        .map((t) => (t || "").replace(/^#/, "").toUpperCase())
        .filter(Boolean),
    ),
  ];

  const queue = normalizedTags.slice();
  const results = [];

  const workers = Array.from(
    { length: Math.min(CLAN_RACELOG_CONCURRENCY, queue.length) },
    async () => {
      while (queue.length > 0) {
        const clanTag = queue.shift();
        try {
          const raceLog = await fetchRaceLogCached(clanTag);
          results.push({ clanTag, raceLog });
        } catch (err) {
          results.push({ clanTag, raceLog: null, error: err });
        }
      }
    },
  );

  await Promise.all(workers);
  return results;
}

// ── Exports publics ───────────────────────────────────────────

/**
 * Extract a player's week-by-week river race history from a clan race log.
 *
 * @param {string}   playerTag        Player tag (with or without #)
 * @param {object[]} raceLog          Array returned by /clans/{tag}/riverracelog
 * @param {string}   [currentClanTag] Tag of the player's current clan (to compute streak)
 * @param {object}   [currentRace]    Optional current race object from /currentriverrace
 */
export function buildWarHistory(
  playerTag,
  raceLog,
  currentClanTag = null,
  currentRace = null,
) {
  const normalized = playerTag.startsWith("#") ? playerTag : `#${playerTag}`;
  const normClan = currentClanTag
    ? currentClanTag.startsWith("#")
      ? currentClanTag
      : `#${currentClanTag}`
    : null;
  const weeks = [];

  for (const race of raceLog) {
    for (const standing of race.standings ?? []) {
      const p = standing.clan?.participants?.find((x) => x.tag === normalized);
      if (p) {
        weeks.push({
          label: `S${race.seasonId}·W${race.sectionIndex + 1}`,
          seasonId: race.seasonId,
          sectionIndex: race.sectionIndex,
          fame: p.fame ?? 0,
          decksUsed: p.decksUsed ?? 0,
          boatAttacks: p.boatAttacks ?? 0,
          clanTag: standing.clan.tag,
          clanName: standing.clan.name ?? standing.clan.tag,
          sourceKind: "clanRaceLog",
        });
        break;
      }
    }
  }

  // Prépend la race en cours si le joueur y figure.
  // /currentriverrace expose .clan.participants[] directement (pas standings[]).
  // seasonId absent de currentriverrace → on le déduit via computeCurrentWeekId.
  if (currentRace?.clan?.participants) {
    const p = currentRace.clan.participants.find((x) => x.tag === normalized);
    if (p) {
      const liveWeekId = computeCurrentWeekId(currentRace, raceLog); // ex. "S130W5"
      const liveLabel = liveWeekId
        ? `${liveWeekId.replace("W", "·W")} (live)`
        : `S?·W${(currentRace.sectionIndex ?? 0) + 1} (live)`;
      const liveSeasonId = liveWeekId
        ? Number(liveWeekId.match(/^S(\d+)/)?.[1])
        : (currentRace.seasonId ?? null);
      weeks.unshift({
        label: liveLabel,
        seasonId: liveSeasonId,
        sectionIndex: currentRace.sectionIndex ?? 0,
        fame: p.fame ?? 0,
        decksUsed: p.decksUsed ?? 0,
        boatAttacks: p.boatAttacks ?? 0,
        clanTag: currentRace.clan.tag,
        clanName: currentRace.clan.name ?? currentRace.clan.tag,
        isCurrent: true,
        sourceKind: "currentRaceLog",
      });
    }
  }

  // Semaines consécutives dans le clan actuel (du plus récent vers le plus ancien).
  // La semaine en cours (isCurrent) est exclue car incomplète.
  let streakInCurrentClan = 0;
  if (normClan) {
    for (const w of weeks) {
      if (w.isCurrent) continue;
      if (w.clanTag === normClan) streakInCurrentClan++;
      else break;
    }
  }

  const weeksPlayed = weeks.filter((w) => w.decksUsed > 0);
  const totalFame = weeksPlayed.reduce((s, w) => s + w.fame, 0);
  const participation = weeksPlayed.length;
  const totalWeeks = raceLog.length;
  const avgFame = participation ? Math.round(totalFame / participation) : 0;
  const maxFame = weeksPlayed.reduce((m, w) => Math.max(m, w.fame), 0);

  // Win rate historique estimé depuis la fame (semaines terminées uniquement)
  const MIN_PVP_DECKS = 5;
  const completedWeeks = weeksPlayed.filter((w) => !w.isCurrent);
  const completedParticipation = completedWeeks.length;
  let totalPvpDecks = 0,
    totalEstimatedWins = 0;
  for (const w of completedWeeks) {
    const { wins: wWins, pvpDecks: wPvp } = estimateWinsFromFame(
      w.fame,
      w.decksUsed,
      w.boatAttacks,
    );
    totalPvpDecks += wPvp;
    totalEstimatedWins += wWins;
  }
  const historicalWinRate =
    totalPvpDecks >= MIN_PVP_DECKS ? totalEstimatedWins / totalPvpDecks : null;

  return {
    weeks,
    totalFame,
    avgFame,
    maxFame,
    participation,
    completedParticipation,
    totalWeeks,
    streakInCurrentClan,
    historicalWinRate,
  };
}

/**
 * Build a merged war history from known clan logs, including current clan and family clans.
 * Allows showing weeks from previous clan(s) for transferred players.
 */
export async function buildFamilyWarHistory(
  playerTag,
  currentClanTag,
  currentRace = null,
  battleLog = [],
) {
  const normalizedCurrent = currentClanTag
    ? currentClanTag.replace(/^#/, "").toUpperCase()
    : null;
  const clanTags = new Set(FAMILY_CLAN_TAGS);
  if (normalizedCurrent) clanTags.add(normalizedCurrent);

  for (const b of battleLog) {
    const clanTag = b?.team?.[0]?.clan?.tag;
    if (clanTag) {
      const clean = clanTag.replace(/^#/, "").toUpperCase();
      if (clean) clanTags.add(clean);
    }
  }

  const weekMap = new Map();

  const results = await fetchRaceLogsForClans(clanTags);
  for (const entry of results) {
    if (!entry.raceLog) continue;
    const history = buildWarHistory(
      playerTag,
      entry.raceLog,
      `#${entry.clanTag}`,
      normalizedCurrent === entry.clanTag ? currentRace : null,
    );
    for (const week of history.weeks) {
      const key = `${week.seasonId ?? "unknown"}_${week.sectionIndex ?? "unknown"}_${week.clanTag ?? "unknown"}_${week.isCurrent ? "current" : "past"}`;
      if (!weekMap.has(key)) {
        weekMap.set(key, week);
      }
    }
  }

  let mergedWeeks = [...weekMap.values()];

  mergedWeeks.sort((a, b) => {
    if (a.isCurrent && !b.isCurrent) return -1;
    if (b.isCurrent && !a.isCurrent) return 1;
    const seasonA = Number(a.seasonId) || 0;
    const seasonB = Number(b.seasonId) || 0;
    if (seasonA !== seasonB) return seasonB - seasonA;
    const secA = Number(a.sectionIndex) || 0;
    const secB = Number(b.sectionIndex) || 0;
    return secB - secA;
  });

  // Déduplique par semaine (saison+section). Garde la ligne avec le plus de decks.
  const weekSelector = new Map();
  for (const week of mergedWeeks) {
    const weekKey = `${week.seasonId ?? week.label ?? ""}:${week.sectionIndex ?? ""}`;
    const existing = weekSelector.get(weekKey);
    if (!existing) {
      weekSelector.set(weekKey, week);
      continue;
    }

    const existingDecks = Number(existing.decksUsed) || 0;
    const candidateDecks = Number(week.decksUsed) || 0;

    let winner = existing;
    if (week.isCurrent && !existing.isCurrent) winner = week;
    else if (!week.isCurrent && existing.isCurrent) winner = existing;
    else if (candidateDecks > existingDecks) winner = week;
    else if (candidateDecks < existingDecks) winner = existing;
    else {
      const existingTag = (existing.clanTag || "")
        .replace(/^#/, "")
        .toUpperCase();
      const candidateTag = (week.clanTag || "").replace(/^#/, "").toUpperCase();
      if (
        existingTag === normalizedCurrent &&
        candidateTag !== normalizedCurrent
      )
        winner = week;
      else if (
        candidateTag === normalizedCurrent &&
        existingTag !== normalizedCurrent
      )
        winner = existing;
    }

    weekSelector.set(weekKey, winner);
  }

  mergedWeeks = [...weekSelector.values()];

  const playedWeeks = mergedWeeks.filter((w) => w.decksUsed > 0);
  const totalFame = playedWeeks.reduce((sum, w) => sum + (w.fame || 0), 0);
  const participation = playedWeeks.length;
  const completedParticipation = mergedWeeks.filter(
    (w) => !w.isCurrent && (w.decksUsed || 0) > 0,
  ).length;
  const totalWeeks = mergedWeeks.length;

  let streakInCurrentClan = 0;
  let streakInFamily = 0;
  const currentTag = normalizedCurrent ? `#${normalizedCurrent}` : null;
  const familyTags = new Set(
    FAMILY_CLAN_TAGS.map((t) => t.replace(/^#/, "").toUpperCase()),
  );
  if (normalizedCurrent) familyTags.add(normalizedCurrent);
  for (const w of mergedWeeks) {
    if (w.isCurrent) continue;
    const normalizedWeekTag = (w.clanTag ?? "").replace(/^#/, "").toUpperCase();
    if (w.clanTag === currentTag) streakInCurrentClan += 1;
    if (familyTags.has(normalizedWeekTag)) streakInFamily += 1;
    if (!familyTags.has(normalizedWeekTag)) break;
  }

  const avgFame = participation ? Math.round(totalFame / participation) : 0;
  const maxFame = playedWeeks.reduce((m, w) => Math.max(m, w.fame || 0), 0);

  const MIN_PVP_DECKS = 5;
  let totalPvpDecks = 0;
  let totalEstimatedWins = 0;
  for (const w of mergedWeeks.filter(
    (w) => !w.isCurrent && (w.decksUsed || 0) > 0,
  )) {
    const { wins, pvpDecks } = estimateWinsFromFame(
      w.fame,
      w.decksUsed,
      w.boatAttacks,
    );
    totalPvpDecks += pvpDecks;
    totalEstimatedWins += wins;
  }
  const historicalWinRate =
    totalPvpDecks >= MIN_PVP_DECKS ? totalEstimatedWins / totalPvpDecks : null;

  const noFurtherData = mergedWeeks.length === 1 && mergedWeeks[0]?.isCurrent;

  return {
    weeks: mergedWeeks,
    totalFame,
    avgFame,
    maxFame,
    participation,
    completedParticipation,
    totalWeeks,
    streakInCurrentClan,
    streakInFamily,
    historicalWinRate,
    noFurtherData,
  };
}

/**
 * Si la semaine la plus ancienne de prevWeeks a < 16 decks, la marque ignorée
 * et recalcule les métriques résumées de wh en excluant cette semaine.
 * Mute wh en place. Retourne true si une semaine a été ignorée, false sinon.
 *
 * @param {object}   wh        Objet warHistory (muté en place)
 * @param {object[]} prevWeeks Semaines passées (filtrées : !isCurrent)
 * @returns {boolean}
 */
export function applyOldestWeekIgnore(wh, prevWeeks) {
  if (prevWeeks.length < 2) return false;
  const oldest = prevWeeks[prevWeeks.length - 1];
  if ((oldest.decksUsed ?? 0) >= 16) return false;

  oldest.ignored = true;

  const kept = wh.weeks.filter((w) => !w.ignored && (w.decksUsed ?? 0) > 0);
  const totalFame = kept.reduce((s, w) => s + (w.fame || 0), 0);
  wh.totalFame = totalFame;
  wh.participation = kept.length;
  wh.avgFame = kept.length ? Math.round(totalFame / kept.length) : 0;
  wh.maxFame = kept.reduce((mx, w) => Math.max(mx, w.fame || 0), 0);
  wh.completedParticipation = kept.filter((w) => !w.isCurrent).length;

  const MIN_PVP_DECKS = 5;
  let totalPvpDecks = 0,
    totalEstimatedWins = 0;
  for (const w of kept.filter((w) => !w.isCurrent)) {
    const { wins: wWins, pvpDecks: wPvp } = estimateWinsFromFame(
      w.fame,
      w.decksUsed,
      w.boatAttacks,
    );
    totalPvpDecks += wPvp;
    totalEstimatedWins += wWins;
  }
  wh.historicalWinRate =
    totalPvpDecks >= MIN_PVP_DECKS ? totalEstimatedWins / totalPvpDecks : null;

  return true;
}
