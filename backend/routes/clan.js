// ============================================================
// routes/clan.js — Clan-related API routes
// ============================================================

import { Router } from 'express';
import { fetchClan, fetchClanMembers, fetchRaceLog, fetchBattleLog, fetchPlayer, fetchCurrentRace } from '../services/clashApi.js';
import {
  analyzeClanMembers, buildWarHistory, computeWarScore,
  computeWarReliabilityFallback, categorizeBattleLog,
  filterWarBattles, expandDuelRounds, isWarWin, buildCurrentWarDays,
} from '../services/analysisService.js';
import { computeTopPlayers } from '../services/topplayers.js';
import { computeUncomplete } from '../services/uncomplete.js';
import { getOrSet } from '../services/cache.js';

const CLAN_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

const router = Router();

/**
 * Run async tasks with limited concurrency to avoid rate-limiting.
 * Returns an array of { status, value } | { status, reason } mirroring Promise.allSettled.
 */
async function pooledAllSettled(tasks, concurrency = 8) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

/**
 * GET /api/clan/:tag
 * Returns raw clan profile from the Clash Royale API.
 */
router.get('/:tag', async (req, res) => {
  try {
    const clan = await fetchClan(req.params.tag);
    res.json(clan);
  } catch (err) {
    const status = err.message.includes('404') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/clan/:tag/analysis
 * Returns clan profile + enriched member list with activity scores.
 */
router.get('/:tag/analysis', async (req, res) => {
  try {
    const clanTag = req.params.tag;
    const { value: payload, fromCache } = await getOrSet(
      `clan:analysis:${clanTag}`,
      () => buildClanAnalysis(clanTag),
      CLAN_CACHE_TTL,
    );
    res.set('X-Cache', fromCache ? 'HIT' : 'MISS');
    res.json(payload);
  } catch (err) {
    const status = err.message.includes('404') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

export async function buildClanAnalysis(clanTag) {
    const [clan, members] = await Promise.all([
      fetchClan(clanTag),
      fetchClanMembers(clanTag),
    ]);

    // Fetch race log once and compute war-based scores for every member.
    // Fall back to the legacy activity score for members absent from the log.
    let raceLog = null;
    let currentRace = null;
    try {
      [raceLog, currentRace] = await Promise.all([
        fetchRaceLog(clanTag),
        fetchCurrentRace(clanTag).catch(() => null),
      ]);
    } catch (_) { /* silent */ }

    // compute top players for a few predefined fame quotas so the frontend
    // can render the "Last War Best Players" card without additional
    // network requests. the helper gracefully handles missing logs.
    const topPlayers = await computeTopPlayers(clanTag, members);
    // compute list of players who didn't do the full 16 decks last week
    const uncomplete = await computeUncomplete(clanTag, members);

    // Fetch full player profiles + battle logs for ALL members with capped concurrency
    // (avoids RoyaleAPI rate-limiting that caused non-deterministic scores on reload)
    const memberDataResults = raceLog
      ? await pooledAllSettled(
          members.map((m) => () => Promise.all([fetchPlayer(m.tag), fetchBattleLog(m.tag)]))
        )
      : [];

    // First pass: compute war scores for all members
    const analyzedMembers = members.map((m, idx) => {
      let activityScore, verdict, color, isNew = false, warHistory = null;

      // Resolve full player profile (for badges) and battle log
      const mdResult    = memberDataResults[idx];
      const fullPlayer  = mdResult?.status === 'fulfilled' ? mdResult.value[0] : null;
      const battleLog   = mdResult?.status === 'fulfilled' ? mdResult.value[1] : null;

      // Player proxy: prefer full profile (has badges), fall back to member data
      const playerProxy = fullPlayer ?? { bestTrophies: m.trophies ?? 0, donations: m.donations ?? 0 };

      if (raceLog) {
        const wh = buildWarHistory(m.tag, raceLog, clan.tag, currentRace);
        warHistory = wh;

        // Compute GDC win rate from battle log when available
        let warWinRate = null;
        if (battleLog) {
          const rawWarLog = expandDuelRounds(filterWarBattles(battleLog));
          if (rawWarLog.length > 0) {
            const wins = rawWarLog.filter(isWarWin).length;
            warWinRate = wins / rawWarLog.length;
          }
        }

        // Determine whether warHistory alone is sufficient. We want to
        // grant full scores when the player has either a full 16-deck week
        // in the past or the old rule of ≥2 completed weeks in the clan.
        const prevWeeks = wh.weeks.filter((w) => !w.isCurrent);
        const hasFullWeek = prevWeeks.some((w) => (w.decksUsed ?? 0) >= 16);
        const oldRule = wh.streakInCurrentClan >= 2 && wh.completedParticipation >= 2;
        let hasEnoughHistory = hasFullWeek || oldRule;

        // same mid‑race arrival handling as player view (ignore oldest incomplete)
        if (!hasFullWeek && prevWeeks.length >= 2 && (prevWeeks[0].decksUsed ?? 0) < 16) {
          wh.weeks = wh.weeks.slice(1);
          hasEnoughHistory = true;
        }

        if (hasEnoughHistory) {
          // Historical data — computeWarScore + win rate historique (race log) en priorité
          const effectiveWinRate = wh.historicalWinRate ?? warWinRate;
          const ws = computeWarScore(playerProxy, wh, effectiveWinRate, m.lastSeen ?? null);
          activityScore = ws.pct; verdict = ws.verdict; color = ws.color;
        } else if (battleLog) {
          // New member — full fallback with battle log
          const bd     = categorizeBattleLog(battleLog);
          const warLog = expandDuelRounds(filterWarBattles(battleLog));
          const ws     = computeWarReliabilityFallback(playerProxy, warLog, bd, m.lastSeen ?? null);
          activityScore = ws.pct; verdict = ws.verdict; color = ws.color;
          isNew = true;
        } else {
          // Battle log unavailable — minimal estimate
          const pct = Math.round((Math.min(2, ((playerProxy.donations ?? 0) / 500) * 2) / 40) * 100);
          activityScore = pct; verdict = 'Extreme risk'; color = 'red';
          isNew = true;
        }

        // Ensure we don't flag long‑inactive members as "new" just because
        // they lack sufficient war history. 117d‑ago Mat proved that the
        // badge was misleading: require a recent login (≤7 days) before
        // showing the label. This threshold is intentionally simple – the
        // front‑end only renders the field supplied by the API.
        if (isNew && m.lastSeen) {
          const lastSeenDate = new Date(m.lastSeen.replace(
            /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/,
            '$1-$2-$3T$4:$5:$6.$7Z'
          ));
          const lastSeenDays = (Date.now() - lastSeenDate.getTime()) / (1000 * 60 * 60 * 24);
          if (lastSeenDays > 7) {
            isNew = false;
          }
        }
      } else {
        // No race log at all — legacy trophies-based estimate
        const donPart = Math.min(40, ((m.donations ?? 0) / 300) * 40);
        const trPart  = Math.min(40, ((m.trophies ?? 0) / 10000) * 40);
        const expPart = Math.min(20, ((m.expLevel ?? 1) / 60) * 20);
        const score   = Math.round(donPart + trPart + expPart);
        activityScore = score;
        verdict = score >= 76 ? 'High reliability'
                : score >= 61 ? 'Moderate risk'
                : score >= 31 ? 'High risk'
                :               'Extreme risk';
        color = score >= 76 ? 'green' : score >= 56 ? 'yellow' : score >= 31 ? 'orange' : 'red';
      }

      const warDays = (() => {
          if (battleLog === null) return null;
          const currentWeek = warHistory?.weeks?.find((w) => w.isCurrent) ?? null;
          const summary      = buildCurrentWarDays(battleLog, currentWeek?.decksUsed ?? null, {
            state:       currentRace?.state       ?? null,
            periodIndex: currentRace?.periodIndex ?? null,
          });
          if (
            summary &&
            summary.daysFromThu > 0 &&
            (warHistory?.streakInCurrentClan ?? 0) === 1 &&
            (currentWeek?.decksUsed ?? 0) === 0
          ) {
            summary.arrivedMidWar   = true;
            summary.arrivedOnDay    = summary.daysFromThu + 1;
            summary.totalDecksUsed  = 0;
            summary.isReliableTotal = true;
          }
          return summary;
        })();

      return {
        name:               m.name,
        tag:                m.tag,
        role:               m.role,
        trophies:           m.trophies ?? 0,
        donations:          m.donations ?? 0,
        donationsReceived:  m.donationsReceived ?? 0,
        expLevel:           m.expLevel ?? 1,
        activityScore,
        verdict,
        color,
        isNew,
        warDays,
        // Valeur numérique pour le tri de la colonne "This War"
        // -1 = arrivé en cours de semaine, null = hors période de guerre
        warDecks:  warDays === null ? null : (warDays.arrivedMidWar ? -1 : (warDays.totalDecksUsed ?? 0)),
        lastSeen:  m.lastSeen ?? null,
      };
    });

    // Sort by activityScore ascending (most at-risk first)
    analyzedMembers.sort((a, b) => a.activityScore - b.activityScore);

    // Aggregate stats for chart data
    const green  = analyzedMembers.filter((m) => m.color === 'green').length;
    const yellow  = analyzedMembers.filter((m) => m.color === 'yellow').length;
    const orange  = analyzedMembers.filter((m) => m.color === 'orange').length;
    const red     = analyzedMembers.filter((m) => m.color === 'red').length;
    const avgScore =
      analyzedMembers.length > 0
        ? Math.round(
            analyzedMembers.reduce((s, m) => s + m.activityScore, 0) /
              analyzedMembers.length
          )
        : 0;

    return {
      clan: {
        name: clan.name,
        tag: clan.tag,
        description: clan.description,
        clanScore: clan.clanScore,
        clanWarTrophies: clan.clanWarTrophies,
        members: clan.members,
        type: clan.type,
        requiredTrophies: clan.requiredTrophies,
        badge: clan.badgeId,
      },
      members: analyzedMembers,
      summary: { green, yellow, orange, red, avgScore, total: analyzedMembers.length },
      isWarPeriod: analyzedMembers.some((m) => m.warDays !== null),
      topPlayers,                    // added by computeTopPlayers
      uncomplete,                    // new list of incomplete deck players
    };
}

export { router as default };
