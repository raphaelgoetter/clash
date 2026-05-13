// ============================================================
// routes/clan.js — Clan-related API routes
// ============================================================

import { Router } from "express";
import { waitUntil } from "@vercel/functions";
import {
  fetchClan,
  fetchClanMembers,
  fetchRaceLog,
  fetchBattleLog,
  fetchPlayer,
  fetchCurrentRace,
  fetchClanWarRankings,
} from "../services/clashApi.js";
import {
  analyzeClanMembers,
  buildWarHistory,
  buildFamilyWarHistory,
  computeWarScore,
  computeWarReliabilityFallback,
  categorizeBattleLog,
  computeIsNewPlayer,
  filterWarBattles,
  expandDuelRounds,
  isWarWin,
  buildCurrentWarDays,
  estimateWinsFromFame,
  warResetOffsetMs,
  scoreTotalDonations,
  applyOldestWeekIgnore,
  computeCurrentWeekId,
  computePrevWeekId,
} from "../services/analysisService.js";
import { buildDebugSnapshotInfo } from "../services/debugSnapshotInfo.js";
import { computeTopPlayers } from "../services/topplayers.js";
import { computeUncomplete } from "../services/uncomplete.js";
import { getOrSet } from "../services/cache.js";
import { getDiscordLinks } from "../services/discordLinks.js";
import {
  recordSnapshot,
  getSnapshotFileDebug,
  overrideWarSnapshotDaysWithLiveCurrentDay,
} from "../services/snapshot.js";
import { loadClanCache, saveClanCache } from "../services/clanCache.js";
import fs from "fs/promises";
import path from "path";

const router = Router();

// One day in milliseconds (used for war day calculations)
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * Run async tasks with limited concurrency to avoid rate-limiting.
 * Returns an array of { status, value } | { status, reason } mirroring Promise.allSettled.
 */
function slimPlayerProfile(fullPlayer) {
  if (!fullPlayer || typeof fullPlayer !== "object") return null;

  const clan = fullPlayer.clan
    ? {
        tag: fullPlayer.clan.tag,
        name: fullPlayer.clan.name,
        clanScore: fullPlayer.clan.clanScore,
        clanWarTrophies: fullPlayer.clan.clanWarTrophies,
      }
    : null;

  const cw2 = (fullPlayer.badges || []).find((b) => b.name === "ClanWarWins");

  const totalDonations = fullPlayer.totalDonations ?? null;
  const donations = fullPlayer.donations ?? null;

  return {
    tag: fullPlayer.tag,
    name: fullPlayer.name,
    role: fullPlayer.role || null,
    trophies: fullPlayer.trophies ?? null,
    bestTrophies: fullPlayer.bestTrophies ?? null,
    expLevel: fullPlayer.expLevel ?? null,
    totalDonations,
    donations,
    warDayWins: fullPlayer.warDayWins ?? null,
    cw2Progress: cw2?.progress ?? null,
    clan,
    arena: fullPlayer.arena?.name ?? null,
    stats: {
      battleCount: fullPlayer.battleCount ?? null,
      threeCrownWins: fullPlayer.threeCrownWins ?? null,
    },
  };
}

async function pooledAllSettled(tasks, concurrency = 10) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker),
  );
  return results;
}

/**
 * GET /api/clan/:tag
 * Returns raw clan profile from the Clash Royale API.
 */
router.get("/:tag", async (req, res) => {
  try {
    const clan = await fetchClan(req.params.tag);
    res.json(clan);
  } catch (err) {
    const status = err.message.includes("404") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/clan/:tag/lite
 * Retourne un profil clan simplifié à partir des données natives de l'API Clash Royale.
 * Aucun calcul de fiabilité ni appel individuel par membre — 4 requêtes max.
 */
router.get("/:tag/lite", async (req, res) => {
  try {
    let clanTag = req.params.tag;
    if (clanTag.startsWith("#")) clanTag = clanTag.slice(1);
    clanTag = clanTag.toUpperCase();

    const cacheKey = `clan:${clanTag}:lite`;
    const cached = await getOrSet(
      cacheKey,
      async () => {
        const [clanResult, membersResult, raceLogResult, currentRaceResult] =
          await Promise.allSettled([
            fetchClan(clanTag),
            fetchClanMembers(clanTag),
            fetchRaceLog(clanTag),
            fetchCurrentRace(clanTag),
          ]);

        if (clanResult.status === "rejected") throw clanResult.reason;
        if (membersResult.status === "rejected") throw membersResult.reason;

        const clan = clanResult.value;
        const membersRaw = membersResult.value ?? [];
        const raceLog =
          raceLogResult.status === "fulfilled" ? raceLogResult.value : null;
        const currentRace =
          currentRaceResult.status === "fulfilled"
            ? currentRaceResult.value
            : null;

        // Membres : champs natifs uniquement, sans calcul de fiabilité
        const members = membersRaw.map((m) => ({
          tag: m.tag,
          name: m.name,
          role: m.role,
          trophies: m.trophies,
          donations: m.donations,
          donationsReceived: m.donationsReceived,
          lastSeen: m.lastSeen,
          expLevel: m.expLevel,
        }));

        // Meilleures performances de la dernière guerre (top par fame brut)
        let lastWarBest = null;
        const races = Array.isArray(raceLog) ? raceLog : (raceLog?.items ?? []);
        if (races.length > 0) {
          const lastRace = races[0];
          const ourStanding = (lastRace.standings ?? []).find(
            (s) => s.clan?.tag?.replace("#", "").toUpperCase() === clanTag,
          );
          const participants = ourStanding?.clan?.participants ?? [];
          lastWarBest = participants
            .filter((p) => (p.fame ?? 0) >= 2600)
            .sort((a, b) => (b.fame ?? 0) - (a.fame ?? 0))
            .slice(0, 50)
            .map((p) => ({
              tag: p.tag,
              name: p.name,
              fame: p.fame ?? 0,
              decksUsed: p.decksUsed ?? 0,
            }));
        }

        // Garde calendaire : hors jeu–dim, l'API peut encore dire 'warDay'
        // juste après le reset du lundi — on refuse d'entrer en mode GDC.
        const _liteDow = new Date(
          Date.now() - warResetOffsetMs(clanTag),
        ).getUTCDay();
        const isWarPeriod =
          (_liteDow === 0 || _liteDow >= 4) &&
          (currentRace?.periodType === "warDay" ||
            currentRace?.state === "warDay" ||
            currentRace?.state === "overtime");

        return {
          clan: {
            name: clan.name,
            tag: clan.tag,
            description: clan.description ?? "",
            members: clan.members,
            clanScore: clan.clanScore,
            clanWarTrophies: clan.clanWarTrophies ?? 0,
            type: clan.type,
            requiredTrophies: clan.requiredTrophies ?? 0,
          },
          members,
          isWarPeriod,
          lastWarBest,
          lastWarWeekId: computePrevWeekId(races),
          isLite: true,
        };
      },
      5 * 60 * 1000,
    );

    // Classement France — réutilise le cache partagé (TTL 60 min)
    let frRank = null;
    let frPreviousRank = null;
    try {
      const frRankings = await getOrSet(
        "warRankings:fr",
        () => fetchClanWarRankings(57000087, 500),
        60 * 60 * 1000,
      );
      const entry = (frRankings.value ?? []).find(
        (r) => r.tag?.replace("#", "").toUpperCase() === clanTag,
      );
      if (entry) {
        frRank = entry.rank ?? null;
        frPreviousRank = entry.previousRank ?? null;
      }
    } catch (err) {
      console.warn(
        `[clan/lite] classement France indisponible pour ${clanTag}:`,
        err.message,
      );
    }

    const liteValue = cached.value;
    const responseWithRank =
      frRank != null ? { ...liteValue, frRank, frPreviousRank } : liteValue;

    res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
    res.set("X-Cache", cached.fromCache ? "HIT" : "MISS");
    return res.json(responseWithRank);
  } catch (err) {
    const status = err.message?.includes("404") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/clan/:tag/analysis
 * Returns clan profile + enriched member list with activity scores.
 */
router.get("/:tag/analysis", async (req, res) => {
  try {
    // normalize: strip leading # and uppercase so it matches ALLOWED_CLANS
    let clanTag = req.params.tag;
    if (clanTag.startsWith("#")) clanTag = clanTag.slice(1);
    clanTag = clanTag.toUpperCase();

    if (!ALLOWED_CLANS.includes(clanTag)) {
      return res.status(400).json({ error: "Clan not in allowed list" });
    }

    const DISK_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes (keep aggressive for live accuracy)
    const nowMs = Date.now();
    let diskCached = null;
    let staleCache = null;
    const forceRefresh = req.query.force === "true";
    const includeTopPlayers =
      req.query.includeTopPlayers !== "false" &&
      req.query.includeTopPlayers !== "0";
    const includeUncomplete =
      req.query.includeUncomplete !== "false" &&
      req.query.includeUncomplete !== "0";
    const includeRaceGroup =
      req.query.includeRaceGroup === "true" ||
      req.query.includeRaceGroup === "1";
    const includeMembers =
      req.query.includeMembers !== "false" && req.query.includeMembers !== "0";
    const fast = req.query.fast === "true" || req.query.fast === "1";

    try {
      diskCached = await loadClanCache(clanTag);
      if (diskCached) {
        staleCache = { ...diskCached };
        staleCache.fallbackReason = forceRefresh
          ? "diskCacheForceFailed"
          : "diskCacheStale";
        staleCache.rateLimited = false;
        if (!includeTopPlayers) staleCache.topPlayers = null;
        if (!includeUncomplete) staleCache.uncomplete = null;
        if (!includeMembers) {
          staleCache.members = null;
          staleCache.membersRaw = null;
        }
        const age = diskCached.analysisCacheUpdatedAt
          ? nowMs - new Date(diskCached.analysisCacheUpdatedAt).getTime()
          : Number.MAX_SAFE_INTEGER;

        // The raceGroup is considered "complete" if at least one rival has war fame data.
        const hasFullRaceGroup =
          includeRaceGroup &&
          Array.isArray(diskCached.raceGroup) &&
          diskCached.raceGroup.some(
            (c) =>
              c.tag !== `#${clanTag}` &&
              (c.lastWarFame !== null || c.prevWarFame !== null),
          );
        const hasLiveRaceGroupDetails =
          includeRaceGroup &&
          Array.isArray(diskCached.raceGroup) &&
          diskCached.raceGroup.some(
            (c) =>
              c.decksToday != null ||
              c.ptsPerDeck != null ||
              c.projectedFame != null ||
              c.currentFame != null ||
              c.maxReachableFame != null,
          );

        // topPlayers et uncomplete sont toujours calculés désormais — seul raceGroup
        // justifie une clé de cache distincte (appels rivaux supplémentaires).
        const currentRaceIndicatesWarDay = false;
        const canUseDiskCache =
          !includeRaceGroup ||
          (hasFullRaceGroup &&
            (!currentRaceIndicatesWarDay || hasLiveRaceGroupDetails));

        if (!forceRefresh && !includeMembers) {
          const responsePayload = { ...diskCached };
          responsePayload.fallbackReason = "diskCache";
          responsePayload.rateLimited = false;
          if (!includeTopPlayers) responsePayload.topPlayers = null;
          if (!includeUncomplete) responsePayload.uncomplete = null;
          responsePayload.members = null;
          responsePayload.membersRaw = null;
          res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
          res.set("X-Cache", "HIT");
          return res.json(responsePayload);
        }

        if (!forceRefresh && fast && diskCached) {
          const responsePayload = { ...diskCached };
          responsePayload.fallbackReason = "diskCacheFast";
          responsePayload.rateLimited = false;
          if (!includeTopPlayers) responsePayload.topPlayers = null;
          if (!includeUncomplete) responsePayload.uncomplete = null;
          if (!includeMembers) {
            responsePayload.members = null;
            responsePayload.membersRaw = null;
          }
          res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
          res.set("X-Cache", "HIT");
          return res.json(responsePayload);
        }

        if (!forceRefresh && age <= DISK_CACHE_TTL_MS && canUseDiskCache) {
          // Fresh cache: safe to return directly.
          const responsePayload = { ...diskCached };
          responsePayload.fallbackReason = "diskCacheFresh";
          responsePayload.rateLimited = false;
          if (!includeTopPlayers) responsePayload.topPlayers = null;
          if (!includeUncomplete) responsePayload.uncomplete = null;
          if (!includeMembers) {
            responsePayload.members = null;
            responsePayload.membersRaw = null;
          }
          res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
          res.set("X-Cache", "HIT");
          return res.json(responsePayload);
        }

        if (!forceRefresh && age > DISK_CACHE_TTL_MS) {
          // Keep stale payload as fallback if live fetch fails.
          staleCache = {
            ...diskCached,
            fallbackReason: "diskCacheStale",
            rateLimited: false,
          };
          if (!includeMembers) {
            staleCache.members = null;
            staleCache.membersRaw = null;
          }

          // Trigger asynchronous update in background as a best-effort refresh.
          // waitUntil garantit que Vercel maintient la fonction active jusqu'à la fin du refresh.
          waitUntil(
            buildClanAnalysis(clanTag, { includeRaceGroup })
              .then((fresh) => saveClanCache(clanTag, fresh).catch(() => null))
              .catch((err) =>
                console.warn(
                  `[clan] background refresh failed for ${clanTag}:`,
                  err.message,
                ),
              ),
          );
        }
      }
    } catch (err) {
      // ignore disk cache read errors and continue to live build
    }

    // short-lived in-memory cache to speed up back/forward and repeated
    // clicks on the same instance.  TTL is small so stale issues are rare.
    // topPlayers et uncomplete sont toujours calculés dans le payload — seul
    // includeRaceGroup entraîne des appels API supplémentaires (rivaux) et
    // justifie une clé distincte.
    const cacheKey = `clan:${clanTag}:group=${includeRaceGroup ? 1 : 0}`;
    try {
      let payload;
      let fromCache = false;
      if (forceRefresh) {
        payload = await buildClanAnalysis(clanTag, {
          forceRefresh: true,
          includeRaceGroup,
        });
        // force refresh est une demande forte, mettre à jour cache public clan
        await saveClanCache(clanTag, payload).catch(() => null);
      } else {
        const cached = await getOrSet(
          cacheKey,
          () => buildClanAnalysis(clanTag, { includeRaceGroup }),
          5 * 60 * 1000,
        );
        payload = cached.value;
        fromCache = cached.fromCache;

        // Keep a persistent fallback cache on disk, to survive cold starts and rate-limit incidents.
        if (!fromCache) {
          await saveClanCache(clanTag, payload).catch(() => null);
        }
      }

      // optionally strip details for lazy load modes (without mutating cached payload)
      const responsePayload = { ...payload };
      if (!includeTopPlayers) responsePayload.topPlayers = null;
      if (!includeUncomplete) responsePayload.uncomplete = null;
      if (!includeMembers) {
        responsePayload.members = null;
        responsePayload.membersRaw = null;
      }

      // prevent Vercel/edge from caching this response
      res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
      res.set("X-Cache", fromCache ? "HIT" : "MISS");
      return res.json(responsePayload);
    } catch (err) {
      if (
        staleCache &&
        (err.isRateLimit ||
          err.message.includes("429") ||
          err.message.includes("504") ||
          err.status >= 500)
      ) {
        const responseStale = { ...staleCache };
        responseStale.rateLimited = true;
        responseStale.fallbackReason = "diskCacheRateLimited";
        if (!includeTopPlayers) responseStale.topPlayers = null;
        if (!includeUncomplete) responseStale.uncomplete = null;
        if (!includeMembers) {
          responseStale.members = null;
          responseStale.membersRaw = null;
        }
        res.set("X-Cache", "STALE");
        res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
        return res.status(200).json(responseStale);
      }
      throw err;
    }
  } catch (err) {
    const status = err.message.includes("404") ? 404 : 500;

    // If we are temporarily rate-limited, serve prebuilt static cache to avoid total failure.
    if (
      (err.isRateLimit ||
        err.message.includes("429") ||
        err.message.includes("504") ||
        err.status >= 500) &&
      clanTag
    ) {
      try {
        const cached = await loadClanCache(clanTag);
        if (cached) {
          const responseCached = { ...cached };
          responseCached.fallbackReason = "diskCache";
          responseCached.rateLimited = true;
          if (!includeTopPlayers) responseCached.topPlayers = null;
          if (!includeUncomplete) responseCached.uncomplete = null;
          if (!includeMembers) {
            responseCached.members = null;
            responseCached.membersRaw = null;
          }
          res.set("X-Cache", "STALE");
          res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
          return res.status(200).json(responseCached);
        }
      } catch (loadErr) {
        console.warn(
          `[clan] persistent fallback load failed for ${clanTag}:`,
          loadErr.message,
        );
      }

      try {
        // Utilise loadClanCache pour respecter la priorité /tmp → bundle statique
        const fallbackData = await loadClanCache(clanTag);
        if (fallbackData) {
          fallbackData.fallbackReason = "publicCache";
          fallbackData.rateLimited = true;
          if (!includeMembers) {
            fallbackData.members = null;
            fallbackData.membersRaw = null;
          }
          res.set("X-Cache", "STALE");
          res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
          return res.status(200).json(fallbackData);
        }
      } catch (fallbackErr) {
        console.warn(
          `[clan] rate-limited public fallback failed for ${clanTag}:`,
          fallbackErr.message,
        );
      }
    }

    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/clan/:tag/members
 * Returns only the clan member table payload, optionally from static cache.
 */
router.get("/:tag/current-war", async (req, res) => {
  try {
    let clanTag = req.params.tag;
    if (clanTag.startsWith("#")) clanTag = clanTag.slice(1);
    clanTag = clanTag.toUpperCase();

    if (!ALLOWED_CLANS.includes(clanTag)) {
      return res.status(400).json({ error: "Clan not in allowed list" });
    }

    const clan = await fetchClan(clanTag);
    const currentRace = await fetchCurrentRace(clanTag);
    if (!currentRace) {
      return res.status(500).json({ error: "Failed to load current race" });
    }

    const isWarDay =
      currentRace.periodType === "warDay" ||
      currentRace.state === "warDay" ||
      currentRace.state === "overtime" ||
      currentRace.periodType === "colosseum";
    if (!isWarDay) {
      return res.status(400).json({ error: "No active war in progress" });
    }

    const participants = Array.isArray(currentRace.clan?.participants)
      ? currentRace.clan.participants
      : [];
    const deckTotals = participants.reduce(
      (sum, p) => sum + (p.decksUsed ?? 0),
      0,
    );
    const currentDayLive = participants.reduce(
      (sum, p) => sum + (p.decksUsedToday ?? 0),
      0,
    );
    const daysFromThu =
      typeof currentRace.periodIndex === "number" &&
      currentRace.periodIndex >= 0 &&
      currentRace.periodIndex <= 3
        ? currentRace.periodIndex
        : 0;
    const MAX_MEMBERS = 50;
    const maxDecksElapsed = MAX_MEMBERS * (daysFromThu + 1) * 4;
    const maxDecksWeek = MAX_MEMBERS * 16;
    const DAY_LABELS = ["Thu", "Fri", "Sat", "Sun"];
    const days = DAY_LABELS.map((label, index) => {
      const isToday = index === daysFromThu;
      return {
        label,
        totalCount: isToday ? Math.min(200, Math.max(0, currentDayLive)) : null,
        maxCount: 200,
        isPast: index < daysFromThu,
        isToday,
        isFuture: index > daysFromThu,
        source: isToday ? "live" : "unknown",
        snapshotCount: isToday
          ? Math.min(200, Math.max(0, currentDayLive))
          : null,
        liveCount: isToday ? Math.min(200, Math.max(0, currentDayLive)) : null,
      };
    });

    const clanWarSummary = {
      totalDecksUsed: Math.min(maxDecksWeek, Math.max(0, deckTotals)),
      maxDecksElapsed,
      maxDecksWeek,
      participantCount: MAX_MEMBERS,
      daysFromThu,
      days,
      weekId:
        currentRace.sectionIndex != null
          ? `S${currentRace.seasonId ?? ""}W${currentRace.sectionIndex + 1}`
          : null,
      ended: false,
    };

    res.set("Cache-Control", "no-store, max-age=0, must-revalidate");
    return res.json({
      clan: {
        tag: clan.tag,
        name: clan.name,
        warResetUtcMinutes: clan.warResetUtcMinutes ?? null,
      },
      clanWarSummary,
      isWarPeriod: true,
      snapshotDate: null,
    });
  } catch (err) {
    const status = err.message?.includes("404") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

router.get("/:tag/members", async (req, res) => {
  try {
    let clanTag = req.params.tag;
    if (clanTag.startsWith("#")) clanTag = clanTag.slice(1);
    clanTag = clanTag.toUpperCase();

    if (!ALLOWED_CLANS.includes(clanTag)) {
      return res.status(400).json({ error: "Clan not in allowed list" });
    }

    const forceRefresh = req.query.force === "true" || req.query.force === "1";
    let cached = null;
    try {
      cached = await loadClanCache(clanTag);
    } catch (_) {
      cached = null;
    }

    if (!forceRefresh && cached && Array.isArray(cached.members)) {
      res.set("X-Cache", "HIT");
      return res.json({
        members: cached.members,
        membersMeta: {
          source: "cached",
          updatedAt: cached.analysisCacheUpdatedAt || new Date().toISOString(),
          snapshotTakenAt:
            cached.snapshotTakenAt ?? cached.warSnapshotTakenAt ?? null,
        },
      });
    }

    try {
      const payload = await buildClanAnalysis(clanTag, {
        includeRaceGroup: false,
      });
      await saveClanCache(clanTag, payload).catch(() => null);
      res.set("X-Cache", "MISS");
      return res.json({
        members: Array.isArray(payload.members) ? payload.members : [],
        membersMeta: {
          source: "live",
          updatedAt: payload.analysisCacheUpdatedAt || new Date().toISOString(),
          snapshotTakenAt: payload.snapshotTakenAt ?? null,
        },
      });
    } catch (err) {
      if (cached && Array.isArray(cached.members)) {
        res.set("X-Cache", "HIT");
        return res.json({
          members: cached.members,
          membersMeta: {
            source: "cached",
            updatedAt:
              cached.analysisCacheUpdatedAt || new Date().toISOString(),
            snapshotTakenAt:
              cached.snapshotTakenAt ?? cached.warSnapshotTakenAt ?? null,
          },
        });
      }
      const status = err.message.includes("404") ? 404 : 500;
      res.status(status).json({ error: err.message });
    }
  } catch (err) {
    const status = err.message.includes("404") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Force a snapshot generation for the given clan (useful for debugging / manual refresh).
// This runs the same logic as the nightly cron but is triggered on demand.
router.post("/:tag/snapshot", async (req, res) => {
  try {
    let clanTag = req.params.tag;
    if (clanTag.startsWith("#")) clanTag = clanTag.slice(1);
    clanTag = clanTag.toUpperCase();

    if (!ALLOWED_CLANS.includes(clanTag)) {
      return res.status(400).json({ error: "Clan not in allowed list" });
    }

    // Fetch the current race (live) and race log (to compute week id).
    const [raceLog, currentRace] = await Promise.all([
      fetchRaceLog(clanTag).catch(() => null),
      fetchCurrentRace(clanTag).catch(() => null),
    ]);

    if (!currentRace || currentRace.periodType !== "warDay") {
      return res.status(400).json({ error: "No active war in progress" });
    }

    // Calcul de l'identifiant de semaine (source de vérité : computeCurrentWeekId)
    const weekId =
      computeCurrentWeekId(currentRace, raceLog) ??
      `W${(currentRace.sectionIndex ?? 0) + 1}`;

    await recordSnapshot(clanTag, currentRace.clan.participants, weekId);
    const debugInfo = await getSnapshotFileDebug(clanTag).catch(() => null);
    res.json({ ok: true, weekId, debugInfo });
  } catch (err) {
    const status = err.message.includes("404") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/clan/:tag/snapshot-force
 * Force a runtime snapshot generation from the current live war and returns /tmp debug info.
 */
router.get("/:tag/snapshot-force", async (req, res) => {
  try {
    let clanTag = req.params.tag;
    if (clanTag.startsWith("#")) clanTag = clanTag.slice(1);
    clanTag = clanTag.toUpperCase();

    if (!ALLOWED_CLANS.includes(clanTag)) {
      return res.status(400).json({ error: "Clan not in allowed list" });
    }

    const [raceLog, currentRace] = await Promise.all([
      fetchRaceLog(clanTag).catch(() => null),
      fetchCurrentRace(clanTag).catch(() => null),
    ]);

    if (!currentRace || currentRace.periodType !== "warDay") {
      return res.status(400).json({ error: "No active war in progress" });
    }

    const weekId =
      computeCurrentWeekId(currentRace, raceLog) ??
      `W${(currentRace.sectionIndex ?? 0) + 1}`;

    await recordSnapshot(clanTag, currentRace.clan.participants, weekId);
    const debugInfo = await getSnapshotFileDebug(clanTag).catch(() => null);
    return res.json({ ok: true, weekId, debugInfo });
  } catch (err) {
    const status = err.message.includes("404") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

/**
 * GET /api/clan/:tag/snapshot-debug
 * Returns runtime snapshot storage metadata to verify whether /tmp or data/ is used.
 */
router.get("/:tag/snapshot-debug", async (req, res) => {
  try {
    let clanTag = req.params.tag;
    if (clanTag.startsWith("#")) clanTag = clanTag.slice(1);
    clanTag = clanTag.toUpperCase();

    if (!ALLOWED_CLANS.includes(clanTag)) {
      return res.status(400).json({ error: "Clan not in allowed list" });
    }

    const debugInfo = await getSnapshotFileDebug(clanTag);
    res.json(debugInfo);
  } catch (err) {
    const status = err.message.includes("404") ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// list of clans the UI is allowed to query (uppercase normalized, without '#')
// Removing the leading hash simplifies comparisons both in the router
// and when callers invoke `buildClanAnalysis` programmatically.
export const ALLOWED_CLANS = [
  "Y8JUPC9C", // La Resistance
  "LRQP20V9", // Les Resistants
  "QU9UQJRL", // Les Revoltes
];

// family clans used for transfer detection. Keep in sync with ALLOWED_CLANS.
export const FAMILY_CLAN_TAGS = ALLOWED_CLANS;

const MEMBER_DATA_TTL_MS = 30 * 60 * 1000; // 30 min

export async function buildClanAnalysis(clanTag, options = {}) {
  const forceRefresh = !!options.forceRefresh;

  // sanitiZe input exactly as the route does
  if (clanTag.startsWith("#")) clanTag = clanTag.slice(1);
  clanTag = clanTag.toUpperCase();

  if (!ALLOWED_CLANS.includes(clanTag)) {
    throw new Error("Clan not allowed");
  }
  const [clan, members] = await Promise.all([
    fetchClan(clanTag),
    fetchClanMembers(clanTag),
  ]);

  // Reuse existing persisted analysis cache to avoid refetching players on every call.
  const existingCache = forceRefresh
    ? null
    : await loadClanCache(clanTag).catch(() => null);
  const membersRaw = existingCache?.membersRaw
    ? { ...existingCache.membersRaw }
    : {};

  const SCORE_VERSION = "2026-04-07-v1";

  // Quick map of prior member results, to avoid expensive player-api fan-out for a hot cache.
  // `scoreVersion` garantit qu'une modification de l'algorithme force recalcul.
  const existingMemberAnalysis = new Map(
    (existingCache?.members || []).map((member) => [member.tag, member]),
  );

  const nowMs = Date.now();
  const membersToFetch = members.filter((m) => {
    if (forceRefresh) return true;
    const existing = membersRaw[m.tag];
    if (!existing || !existing.fetchedAt) return true;
    const ageMs = nowMs - Date.parse(existing.fetchedAt);
    return Number.isNaN(ageMs) || ageMs > MEMBER_DATA_TTL_MS;
  });
  const membersToFetchSet = new Set(membersToFetch.map((m) => m.tag));

  // Chargement des liens Discord (tag → discord_user_id) — cache 5 min
  const discordLinks = await getDiscordLinks().catch(() => ({}));

  // Fetch race log once and compute war-based scores for every member.
  // Fall back to the legacy activity score when race log is temporarily unavailable.
  let memberRateLimited = false;
  let raceLog = null;
  let currentRace = null;
  let raceLogUnavailable = false;

  // fetch current race and race log independently so one failure doesn't discard the other.
  try {
    raceLog = await fetchRaceLog(clanTag);
  } catch (err) {
    if (err.isRateLimit || (err.message && err.message.includes("429"))) {
      console.warn(
        `[clan] raceLog throttled for ${clanTag}, partial fallback`,
        err.message,
      );
      raceLogUnavailable = true;
    } else {
      console.warn(
        `[clan] raceLog failed for ${clanTag}, partial fallback`,
        err.message,
      );
      raceLogUnavailable = true;
    }
    raceLog = null;
  }

  try {
    currentRace = await fetchCurrentRace(clanTag);
  } catch (err) {
    console.warn(`[clan] currentRace failed for ${clanTag}`, err.message);
    currentRace = null;
  }

  // If both are missing, we are in degraded mode.
  raceLogUnavailable = !raceLog && !currentRace;

  // Classement France (location 57000087) — un seul appel partageable entre les 3 clans.
  // TTL 60 min : le classement n'est mis à jour qu'après le reset hebdomadaire.
  let frRank = null;
  let frPreviousRank = null;
  try {
    const frRankings = await getOrSet(
      "warRankings:fr",
      () => fetchClanWarRankings(57000087, 500),
      60 * 60 * 1000,
    );
    const entry = (frRankings.value ?? []).find(
      (r) => r.tag?.replace("#", "").toUpperCase() === clanTag,
    );
    if (entry) {
      frRank = entry.rank ?? null;
      frPreviousRank = entry.previousRank ?? null;
    }
  } catch (err) {
    console.warn(
      `[clan] classement France indisponible pour ${clanTag}:`,
      err.message,
    );
  }

  const currentRaceIndicatesWarDay =
    currentRace?.periodType === "warDay" ||
    currentRace?.periodType === "colosseum" ||
    currentRace?.state === "warDay" ||
    currentRace?.state === "overtime" ||
    currentRace?.state === "full";

  // Helper: cumul pts de bataille semaine depuis les participants (source de vérité).
  // Fallback : clan.clanScore qui a la même sémantique dans raceLog (cumul semaine).
  const sumParticipantsFame = (standing) => {
    const parts = standing?.clan?.participants;
    if (!Array.isArray(parts) || parts.length === 0) return null; // clan.fame et clan.clanScore dans raceLog ne sont pas fiables sans participants
    let total = 0;
    for (let i = 0; i < parts.length; i++) {
      total += parts[i].fame ?? 0;
    }
    return total;
  };

  const includeTopPlayers = options.includeTopPlayers !== false;
  const includeUncomplete = options.includeUncomplete !== false;
  // Robust boolean check: true, 'true', or '1'
  const includeRaceGroup =
    options.includeRaceGroup === true ||
    options.includeRaceGroup === "true" ||
    options.includeRaceGroup === "1" ||
    options.includeRaceGroup === 1;

  const sumParticipantsDecks = (standing) => {
    const parts = standing?.clan?.participants;
    if (!Array.isArray(parts) || parts.length === 0) return null;
    return parts.reduce((s, p) => s + (p.decksUsed ?? 0), 0);
  };

  const raceGroupRivalData = {};
  const rivalLastWarByTag = {};
  const rivalPrevWarByTag = {};
  const rivalAvgDecksByTag = {}; // Moyenne quotidienne de la semaine passée
  const rivalAvgPtsPerDeckByTag = {}; // Moyenne pts/deck sur les GDC récentes

  if (includeRaceGroup && Array.isArray(currentRace?.clans)) {
    const ownTagNorm = `#${clanTag}`.toUpperCase();
    const rivalClans = currentRace.clans.filter(
      (c) => c.tag && c.tag.toUpperCase() !== ownTagNorm,
    );

    // Timeout de sécurité pour éviter le 504 global (Vercel)
    const timeoutPromise = (ms) =>
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timeout Rivals")), ms),
      );

    await Promise.race([
      Promise.allSettled(
        rivalClans.map(async (c) => {
          const tagNorm = c.tag.toUpperCase();

          // On traite chaque rival indépendément pour maximiser les chances
          const clanProm = fetchClan(c.tag)
            .then((res) => {
              raceGroupRivalData[tagNorm] = res;
            })
            .catch((e) =>
              console.warn(
                `[clan]     ! fetchClan ${tagNorm} failed:`,
                e.message,
              ),
            );
          const logProm = fetchRaceLog(c.tag)
            .then((rivalLog) => {
              const lastStanding = (rivalLog?.[0]?.standings ?? []).find(
                (s) => (s.clan?.tag ?? "").toUpperCase() === tagNorm,
              );
              rivalLastWarByTag[tagNorm] = sumParticipantsFame(lastStanding);
              const totalDecksLastWeek = sumParticipantsDecks(lastStanding);
              if (totalDecksLastWeek != null) {
                rivalAvgDecksByTag[tagNorm] = totalDecksLastWeek / 4;
              }
              const prevStanding = (rivalLog?.[1]?.standings ?? []).find(
                (s) => (s.clan?.tag ?? "").toUpperCase() === tagNorm,
              );
              rivalPrevWarByTag[tagNorm] = sumParticipantsFame(prevStanding);

              // Rivaux : on n'a pas de snapshots par jour, donc on estime
              // l'efficacité avec la moyenne pts/deck des GDC précédentes.
              const ppdSamples = [];
              for (const weekEntry of rivalLog ?? []) {
                const standing = (weekEntry?.standings ?? []).find(
                  (s) => (s.clan?.tag ?? "").toUpperCase() === tagNorm,
                );
                if (!standing) continue;
                const fame = sumParticipantsFame(standing);
                const decks = sumParticipantsDecks(standing);
                if (
                  typeof fame === "number" &&
                  Number.isFinite(fame) &&
                  typeof decks === "number" &&
                  Number.isFinite(decks) &&
                  decks > 0
                ) {
                  ppdSamples.push(fame / decks);
                }
                if (ppdSamples.length >= 4) break;
              }
              if (ppdSamples.length > 0) {
                rivalAvgPtsPerDeckByTag[tagNorm] =
                  ppdSamples.reduce((s, v) => s + v, 0) / ppdSamples.length;
              }
            })
            .catch((e) =>
              console.warn(
                `[clan]     ! fetchRaceLog ${tagNorm} failed:`,
                e.message,
              ),
            );
          return Promise.allSettled([clanProm, logProm]);
        }),
      ),
      timeoutPromise(14000),
    ]).catch((err) => {
      console.warn(
        "[clan] Rival fetching timed out or failed globally:",
        err.message,
      );
    });
  }

  // topPlayers est toujours calculé (pas d'appel API supplémentaire : réutilise
  // raceLog déjà chargé) pour que le cache unifié le contienne dès le 1er appel.
  let topPlayers = null;
  topPlayers = await computeTopPlayers(
    clanTag,
    members,
    [2400, 2600, 2800],
    raceLog,
  );

  // Enregistre le snapshot journalier depuis la course EN COURS (currentRace),
  // pas depuis le race log terminé. decksUsed = cumul depuis jeudi → le delta
  // inter-snapshots donne les combats du jour.
  // On n'enregistre que pendant 'warDay' : en période training, decksUsed
  // reflète la guerre précédente terminée et produirait des valeurs erronées.
  // On utilise periodType (et non state qui peut valoir 'full' quand le clan
  // a atteint 10 000 pts) pour distinguer guerre vs entraînement.
  const isCurrentRaceWarDay =
    currentRace?.periodType === "warDay" ||
    currentRace?.state === "warDay" ||
    currentRace?.state === "overtime";

  if (isCurrentRaceWarDay && currentRace?.clan?.participants?.length > 0) {
    const participants = currentRace.clan.participants;
    // Calcul de l'identifiant de semaine (source de vérité : computeCurrentWeekId)
    const weekId =
      computeCurrentWeekId(currentRace, raceLog) ??
      `W${(currentRace.sectionIndex ?? 0) + 1}`;
    try {
      const { recordSnapshot } = await import("../services/snapshot.js");
      await recordSnapshot(clanTag, participants, weekId, {
        periodType: currentRace?.periodType ?? null,
      });
    } catch (err) {
      console.warn(
        "[snapshot] recordSnapshot failed for",
        clanTag,
        ":",
        err?.message || err,
      );
    }
  }

  // fetch full player profiles + battle logs for members requiring refresh
  let memberDataResults = [];
  if (membersToFetch.length > 0) {
    memberDataResults = await pooledAllSettled(
      membersToFetch.map(
        (m) => () => Promise.all([fetchPlayer(m.tag), fetchBattleLog(m.tag)]),
      ),
    );

    memberDataResults.forEach((res, idx) => {
      const tag = membersToFetch[idx].tag;
      if (res.status === "rejected") {
        if (res.reason?.isRateLimit) {
          console.warn(
            `member fetch rate-limited for ${tag}:`,
            res.reason.message || res.reason,
          );
        } else {
          console.warn(
            `member fetch failed for ${tag}:`,
            res.reason?.message || res.reason,
          );
        }
        return;
      }

      const [profile, battleLog] = res.value;
      const existingRaw = membersRaw[tag];
      membersRaw[tag] = {
        profile: slimPlayerProfile(profile) || {
          tag: profile?.tag || tag,
          name: profile?.name || membersToFetch[idx].name,
          role: profile?.role || membersToFetch[idx].role,
          trophies: profile?.trophies ?? membersToFetch[idx].trophies,
          donations: profile?.donations ?? membersToFetch[idx].donations,
          totalDonations:
            profile?.totalDonations ??
            existingRaw?.profile?.totalDonations ??
            null,
        },
        battleLogSummary: {
          totalBattles: Array.isArray(battleLog) ? battleLog.length : 0,
          warBattles: Array.isArray(battleLog)
            ? expandDuelRounds(filterWarBattles(battleLog)).length
            : 0,
        },
        fetchedAt: new Date().toISOString(),
      };
    });
  }

  const normalizeTag = (tag) =>
    `#${String(tag ?? "")
      .replace(/^#/, "")
      .toUpperCase()}`;

  // Remove old members who are no longer in clan.
  const currentMemberTags = new Set(members.map((m) => normalizeTag(m.tag)));
  Object.keys(membersRaw).forEach((tag) => {
    if (!currentMemberTags.has(normalizeTag(tag))) delete membersRaw[tag];
  });

  // detect API rate limiting in member fetches
  memberRateLimited = memberDataResults.some(
    (res) => res.status === "rejected" && res.reason?.isRateLimit,
  );

  // build map of raw fetched data by tag for later use
  const memberDataByTag = {};
  const battleLogsByTag = {};

  // Use fresh data for members we fetched now, otherwise fall back to cached data where available.
  members.forEach((m) => {
    const existingRaw = membersRaw[m.tag];
    memberDataByTag[m.tag] = {
      profile: existingRaw?.profile ?? null,
      battleLog: [],
    };
    // Keep an explicit battle log container for each member; may remain empty until fetched.
    battleLogsByTag[m.tag] = [];
  });

  if (memberDataResults.length) {
    memberDataResults.forEach((res, idx) => {
      const tag = membersToFetch[idx]?.tag;
      if (!tag) return;

      if (res.status === "fulfilled") {
        memberDataByTag[tag] = {
          profile: res.value[0],
          battleLog: res.value[1] || [],
        };
        battleLogsByTag[tag] = res.value[1] || [];
      } else {
        // Keep cached data from membersRaw where available, or null otherwise
        memberDataByTag[tag] = memberDataByTag[tag] || {
          profile: null,
          battleLog: [],
        };
        battleLogsByTag[tag] = battleLogsByTag[tag] || [];
      }
    });
  }

  // For members not fetched now but cached memberRaw exists, include cached battle logs as summary is not actual logs.
  members.forEach((m) => {
    if (!battleLogsByTag[m.tag] && membersRaw[m.tag]?.battleLogSummary) {
      battleLogsByTag[m.tag] = [];
    }
  });

  // uncomplete est toujours calculé (pas d'appel API supplémentaire : réutilise
  // battleLogsByTag déjà chargé) pour que le cache unifié le contienne dès le 1er appel.
  let uncomplete = null;
  uncomplete = await computeUncomplete(
    clanTag,
    members,
    battleLogsByTag,
    raceLog,
  );

  // override/update daily breakdown using snapshots if available and race log exists
  let weekSnaps = [];
  let prevWeekId = null;
  let currWeekId = null;
  let warSnapshotDays = null;
  let warSnapshotTakenAt = null;

  let getSnapshotsForWeeks = null;
  let getWarDayName = null;
  let getWarDayKey = null;

  if (raceLog && raceLog.length > 0) {
    ({ getSnapshotsForWeeks, getWarDayName, getWarDayKey } =
      await import("../services/snapshot.js"));

    // Calcul des identifiants des deux semaines avant de charger les snapshots
    prevWeekId = computePrevWeekId(raceLog);
    currWeekId = computeCurrentWeekId(currentRace, raceLog);

    // Lecture unique du fichier de snapshots pour les deux semaines
    const snapshotsByWeek = await getSnapshotsForWeeks(clanTag, [
      prevWeekId,
      currWeekId,
    ]);
    const prevSnaps = snapshotsByWeek[prevWeekId] ?? [];
    weekSnaps = snapshotsByWeek[currWeekId] ?? [];
    if (
      prevSnaps.length > 0 &&
      uncomplete &&
      Array.isArray(uncomplete.players)
    ) {
      const dayIndex = { thursday: 0, friday: 1, saturday: 2, sunday: 3 };

      // Determine whether we have snapshots for all 4 GDC days (thu→sun).
      const snapshotDays = new Set();
      for (const snap of prevSnaps) {
        const warDay =
          snap.warDay ??
          getWarDayName(getWarDayKey(new Date(`${snap.date}T12:00:00Z`)));
        const hasData =
          snap.decks &&
          Object.values(snap.decks).some((v) => typeof v === "number" && v > 0);
        if (warDay && hasData) snapshotDays.add(warDay);
      }
      const ALL_WAR_DAYS = ["thursday", "friday", "saturday", "sunday"];
      uncomplete.snapshotComplete = ALL_WAR_DAYS.every((d) =>
        snapshotDays.has(d),
      );
      uncomplete.snapshotDays = Array.from(snapshotDays).sort();

      uncomplete.players = uncomplete.players.map((p) => {
        // Build a fixed 4‑day array (thu→sun). Missing days stay null.
        const daily = [null, null, null, null];
        for (const snap of prevSnaps) {
          const warDay =
            snap.warDay ??
            getWarDayName(getWarDayKey(new Date(`${snap.date}T12:00:00Z`)));
          const idx = dayIndex[warDay];
          if (idx === undefined) continue;
          const hasData =
            snap.decks &&
            Object.values(snap.decks).some(
              (v) => typeof v === "number" && v > 0,
            );
          if (!hasData) continue;
          const val = snap.decks ? snap.decks[p.tag] : null;
          daily[idx] = val == null ? null : val;
        }
        p.daily = daily;
        p.dailySource = "snapshot";
        p.dailySnapshotComplete = daily.every((v) => v !== null);
        if (p.dailySnapshotComplete) {
          const dailyTotal = daily.reduce(
            (sum, v) => sum + (typeof v === "number" ? v : 0),
            0,
          );
          // Keep the official count from race standings (p.decks) as source of truth.
          // Snapshot can be used for breakdown/diagnostic, but may be trailing or noisy.
          p.dailyMismatch = p.decks !== dailyTotal;
          p.dailyTotalFromSnapshot = dailyTotal;
        } else {
          p.dailyMismatch = false;
          p.dailyTotalFromSnapshot = null;
        }
        return p;
      });
    }

    // Track when the latest snapshot was taken (useful for debug/analysis)
    const latestSnap = weekSnaps
      .map((s) => s.snapshotTime || s.snapshotBackupTime || null)
      .filter(Boolean)
      .sort()
      .pop();
    warSnapshotTakenAt = latestSnap ?? null;

    if (weekSnaps.length) {
      // weekSnaps is expected to be an array of day entries for the current week
      // (thu→sun). Build an array of total decks per day.
      // null = pas de snapshot valide pour ce jour (snapshot invalide ou manquant)
      warSnapshotDays = weekSnaps.map((snap) => {
        if (!snap) return null;
        const totalFromDecks =
          snap.decks && Object.keys(snap.decks).length > 0
            ? Object.values(snap.decks).reduce(
                (s, v) => s + (typeof v === "number" ? v : 0),
                0,
              )
            : null;
        const snapshotCount = Number.isFinite(snap.snapshotCount)
          ? Math.min(200, snap.snapshotCount)
          : null;
        const total =
          snapshotCount != null
            ? snapshotCount
            : totalFromDecks != null && totalFromDecks > 0
              ? totalFromDecks
              : null;
        return total != null && total > 0 ? total : null;
      });

      warSnapshotDays = overrideWarSnapshotDaysWithLiveCurrentDay(
        warSnapshotDays,
        currentRace,
        currentMemberTags,
        clanTag,
      );
    }
  }

  // First pass: compute war scores for all members (concurrency-limited to avoid Clash API rate pressure)
  const MEMBER_CONCURRENCY = 15;
  const memberTasks = members.map((m, idx) => async () => {
    let reliabilityScore,
      verdict,
      color,
      isNew = false,
      isNewFromCache = null,
      warHistory = null,
      scoreSource = "clan",
      playerAnalysis = null;
    let memberWarScore = null;

    // Resolve full player profile (for badges) and battle log from fetch results or existing cache.
    const memberData = memberDataByTag[m.tag] || {
      profile: null,
      battleLog: [],
    };
    const fullPlayer = memberData.profile;
    const battleLog = memberData.battleLog || [];

    // Keep trimmed data as warm cache for instant UI hydration.
    const existingRaw = membersRaw[m.tag];
    membersRaw[m.tag] = {
      profile: slimPlayerProfile(fullPlayer) ||
        existingRaw?.profile || {
          tag: m.tag,
          name: m.name,
          role: m.role,
          trophies: m.trophies ?? null,
          donations: m.donations ?? null,
          totalDonations: existingRaw?.profile?.totalDonations ?? null,
        },
      battleLogSummary: {
        totalBattles: Array.isArray(battleLog) ? battleLog.length : 0,
        warBattles: Array.isArray(battleLog)
          ? expandDuelRounds(filterWarBattles(battleLog)).length
          : 0,
      },
      fetchedAt: membersToFetchSet.has(m.tag)
        ? new Date().toISOString()
        : (existingRaw?.fetchedAt ?? new Date().toISOString()),
    };

    // Player proxy: prefer full profile (has badges), fall back to member data
    const playerProxy = fullPlayer ?? {
      trophies: m.trophies ?? 0,
      bestTrophies: m.trophies ?? 0,
      totalDonations: m.donations ?? 0,
      donations: m.donations ?? 0,
    };
    // Présence Discord : le tag du membre est-il dans discord-links.json ?
    const discordLinked = Object.prototype.hasOwnProperty.call(
      discordLinks,
      m.tag,
    );

    // Source de vérité : préférer les résultats stockés en cache pour réduire le trafic API.
    let playerScoreOverride = false;
    const cachedMember = existingMemberAnalysis.get(m.tag);
    if (
      cachedMember &&
      Number.isFinite(cachedMember.reliability) &&
      cachedMember.scoreVersion === SCORE_VERSION
    ) {
      const pa = {
        pct: cachedMember.reliability,
        verdict: cachedMember.verdict,
        color: cachedMember.color,
      };
      playerAnalysis = {
        warScore: pa,
        warHistory: cachedMember.warHistory || null,
      };
      reliabilityScore = pa.pct;
      verdict = pa.verdict ?? "Unknown";
      color = pa.color ?? "orange";
      scoreSource = "cached";
      memberWarScore = pa;
      if (cachedMember.warHistory) {
        warHistory = cachedMember.warHistory;
        playerScoreOverride = true;
      } else {
        // We have a reliability cache but no detailed war history, so we
        // still allow fresh computation (not strict override) for isNew.
        playerScoreOverride = false;
      }
      if (typeof cachedMember.isNew === "boolean") {
        isNewFromCache = cachedMember.isNew;
      }
    } else if (
      cachedMember &&
      Number.isFinite(cachedMember.reliability) &&
      cachedMember.scoreVersion !== SCORE_VERSION
    ) {
      // forcing refresh of outdated score logic.
      console.warn(
        `[clan] cache score version mismatch for ${m.tag}, expected ${SCORE_VERSION}, got ${cachedMember.scoreVersion}. Recomputing.`,
      );
    }

    if (!playerScoreOverride && raceLog) {
      let memberBattleLog = battleLogsByTag[m.tag] || [];
      let wh = await buildFamilyWarHistory(
        m.tag,
        clan.tag,
        currentRace,
        memberBattleLog,
      );
      warHistory = wh;

      // Compute GDC win rate from battle log when available
      let warWinRate = null;
      if (battleLog) {
        const rawWarLog = expandDuelRounds(filterWarBattles(battleLog));
        if (rawWarLog.length >= 10) {
          // même seuil que la route player
          const wins = rawWarLog.filter(isWarWin).length;
          warWinRate = wins / rawWarLog.length;
        }
      }

      // Determine whether warHistory alone is sufficient. We want to
      // grant full scores when the player has either a full 16-deck week
      // in the past or the old rule of ≥2 completed weeks in the clan.
      let prevWeeks = wh.weeks.filter((w) => !w.isCurrent);
      let hasFullWeek = prevWeeks.some((w) => (w.decksUsed ?? 0) >= 16);
      const streakInFamily = wh.streakInFamily ?? wh.streakInCurrentClan;
      const oldRule = streakInFamily >= 2 && wh.completedParticipation >= 2;
      // Strict mapping with Player view : only full week or old rule counts.
      let hasEnoughHistory = hasFullWeek || oldRule;

      // Define BattleLog mode the same way as in frontend player view:
      const hasCompletedWarWeeks = wh.weeks.some(
        (w) => !w.isCurrent && (w.decksUsed ?? 0) > 0,
      );
      const hasOnlyCurrentWeek =
        wh.weeks.length === 1 && wh.weeks[0]?.isCurrent;
      const isBattleLogMode = !hasCompletedWarWeeks || hasOnlyCurrentWeek;

      // same mid‑race arrival handling as player view (ignore oldest incomplete)
      if (prevWeeks.length >= 2) {
        if (applyOldestWeekIgnore(wh, prevWeeks)) {
          // réévaluer après le recalcul (completedParticipation peut avoir changé)
          // conserver true si on avait déjà suffisamment d'historique avant l'ajustement.
          const familyStreakAfterIgnore =
            wh.streakInFamily ?? wh.streakInCurrentClan;
          hasEnoughHistory =
            hasEnoughHistory ||
            hasFullWeek ||
            (familyStreakAfterIgnore >= 2 && wh.completedParticipation >= 2);
        }
      }

      const hasFamilyWeek = prevWeeks.some((w) => {
        const normalized = (w.clanTag ?? "").replace(/^#/, "").toUpperCase();
        return FAMILY_CLAN_TAGS.includes(normalized);
      });
      if (!hasFamilyWeek) {
        hasEnoughHistory = false;
      }

      const isNewClanArrivee =
        (wh?.streakInCurrentClan ?? 0) < 2 && (wh?.totalWeeks ?? 0) > 1;

      // For transfer players, we first evaluate using available family/current clan history.
      // If still insufficient, try fetching the member-specific battle log to recover non-family transfer history.
      // Skip si le score est déjà en cache avec la bonne version : pas besoin d'améliorer le score,
      // et warDays peut être calculé depuis currentRace.clan.participants directement.
      const scoreAlreadyCached = !!(
        cachedMember &&
        Number.isFinite(cachedMember.reliability) &&
        cachedMember.scoreVersion === SCORE_VERSION
      );
      if (
        !hasEnoughHistory &&
        (!Array.isArray(memberBattleLog) || memberBattleLog.length === 0) &&
        !scoreAlreadyCached
      ) {
        console.warn(
          `[clan] fetchBattleLog fallback for ${m.tag} (no family history)`,
        );
        try {
          const fallbackBattleLog = await fetchBattleLog(m.tag);
          console.warn(
            `[clan] ${m.tag} battleLog len ${Array.isArray(fallbackBattleLog) ? fallbackBattleLog.length : "??"}`,
          );
          if (
            Array.isArray(fallbackBattleLog) &&
            fallbackBattleLog.length > 0
          ) {
            memberBattleLog = fallbackBattleLog;
            battleLogsByTag[m.tag] = fallbackBattleLog;
            wh = await buildFamilyWarHistory(
              m.tag,
              clan.tag,
              currentRace,
              memberBattleLog,
            );

            prevWeeks = wh.weeks.filter((w) => !w.isCurrent);
            hasFullWeek = prevWeeks.some((w) => (w.decksUsed ?? 0) >= 16);
            // old rule : 2 completed weeks in clan
            const oldRuleRefetch =
              wh.streakInCurrentClan >= 2 && wh.completedParticipation >= 2;
            hasEnoughHistory = hasFullWeek || oldRuleRefetch;
          }
        } catch (e) {
          console.warn(
            `[clan] ${m.tag} fallback fetchBattleLog failed:`,
            e.message,
          );
          // ignore and keep fallback behavior
        }
      }

      if (hasEnoughHistory) {
        // Historical data — computeWarScore + win rate historique (race log) en priorité
        const effectiveWinRate = wh.historicalWinRate ?? warWinRate;
        const ws = computeWarScore(
          playerProxy,
          wh,
          effectiveWinRate,
          m.lastSeen ?? null,
          discordLinked,
        );
        memberWarScore = ws;
        reliabilityScore = ws.pct;
        verdict = ws.verdict;
        color = ws.color;
        scoreSource = "history";
      } else if (battleLog) {
        // New member — full fallback with battle log
        const bd = categorizeBattleLog(battleLog);
        const warLog = expandDuelRounds(filterWarBattles(battleLog));
        const normalizedTagFb = m.tag.startsWith("#") ? m.tag : `#${m.tag}`;
        const racePartFb = currentRace?.clan?.participants?.find(
          (p) => p.tag === normalizedTagFb,
        );
        const wsFallback = computeWarReliabilityFallback(
          playerProxy,
          warLog,
          bd,
          m.lastSeen ?? null,
          discordLinked,
          racePartFb?.decksUsed ?? 0,
        );

        // If we already have a player-level analysis, use it to align the score.
        if (
          playerAnalysis?.warScore &&
          typeof playerAnalysis.warScore.pct === "number"
        ) {
          const pa = playerAnalysis.warScore;
          memberWarScore = pa;
          reliabilityScore = pa.pct;
          verdict = pa.verdict ?? wsFallback.verdict;
          color = pa.color ?? wsFallback.color;
          scoreSource = "player";
          if (playerAnalysis.warHistory) warHistory = playerAnalysis.warHistory;
        } else if (playerAnalysis && !playerAnalysis.warScore) {
          memberWarScore = wsFallback;
          reliabilityScore = wsFallback.pct;
          verdict = wsFallback.verdict;
          color = wsFallback.color;
          scoreSource = "fallback";
        } else {
          memberWarScore = wsFallback;
          reliabilityScore = wsFallback.pct;
          verdict = wsFallback.verdict;
          color = wsFallback.color;
          scoreSource = "fallback";
        }
      } else if (!playerScoreOverride) {
        // Battle log unavailable — minimal estimate
        const totalDonations =
          playerProxy.totalDonations ?? playerProxy.donations ?? 0;
        const donationPts = scoreTotalDonations(totalDonations, 2);
        const pct = Math.round((donationPts / 40) * 100);
        reliabilityScore = pct;
        verdict = "Extreme risk";
        color = "red";
        // If we have no race log, we cannot safely mark someone as "new".
        // Keep their existing status to avoid false positives for clan / Discord.
      }
    } else if (!playerScoreOverride) {
      // No river race log available (rate-limited or missing data) — use battle logs / player profile fallback.
      const memberBattleLog = battleLogsByTag[m.tag] || [];
      const bd = categorizeBattleLog(memberBattleLog);
      const warLog = expandDuelRounds(filterWarBattles(memberBattleLog));
      const normalizedTagFb = m.tag.startsWith("#") ? m.tag : `#${m.tag}`;
      const racePartFb = currentRace?.clan?.participants?.find(
        (p) => p.tag === normalizedTagFb,
      );
      const ws = computeWarReliabilityFallback(
        playerProxy,
        warLog,
        bd,
        m.lastSeen ?? null,
        discordLinked,
        racePartFb?.decksUsed ?? 0,
      );
      memberWarScore = ws;
      reliabilityScore = ws.pct;
      verdict = ws.verdict;
      color = ws.color;
      scoreSource = "fallback";

      // In this mode we cannot robustly determine clan-age newness from raceLog history.
      isNew = false;
    }

    // Ensure player view score is authoritative when available (global override).
    if (
      playerAnalysis?.warScore &&
      Number.isFinite(playerAnalysis.warScore.pct)
    ) {
      const pa = playerAnalysis.warScore;
      memberWarScore = pa;
      reliabilityScore = pa.pct;
      verdict = pa.verdict ?? verdict;
      color = pa.color ?? color;
      scoreSource = "player";
      if (playerAnalysis.warHistory) warHistory = playerAnalysis.warHistory;
    }

    // Determine new member flag by shared policy.
    if (raceLogUnavailable) {
      if (typeof isNewFromCache === "boolean") {
        isNew = isNewFromCache;
      } else {
        isNew = false;
      }
    } else if (warHistory == null) {
      // Avoid global false positives when war history is missing; fall back to cached state if available.
      if (typeof isNewFromCache === "boolean") {
        isNew = isNewFromCache;
      } else {
        isNew = false;
      }
    } else {
      isNew = computeIsNewPlayer(warHistory, memberWarScore);
    }

    // Ensure we don't flag long‑inactive members as "new" for non BattleLog players.
    if (isNew && m.lastSeen) {
      const lastSeenDate = new Date(
        m.lastSeen.replace(
          /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/,
          "$1-$2-$3T$4:$5:$6.$7Z",
        ),
      );
      const lastSeenDays =
        (Date.now() - lastSeenDate.getTime()) / (1000 * 60 * 60 * 24);
      if (lastSeenDays > 7) {
        isNew = false;
      }
    }

    // Calcul des jours GDC de la semaine courante
    const warDays = (() => {
      const currentWeek = warHistory?.weeks?.find((w) => w.isCurrent) ?? null;
      // Source fiable 1 : semaine courante depuis warHistory (déjà issu de currentRace)
      // Source fiable 2 : currentRace.clan.participants en direct (fallback si warHistory
      //   n'a pas pu intégrer ce joueur, ex. fetch battleLog raté + race log partiel)
      const normalizedTag = m.tag.startsWith("#") ? m.tag : `#${m.tag}`;
      const raceParticipant =
        currentRace?.clan?.participants?.find((p) => p.tag === normalizedTag) ??
        null;
      const raceTotalDecks =
        currentWeek?.decksUsed ?? raceParticipant?.decksUsed ?? null;
      // On ne peut rien calculer si ni battleLog ni données de race ne sont disponibles
      if (battleLog === null && raceTotalDecks === null) return null;
      const effectiveBattleLog = battleLog ?? [];
      const summary = buildCurrentWarDays(
        effectiveBattleLog,
        raceTotalDecks,
        {
          state: currentRace?.state ?? null,
          periodIndex: currentRace?.periodIndex ?? null,
        },
        clanTag,
      );
      if (
        summary &&
        summary.daysFromThu > 0 &&
        (warHistory?.streakInCurrentClan ?? 0) === 1 &&
        (currentWeek?.decksUsed ?? 0) === 0
      ) {
        summary.arrivedMidWar = true;
        summary.arrivedOnDay = summary.daysFromThu + 1;
        summary.totalDecksUsed = 0;
        summary.isReliableTotal = true;
      }
      return summary;
    })();

    const totalDonations =
      playerProxy.totalDonations ?? m.totalDonations ?? null;

    return {
      name: m.name,
      tag: m.tag,
      role: m.role,
      trophies: m.trophies ?? 0,
      donations: m.donations ?? 0,
      totalDonations,
      donationsReceived: m.donationsReceived ?? 0,
      expLevel: m.expLevel ?? 1,
      reliability: reliabilityScore,
      reliabilitySource: scoreSource,
      verdict,
      color,
      isNew,
      discord: discordLinked,
      warDays,
      // Valeur numérique pour le tri de la colonne "This War"
      // -1 = arrivé en cours de semaine, null = hors période de guerre
      warDecks:
        warDays === null
          ? null
          : warDays.arrivedMidWar
            ? -1
            : (warDays.totalDecksUsed ?? 0),
      lastSeen: m.lastSeen ?? null,
      scoreVersion: SCORE_VERSION,
    };
  });

  const memberResults = await pooledAllSettled(memberTasks, MEMBER_CONCURRENCY);
  const analyzedMembers = memberResults.map((result, idx) => {
    if (result.status === "fulfilled") return result.value;
    const fallback = analyzeClanMembers([members[idx]])[0];
    console.warn(
      `[clan] member analysis failed for ${members[idx].tag}: ${result.reason?.message || result.reason}`,
    );
    return {
      ...fallback,
      reliabilitySource: "fallback",
      isNew: false,
      warDays: null,
      warDecks: null,
      lastSeen: members[idx].lastSeen ?? null,
    };
  });

  // Sort by reliability ascending (most at-risk first)
  analyzedMembers.sort((a, b) => (a.reliability ?? 0) - (b.reliability ?? 0));

  // Enrichir uncomplete avec isNew (calculé via l'historique de guerre de chaque membre)
  if (uncomplete && Array.isArray(uncomplete.players)) {
    const memberMap = new Map(analyzedMembers.map((m) => [m.tag, m]));
    uncomplete.players = uncomplete.players.map((p) => ({
      ...p,
      isNew: memberMap.get(p.tag)?.isNew ?? false,
    }));
  }

  // Aggregate stats for chart data
  const green = analyzedMembers.filter((m) => m.color === "green").length;
  const yellow = analyzedMembers.filter((m) => m.color === "yellow").length;
  const orange = analyzedMembers.filter((m) => m.color === "orange").length;
  const red = analyzedMembers.filter((m) => m.color === "red").length;
  const avgScore =
    analyzedMembers.length > 0
      ? Math.round(
          analyzedMembers.reduce((s, m) => s + (m.reliability ?? 0), 0) /
            analyzedMembers.length,
        )
      : 0;

  // determine whether a snapshot already exists for today; this lets the
  // frontend display an informative note beside "Live data".  we also
  // compute the date even when `raceLog` is missing so the UI can still
  // report "Snapshot : …" while outside war period.
  const { hasSnapshotForToday, getLastSnapshotDate } =
    await import("../services/snapshot.js");
  const snapshotToday = await hasSnapshotForToday(clanTag);
  const snapshotDate = await getLastSnapshotDate(clanTag);

  // Synthèse des combats GDC pour l'ensemble du clan (sans requête supplémentaire)
  let clanWarSummary = null;
  let lastWarSummary = null;

  const clampDeckTotal = (value) => {
    if (value == null || Number.isNaN(value)) return null;
    return Math.min(200, Math.max(0, Math.round(value)));
  };

  // Source de vérité : au moins un membre a des jours GDC courants calculés.
  // On utilise cela plutôt que periodType (peut être absent/différent selon l'API).
  const warActiveFromMembers = analyzedMembers.some((m) => m.warDays !== null);
  // Garde calendaire : hors jeu–dim, on ne construit jamais de clanWarSummary,
  // même si l'API renvoie encore periodType='warDay' après le reset du lundi.
  const _gdcDowClan = new Date(
    Date.now() - warResetOffsetMs(clanTag),
  ).getUTCDay();
  const isWarPeriodCalendar = _gdcDowClan === 0 || _gdcDowClan >= 4;

  if (
    isWarPeriodCalendar &&
    (warActiveFromMembers || currentRaceIndicatesWarDay)
  ) {
    // Déterminer daysFromThu : préférer sampleWarDays (calculé par membre), puis
    // periodIndex de l'API, puis fallback calendaire. Cela permet de construire un
    // résumé valide même si aucun participant n'a encore joué (début de jeudi).
    const sampleWarDays =
      analyzedMembers.find((m) => m.warDays && !m.warDays.arrivedMidWar)
        ?.warDays ?? null;

    let daysFromThu = sampleWarDays?.daysFromThu;
    if (daysFromThu === undefined || daysFromThu === null) {
      if (
        currentRace &&
        typeof currentRace.periodIndex === "number" &&
        currentRace.periodIndex >= 0 &&
        currentRace.periodIndex <= 3
      ) {
        daysFromThu = currentRace.periodIndex;
      } else {
        const now = new Date();
        const nowGdcDate = new Date(now.getTime() - warResetOffsetMs(clanTag));
        const dow = nowGdcDate.getUTCDay();
        if (dow === 0 || dow >= 4) {
          daysFromThu = dow === 4 ? 0 : dow === 5 ? 1 : dow === 6 ? 2 : 3;
        }
      }
    }

    if (daysFromThu !== undefined && daysFromThu !== null) {
      // En mode Colossée, currentRace.clan.participants peut contenir 3 clans
      // (150 joueurs). On filtre sur les membres actuels du clan uniquement.
      const allParticipants = currentRace?.clan?.participants ?? [];
      const participants = allParticipants.filter((p) =>
        currentMemberTags.has(normalizeTag(p.tag)),
      );
      // Total fiable depuis currentRace (cumul hebdo par participant)
      let totalDecksUsed = participants.reduce(
        (s, p) => s + (p.decksUsed ?? 0),
        0,
      );
      // Use fixed max values based on a full 50-member clan for reporting purposes.
      // This keeps the UI consistent with the 600/800 max legends even if the
      // current member count is slightly lower (e.g. due to in-progress recruitment).
      const MAX_MEMBERS = 50;
      const maxDecksElapsed = MAX_MEMBERS * (daysFromThu + 1) * 4; // 600 at day 3
      const maxDecksWeek = MAX_MEMBERS * 16; // 800 for full week
      totalDecksUsed = Math.min(maxDecksWeek, Math.max(0, totalDecksUsed));
      // Détail par jour : on combine snapshot (source fiable) et une estimation live
      // basée sur les cumul d'API (currentRace) pour limiter l'écart en cas de lag.
      const currentCumul = {};
      participants.forEach((p) => {
        currentCumul[p.tag] = p.decksUsed ?? 0;
      });
      const currentCumulTotal = Object.values(currentCumul).reduce(
        (s, v) => s + v,
        0,
      );

      const DAY_LABELS = ["Thu", "Fri", "Sat", "Sun"];
      // used to infer day totals when snapshot appears to undercount
      const dayTotals = Array(DAY_LABELS.length).fill(0);
      const existingDays =
        existingCache?.clanWarSummary?.days ??
        existingCache?.lastWarSummary?.days ??
        null;

      const days = DAY_LABELS.map((label, i) => {
        const snap = weekSnaps[i] ?? null;
        const prevSnap = weekSnaps[i - 1] ?? null;
        const existingDay = existingDays?.[i] ?? null;

        // Prefer the decks sum from the snapshot (matches warSnapshotDays),
        // fallback to the _cumul delta if decks are missing.
        const snapshotCountFromDecks =
          snap?.decks && Object.keys(snap.decks).length > 0
            ? Object.values(snap.decks).reduce((s, v) => s + v, 0)
            : null;
        const snapshotCountFromMeta = Number.isFinite(snap?.snapshotCount)
          ? clampDeckTotal(snap.snapshotCount)
          : null;

        const cumul = snap?._cumul ?? null;
        const prevCumul = prevSnap?._cumul ?? null;
        const cumulDelta =
          cumul && prevCumul
            ? Math.max(
                0,
                Object.values(cumul).reduce((s, v) => s + v, 0) -
                  Object.values(prevCumul).reduce((s, v) => s + v, 0),
              )
            : null;

        let snapshotCount =
          snapshotCountFromMeta !== null
            ? snapshotCountFromMeta
            : snapshotCountFromDecks !== null
              ? clampDeckTotal(snapshotCountFromDecks)
              : cumulDelta !== null
                ? clampDeckTotal(cumulDelta)
                : null;

        // Les jours passés sont immutables côté affichage.
        // On permet à un snapshot plus récent d'améliorer la valeur (jamais de descente).
        // ATTENTION : existingDay.source === 'live' signifie que la valeur en cache
        // est la valeur live de fin de journée (ex. 200), pas un snapshot figé.
        // On l'utilise uniquement comme dernier recours si elle est strictement
        // inférieure à 200, afin de conserver un total connu plutôt que d'inférer 200.
        if (i < daysFromThu) {
          const existingSnapshot =
            existingDay?.snapshotCount != null
              ? clampDeckTotal(existingDay.snapshotCount)
              : existingDay?.totalCount != null &&
                  existingDay?.source !== "live"
                ? clampDeckTotal(existingDay.totalCount)
                : null;

          if (existingSnapshot != null && existingSnapshot > 0) {
            if (
              snapshotCount == null ||
              snapshotCount === 0 ||
              existingSnapshot > snapshotCount
            ) {
              snapshotCount = existingSnapshot;
            }
          } else if (snapshotCount == null || snapshotCount === 0) {
            const existingTotal = existingDay?.totalCount;
            if (
              existingTotal > 0 &&
              (existingDay?.source !== "live" || existingTotal < 200)
            ) {
              snapshotCount = clampDeckTotal(existingTotal);
            }
          }
        }

        const knownPrevDaysTotal = dayTotals.reduce((s, v) => s + v, 0);
        const inferredFromLive =
          totalDecksUsed > knownPrevDaysTotal
            ? clampDeckTotal(totalDecksUsed - knownPrevDaysTotal)
            : null;

        let totalCount = null;
        let source = "unknown";
        let liveCount = null;

        if (i === daysFromThu) {
          const currentDayLive = participants.reduce(
            (sum, p) => sum + (p.decksUsedToday ?? 0),
            0,
          );
          liveCount = Math.max(0, Math.min(200, currentDayLive));
          totalCount = liveCount;
          source = "live";
          snapshotCount = null;
        } else if (i < daysFromThu) {
          if (snapshotCount != null) {
            totalCount = Math.min(200, snapshotCount);
            source = "snapshot";
          } else {
            totalCount = null;
            source = "unknown";
          }
          liveCount = null;
        } else {
          // future day
          totalCount = snapshotCount != null ? Math.min(200, snapshotCount) : 0;
          source = snapshotCount != null ? "snapshot" : "unknown";
          liveCount = null;
        }

        // keep track of what we used to compute subsequent days
        dayTotals[i] = totalCount ?? 0;

        return {
          label,
          totalCount,
          maxCount: 200,
          isPast: i < daysFromThu,
          isToday: i === daysFromThu,
          isFuture: i > daysFromThu,
          source,
          snapshotCount:
            snapshotCount !== null ? Math.min(200, snapshotCount) : null,
          liveCount,
        };
      });

      // Ensure consistency : totalDecksUsed = somme des jours (today live + jours précédents)
      const todayIdx = daysFromThu;
      const todayLiveSum = participants.reduce(
        (sum, p) => sum + (p.decksUsedToday ?? 0),
        0,
      );
      if (days[todayIdx]) {
        days[todayIdx].totalCount = Math.min(200, Math.max(0, todayLiveSum));
        days[todayIdx].source = "live";
        days[todayIdx].liveCount = todayLiveSum;
      }

      // Keep past snapshot counts intact and do not rebalance past days to fit current total.
      // This ensures Thu/Fri values remain authoritative (snapshot) instead of being modified.
      const finalPastTotal = days
        .slice(0, todayIdx)
        .reduce((sum, d) => sum + (d.totalCount ?? 0), 0);
      // si rien ne colle (gros écart), on tolère ; on ne modifie plus.
      if (finalPastTotal + todayLiveSum !== totalDecksUsed) {
        // fallback: garder totalDecksUsed comme source principale
        // et ne plus toucher si impossible de faire concorder proprement.
      }
      const finalTotalDecksUsed = Math.min(
        maxDecksWeek,
        Math.max(
          0,
          days.reduce((sum, d) => sum + (d.totalCount ?? 0), 0),
        ),
      );
      clanWarSummary = {
        totalDecksUsed: finalTotalDecksUsed,
        maxDecksElapsed,
        maxDecksWeek,
        participantCount: MAX_MEMBERS,
        daysFromThu,
        days,
        weekId: currWeekId,
        ended: false,
      };
    } // end if daysFromThu
  } // end if warDay

  // If we are outside an active war and no current-week snapshot exists,
  // fall back to the previous completed week snapshot (prevWeekId).
  if (
    !clanWarSummary &&
    getSnapshotsForWeeks &&
    (!weekSnaps || weekSnaps.length === 0) &&
    prevWeekId
  ) {
    const fallbackByWeek = await getSnapshotsForWeeks(clanTag, [prevWeekId]);
    const prevWeekSnaps = fallbackByWeek[prevWeekId] ?? [];
    if (prevWeekSnaps.length > 0) {
      weekSnaps = prevWeekSnaps;
      currWeekId = prevWeekId;

      // Keep the same derived debug fields as in war-week processing.
      warSnapshotDays = weekSnaps.map((s) => {
        if (!s) return null;
        const totalFromDecks =
          s.decks && Object.keys(s.decks).length > 0
            ? Object.values(s.decks).reduce(
                (acc, v) => acc + (typeof v === "number" ? v : 0),
                0,
              )
            : null;
        const snapshotCount = Number.isFinite(s.snapshotCount)
          ? Math.min(200, s.snapshotCount)
          : null;
        const total =
          snapshotCount != null
            ? snapshotCount
            : totalFromDecks != null && totalFromDecks > 0
              ? totalFromDecks
              : null;
        return total != null && total > 0 ? total : null;
      });

      const latestSnap = weekSnaps
        .map((s) => s.snapshotTime || s.snapshotBackupTime || null)
        .filter(Boolean)
        .sort()
        .pop();
      warSnapshotTakenAt = latestSnap ?? null;
    }
  }

  // If there is no current war summary (GDC ended), fall back to last available week snapshot.
  // Ne pas déclencher ce fallback si la guerre est encore active (on afficherait érronément ended:true).
  if (
    !clanWarSummary &&
    !warActiveFromMembers &&
    Array.isArray(weekSnaps) &&
    weekSnaps.length > 0
  ) {
    const DAY_LABELS = ["Thu", "Fri", "Sat", "Sun"];
    const days = DAY_LABELS.map((label, i) => {
      const snap = weekSnaps[i] ?? null;
      const totalFromDecks =
        snap?.decks && Object.keys(snap.decks).length > 0
          ? Object.values(snap.decks).reduce(
              (acc, v) => acc + (typeof v === "number" ? v : 0),
              0,
            )
          : null;
      const snapshotCount = Number.isFinite(snap?.snapshotCount)
        ? Math.min(200, snap.snapshotCount)
        : null;
      let totalCount =
        totalFromDecks != null && totalFromDecks > 0
          ? totalFromDecks
          : snapshotCount;
      if (totalCount != null) {
        totalCount = Math.min(200, Math.max(0, totalCount));
      }
      return {
        label,
        totalCount,
        maxCount: 200,
        isPast: true,
        isToday: false,
        isFuture: false,
        source: totalCount != null ? "snapshot" : "unknown",
        snapshotCount: totalCount,
        liveCount: null,
      };
    });

    let totalDecksUsed = days.reduce((sum, d) => sum + (d.totalCount ?? 0), 0);
    const MAX_MEMBERS = 50;
    const maxDecksElapsed = MAX_MEMBERS * 16;
    const maxDecksWeek = MAX_MEMBERS * 16;
    totalDecksUsed = Math.min(totalDecksUsed, maxDecksWeek);

    // Ensure debug stats available even hors course (fallback via snapshot)
    warSnapshotDays = days.map((d) =>
      d.totalCount != null ? d.totalCount : null,
    );
    warSnapshotTakenAt =
      weekSnaps
        .map((s) => s.snapshotTime || s.snapshotBackupTime || null)
        .filter(Boolean)
        .sort()
        .pop() ?? warSnapshotTakenAt;

    clanWarSummary = {
      totalDecksUsed,
      maxDecksElapsed,
      maxDecksWeek,
      participantCount: members.length,
      daysFromThu: 4,
      days,
      weekId: currWeekId,
      ended: true,
    };
  }

  // build helper data for frontend debug display
  let currentWarDays = null;
  if (clanWarSummary && clanWarSummary.days) {
    const now = new Date();
    const nowGdcDate = new Date(now.getTime() - warResetOffsetMs(clanTag));
    const thuGdcMs =
      nowGdcDate.getTime() - (clanWarSummary.daysFromThu ?? 0) * MS_PER_DAY;
    currentWarDays = clanWarSummary.days.map((d, i) => ({
      key: new Date(thuGdcMs + i * MS_PER_DAY).toISOString().slice(0, 10),
      label: d.label,
      count: d.totalCount,
      isPast: d.isPast,
      isToday: d.isToday,
      isFuture: d.isFuture,
      source: d.source || "unknown",
      snapshotCount: d.snapshotCount ?? null,
      liveCount: d.liveCount ?? null,
    }));
  }

  // Merge in persisted cache fallback when current war summary has unset/zero past days.
  // This prevents losing pre-existing snapshot values (e.g. Thu count) during partial live updates.
  const fallbackWarSummary =
    existingCache?.clanWarSummary ?? existingCache?.lastWarSummary ?? null;
  const mergeWarSummariesBackend = (current, backup) => {
    if (!current) return backup || null;
    if (!backup) return current;
    const days = (current.days ?? []).map((day, idx) => {
      if (!day || typeof day !== "object") return day;
      const backupDay = (backup.days ?? [])[idx] ?? null;
      const currentValue =
        typeof day.totalCount === "number" ? day.totalCount : null;
      const backupValue =
        typeof backupDay?.totalCount === "number" ? backupDay.totalCount : null;
      const hasExplicitCurrent =
        day.source === "snapshot" ||
        day.source === "live" ||
        Number.isFinite(day.snapshotCount);
      const hasCurrent = currentValue != null;
      const shouldUseBackup =
        backupValue != null &&
        backupValue > 0 &&
        (!hasCurrent || currentValue <= 0);

      if (day.isPast) {
        if (shouldUseBackup) {
          return {
            ...day,
            totalCount: backupValue,
            snapshotCount: backupValue,
            source: "snapshot",
          };
        }
        if (hasExplicitCurrent) {
          return day;
        }
        if (backupValue != null) {
          return {
            ...day,
            totalCount: backupValue,
            snapshotCount: backupValue,
            source: "snapshot",
          };
        }
        if (hasCurrent) {
          return {
            ...day,
            totalCount: currentValue,
            snapshotCount: currentValue,
            source: day.source === "live" ? "unknown" : "snapshot",
          };
        }
        return {
          ...day,
          totalCount: null,
          snapshotCount: null,
          source: "snapshot",
        };
      }

      // Today/future: keep current computed source state (do not override with backup)
      return day;
    });
    const totalDecksUsed = days.reduce(
      (sum, d) => sum + (typeof d?.totalCount === "number" ? d.totalCount : 0),
      0,
    );
    return { ...current, totalDecksUsed, days };
  };

  let debugSnapshotInfo = null;
  clanWarSummary = mergeWarSummariesBackend(clanWarSummary, fallbackWarSummary);

  if (clanWarSummary && Array.isArray(clanWarSummary.days)) {
    const backupDays = fallbackWarSummary?.days ?? [];
    warSnapshotDays = clanWarSummary.days.map((day, idx) => {
      if (!day || typeof day.totalCount !== "number") {
        const backupTotal =
          typeof backupDays[idx]?.totalCount === "number"
            ? backupDays[idx].totalCount
            : null;
        return backupTotal != null
          ? Math.min(200, Math.max(0, backupTotal))
          : null;
      }
      if (day.isFuture && day.snapshotCount == null) return null;
      return Math.min(200, Math.max(0, day.totalCount));
    });

    const warnings = [];
    if (
      clanWarSummary.days.some((d) => {
        if (!d.isPast) return false;
        if (d.totalCount == null) return true;
        return (
          d.totalCount === 0 &&
          d.source !== "snapshot" &&
          d.source !== "live" &&
          !Number.isFinite(d.snapshotCount)
        );
      })
    ) {
      warnings.push("missingOrZeroPastDay");
    }
    if (
      clanWarSummary.days.some(
        (d) =>
          d.isPast &&
          d.snapshotCount != null &&
          d.snapshotCount !== d.totalCount,
      )
    ) {
      warnings.push("pastDayMismatch");
    }
    clanWarSummary.snapshotWarnings = warnings;
  }

  const computedLastWarSummary = existingCache?.lastWarSummary || null;
  const snapshotFileDebug = await getSnapshotFileDebug(clanTag).catch(
    () => null,
  );

  return {
    lastWarSummary: computedLastWarSummary,
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
      warResetUtcMinutes: warResetOffsetMs(clanTag) / 60000,
    },
    membersRaw,
    members: analyzedMembers,
    summary: {
      green,
      yellow,
      orange,
      red,
      avgScore,
      total: analyzedMembers.length,
    },
    isWarPeriod:
      clanWarSummary != null ||
      analyzedMembers.some((m) => m.warDays !== null) ||
      // La garde calendaire prime sur periodType : l'API peut encore renvoyer
      // 'warDay' juste après le reset du lundi — on refuse d'entrer en mode GDC
      // hors jeu–dim selon l'heure de reset du clan.
      (isCurrentRaceWarDay && isWarPeriodCalendar),
    isColosseum: currentRace?.periodType === "colosseum",
    topPlayers, // added by computeTopPlayers
    uncomplete, // new list of incomplete deck players
    clanWarSummary, // synthèse GDC clan (null hors période de guerre)
    prevWeekId, // identifiant semaine précédente (pour Last War cards)
    snapshotToday, // boolean for backwards compatibility
    snapshotDate, // ISO date or null, used by frontend for message
    warCurrentWeekId: clanWarSummary?.weekId ?? null,
    warSnapshotDays, // derived from snapshot files (null if missing)
    snapshotTakenAt: warSnapshotTakenAt,
    snapshotFileDebug,
    currentWarDays: clanWarSummary?.days ?? null, // expose the per-day summary for debug/insights
    raceGroup: currentRace?.clans
      ? (() => {
          // ═══════════════════════════════════════════════════════════════════════
          // CURRENT WAR GROUP — source de vérité
          // ═══════════════════════════════════════════════════════════════════════
          //
          // Variables exposées par entrée du tableau raceGroup :
          //
          // tag              {string}  Tag du clan (#XXXXX)
          // name             {string}  Nom du clan
          // rank             {number}  Classement dans le groupe de course
          // members          {number}  Nb membres actifs
          // clanWarTrophies  {number}  Trophées de guerre du clan
          //
          // prevWarFame      {number}  Total pts semaine N-2  [≈ 50 000–200 000]
          // lastWarFame      {number}  Total pts semaine N-1  [≈ 50 000–200 000]
          //   → source : raceLog[1]/[0].standings.clan.participants (sum)
          //   → affichés dans les colonnes "N-2 WAR" et "LAST WAR"
          //
          // decksToday       {number}  Decks joués aujourd'hui (en période warDay)
          //                           [0–200, 50 membres × 4 decks max]
          //   → clan propre  : sum(currentRace.clan.participants.decksUsedToday),
          //                    membres actifs uniquement (filtre currentMemberTags)
          //   → rivaux       : sum(clans[i].participants.decksUsedToday)
          //   → null hors période warDay
          //
          // targetDecksToday {number}  Cible de decks pour la journée  [100–200]
          //   → clan propre J2-J4 : warSnapshotDays[warDayIndex-1] (snapshot veille)
          //   → rivaux J2-J4      : (totalDecksWeekly - decksToday) / warDayIndex
          //   → J1 / fallback     : moyenne decks semaine passée (raceLog[0]) ou 200
          //
          // ptsPerDeck       {number}  Efficacité pts/deck  [100–250]
          //   → clan propre  : currentRace.clan.periodPoints / decksToday (source de vérité directe)
          //                    fallback : ownHistoricPpd si periodPoints indisponible
          //   → rivaux       : c.periodPoints / decksToday (source de vérité directe)
          //                    fallback : rivalAvgPtsPerDeckByTag quand decksToday === 0
          //
          // clanScore        {number}  Pts du jour  [0–50 000]
          //   → clan propre  : currentRace.clan.periodPoints (exact, API directe)
          //   → rivaux       : currentRace.clans[i].periodPoints (exact, même appel API)
          //
          // projectedFame    {number}  Projection pts fin de journée  [5 000–50 000]
          //   = max(decksToday, targetDecks) × ptsPerDeck
          //   → hypothèse : les decks restants (targetDecks - decksToday) auront
          //     la même efficacité que les decks déjà joués
          //   → en mode Colosseum, la valeur est cumulée au total live actuel
          //     (currentFame + points estimés restants).
          //
          // projectedRank    {string}  Rang projeté ("1st"…"5th")
          //
          // currentFame      {number}  Fame cumulée actuelle de la semaine
          // maxReachableFame {number}  Fame max théorique atteignable
          //                            = currentFame + (800 - decksUsedWeekly) * 200
          // isClinchedWin    {boolean} Victoire mathématiquement assurée
          //                            (strictement au-dessus du max atteignable
          //                            de tous les autres clans du groupe)
          //
          // warResetUtcMinutes {number}  Heure du reset GDC en minutes UTC  [540–660]
          //   → tiré de warResetOffsetMs(tag) — differ per clan, set manually in dateUtils.js
          //
          // ═══════════════════════════════════════════════════════════════════════
          const ownTagNorm = `#${clanTag}`.toUpperCase();
          const ownLastStanding = (raceLog?.[0]?.standings ?? []).find(
            (s) => (s.clan?.tag ?? "").toUpperCase() === ownTagNorm,
          );
          const ownLastWarFame = sumParticipantsFame(ownLastStanding);
          const ownPrevStanding = (raceLog?.[1]?.standings ?? []).find(
            (s) => (s.clan?.tag ?? "").toUpperCase() === ownTagNorm,
          );
          const ownPrevWarFame = sumParticipantsFame(ownPrevStanding);

          // Garde calendaire identique à la route principale : hors jeu–dim,
          // on ne passe jamais en mode warDay même si l'API dit encore 'warDay'.
          const isWarPeriod =
            isWarPeriodCalendar &&
            (currentRace?.periodType === "warDay" ||
              currentRace?.periodType === "colosseum" ||
              currentRace?.state === "warDay" ||
              currentRace?.state === "overtime" ||
              currentRace?.state === "full");
          const isColosseum = currentRace?.periodType === "colosseum";

          // Step 1: Pré-calcul des projections pour tous les clans du groupe
          // Calcul de la moyenne de decks de la semaine passée pour ce clan
          let ownAvgDecks = null;
          let ownHistoricPpd = null;
          if (Array.isArray(raceLog) && raceLog[0]) {
            const lastStanding = (raceLog[0].standings ?? []).find(
              (s) =>
                (s.clan?.tag ?? "").replace("#", "").toUpperCase() ===
                clanTag.toUpperCase(),
            );
            const totalDecksLastWeek = sumParticipantsDecks(lastStanding);
            if (totalDecksLastWeek != null) {
              ownAvgDecks = totalDecksLastWeek / 4;
              // Efficacité historique : même logique que pour les rivaux
              if (ownLastWarFame > 0 && totalDecksLastWeek > 0) {
                ownHistoricPpd = ownLastWarFame / totalDecksLastWeek;
              }
            }
          }

          const warDayIndex =
            buildCurrentWarDays([], null, currentRace, clanTag)?.daysFromThu ??
            0;

          let debugSnapshotInfoRoot = null;
          const groupWithProjections = currentRace.clans.map((c) => {
            let rivalParticipants = null;
            const cTagNorm = (c.tag ?? "").toUpperCase();
            const isOwn = cTagNorm === ownTagNorm;
            let debugSnapshotInfo = null;
            // (déjà défini plus haut)
            // raceData = currentRace (clan propre uniquement) ; pour les rivaux, utiliser c.participants directement
            const raceData = currentRace;
            // allParts toujours défini
            const allParts = isOwn
              ? (raceData?.clan?.participants ?? [])
              : (() => {
                  rivalParticipants = c.participants ?? [];
                  return rivalParticipants;
                })();
            // Ajout debug-panel modulaire
            if (isOwn && warDayIndex > 0) {
              debugSnapshotInfo = buildDebugSnapshotInfo({
                weekSnaps,
                warDayIndex,
                currentMemberTags,
                allParts,
                warSnapshotDays,
                clanTag,
                currentRaceClanFame: currentRace?.clan?.fame ?? null,
                fallbackWarDays:
                  typeof prevSnaps !== "undefined" && prevSnaps.length > 0
                    ? prevSnaps
                    : (existingCache?.debugSnapshotInfo?.weekSnaps ??
                      existingCache?.clanWarSummary?.days ??
                      existingCache?.lastWarSummary?.debugSnapshotInfo
                        ?.weekSnaps ??
                      existingCache?.lastWarSummary?.days ??
                      []),
              });
            }
            if (debugSnapshotInfo && !debugSnapshotInfoRoot)
              debugSnapshotInfoRoot = debugSnapshotInfo;
            const extra = isOwn ? clan : raceGroupRivalData[cTagNorm] || null;
            // (déjà défini plus haut)

            let decksToday = null;
            let ptsPerDeck = null;
            let projectedFame = null;
            let clanScore = null;
            let currentFame = null;
            let maxReachableFame = null;
            let isClinchedWin = false;

            // rivalParticipants n'est utilisé que côté rivaux, jamais côté isOwn
            if (isWarPeriod && warDayIndex === 0) {
              const avgDecksLastWeek = isOwn
                ? ownAvgDecks
                : rivalAvgDecksByTag[cTagNorm];
              if (avgDecksLastWeek != null) {
                c.targetDecksToday = Math.round(avgDecksLastWeek);
              }
            }

            if (
              isWarPeriod &&
              (isOwn
                ? raceData?.clan?.participants
                : (rivalParticipants ?? []).length > 0)
            ) {
              const allPartsInner = isOwn
                ? raceData.clan.participants
                : rivalParticipants;
              // currentFame = cumul hebdomadaire des pts de bataille depuis J1.
              // clan.fame est le score de progression de classement (≠ fame de combat) ; ne jamais l'utiliser ici.
              currentFame = allPartsInner.reduce(
                (s, p) => s + (p.fame ?? 0),
                0,
              );
              const sectionFame = currentFame; // alias de compatibilité locale

              // Borne haute théorique stricte pour la fin de semaine.
              // 800 = 50 membres * 4 decks * 4 jours ; 200 fame max/deck (CW2).
              const MAX_WEEKLY_DECKS = 800;
              const MAX_FAME_PER_DECK = 200;

              // decksToday : exclure les ex-membres pour cohérence avec clanWarSummary
              const activePartsToday = isOwn
                ? allPartsInner.filter((p) =>
                    currentMemberTags.has(normalizeTag(p.tag)),
                  )
                : allPartsInner;
              decksToday = activePartsToday.reduce(
                (s, p) => s + (p.decksUsedToday ?? 0),
                0,
              );
              // totalDecksWeekly : nécessaire uniquement pour le calcul de targetDecks (rivaux)
              const totalDecksWeekly = allPartsInner.reduce(
                (s, p) => s + (p.decksUsed ?? 0),
                0,
              );
              const remainingDecksWeekly = Math.max(
                0,
                MAX_WEEKLY_DECKS - totalDecksWeekly,
              );
              const maxDecksPerDay = 200;
              const remainingDecksToday = Math.max(
                0,
                maxDecksPerDay - decksToday,
              );
              const remainingFullDays = Math.max(0, 3 - warDayIndex);
              const remainingDecks = Math.min(
                remainingDecksWeekly,
                remainingDecksToday + remainingFullDays * maxDecksPerDay,
              );
              maxReachableFame =
                sectionFame + remainingDecks * MAX_FAME_PER_DECK;

              const avgDecksLastWeek = isOwn
                ? ownAvgDecks
                : rivalAvgDecksByTag[cTagNorm];
              let targetDecks;

              if (
                isOwn &&
                warDayIndex > 0 &&
                warSnapshotDays?.[warDayIndex - 1] != null
              ) {
                // Clan propre J2-J4 : cible = snapshot de la veille (reflète la journée précédente réelle)
                targetDecks = warSnapshotDays[warDayIndex - 1];
              } else if (warDayIndex > 0) {
                // J2-J4 (rivaux) : cible = moyenne des jours passés (seule donnée disponible)
                const decksPassed = totalDecksWeekly - decksToday;
                targetDecks = decksPassed / warDayIndex;
              } else {
                // J1 (ou par défaut) : on utilise la moyenne de la semaine passée
                targetDecks = avgDecksLastWeek ?? 200;
              }

              // weeklyDecks : fallback de secours si la fame live du jour est indisponible.
              const weeklyDecks = allPartsInner.reduce(
                (s, p) => s + (p.decksUsed ?? 0),
                0,
              );
              const liveDayFame = typeof c.fame === "number" ? c.fame : null;

              if (decksToday > 0) {
                if (isColosseum) {
                  if (totalDecksWeekly > 0) {
                    ptsPerDeck = currentFame / totalDecksWeekly;
                  } else if (weeklyDecks > 0) {
                    ptsPerDeck = sectionFame / weeklyDecks;
                  }
                  clanScore =
                    Math.round((decksToday * (ptsPerDeck ?? 0)) / 10) * 10;
                } else if (isOwn) {
                  // periodPoints est la source de vérité directe pour les pts du jour courant.
                  // Plus besoin de calculer un delta via les snapshots J-1.
                  const periodPoints = currentRace.clan.periodPoints;
                  if (periodPoints != null && decksToday > 0) {
                    clanScore = periodPoints;
                    ptsPerDeck = periodPoints / decksToday;
                  } else if (ownHistoricPpd != null) {
                    ptsPerDeck = ownHistoricPpd;
                    clanScore = Math.round((decksToday * ptsPerDeck) / 10) * 10;
                  }
                } else {
                  // Rivaux : c.periodPoints est la source de vérité directe pour les pts du jour.
                  const rivalPeriodPoints = c.periodPoints;
                  if (rivalPeriodPoints != null && decksToday > 0) {
                    clanScore = rivalPeriodPoints;
                    ptsPerDeck = rivalPeriodPoints / decksToday;
                  } else {
                    // Fallback pour projection quand decksToday === 0
                    const rivalPpd = rivalAvgPtsPerDeckByTag[cTagNorm];
                    if (
                      typeof rivalPpd === "number" &&
                      Number.isFinite(rivalPpd) &&
                      rivalPpd > 0
                    ) {
                      ptsPerDeck = rivalPpd;
                    }
                    if (ptsPerDeck != null && decksToday > 0) {
                      clanScore =
                        Math.round((decksToday * ptsPerDeck) / 10) * 10;
                    }
                  }
                }

                if (
                  debugSnapshotInfo?.delta === 0 &&
                  debugSnapshotInfo?.livePlayersWithDecks > 0
                ) {
                  ptsPerDeck = 0;
                  projectedFame = 0;
                  clanScore = 0;
                  isClinchedWin = true;
                }

                if (ptsPerDeck === 0 && decksToday > 0 && !isClinchedWin) {
                  isClinchedWin = true;
                }

                if (ptsPerDeck != null) {
                  if (isColosseum && currentFame != null) {
                    const remainingDecks = Math.max(
                      0,
                      targetDecks - decksToday,
                    );
                    projectedFame = currentFame + remainingDecks * ptsPerDeck;
                  } else {
                    projectedFame =
                      Math.max(decksToday, targetDecks) * ptsPerDeck;
                  }
                }
              }

              // On transmet la cible pour affichage
              c.targetDecksToday = Math.round(targetDecks);
            }

            // Expose le debugSnapshotInfo à la racine de la réponse
            // (déjà défini plus haut)
            return {
              tag: c.tag ?? null,
              name: c.name ?? null,
              rank: c.rank ?? null,
              members: extra?.members ?? null,
              clanWarTrophies: extra?.clanWarTrophies ?? null,
              // clanScore = pts du jour depuis l’API (periodPoints) — exact pour tous les clans du groupe.
              clanScore: clanScore ?? 0,
              prevWarFame: isOwn
                ? ownPrevWarFame
                : (rivalPrevWarByTag[cTagNorm] ?? null),
              // Ajout debug-panel.
              // `debugSnapshotInfo` contient désormais les scores journaliers par jour de guerre :
              //   scoreJeudi, scoreVendredi, scoreSamedi, scoreDimanche
              // et un objet structuré dailyScores { jeudi, vendredi, samedi, dimanche }.
              debugSnapshotInfo: isOwn ? debugSnapshotInfo : undefined,
              lastWarFame: isOwn
                ? ownLastWarFame
                : (rivalLastWarByTag[cTagNorm] ?? null),
              // Nouveaux champs
              decksToday,
              ptsPerDeck,
              projectedFame,
              currentFame,
              maxReachableFame,
              isClinchedWin,
              targetDecksToday: c.targetDecksToday,
              warResetUtcMinutes: warResetOffsetMs(c.tag) / 60000,
            };
          });

          // Step 2: Détecter une victoire assurée et déterminer le rang projeté.
          if (isWarPeriod) {
            const reliableClinchedData = groupWithProjections.every(
              (c) =>
                typeof c.currentFame === "number" &&
                typeof c.maxReachableFame === "number" &&
                Number.isFinite(c.maxReachableFame) &&
                typeof c.decksToday === "number",
            );

            if (reliableClinchedData) {
              // Détection rigoureuse d'une victoire déjà assurée :
              // currentFame du clan > maxReachableFame de tous les autres.
              groupWithProjections.forEach((c) => {
                const rivalsMax = groupWithProjections
                  .filter((x) => x.tag !== c.tag)
                  .map((x) => x.maxReachableFame);
                if (rivalsMax.length === 0) return;
                const bestRivalReachable = Math.max(...rivalsMax);
                c.isClinchedWin = c.currentFame > bestRivalReachable;

                // Si la victoire est déjà assurée sur J4, la projection ne doit plus
                // reposer sur la moyenne précédente : aucun point supplémentaire ne
                // sera compté pour la journée.
                if (c.isClinchedWin && warDayIndex === 3) {
                  c.projectedFame = 0;
                  c.ptsPerDeck = 0;
                  c.clanScore = 0;
                }
              });
            }

            const sortedByProjection = [...groupWithProjections].sort(
              (a, b) => {
                const aClinched = a.isClinchedWin ? 1 : 0;
                const bClinched = b.isClinchedWin ? 1 : 0;
                if (aClinched !== bClinched) return bClinched - aClinched;
                return (b.projectedFame ?? 0) - (a.projectedFame ?? 0);
              },
            );
            groupWithProjections.forEach((c) => {
              c.projectedRank =
                sortedByProjection.findIndex((s) => s.tag === c.tag) + 1;
            });
          }

          debugSnapshotInfo = debugSnapshotInfoRoot;
          if (debugSnapshotInfo && clanWarSummary) {
            clanWarSummary.debugSnapshotInfo = debugSnapshotInfo;
          }
          return groupWithProjections;
        })()
      : null,
    rateLimited: memberRateLimited,
    raceLogUnavailable,
    frRank,
    frPreviousRank,
    analysisCacheUpdatedAt: new Date().toISOString(),
    debugSnapshotInfo,
  };
}

export { router as default };
