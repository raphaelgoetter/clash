// ============================================================
// routes/player.js — Player-related API routes
// ============================================================

import { Router } from 'express';
import { fetchPlayer, fetchBattleLog, fetchRaceLog, fetchCurrentRace, fetchClanMembers } from '../services/clashApi.js';
import {
  analyzePlayer, buildWarHistory, computeWarScore,
  filterWarBattles, expandDuelRounds, isWarWin, buildCurrentWarDays,
  getPlayerAnalysis,
} from '../services/analysisService.js';
import { getOrSet } from '../services/cache.js';
import { getDiscordLinks } from '../services/discordLinks.js';

// short TTL so we don't keep erroneous scores for long
const PLAYER_CACHE_TTL = 30 * 1000; // 30 seconds

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
    // Récupère le statut Discord (lié ou non) avant l'analyse
    const discordLinks  = await getDiscordLinks().catch(() => ({}));
    const discordLinked = Object.prototype.hasOwnProperty.call(discordLinks, tag);
    // attempt memory cache but force rebuild if warHistory seems missing
    let analysis, fromCache;
    ({ value: analysis, fromCache } = await getOrSet(
      `player:analysis:${tag}`,
      () => getPlayerAnalysis(tag, discordLinked),
      PLAYER_CACHE_TTL,
    ));
    // if cached result has warHistory but no weeks and player isn't fallback,
    // refresh synchronously to avoid blank cards
    if (fromCache && analysis.warHistory && analysis.warHistory.weeks.length === 0 && !analysis.reliability) {
      // recompute immediately ignoring cache
      analysis = await getPlayerAnalysis(tag, discordLinked);
      fromCache = false;
    }
    res.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
    res.set('X-Cache', fromCache ? 'HIT' : 'MISS');
    // S'assure que le statut Discord est toujours à jour (indépendamment du cache d'analyse)
    if (analysis.overview) analysis.overview.discord = discordLinked;

    // Enrichir les jours passés de la GDC avec les snapshots du clan si disponibles
    let warSnapshotDays = null;
    let warCurrentWeekId = null;
    const clanTag = analysis.overview?.clan?.tag ?? null;
    if (analysis.currentWarDays?.days && clanTag) {
      try {
        const { getSnapshots } = await import('../services/snapshot.js');
        const allSnaps = await getSnapshots(clanTag);
        const currentWeek = allSnaps.length > 0 ? allSnaps[allSnaps.length - 1].week : null;
        if (currentWeek) {
          warCurrentWeekId = currentWeek;
          const weekSnaps = allSnaps.filter((s) => s.week === currentWeek);
          const playerTag = analysis.overview?.tag ?? tag;

          // Ensure we match days by date, not by array index (snapshot array order
          // can’t be relied upon). Use the day key (YYYY-MM-DD) from currentWarDays.
          const snapByDate = Object.fromEntries(
            weekSnaps.map((s) => [s.date, s.decks[playerTag] ?? null])
          );

          const battleDays = Array.isArray(analysis.currentWarDays?.days)
            ? analysis.currentWarDays.days
            : [];

          warSnapshotDays = battleDays.map((d) => {
            const snap = snapByDate[d.key] ?? null;
            const count = d.count ?? 0;
            // If snapshot is missing, keep null (no data).
            // Otherwise, prefer the higher of snapshot vs. battle-log count to reflect
            // combat played after the snapshot was taken.
            if (snap === null) {
              return count > 0 ? Math.min(4, count) : null;
            }
            return Math.min(4, Math.max(snap, count));
          });
        }
      } catch (_) { /* silencieux */ }
    }

    // keep API shape consistent with clan route
    res.json({ ...analysis, snapshotDate: null, warSnapshotDays, warCurrentWeekId });
  } catch (err) {
    const status = err.message.includes('404') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
