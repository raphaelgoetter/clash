// ============================================================
// routes/player.js — Player-related API routes
// ============================================================

import { Router } from 'express';
import { fetchPlayer, fetchBattleLog, fetchRaceLog, fetchCurrentRace } from '../services/clashApi.js';
import {
  analyzePlayer, buildWarHistory, computeWarScore,
  filterWarBattles, expandDuelRounds, isWarWin, buildCurrentWarDays,
} from '../services/analysisService.js';
import { getOrSet } from '../services/cache.js';

const PLAYER_CACHE_TTL = 15 * 60 * 1000; // 15 minutes

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

        // Nécessite au moins 2 semaines dans le clan (race courante comprise) pour un score fiable,
        // dont au minimum 2 semaines terminées avec des decks joués.
        // En dessous de ce seuil → fallback battle log (membre considéré comme "new").
        const hasEnoughHistory = analysis.warHistory.streakInCurrentClan >= 2
          && analysis.warHistory.completedParticipation >= 2;
        if (hasEnoughHistory) {
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

    // Résumé GDC semaine courante — calculé après warHistory pour utiliser la source fiable
    const currentWeek    = analysis.warHistory?.weeks?.find((w) => w.isCurrent) ?? null;
    const raceTotalDecks = currentWeek?.decksUsed ?? null;
    const warSummary     = buildCurrentWarDays(battleLog, raceTotalDecks);
    // Joueur arrivé pendant la GDC :
    //  - première semaine dans ce clan (streakInCurrentClan === 1 = pas de race log passé ici)
    //  - aucun deck joué dans la race courante
    //  - on est après le jeudi (sinon le joueur a pu jouer normalement depuis le début)
    if (
      warSummary &&
      warSummary.daysFromThu > 0 &&
      (analysis.warHistory?.streakInCurrentClan ?? 0) === 1 &&
      (currentWeek?.decksUsed ?? 0) === 0
    ) {
      warSummary.arrivedMidWar   = true;
      warSummary.arrivedOnDay    = warSummary.daysFromThu + 1; // 1=jeu, 2=ven, 3=sam, 4=dim
      warSummary.totalDecksUsed  = 0;
      warSummary.isReliableTotal = true;
    }
    analysis.currentWarDays = warSummary;

    return analysis;
}

export default router;
