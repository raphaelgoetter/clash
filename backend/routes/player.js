// ============================================================
// routes/player.js — Player-related API routes
// ============================================================

import { Router } from "express";
import {
  fetchPlayer,
  fetchBattleLog,
  fetchRaceLog,
  fetchCurrentRace,
  fetchClanMembers,
} from "../services/clashApi.js";
import {
  analyzePlayer,
  buildWarHistory,
  computeWarScore,
  filterWarBattles,
  expandDuelRounds,
  isWarWin,
  buildCurrentWarDays,
  getPlayerAnalysis,
  warResetOffsetMs,
} from "../services/analysisService.js";
import { getOrSet } from "../services/cache.js";
import { getDiscordLinks } from "../services/discordLinks.js";

// short TTL so we don't keep erroneous scores for long
const PLAYER_CACHE_TTL = 30 * 1000; // 30 seconds

const router = Router();

/**
 * GET /api/player/:tag
 * Returns raw player profile from the Clash Royale API.
 */
router.get("/:tag", async (req, res) => {
  try {
    const player = await fetchPlayer(req.params.tag);
    res.json(player);
  } catch (err) {
    const status = err.message.includes("404") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/player/:tag/analysis
 * Returns computed reliability analysis for a player.
 */
router.get("/:tag/analysis", async (req, res) => {
  try {
    const tag = req.params.tag;
    const forceRefresh = req.query.force === "true";
    const fast = req.query.fast === "true" || req.query.fast === "1";

    // Récupère le statut Discord (lié ou non) avant l'analyse
    const discordLinks = await getDiscordLinks().catch(() => ({}));
    const discordLinked = Object.prototype.hasOwnProperty.call(
      discordLinks,
      tag,
    );

    let clanTag = null;

    // attempt memory cache but obey force parameter
    let analysis, fromCache;
    if (forceRefresh) {
      analysis = await getPlayerAnalysis(tag, discordLinked);
      fromCache = false;
    } else {
      ({ value: analysis, fromCache } = await getOrSet(
        `player:analysis:${tag}`,
        () => getPlayerAnalysis(tag, discordLinked),
        PLAYER_CACHE_TTL,
      ));
    }

    clanTag = analysis.overview?.clan?.tag ?? null;

    // if a fast response is requested, return cached analysis immediately when available.
    if (fast && fromCache) {
      res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
      res.set("X-Cache", "HIT");
      if (analysis.overview) analysis.overview.discord = discordLinked;
      const warResetUtcMinutes = clanTag
        ? warResetOffsetMs(clanTag) / 60000
        : null;
      const warSnapshotDays = analysis.warSnapshotDays || null;
      const warCurrentWeekId = analysis.warCurrentWeekId || null;
      const warSnapshotTakenAt = analysis.warSnapshotTakenAt || null;
      return res.json({
        ...analysis,
        snapshotDate: null,
        warSnapshotDays,
        warCurrentWeekId,
        warSnapshotTakenAt,
        warResetUtcMinutes,
      });
    }

    // if cached result has warHistory but no weeks and player isn't fallback,
    // refresh synchronously to avoid blank cards
    if (
      !forceRefresh &&
      fromCache &&
      analysis.warHistory &&
      analysis.warHistory.weeks.length === 0 &&
      !analysis.reliability
    ) {
      // recompute immediately ignoring cache
      analysis = await getPlayerAnalysis(tag, discordLinked);
      fromCache = false;
    }

    res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
    res.set("X-Cache", fromCache ? "HIT" : "MISS");
    // S'assure que le statut Discord est toujours à jour (indépendamment du cache d'analyse)
    if (analysis.overview) analysis.overview.discord = discordLinked;

    // Enrichir les jours passés de la GDC avec les snapshots du clan si disponibles
    let warSnapshotDays = null;
    let warSnapshotTakenAt = null;
    let warCurrentWeekId = null;
    clanTag = analysis.overview?.clan?.tag ?? null;
    if (analysis.currentWarDays?.days && clanTag) {
      try {
        const { getSnapshots } = await import("../services/snapshot.js");
        const allSnaps = await getSnapshots(clanTag);
        const currentWeek =
          allSnaps.length > 0 ? allSnaps[allSnaps.length - 1].week : null;
        if (currentWeek) {
          warCurrentWeekId = currentWeek;
          const weekSnaps = allSnaps.filter((s) => s.week === currentWeek);
          const playerTag = analysis.overview?.tag ?? tag;

          // Capture when the most recent snapshot was taken
          const lastSnap = weekSnaps
            .map((s) => s.snapshotTime || s.snapshotBackupTime || null)
            .filter(Boolean)
            .sort()
            .pop();
          warSnapshotTakenAt = lastSnap ?? null;

          // Ensure we match days by date, not by array index (snapshot array order
          // can’t be relied upon). Use the day key (YYYY-MM-DD) from currentWarDays.
          const snapByDate = Object.fromEntries(
            weekSnaps.map((s) => [s.date, s]),
          );

          const battleDays = Array.isArray(analysis.currentWarDays?.days)
            ? analysis.currentWarDays.days
            : [];

          warSnapshotDays = battleDays.map((d) => {
            const snap = snapByDate[d.key] ?? null;
            const count = d.count ?? 0;
            if (!snap) {
              // No snapshot for this day: fall back to the battle log count.
              return count > 0 ? Math.min(4, count) : null;
            }
            const hasPlayerDecks =
              snap.decks &&
              Object.prototype.hasOwnProperty.call(snap.decks, playerTag);
            if (!hasPlayerDecks) {
              // Snapshot exists for this day, but no per-player breakdown was recorded.
              // Do not fallback to incomplete battle log data, to avoid misleading counts.
              return null;
            }
            const playerDecks = snap.decks[playerTag];
            return Math.min(4, Math.max(playerDecks, count));
          });
        }
      } catch (_) {
        /* silencieux */
      }
    }

    const warResetUtcMinutes = clanTag
      ? warResetOffsetMs(clanTag) / 60000
      : null;

    // keep API shape consistent with clan route
    res.json({
      ...analysis,
      snapshotDate: null,
      warSnapshotDays,
      warCurrentWeekId,
      warSnapshotTakenAt,
      warResetUtcMinutes,
    });
  } catch (err) {
    const status = err.message.includes("404") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

export default router;
