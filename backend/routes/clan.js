// ============================================================
// routes/clan.js — Clan-related API routes
// ============================================================

import { Router } from 'express';
import { fetchClan, fetchClanMembers, fetchRaceLog, fetchBattleLog } from '../services/clashApi.js';
import {
  analyzeClanMembers, buildWarHistory, computeWarScore,
  computeWarReliabilityFallback, categorizeBattleLog,
  filterWarBattles, expandDuelRounds, isWarWin,
} from '../services/analysisService.js';

const router = Router();

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
    const [clan, members] = await Promise.all([
      fetchClan(clanTag),
      fetchClanMembers(clanTag),
    ]);

    // Fetch race log once and compute war-based scores for every member.
    // Fall back to the legacy activity score for members absent from the log.
    let raceLog = null;
    try { raceLog = await fetchRaceLog(clanTag); } catch (_) { /* silent */ }

    // Fetch battle logs for ALL members in parallel to get GDC win rates
    // (used both for established members' win rate criterion and fallback scoring for new members)
    const battleLogResults = raceLog
      ? await Promise.allSettled(members.map((m) => fetchBattleLog(m.tag)))
      : [];

    // First pass: compute war scores for all members
    const analyzedMembers = members.map((m, idx) => {
      const playerProxy = { bestTrophies: m.trophies ?? 0, donations: m.donations ?? 0 };
      let activityScore, verdict, color;

      if (raceLog) {
        const wh = buildWarHistory(m.tag, raceLog, clan.tag);

        // Compute GDC win rate from battle log when available
        let warWinRate = null;
        const blResult = battleLogResults[idx];
        if (blResult?.status === 'fulfilled') {
          const rawWarLog = expandDuelRounds(filterWarBattles(blResult.value));
          if (rawWarLog.length > 0) {
            const wins = rawWarLog.filter(isWarWin).length;
            warWinRate = wins / rawWarLog.length;
          }
        }

        if (wh.weeks.length > 0) {
          // Historical data — computeWarScore + win rate as 6th criterion
          const ws = computeWarScore(playerProxy, wh, warWinRate);
          activityScore = ws.pct; verdict = ws.verdict; color = ws.color;
        } else if (blResult?.status === 'fulfilled') {
          // New member — full fallback with battle log
          const rawBattleLog = blResult.value;
          const bd           = categorizeBattleLog(rawBattleLog);
          const warLog       = expandDuelRounds(filterWarBattles(rawBattleLog));
          const ws           = computeWarReliabilityFallback(playerProxy, warLog, bd);
          activityScore = ws.pct; verdict = ws.verdict; color = ws.color;
        } else {
          // Battle log unavailable — minimal estimate
          const pct = Math.round((Math.min(2, (playerProxy.donations / 500) * 2) / 30) * 100);
          activityScore = pct; verdict = 'Extreme risk'; color = 'red';
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

    res.json({
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
    });
  } catch (err) {
    const status = err.message.includes('404') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
