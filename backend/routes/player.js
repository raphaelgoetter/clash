// ============================================================
// routes/player.js — Player-related API routes
// ============================================================

import { Router } from 'express';
import { fetchPlayer, fetchBattleLog, fetchRaceLog } from '../services/clashApi.js';
import {
  analyzePlayer, buildWarHistory, computeWarScore,
  filterWarBattles, expandDuelRounds, isWarWin,
} from '../services/analysisService.js';

const router = Router();

/**
 * GET /api/player/:tag
 * Returns raw player profile from the Clash Royale API.
 */
router.get('/:tag', async (req, res) => {
  try {
    const player = await fetchPlayer(req.params.tag);
    res.json(player);
  } catch (err) {
    const status = err.message.includes('404') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/player/:tag/analysis
 * Returns computed reliability analysis for a player.
 */
router.get('/:tag/analysis', async (req, res) => {
  try {
    const [player, battleLog] = await Promise.all([
      fetchPlayer(req.params.tag),
      fetchBattleLog(req.params.tag),
    ]);

    const analysis = analyzePlayer(player, battleLog);

    // Enrich with river race history if the player is currently in a clan.
    // We silently ignore failures so a missing/private war log doesn't block the response.
    if (player.clan?.tag) {
      try {
        const raceLog = await fetchRaceLog(player.clan.tag);
        analysis.warHistory = buildWarHistory(player.tag, raceLog, player.clan.tag);

        // Compute GDC win rate from battle log (available for all players)
        const rawWarLog = expandDuelRounds(filterWarBattles(battleLog));
        const gdcWins   = rawWarLog.filter(isWarWin).length;
        const warWinRate = rawWarLog.length > 0 ? gdcWins / rawWarLog.length : null;

        if (analysis.warHistory.weeks.length > 0) {
          // Historical data available → score from river race history + win rate
          analysis.warScore = computeWarScore(player, analysis.warHistory, warWinRate);
        } else {
          // New member: no completed races found → use battle log fallback
          analysis.warScore = analysis.reliability;
        }
      } catch (_) {
        analysis.warHistory = null;
        analysis.warScore   = analysis.reliability; // fallback
      }
    } else {
      analysis.warHistory = null;
      analysis.warScore   = analysis.reliability; // fallback
    }

    res.json(analysis);
  } catch (err) {
    const status = err.message.includes('404') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
