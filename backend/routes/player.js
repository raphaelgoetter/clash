// ============================================================
// routes/player.js — Player-related API routes
// ============================================================

import { Router } from 'express';
import { fetchPlayer, fetchBattleLog, fetchRaceLog, fetchCurrentRace } from '../services/clashApi.js';
import {
  analyzePlayer, buildWarHistory, computeWarScore,
  filterWarBattles, expandDuelRounds, isWarWin,
} from '../services/analysisService.js';
import { getOrSet } from '../services/cache.js';

const PLAYER_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

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
    const tag = req.params.tag;
    const { value: analysis, fromCache } = await getOrSet(
      `player:analysis:${tag}`,
      () => buildPlayerAnalysis(tag),
      PLAYER_CACHE_TTL,
    );
    res.set('X-Cache', fromCache ? 'HIT' : 'MISS');
    res.json(analysis);
  } catch (err) {
    const status = err.message.includes('404') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

async function buildPlayerAnalysis(tag) {
    const [player, battleLog] = await Promise.all([
      fetchPlayer(tag),
      fetchBattleLog(tag),
    ]);

    const analysis = analyzePlayer(player, battleLog);

    // Enrich with river race history if the player is currently in a clan.
    // We silently ignore failures so a missing/private war log doesn't block the response.
    if (player.clan?.tag) {
      try {
        const [raceLog, currentRace] = await Promise.all([
          fetchRaceLog(player.clan.tag),
          fetchCurrentRace(player.clan.tag).catch(() => null),
        ]);
        analysis.warHistory = buildWarHistory(player.tag, raceLog, player.clan.tag, currentRace);

        // Compute GDC win rate from battle log (available for all players)
        const rawWarLog = expandDuelRounds(filterWarBattles(battleLog));
        const gdcWins   = rawWarLog.filter(isWarWin).length;
        const warWinRate = rawWarLog.length > 0 ? gdcWins / rawWarLog.length : null;

        // Préférer le win rate historique (estimé depuis la fame du race log) quand disponible :
        // plus cohérent avec la fame moyenne, car calculé sur la même fenêtre temporelle.
        const effectiveWinRate = analysis.warHistory.historicalWinRate ?? warWinRate;

        // Nécessite au moins 2 semaines dans le clan (race courante comprise) pour un score fiable.
        // En dessous de ce seuil, un seul point de donnée ne suffit pas → fallback battle log.
        if (analysis.warHistory.streakInCurrentClan >= 2) {
          analysis.warScore = computeWarScore(player, analysis.warHistory, effectiveWinRate);
        } else {
          // Historique insuffisant → fallback battle log
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

    return analysis;
}

export default router;
