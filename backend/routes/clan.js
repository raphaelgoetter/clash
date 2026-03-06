// ============================================================
// routes/clan.js — Clan-related API routes
// ============================================================

import { Router } from 'express';
import { fetchClan, fetchClanMembers, fetchRaceLog, fetchBattleLog } from '../services/clashApi.js';
import {
  analyzeClanMembers, buildWarHistory, computeWarScore,
  computeWarReliabilityFallback, categorizeBattleLog,
  filterWarBattles, expandDuelRounds,
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

    // First pass: compute war scores for all members from race log
    const firstPass = members.map((m) => {
      const playerProxy = { bestTrophies: m.trophies ?? 0, donations: m.donations ?? 0 };

      if (raceLog) {
        const wh = buildWarHistory(m.tag, raceLog, clan.tag);
        if (wh.weeks.length > 0) {
          // Historical data available — same scoring as player tab
          const ws = computeWarScore(playerProxy, wh);
          return { m, activityScore: ws.pct, verdict: ws.verdict, color: ws.color, needsBattleLog: false };
        }
        // New member: no weeks in the last 10 races → will need battle log
        return { m, activityScore: null, verdict: null, color: null, needsBattleLog: true };
      }

      // No race log at all — legacy trophies-based estimate
      const donPart = Math.min(40, ((m.donations ?? 0) / 300) * 40);
      const trPart  = Math.min(40, ((m.trophies ?? 0) / 10000) * 40);
      const expPart = Math.min(20, ((m.expLevel ?? 1) / 60) * 20);
      const score   = Math.round(donPart + trPart + expPart);
      return {
        m, activityScore: score,
        verdict: score >= 70 ? 'Fiabilité très élevée en guerre de clans'
               : score >= 40 ? 'Fiabilité correcte — à surveiller'
               :               'Risque élevé d\'inactivité en GDC',
        color: score >= 70 ? 'green' : score >= 40 ? 'yellow' : 'red',
        needsBattleLog: false,
      };
    });

    // Second pass: fetch battle logs in parallel for new members
    const newMemberIndices = firstPass.reduce((acc, entry, i) => {
      if (entry.needsBattleLog) acc.push(i);
      return acc;
    }, []);

    if (newMemberIndices.length > 0) {
      const battleLogResults = await Promise.allSettled(
        newMemberIndices.map((i) => fetchBattleLog(firstPass[i].m.tag))
      );
      battleLogResults.forEach((result, idx) => {
        const i = newMemberIndices[idx];
        const { m } = firstPass[i];
        const playerProxy = { bestTrophies: m.trophies ?? 0, donations: m.donations ?? 0 };
        if (result.status === 'fulfilled') {
          const rawBattleLog  = result.value;
          const bd            = categorizeBattleLog(rawBattleLog);
          const warLog        = expandDuelRounds(filterWarBattles(rawBattleLog));
          const ws            = computeWarReliabilityFallback(playerProxy, warLog, bd);
          firstPass[i].activityScore = ws.pct;
          firstPass[i].verdict       = ws.verdict;
          firstPass[i].color         = ws.color;
        } else {
          // Battle log fetch failed: minimal score from trophies+donations only
          const pct = Math.round((Math.min(5, (playerProxy.donations / 500) * 5) / 30) * 100);
          firstPass[i].activityScore = pct;
          firstPass[i].verdict       = 'Risque élevé d\'inactivité en GDC';
          firstPass[i].color         = 'red';
        }
      });
    }

    const analyzedMembers = firstPass.map(({ m, activityScore, verdict, color }) => ({
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
    }));

    // Sort by activityScore ascending (most at-risk first)
    analyzedMembers.sort((a, b) => a.activityScore - b.activityScore);

    // Aggregate stats for chart data
    const green = analyzedMembers.filter((m) => m.color === 'green').length;
    const yellow = analyzedMembers.filter((m) => m.color === 'yellow').length;
    const red = analyzedMembers.filter((m) => m.color === 'red').length;
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
      summary: { green, yellow, red, avgScore, total: analyzedMembers.length },
    });
  } catch (err) {
    const status = err.message.includes('404') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
