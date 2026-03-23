// ============================================================
// routes/clan.js — Clan-related API routes
// ============================================================

import { Router } from 'express';
import { fetchClan, fetchClanMembers, fetchRaceLog, fetchBattleLog, fetchPlayer, fetchCurrentRace } from '../services/clashApi.js';
import {
  analyzeClanMembers, buildWarHistory, computeWarScore,
  computeWarReliabilityFallback, categorizeBattleLog,
  filterWarBattles, expandDuelRounds, isWarWin, buildCurrentWarDays,
  estimateWinsFromFame, warResetOffsetMs, scoreTotalDonations,
  mergeWarHistoryWithTransfer,
} from '../services/analysisService.js';
import { computeTopPlayers } from '../services/topplayers.js';
import { computeUncomplete } from '../services/uncomplete.js';
import { getOrSet } from '../services/cache.js';
import { getDiscordLinks } from '../services/discordLinks.js';
import { recordSnapshot } from '../services/snapshot.js';
import fs from 'fs/promises';
import path from 'path';

const router = Router();

// One day in milliseconds (used for war day calculations)
const MS_PER_DAY = 24 * 60 * 60 * 1000;

/**
 * When a player appears in another family clan, we consider them a transfer
 * if they played at least this many decks in the most recent completed week.
 */
const FAMILY_TRANSFER_DECKS_THRESHOLD = 13;

/**
 * Only consider the most recent completed week for transfer detection.
 */
const FAMILY_TRANSFER_WINDOW_WEEKS = 1;

/**
 * Run async tasks with limited concurrency to avoid rate-limiting.
 * Returns an array of { status, value } | { status, reason } mirroring Promise.allSettled.
 */
async function pooledAllSettled(tasks, concurrency = 10) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = { status: 'fulfilled', value: await tasks[i]() };
      } catch (err) {
        results[i] = { status: 'rejected', reason: err };
      }
    }
  }
  await Promise.all(Array.from({ length: Math.min(concurrency, tasks.length) }, worker));
  return results;
}

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
    // normalize: strip leading # and uppercase so it matches ALLOWED_CLANS
    let clanTag = req.params.tag;
    if (clanTag.startsWith('#')) clanTag = clanTag.slice(1);
    clanTag = clanTag.toUpperCase();

    if (!ALLOWED_CLANS.includes(clanTag)) {
      return res.status(400).json({ error: 'Clan not in allowed list' });
    }

    // short-lived in-memory cache to speed up back/forward and repeated
    // clicks on the same instance.  TTL is small so stale issues are rare.
    const cacheKey = `clan:${clanTag}`;
    const { value:payload, fromCache } = await getOrSet(cacheKey, () => buildClanAnalysis(clanTag), 30 * 1000);
    // prevent Vercel/edge from caching this response
    res.set('Cache-Control', 'no-store, max-age=0, must-revalidate');
    res.set('X-Cache', fromCache ? 'HIT' : 'MISS');
    res.json(payload);
  } catch (err) {
    const status = err.message.includes('404') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// Force a snapshot generation for the given clan (useful for debugging / manual refresh).
// This runs the same logic as the nightly cron but is triggered on demand.
router.post('/:tag/snapshot', async (req, res) => {
  try {
    let clanTag = req.params.tag;
    if (clanTag.startsWith('#')) clanTag = clanTag.slice(1);
    clanTag = clanTag.toUpperCase();

    if (!ALLOWED_CLANS.includes(clanTag)) {
      return res.status(400).json({ error: 'Clan not in allowed list' });
    }

    // Fetch the current race (live) and race log (to compute week id).
    const [raceLog, currentRace] = await Promise.all([
      fetchRaceLog(clanTag).catch(() => null),
      fetchCurrentRace(clanTag).catch(() => null),
    ]);

    if (!currentRace || currentRace.periodType !== 'warDay') {
      return res.status(400).json({ error: 'No active war in progress' });
    }

    // Determine week identifier (same logic as in buildClanAnalysis)
    const currSection = currentRace.sectionIndex ?? 0;
    let seasonId = raceLog?.[0]?.seasonId;
    if (seasonId !== undefined && currSection <= (raceLog[0]?.sectionIndex ?? -1)) seasonId += 1;
    const weekId = seasonId != null ? `S${seasonId}W${currSection + 1}` : `W${currSection + 1}`;

    await recordSnapshot(clanTag, currentRace.clan.participants, weekId);
    res.json({ ok: true, weekId });
  } catch (err) {
    const status = err.message.includes('404') ? 404 : 500;
    res.status(status).json({ error: err.message });
  }
});

// list of clans the UI is allowed to query (uppercase normalized, without '#')
// Removing the leading hash simplifies comparisons both in the router
// and when callers invoke `buildClanAnalysis` programmatically.
export const ALLOWED_CLANS = [
  'Y8JUPC9C', // La Resistance
  'LRQP20V9', // Les Resistants
  'QU9UQJRL', // Les Revoltes
];

export async function buildClanAnalysis(clanTag) {
    // sanitiZe input exactly as the route does
    if (clanTag.startsWith('#')) clanTag = clanTag.slice(1);
    clanTag = clanTag.toUpperCase();

    if (!ALLOWED_CLANS.includes(clanTag)) {
      throw new Error('Clan not allowed');
    }
    const [clan, members] = await Promise.all([
      fetchClan(clanTag),
      fetchClanMembers(clanTag),
    ]);

    // Chargement des liens Discord (tag → discord_user_id) — cache 5 min
    const discordLinks = await getDiscordLinks().catch(() => ({}));

    // Fetch race log once and compute war-based scores for every member.
    // Fall back to the legacy activity score for members absent from the log.
    let raceLog = null;
    let currentRace = null;
    try {
      [raceLog, currentRace] = await Promise.all([
        fetchRaceLog(clanTag),
        fetchCurrentRace(clanTag).catch(() => null),
      ]);
    } catch (_) { /* silent */ }

    // compute top players for a few predefined fame quotas so the frontend
    // can render the "Last War Best Players" card without additional
    // network requests. the helper gracefully handles missing logs.
    const topPlayers = await computeTopPlayers(clanTag, members, [2400, 2600, 2800], raceLog);

    // Preload family clan race logs to detect recent transfers between clans.
    // This avoids querying the API repeatedly for each member.
    const familyRaceLogs = {};
    await Promise.all(
      ALLOWED_CLANS.filter((t) => t !== clanTag).map(async (tag) => {
        try {
          familyRaceLogs[tag] = await fetchRaceLog(tag);
        } catch (_) {
          familyRaceLogs[tag] = null;
        }
      })
    );

    const findRecentFamilyTransfer = (playerTag) => {
      if (!playerTag) return null;
      const normalizedTag = playerTag.startsWith('#') ? playerTag : `#${playerTag}`;

      for (const [otherTag, otherRaceLog] of Object.entries(familyRaceLogs)) {
        if (!otherRaceLog || otherRaceLog.length === 0) continue;
        const otherHistory = buildWarHistory(playerTag, otherRaceLog, otherTag, null);
        if (!otherHistory?.weeks?.length) continue;

        const week = otherHistory.weeks[0];
        if ((week.decksUsed ?? 0) >= FAMILY_TRANSFER_DECKS_THRESHOLD) {
          return { transferWeek: week, fromClanTag: otherTag };
        }
      }

      return null;
    };

    // Enregistre le snapshot journalier depuis la course EN COURS (currentRace),
    // pas depuis le race log terminé. decksUsed = cumul depuis jeudi → le delta
    // inter-snapshots donne les combats du jour.
    // On n'enregistre que pendant 'warDay' : en période training, decksUsed
    // reflète la guerre précédente terminée et produirait des valeurs erronées.
    // On utilise periodType (et non state qui peut valoir 'full' quand le clan
    // a atteint 10 000 fame) pour distinguer guerre vs entraînement.
    if (currentRace?.periodType === 'warDay' && currentRace?.clan?.participants?.length > 0) {
      const participants = currentRace.clan.participants;
      // seasonId absent de currentriverrace → on le prend dans le race log terminé.
      // sectionIndex est 0-based côté API ; RoyaleAPI affiche en 1-based (S130W1 = sectionIndex 0).
      // Si sectionIndex courant ≤ sectionIndex du dernier log, on est passé à la saison suivante.
      const currSection = currentRace.sectionIndex ?? 0;
      let seasonId = raceLog?.[0]?.seasonId;
      if (seasonId !== undefined && currSection <= (raceLog[0]?.sectionIndex ?? -1)) seasonId += 1;
      const weekId = seasonId != null ? `S${seasonId}W${currSection + 1}` : `W${currSection + 1}`;
      import('../services/snapshot.js').then(({ recordSnapshot }) => {
        recordSnapshot(clanTag, participants, weekId).catch(()=>{/* silent */});
      });
    }

    // fetch full player profiles + battle logs for ALL members with capped concurrency
    // (avoids RoyaleAPI rate-limiting that caused non-deterministic scores on reload)
    let memberDataResults = [];
    if (raceLog) {
      memberDataResults = await pooledAllSettled(
        members.map((m) => () => Promise.all([fetchPlayer(m.tag), fetchBattleLog(m.tag)]))
      );
      // debug: log any failures
      memberDataResults.forEach((res, idx) => {
        if (res.status === 'rejected') {
          console.warn(`member fetch failed for ${members[idx].tag}:`, res.reason?.message || res.reason);
        }
      });
    }

    // build map of battle logs by tag for later use
    const battleLogsByTag = {};
    if (memberDataResults.length) {
      memberDataResults.forEach((res, idx) => {
        if (res.status === 'fulfilled') {
          const tag = members[idx].tag;
          battleLogsByTag[tag] = res.value[1];
        }
      });
    }

    // compute list of players who didn't do the full 16 decks last week (with breakdown)
    let uncomplete = await computeUncomplete(clanTag, members, battleLogsByTag, raceLog);

    // override/update daily breakdown using snapshots if available and race log exists
    let weekSnaps = [];
    let prevWeekId = null;
    let currWeekId = null;
    let warSnapshotDays = null;
    let warSnapshotTakenAt = null;

    let getSnapshotsForWeek = null;
    let getWarDayName = null;
    let getWarDayKey = null;

    if (raceLog && raceLog.length > 0) {
      ({ getSnapshotsForWeek, getWarDayName, getWarDayKey } = await import('../services/snapshot.js'));

      // --- Snapshots semaine PRÉCÉDENTE → enrichissement uncomplete ---
      // raceLog[0] est la semaine terminée : sectionIndex=0 → "S130W1"
      prevWeekId = `S${raceLog[0].seasonId}W${raceLog[0].sectionIndex + 1}`;
      const prevSnaps = await getSnapshotsForWeek(clanTag, prevWeekId);
      if (prevSnaps.length > 0 && uncomplete && Array.isArray(uncomplete.players)) {
        const dayIndex = { thursday: 0, friday: 1, saturday: 2, sunday: 3 };

        // Determine whether we have snapshots for all 4 GDC days (thu→sun).
        const snapshotDays = new Set();
        for (const snap of prevSnaps) {
          const warDay = snap.warDay ?? getWarDayName(getWarDayKey(new Date(`${snap.date}T12:00:00Z`)));
          const hasData =
            snap.decks &&
            Object.values(snap.decks).some((v) => typeof v === 'number' && v > 0);
          if (warDay && hasData) snapshotDays.add(warDay);
        }
        const ALL_WAR_DAYS = ['thursday', 'friday', 'saturday', 'sunday'];
        uncomplete.snapshotComplete = ALL_WAR_DAYS.every((d) => snapshotDays.has(d));
        uncomplete.snapshotDays = Array.from(snapshotDays).sort();

        uncomplete.players = uncomplete.players.map((p) => {
          // Build a fixed 4‑day array (thu→sun). Missing days stay null.
          const daily = [null, null, null, null];
          for (const snap of prevSnaps) {
            const warDay = snap.warDay ?? getWarDayName(getWarDayKey(new Date(`${snap.date}T12:00:00Z`)));
            const idx = dayIndex[warDay];
            if (idx === undefined) continue;
            const hasData =
              snap.decks &&
              Object.values(snap.decks).some((v) => typeof v === 'number' && v > 0);
            if (!hasData) continue;
            const val = snap.decks ? snap.decks[p.tag] : null;
            daily[idx] = val == null ? null : val;
          }
          p.daily = daily;
          p.dailySource = 'snapshot';
          p.dailySnapshotComplete = daily.every((v) => v !== null);
          return p;
        });
      }

      // --- Snapshots semaine COURANTE → chips clanWarSummary ---
      // Même logique que l'écriture (recordSnapshot) : utilise currentRace.sectionIndex.
      const currSection = currentRace?.sectionIndex ?? (raceLog[0].sectionIndex + 1);
      let seasonId = raceLog[0].seasonId;
      if (currentRace && currSection <= (raceLog[0]?.sectionIndex ?? -1)) seasonId += 1;
      currWeekId = `S${seasonId}W${currSection + 1}`;
      weekSnaps = await getSnapshotsForWeek(clanTag, currWeekId);

      // Track when the latest snapshot was taken (useful for debug/analysis)
      const latestSnap = weekSnaps
        .map((s) => s._snapshotTakenAt || s._generatedAt || null)
        .filter(Boolean)
        .sort()
        .pop();
      warSnapshotTakenAt = latestSnap ?? null;

      if (weekSnaps.length) {
        // weekSnaps is expected to be an array of day entries for the current week
        // (thu→sun). Build an array of total decks per day.
        warSnapshotDays = weekSnaps.map((snap) => {
          if (!snap || !snap.decks) return null;
          const total = Object.values(snap.decks).reduce((s, v) => s + (typeof v === 'number' ? v : 0), 0);
          return total > 0 ? Math.min(200, total) : 0;
        });
      }

    // Note: CWStats scraping was previously used to sanity-check deck totals
    // but it is currently disabled (not used in the analysis output).
  }


    // First pass: compute war scores for all members
    const analyzedMembers = await Promise.all(
      members.map(async (m, idx) => {
        let activityScore, verdict, color, isNew = false, warHistory = null;

      // Resolve full player profile (for badges) and battle log
      const mdResult    = memberDataResults[idx];
      const fullPlayer  = mdResult?.status === 'fulfilled' ? mdResult.value[0] : null;
      const battleLog   = mdResult?.status === 'fulfilled' ? mdResult.value[1] : null;

      // Player proxy: prefer full profile (has badges), fall back to member data
      const playerProxy = fullPlayer ?? {
        trophies:     m.trophies ?? 0,
        bestTrophies: m.trophies ?? 0,
        totalDonations: m.donations ?? 0,
        donations:    m.donations ?? 0,
      };
      // Présence Discord : le tag du membre est-il dans discord-links.json ?
      const discordLinked = Object.prototype.hasOwnProperty.call(discordLinks, m.tag);

      if (raceLog) {
        let wh = buildWarHistory(m.tag, raceLog, clan.tag, currentRace);
        warHistory = wh;

        // Compute GDC win rate from battle log when available
        let warWinRate = null;
        if (battleLog) {
          const rawWarLog = expandDuelRounds(filterWarBattles(battleLog));
          if (rawWarLog.length >= 10) { // même seuil que la route player
            const wins = rawWarLog.filter(isWarWin).length;
            warWinRate = wins / rawWarLog.length;
          }
        }

        // Determine whether warHistory alone is sufficient. We want to
        // grant full scores when the player has either a full 16-deck week
        // in the past or the old rule of ≥2 completed weeks in the clan.
        let prevWeeks = wh.weeks.filter((w) => !w.isCurrent);
        let hasFullWeek = prevWeeks.some((w) => (w.decksUsed ?? 0) >= 16);
        const oldRule = wh.streakInCurrentClan >= 2 && wh.completedParticipation >= 2;
        let hasEnoughHistory = hasFullWeek || oldRule;

        // Transfer detection (family clan) — on veut afficher "transfer" même
        // si l'historique est déjà jugé suffisant.
        const transfer = findRecentFamilyTransfer(m.tag);
        if (transfer) {
          // Si l'historique n'était pas suffisant, fusionne pour calculer un
          // vrai war score uniquement avec des données fiables.
          if (!hasEnoughHistory) {
            const merged = mergeWarHistoryWithTransfer(wh, transfer.transferWeek, transfer.fromClanTag);
            wh = merged;
            warHistory = merged;
            prevWeeks = wh.weeks.filter((w) => !w.isCurrent);
            hasFullWeek = prevWeeks.some((w) => (w.decksUsed ?? 0) >= 16);
            hasEnoughHistory = hasFullWeek || oldRule;
          }
          // Toujours marquer comme transfert (même si l'historique était suffisant)
          isNew = false;
        }

        // same mid‑race arrival handling as player view (ignore oldest incomplete)
        if (prevWeeks.length >= 2) {
          const oldest = prevWeeks[prevWeeks.length - 1];
          if ((oldest.decksUsed ?? 0) < 16) {
            oldest.ignored = true;

            // recalcul des métriques résumées en excluant la semaine ignorée
            const kept = wh.weeks.filter((w) => !w.ignored && (w.decksUsed ?? 0) > 0);
            const totalFame = kept.reduce((s, w) => s + (w.fame || 0), 0);
            wh.totalFame = totalFame;
            wh.participation = kept.length;
            wh.avgFame = kept.length ? Math.round(totalFame / kept.length) : 0;
            wh.maxFame = kept.reduce((mx, w) => Math.max(mx, w.fame || 0), 0);
            wh.completedParticipation = kept.filter((w) => !w.isCurrent).length;
            // recalcul du taux de victoire historique sur les semaines conservées
            const MIN_PVP_DECKS = 5;
            let totalPvpDecks = 0, totalEstimatedWins = 0;
            for (const w of kept.filter((w) => !w.isCurrent)) {
              const { wins: wWins, pvpDecks: wPvp } = estimateWinsFromFame(w.fame, w.decksUsed, w.boatAttacks);
              totalPvpDecks      += wPvp;
              totalEstimatedWins += wWins;
            }
            wh.historicalWinRate = totalPvpDecks >= MIN_PVP_DECKS ? totalEstimatedWins / totalPvpDecks : null;
            // réévaluer après le recalcul (completedParticipation peut avoir changé)
            hasEnoughHistory = hasFullWeek || (wh.streakInCurrentClan >= 2 && wh.completedParticipation >= 2);
          }
        }

        if (hasEnoughHistory) {
          // Historical data — computeWarScore + win rate historique (race log) en priorité
          const effectiveWinRate = wh.historicalWinRate ?? warWinRate;
          const ws = computeWarScore(playerProxy, wh, effectiveWinRate, m.lastSeen ?? null, discordLinked);
          activityScore = ws.pct; verdict = ws.verdict; color = ws.color;
        } else if (battleLog) {
          // New member — full fallback with battle log
          const bd     = categorizeBattleLog(battleLog);
          const warLog = expandDuelRounds(filterWarBattles(battleLog));
          const normalizedTagFb = m.tag.startsWith('#') ? m.tag : `#${m.tag}`;
          const racePartFb = currentRace?.clan?.participants?.find((p) => p.tag === normalizedTagFb);
          const ws     = computeWarReliabilityFallback(playerProxy, warLog, bd, m.lastSeen ?? null, discordLinked, racePartFb?.decksUsed ?? 0);
          activityScore = ws.pct; verdict = ws.verdict; color = ws.color;
          isNew = true;
        } else {
          // Battle log unavailable — minimal estimate
          const totalDonations = playerProxy.totalDonations ?? playerProxy.donations ?? 0;
          const donationPts = scoreTotalDonations(totalDonations, 2);
          const pct = Math.round((donationPts / 40) * 100);
          activityScore = pct; verdict = 'Extreme risk'; color = 'red';
          isNew = true;
        }

        // Ensure we don't flag long‑inactive members as "new" just because
        // they lack sufficient war history. 117d‑ago Mat proved that the
        // badge was misleading: require a recent login (≤7 days) before
        // showing the label. This threshold is intentionally simple – the
        // front‑end only renders the field supplied by the API.
        if (isNew && m.lastSeen) {
          const lastSeenDate = new Date(m.lastSeen.replace(
            /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/,
            '$1-$2-$3T$4:$5:$6.$7Z'
          ));
          const lastSeenDays = (Date.now() - lastSeenDate.getTime()) / (1000 * 60 * 60 * 24);
          if (lastSeenDays > 7) {
            isNew = false;
          }
        }
      } else {
        // No race log at all — legacy trophies-based estimate
        const donPart = Math.min(40, ((m.donations ?? 0) / 300) * 40);
        const trPart  = Math.min(40, ((m.trophies ?? 0) / 10000) * 40);
        const expPart = Math.min(20, ((m.expLevel ?? 1) / 60) * 20);
        const score   = Math.round(donPart + trPart + expPart);
        activityScore = score;
        verdict = score >= 75 ? 'High reliability'
                : score >= 61 ? 'Moderate risk'
                : score >= 31 ? 'High risk'
                :               'Extreme risk';
        color = score >= 75 ? 'green' : score >= 56 ? 'yellow' : score >= 31 ? 'orange' : 'red';
      }

      const warDays = (() => {
          const currentWeek = warHistory?.weeks?.find((w) => w.isCurrent) ?? null;
          // Source fiable 1 : semaine courante depuis warHistory (déjà issu de currentRace)
          // Source fiable 2 : currentRace.clan.participants en direct (fallback si warHistory
          //   n'a pas pu intégrer ce joueur, ex. fetch battleLog raté + race log partiel)
          const normalizedTag = m.tag.startsWith('#') ? m.tag : `#${m.tag}`;
          const raceParticipant = currentRace?.clan?.participants?.find((p) => p.tag === normalizedTag) ?? null;
          const raceTotalDecks = currentWeek?.decksUsed ?? raceParticipant?.decksUsed ?? null;
          // On ne peut rien calculer si ni battleLog ni données de race ne sont disponibles
          if (battleLog === null && raceTotalDecks === null) return null;
          const effectiveBattleLog = battleLog ?? [];
          const summary      = buildCurrentWarDays(effectiveBattleLog, raceTotalDecks, {
            state:       currentRace?.state       ?? null,
            periodIndex: currentRace?.periodIndex ?? null,
          });
          if (
            summary &&
            summary.daysFromThu > 0 &&
            (warHistory?.streakInCurrentClan ?? 0) === 1 &&
            (currentWeek?.decksUsed ?? 0) === 0
          ) {
            summary.arrivedMidWar   = true;
            summary.arrivedOnDay    = summary.daysFromThu + 1;
            summary.totalDecksUsed  = 0;
            summary.isReliableTotal = true;
          }
          return summary;
        })();

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
        isNew,
        isFamilyTransfer:    warHistory?.isFamilyTransfer ?? false,
        transferFromClan:    warHistory?.transferFromClan ?? null,
        transferWeek:        warHistory?.transferWeek?.label ?? null,
        discord:            discordLinked,
        warDays,
        // Valeur numérique pour le tri de la colonne "This War"
        // -1 = arrivé en cours de semaine, null = hors période de guerre
        warDecks:  warDays === null ? null : (warDays.arrivedMidWar ? -1 : (warDays.totalDecksUsed ?? 0)),
        lastSeen:  m.lastSeen ?? null,
      };
    }));

    // Sort by activityScore ascending (most at-risk first)
    analyzedMembers.sort((a, b) => a.activityScore - b.activityScore);

    // Enrichir uncomplete avec isNew (calculé via l'historique de guerre de chaque membre)
    if (uncomplete && Array.isArray(uncomplete.players)) {
      const memberMap = new Map(analyzedMembers.map((m) => [m.tag, m]));
      uncomplete.players = uncomplete.players.map((p) => ({
        ...p,
        isNew: memberMap.get(p.tag)?.isNew ?? false,
      }));
    }

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

    // determine whether a snapshot already exists for today; this lets the
    // frontend display an informative note beside "Live data".  we also
    // compute the date even when `raceLog` is missing so the UI can still
    // report "Snapshot : …" while outside war period.
    const { hasSnapshotForToday, getLastSnapshotDate } = await import('../services/snapshot.js');
    const snapshotToday = await hasSnapshotForToday(clanTag);
    const snapshotDate  = await getLastSnapshotDate(clanTag);


    // Synthèse des combats GDC pour l'ensemble du clan (sans requête supplémentaire)
    let clanWarSummary = null;
    let lastWarSummary = null;

    const clampDeckTotal = (value) => {
      if (value == null || Number.isNaN(value)) return null;
      return Math.min(200, Math.max(0, Math.round(value)));
    };

    if (currentRace?.periodType === 'warDay' && currentRace?.clan?.participants?.length > 0) {
      const sampleWarDays = analyzedMembers.find((m) => m.warDays && !m.warDays.arrivedMidWar)?.warDays ?? null;
      if (sampleWarDays) {
        const { daysFromThu } = sampleWarDays;
        const participants = currentRace.clan.participants;
        // Total fiable depuis currentRace (cumul hebdo par participant)
        let totalDecksUsed = participants.reduce((s, p) => s + (p.decksUsed ?? 0), 0);
        // If we have cwstats data, use it as a sanity check (it tends to be more stable).
        // Use fixed max values based on a full 50-member clan for reporting purposes.
        // This keeps the UI consistent with the 600/800 max legends even if the
        // current member count is slightly lower (e.g. due to in-progress recruitment).
        const MAX_MEMBERS = 50;
        const maxDecksElapsed = MAX_MEMBERS * (daysFromThu + 1) * 4; // 600 at day 3
        const maxDecksWeek    = MAX_MEMBERS * 16;                     // 800 for full week
        totalDecksUsed = Math.min(maxDecksWeek, Math.max(0, totalDecksUsed));
        // Détail par jour : on combine snapshot (source fiable) et une estimation live
        // basée sur les cumul d'API (currentRace) pour limiter l'écart en cas de lag.
        const currentCumul = {};
        participants.forEach((p) => { currentCumul[p.tag] = p.decksUsed ?? 0; });
        const currentCumulTotal = Object.values(currentCumul).reduce((s, v) => s + v, 0);

        const DAY_LABELS = ['Thu', 'Fri', 'Sat', 'Sun'];
        // used to infer day totals when snapshot appears to undercount
        const dayTotals = Array(DAY_LABELS.length).fill(0);
        const days = DAY_LABELS.map((label, i) => {
          const snap = weekSnaps[i] ?? null;
          const prevSnap = weekSnaps[i - 1] ?? null;

          // Prefer the decks sum from the snapshot (matches warSnapshotDays),
          // fallback to the _cumul delta if decks are missing.
          const snapshotCountFromDecks = snap?.decks
            ? Object.values(snap.decks).reduce((s, v) => s + v, 0)
            : null;

          const cumul = snap?._cumul ?? null;
          const prevCumul = prevSnap?._cumul ?? null;
          const cumulDelta = cumul && prevCumul
            ? Math.max(0, Object.values(cumul).reduce((s, v) => s + v, 0) - Object.values(prevCumul).reduce((s, v) => s + v, 0))
            : null;

          const snapshotCount = snapshotCountFromDecks !== null
            ? clampDeckTotal(snapshotCountFromDecks)
            : cumulDelta !== null
              ? clampDeckTotal(cumulDelta)
              : null;

          const knownPrevDaysTotal = dayTotals.reduce((s, v) => s + v, 0);
          const inferredFromLive = totalDecksUsed > knownPrevDaysTotal
            ? clampDeckTotal(totalDecksUsed - knownPrevDaysTotal)
            : null;

          let totalCount = null;
          let source = 'unknown';
          let liveCount = null;

          // Prefer live `decksUsedToday` for the current day (most authoritative from currentriverrace).
          if (i === daysFromThu) {
            const currentDayLive = participants.reduce((sum, p) => sum + (p.decksUsedToday ?? 0), 0);
            liveCount = Math.max(0, Math.min(200, currentDayLive));
            if (snapshotCount !== null) {
              if (liveCount !== snapshotCount) {
                totalCount = liveCount;
                source = 'live';
              } else {
                totalCount = Math.min(200, snapshotCount);
                source = 'snapshot';
              }
            } else {
              totalCount = liveCount;
              source = 'live';
            }
          }

          // Past days: use snapshot if available, else fallback to inferred live.
          if (totalCount === null) {
            if (snapshotCount !== null) {
              totalCount = Math.min(200, snapshotCount);
              source = 'snapshot';
            } else if (inferredFromLive !== null) {
              totalCount = inferredFromLive;
              source = 'live';
            }
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
            snapshotCount: snapshotCount !== null ? Math.min(200, snapshotCount) : null,
            liveCount,
          };
        });

        // Ensure consistency : totalDecksUsed = somme des jours (today live + jours précédents)
        const todayIdx = daysFromThu;
        const todayLiveSum = participants.reduce((sum, p) => sum + (p.decksUsedToday ?? 0), 0);
        if (days[todayIdx]) {
          days[todayIdx].totalCount = Math.min(200, Math.max(0, todayLiveSum));
          days[todayIdx].source = 'live';
          days[todayIdx].liveCount = todayLiveSum;
        }

        const desiredPastTotal = Math.max(0, totalDecksUsed - todayLiveSum);
        const currentPastTotal = days.slice(0, todayIdx).reduce((sum, d) => sum + (d.totalCount ?? 0), 0);
        const pastDiff = currentPastTotal - desiredPastTotal;

        if (pastDiff !== 0 && todayIdx > 0) {
          // Ajustements au plus proche jour passé (dernière journée non-future).
          for (let i = todayIdx - 1; i >= 0 && pastDiff !== 0; i--) {
            const day = days[i];
            if (!day || typeof day.totalCount !== 'number') continue;
            const maxAdjust = Math.min(day.totalCount, Math.abs(pastDiff));
            if (maxAdjust <= 0) continue;
            if (pastDiff > 0) {
              // on est trop haut, on réduit
              day.totalCount -= maxAdjust;
              day.source = 'snapshot';
              pastDiff -= maxAdjust;
            } else {
              // on est trop bas, on augmente (dans la limite de 200)
              const freeSlot = 200 - day.totalCount;
              const add = Math.min(freeSlot, Math.abs(pastDiff));
              day.totalCount += add;
              day.source = 'snapshot';
              pastDiff += add;
            }
          }
        }

        // Recalc des prix à jour après adjustement de cohérence
        const finalPastTotal = days.slice(0, todayIdx).reduce((sum, d) => sum + (d.totalCount ?? 0), 0);
        // si rien ne colle (gros écart), on tolère ; on ne modifie plus.
        if (finalPastTotal + todayLiveSum !== totalDecksUsed) {
          // fallback: garder totalDecksUsed comme source principale
          // et ne plus toucher si impossible de faire concorder proprement.
        }
        const finalTotalDecksUsed = Math.min(maxDecksWeek, Math.max(0, days.reduce((sum, d) => sum + (d.totalCount ?? 0), 0)));
        clanWarSummary = { totalDecksUsed: finalTotalDecksUsed, maxDecksElapsed, maxDecksWeek, participantCount: MAX_MEMBERS, daysFromThu, days, weekId: currWeekId, ended: false };
      }
    }

    // If we are outside an active war and no current-week snapshot exists,
    // fall back to the previous completed week snapshot (prevWeekId).
    if (!clanWarSummary && getSnapshotsForWeek && (!weekSnaps || weekSnaps.length === 0) && prevWeekId) {
      const prevWeekSnaps = await getSnapshotsForWeek(clanTag, prevWeekId);
      if (prevWeekSnaps.length > 0) {
        weekSnaps = prevWeekSnaps;
        currWeekId = prevWeekId;
      }
    }

    // If there is no current war summary (GDC ended), fall back to last available week snapshot.
    if (!clanWarSummary && Array.isArray(weekSnaps) && weekSnaps.length > 0) {
      const DAY_LABELS = ['Thu', 'Fri', 'Sat', 'Sun'];
      const days = DAY_LABELS.map((label, i) => {
        const snap = weekSnaps[i] ?? null;
        let totalCount = snap?.decks
          ? Object.values(snap.decks).reduce((acc, v) => acc + (typeof v === 'number' ? v : 0), 0)
          : null;
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
          source: totalCount != null ? 'snapshot' : 'unknown',
          snapshotCount: totalCount,
          liveCount: null,
        };
      });

      let totalDecksUsed = days.reduce((sum, d) => sum + (d.totalCount ?? 0), 0);
      const MAX_MEMBERS = 50;
      const maxDecksElapsed = MAX_MEMBERS * 16;
      const maxDecksWeek = MAX_MEMBERS * 16;
      totalDecksUsed = Math.min(totalDecksUsed, maxDecksWeek);
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
      const nowGdcDate = new Date(now.getTime() - warResetOffsetMs(now));
      const thuGdcMs = nowGdcDate.getTime() - (clanWarSummary.daysFromThu ?? 0) * MS_PER_DAY;
      currentWarDays = clanWarSummary.days.map((d, i) => ({
        key: new Date(thuGdcMs + i * MS_PER_DAY).toISOString().slice(0, 10),
        label: d.label,
        count: d.totalCount,
        isPast: d.isPast,
        isToday: d.isToday,
        isFuture: d.isFuture,
        source: d.source || 'unknown',
        snapshotCount: d.snapshotCount ?? null,
        liveCount: d.liveCount ?? null,
      }));
    }

    const computedLastWarSummary = clanWarSummary
      ? { ...clanWarSummary, ended: clanWarSummary.ended ?? true, snapshotAsOf: snapshotDate ?? null }
      : null;

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
      },
      members: analyzedMembers,
      summary: { green, yellow, orange, red, avgScore, total: analyzedMembers.length },
      isWarPeriod: analyzedMembers.some((m) => m.warDays !== null),
      topPlayers,                    // added by computeTopPlayers
      uncomplete,                    // new list of incomplete deck players
      clanWarSummary,                // synthèse GDC clan (null hors période de guerre)
      prevWeekId,                    // identifiant semaine précédente (pour Last War cards)
      snapshotToday,                 // boolean for backwards compatibility
      snapshotDate,                  // ISO date or null, used by frontend for message
      warCurrentWeekId: clanWarSummary?.weekId ?? null,
      warSnapshotDays,               // derived from snapshot files (null if missing)
      snapshotTakenAt: warSnapshotTakenAt,
      currentWarDays: clanWarSummary?.days ?? null, // expose the per-day summary for debug/insights
    };
}

export { router as default };
