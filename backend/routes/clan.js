// ============================================================
// routes/clan.js — Clan-related API routes
// ============================================================

import { Router } from 'express';
import { fetchClan, fetchClanMembers, fetchRaceLog } from '../services/clashApi.js';
import { analyzeClanMembers, buildWarHistory, computeWarScore } from '../services/analysisService.js';

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

    const analyzedMembers = members.map((m) => {
      let activityScore, verdict, color;

      if (raceLog) {
        // Reuse the same scoring as the player tab
        const wh = buildWarHistory(m.tag, raceLog, clan.tag);
        // bestTrophies not available from /members — use current trophies as proxy
        const playerProxy = { bestTrophies: m.trophies ?? 0, donations: m.donations ?? 0 };
        const ws = computeWarScore(playerProxy, wh);
        activityScore = ws.pct;
        verdict       = ws.verdict;
        color         = ws.color;
      } else {
        // Legacy fallback (no race log)
        const base = m.donations ?? 0;
        const trophies = m.trophies ?? 0;
        const expLevel = m.expLevel ?? 1;
        const donPart = Math.min(40, (base / 300) * 40);
        const trPart  = Math.min(40, (trophies / 10000) * 40);
        const expPart = Math.min(20, (expLevel / 60) * 20);
        activityScore = Math.round(donPart + trPart + expPart);
        verdict = activityScore >= 70 ? 'Fiabilité très élevée en guerre de clans'
                : activityScore >= 40 ? 'Fiabilité correcte — à surveiller'
                :                       'Risque élevé d\'inactivité en GDC';
        color = activityScore >= 70 ? 'green' : activityScore >= 40 ? 'yellow' : 'red';
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
