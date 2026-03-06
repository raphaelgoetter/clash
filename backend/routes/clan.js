// ============================================================
// routes/clan.js — Clan-related API routes
// ============================================================

import { Router } from 'express';
import { fetchClan, fetchClanMembers, fetchRaceLog, fetchBattleLog, fetchPlayer } from '../services/clashApi.js';
import {
  analyzeClanMembers, buildWarHistory, computeWarScore,
  computeWarReliabilityFallback, categorizeBattleLog,
  filterWarBattles, expandDuelRounds, isWarWin,
} from '../services/analysisService.js';
import { getOrSet } from '../services/cache.js';

const CLAN_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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

async function buildClanAnalysis(clanTag) {
    const [clan, members] = await Promise.all([
      fetchClan(clanTag),
      fetchClanMembers(clanTag),
    ]);

    // Fetch race log once and compute war-based scores for every member.
    // Fall back to the legacy activity score for members absent from the log.
    let raceLog = null;
    try { raceLog = await fetchRaceLog(clanTag); } catch (_) { /* silent */ }

    // Fetch full player profiles + battle logs for ALL members with capped concurrency
    // (avoids RoyaleAPI rate-limiting that caused non-deterministic scores on reload)
    const memberDataResults = raceLog
      ? await pooledAllSettled(
          members.map((m) => () => Promise.all([fetchPlayer(m.tag), fetchBattleLog(m.tag)]))
        )
      : [];

    // First pass: compute war scores for all members
    const analyzedMembers = members.map((m, idx) => {
      let activityScore, verdict, color, isNew = false;

      // Resolve full player profile (for badges) and battle log
      const mdResult    = memberDataResults[idx];
      const fullPlayer  = mdResult?.status === 'fulfilled' ? mdResult.value[0] : null;
      const battleLog   = mdResult?.status === 'fulfilled' ? mdResult.value[1] : null;

      // Player proxy: prefer full profile (has badges), fall back to member data
      const playerProxy = fullPlayer ?? { bestTrophies: m.trophies ?? 0, donations: m.donations ?? 0 };

      if (raceLog) {
        const wh = buildWarHistory(m.tag, raceLog, clan.tag);

        // Compute GDC win rate from battle log when available
        let warWinRate = null;
        if (battleLog) {
          const rawWarLog = expandDuelRounds(filterWarBattles(battleLog));
          if (rawWarLog.length > 0) {
            const wins = rawWarLog.filter(isWarWin).length;
            warWinRate = wins / rawWarLog.length;
          }
        }

        if (wh.weeks.length > 0) {
          // Historical data — computeWarScore + win rate as 6th criterion
          const ws = computeWarScore(playerProxy, wh, warWinRate);
          activityScore = ws.pct; verdict = ws.verdict; color = ws.color;
        } else if (battleLog) {
          // New member — full fallback with battle log
          const bd     = categorizeBattleLog(battleLog);
          const warLog = expandDuelRounds(filterWarBattles(battleLog));
          const ws     = computeWarReliabilityFallback(playerProxy, warLog, bd);
          activityScore = ws.pct; verdict = ws.verdict; color = ws.color;
          isNew = true;
        } else {
          // Battle log unavailable — minimal estimate
          const pct = Math.round((Math.min(2, ((playerProxy.donations ?? 0) / 500) * 2) / 40) * 100);
          activityScore = pct; verdict = 'Extreme risk'; color = 'red';
          isNew = true;
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
        color = score >= 76 ? 'green' : score >= 61 ? 'yellow' : score >= 31 ? 'orange' : 'red';
      }

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
    };
}

export default router;
