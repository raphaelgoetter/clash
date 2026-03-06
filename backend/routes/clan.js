// ============================================================
// routes/clan.js — Clan-related API routes
// ============================================================

import { Router } from 'express';
import { fetchClan, fetchClanMembers } from '../services/clashApi.js';
import { analyzeClanMembers } from '../services/analysisService.js';

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
    const [clan, members] = await Promise.all([
      fetchClan(req.params.tag),
      fetchClanMembers(req.params.tag),
    ]);

    const analyzedMembers = analyzeClanMembers(members);

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
