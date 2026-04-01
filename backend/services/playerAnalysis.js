// ============================================================
// playerAnalysis.js — Analyse complète d'un joueur ou membre de clan.
// Orchestrateur principal : récupère les données, calcule les scores,
// enrichit avec l'historique de guerre.
// ============================================================

import {
  fetchPlayer,
  fetchBattleLog,
  fetchClanMembers,
  fetchRaceLog,
  fetchCurrentRace,
} from './clashApi.js';
import { parseClashDate, warResetOffsetMs, warDayKey, MS_PER_DAY } from './dateUtils.js';
import {
  filterWarBattles,
  expandDuelRounds,
  categorizeBattleLog,
  isWarWin,
  isWarLoss,
  getMyBattleCrowns,
  buildDailyActivity,
} from './battleLogUtils.js';
import {
  scoreTotalDonations,
  computeWarScore,
  computeWarReliabilityFallback,
  estimateWinsFromFame,
} from './warScoring.js';
import { buildFamilyWarHistory, applyOldestWeekIgnore } from './warHistory.js';

// ── Vue complète d'un joueur (score + historique) ─────────────

/**
 * Produce the complete analysis object for a player from raw API data.
 * The reliability field is a fallback — overridden by warScore in getPlayerAnalysis
 * when race log history is available.
 *
 * @param {object}   player
 * @param {object[]} battleLog
 * @param {string|null} lastSeen
 * @param {boolean} discordLinked
 * @returns {object}
 */
export function analyzePlayer(player, battleLog, lastSeen = null, discordLinked = false) {
  // Catégorise toutes les entrées brutes avant filtrage
  const battleLogBreakdown = categorizeBattleLog(battleLog);

  // Filtre les batailles GDC puis expanse les rounds de duel
  const warLog = expandDuelRounds(filterWarBattles(battleLog));

  // Score fallback (battle log uniquement) — remplacé par warScore si historique disponible
  const reliability = computeWarReliabilityFallback(player, warLog, battleLogBreakdown, lastSeen, discordLinked);
  const dailyActivity = buildDailyActivity(battleLog, 7); // toutes batailles, pas seulement GDC

  const wins              = warLog.filter(isWarWin).length;
  const losses            = warLog.filter(isWarLoss).length;
  const threeCrowns       = warLog.filter((b) => getMyBattleCrowns(b) === 3).length;
  const totalBattlesInLog = warLog.length;
  const winRate           = totalBattlesInLog > 0 ? Math.round((wins / totalBattlesInLog) * 100) : 0;

  return {
    overview: {
      name:         player.name,
      tag:          player.tag,
      trophies:     player.trophies,
      bestTrophies: player.bestTrophies,
      expLevel:     player.expLevel,
      clan:         player.clan ? { name: player.clan.name, tag: player.clan.tag } : null,
      role:         player.role ?? null,
      clanWarWins:  player.badges?.find((b) => b.name === 'ClanWarWins')?.progress ?? 0,
    },
    activityIndicators: {
      totalWarBattles: totalBattlesInLog,
      totalBattles:    battleLog.length,
      wins,
      losses,
      winRate,
      donations:       player.totalDonations ?? player.donations ?? 0,
      threeCrowns,
      battleLogBreakdown,
    },
    recentActivity: {
      dailyActivity,
      apiLimitNote: 'Battle log capped at 30 entries by the Clash Royale API.',
    },
    reliability, // fallback — remplacé par warScore quand l'historique de course est disponible
    battleLog,   // log brut utilisé par la carte BattleLog
  };
}

/**
 * Build the full player analysis (cached, race log enriched).
 * This is the main entry point for external consumers (route /player/:tag/analysis
 * and Discord commands). Returns identical results everywhere.
 *
 * @param {string}  tag           - Player tag (with or without leading '#')
 * @param {boolean} discordLinked
 * @returns {Promise<object>} analysis payload
 */
export async function getPlayerAnalysis(tag, discordLinked = false) {
  let rateLimited = false;

  async function safeFetch(fn) {
    try {
      return await fn();
    } catch (err) {
      if (err.isRateLimit) {
        rateLimited = true;
        return null;
      }
      throw err;
    }
  }

  const [player, battleLog] = await Promise.all([
    safeFetch(() => fetchPlayer(tag)),
    safeFetch(() => fetchBattleLog(tag)),
  ]);

  if (!player) {
    throw new Error(`Player data not available for tag ${tag}`);
  }

  // Récupère lastSeen depuis le roster du clan (non disponible sur le profil joueur)
  let lastSeen = null;
  if (player.clan?.tag) {
    try {
      const members = await fetchClanMembers(player.clan.tag);
      const entry = members.find((m) => m.tag === player.tag);
      lastSeen = entry?.lastSeen ?? null;
    } catch (_) {
      // lastSeen reste null
    }
  }

  const analysis = analyzePlayer(player, battleLog || [], lastSeen, discordLinked);
  if (rateLimited) {
    analysis.rateLimited = true;
  }

  // Enrichit avec l'historique River Race si le joueur est dans un clan.
  let currentRaceMeta = null;
  if (player.clan?.tag) {
    try {
      const [raceLog, currentRace] = await Promise.all([
        fetchRaceLog(player.clan.tag),
        fetchCurrentRace(player.clan.tag).catch(() => null),
      ]);
      currentRaceMeta = { state: currentRace?.state ?? null, periodIndex: currentRace?.periodIndex ?? null };
      analysis.warHistory = await buildFamilyWarHistory(player.tag, player.clan.tag, currentRace, battleLog);

      // Taux de victoire GDC depuis le battle log (minimum 10 batailles)
      const rawWarLog  = expandDuelRounds(filterWarBattles(battleLog));
      const gdcWins    = rawWarLog.filter(isWarWin).length;
      const warWinRate = rawWarLog.length >= 10 ? gdcWins / rawWarLog.length : null;

      // Semaines passées uniquement (hors semaine en cours)
      let prevWeeks = analysis.warHistory.weeks.filter((w) => !w.isCurrent);

      const hasFullWeek = prevWeeks.some((w) => (w.decksUsed ?? 0) >= 16);
      const oldRule     = analysis.warHistory.streakInCurrentClan >= 2
        && analysis.warHistory.completedParticipation >= 2;
      let hasEnoughHistory = hasFullWeek || oldRule;

      // Si la semaine la plus ancienne est incomplète (<16 decks), on la marque ignorée
      // (affichage grisé dans l'UI) pour ne pas pénaliser une arrivée en cours de race.
      if (prevWeeks.length >= 2) {
        applyOldestWeekIgnore(analysis.warHistory, prevWeeks);
        hasEnoughHistory = hasEnoughHistory || hasFullWeek
          || (analysis.warHistory.streakInCurrentClan >= 2 && analysis.warHistory.completedParticipation >= 2);
      }

      const effectiveWinRate = analysis.warHistory.historicalWinRate ?? warWinRate;

      if (hasEnoughHistory) {
        analysis.warScore = computeWarScore(player, analysis.warHistory, effectiveWinRate, lastSeen, discordLinked);
        // Si win rate exclu (<10 batailles), ajoute une entrée informative marquée excluded
        if (effectiveWinRate === null && rawWarLog.length > 0) {
          const rawRate = gdcWins / rawWarLog.length;
          const rr = (v) => Math.round(v * 10) / 10;
          analysis.warScore.breakdown.push({
            label:    'Win Rate (War)',
            score:    rr(Math.min(3, rawRate * 3)),
            max:      3,
            excluded: true,
            detail:   `${Math.round(rawRate * 100)}% wins (${gdcWins}W / ${rawWarLog.length - gdcWins}L) — not counted (10 battles required)`,
          });
        }
      } else {
        // Historique insuffisant → fallback battle log
        const warLogFb   = expandDuelRounds(filterWarBattles(battleLog));
        const bdFb       = categorizeBattleLog(battleLog);
        const racePartFb = currentRace?.clan?.participants?.find((p) => p.tag === player.tag);
        analysis.warScore = computeWarReliabilityFallback(player, warLogFb, bdFb, lastSeen, discordLinked, racePartFb?.decksUsed ?? 0, analysis.warHistory);
      }
    } catch (_) {
      analysis.warHistory = null;
      analysis.warScore   = analysis.reliability;
    }
  } else {
    analysis.warHistory = null;
    analysis.warScore   = analysis.reliability;
  }

  // Résumé GDC semaine courante — calculé après warHistory pour utiliser la source fiable
  const currentWeek    = analysis.warHistory?.weeks?.find((w) => w.isCurrent) ?? null;
  const raceTotalDecks = currentWeek?.decksUsed ?? null;
  const warSummary     = buildCurrentWarDays(battleLog, raceTotalDecks, currentRaceMeta);

  // Joueur arrivé pendant la GDC (pas de deck joué + semaine 1 dans le clan)
  if (
    warSummary &&
    warSummary.daysFromThu > 0 &&
    (analysis.warHistory?.streakInCurrentClan ?? 0) === 1 &&
    (currentWeek?.decksUsed ?? 0) === 0
  ) {
    warSummary.arrivedMidWar  = true;
    warSummary.arrivedOnDay   = warSummary.daysFromThu + 1;
    warSummary.totalDecksUsed = 0;
    warSummary.isReliableTotal = true;
  }
  analysis.currentWarDays = warSummary;

  analysis.overview.lastSeen = lastSeen;
  analysis.overview.discord  = discordLinked;
  analysis.isNew = computeIsNewPlayer(analysis.warHistory, analysis.warScore);

  return analysis;
}

/**
 * Determine whether a member should be flagged as "new" in the UI.
 * Partagé entre la vue joueur et la vue clan pour garantir la cohérence.
 */
export function computeIsNewPlayer(warHistory, warScore) {
  const hasCompletedWarWeeks = !!warHistory?.weeks?.some((w) => !w.isCurrent && (w.decksUsed ?? 0) > 0);
  const hasOnlyCurrentWeek   = !!(warHistory?.weeks?.length === 1 && warHistory.weeks[0]?.isCurrent);
  const isNewClanArrivee     = (warHistory?.streakInCurrentClan ?? 0) < 2 && (warHistory?.totalWeeks ?? 0) > 1;

  const isBattleLogMode = !hasCompletedWarWeeks || hasOnlyCurrentWeek || isNewClanArrivee;
  return isNewClanArrivee || isBattleLogMode;
}

// ── Analyse légère des membres de clan ───────────────────────

/**
 * Compute a lightweight activity score for a clan member.
 * Uses only data available from the /members endpoint (no battle log).
 *
 * Score (0–100):
 *   = min(100, (donations / 300 * 40) + (trophies / 10000 * 40) + (expLevel / 60 * 20))
 */
export function computeMemberReliability(member) {
  const totalDonations = member.totalDonations ?? member.donations ?? 0;
  const trophies       = member.trophies ?? 0;
  const expLevel       = member.expLevel ?? 1;

  const donationPart = Math.min(40, scoreTotalDonations(totalDonations, 40));
  const trophyPart   = Math.min(40, (trophies / 10000) * 40);
  const expPart      = Math.min(20, (expLevel / 60) * 20);

  const score = Math.round(donationPart + trophyPart + expPart);

  let verdict, color;
  if (score >= 75)      { verdict = 'High reliability'; color = 'green'; }
  else if (score >= 61) { verdict = 'Moderate risk';    color = 'yellow'; }
  else if (score >= 31) { verdict = 'High risk';        color = 'orange'; }
  else                  { verdict = 'Extreme risk';     color = 'red'; }

  return { score, verdict, color };
}

/**
 * Enrich an array of clan members with activity scores.
 * @param {object[]} members
 * @returns {object[]}
 */
export function analyzeClanMembers(members) {
  return members.map((m) => {
    const { score, verdict, color } = computeMemberReliability(m);
    return {
      name:              m.name,
      tag:               m.tag,
      role:              m.role,
      trophies:          m.trophies ?? 0,
      totalDonations:    m.totalDonations ?? null,
      donations:         m.donations ?? 0,
      donationsReceived: m.donationsReceived ?? 0,
      expLevel:          m.expLevel ?? 1,
      reliability:       score,
      verdict,
      color,
    };
  });
}

// ── Semaine de guerre en cours ────────────────────────────────

/**
 * Calcule les données de la semaine de guerre en cours (jeu–dim).
 * Retourne null si on est hors période de guerre (lun–mer).
 *
 * @param {object[]} battleLog
 * @param {number|null} raceTotalDecks  decksUsed depuis currentriverrace (source fiable), ou null
 * @param {object|null} raceMeta        Métadonnées de course ({ state, periodIndex })
 * @returns {{ days, totalDecksUsed, maxDecksElapsed, maxDecksWeek, isReliableTotal }|null}
 */
export function buildCurrentWarDays(battleLog, raceTotalDecks = null, raceMeta = null) {
  const now        = new Date();
  const nowGdcDate = new Date(now.getTime() - warResetOffsetMs(now));

  let daysFromThu;

  const nowDow          = nowGdcDate.getUTCDay(); // 0=Dim, 1=Lun … 4=Jeu, 5=Ven, 6=Sam
  const isWarPeriod     = nowDow === 0 || nowDow >= 4;
  const fallbackDaysFromThu = isWarPeriod ? (nowDow === 4 ? 0 : nowDow === 5 ? 1 : nowDow === 6 ? 2 : 3) : undefined;

  if (raceMeta?.state) {
    const { state, periodIndex } = raceMeta;
    // Journée d'entraînement → pas de période de guerre active
    if (state === 'trainingDay' || state === 'preparation') return null;
    if (typeof periodIndex === 'number' && periodIndex >= 0 && periodIndex <= 3) {
      daysFromThu = periodIndex; // 0=Jeu, 1=Ven, 2=Sam, 3=Dim
      // Protection : ne pas avancer avant le reset officiel (9:40 UTC)
      if (fallbackDaysFromThu !== undefined && daysFromThu > fallbackDaysFromThu) {
        daysFromThu = fallbackDaysFromThu;
      }
    } else if (state === 'overtime') {
      daysFromThu = 3;
      if (fallbackDaysFromThu !== undefined && daysFromThu > fallbackDaysFromThu) {
        daysFromThu = fallbackDaysFromThu;
      }
    }
  }

  // Fallback calendaire si currentRace non disponible
  if (daysFromThu === undefined) {
    if (!isWarPeriod) return null;
    daysFromThu = fallbackDaysFromThu;
  }

  const thuGdcMs  = nowGdcDate.getTime() - daysFromThu * MS_PER_DAY;

  const DAY_LABELS = ['Thu', 'Fri', 'Sat', 'Sun'];
  const days = DAY_LABELS.map((label, i) => ({
    key:      new Date(thuGdcMs + i * MS_PER_DAY).toISOString().slice(0, 10),
    label,
    count:    0,
    isPast:   i < daysFromThu,
    isToday:  i === daysFromThu,
    isFuture: i > daysFromThu,
  }));

  // Compte les combats GDC par jour depuis le battle log (potentiellement tronqué)
  for (const b of filterWarBattles(battleLog)) {
    const key = warDayKey(b.battleTime);
    const day = days.find((d) => d.key === key);
    if (day) day.count++;
  }

  const maxDecksElapsed = (daysFromThu + 1) * 4;
  const maxDecksWeek    = 16;

  const isReliableTotal = raceTotalDecks !== null;
  const totalDecksUsed  = isReliableTotal ? raceTotalDecks : days.reduce((s, d) => s + d.count, 0);

  return { days, totalDecksUsed, maxDecksElapsed, maxDecksWeek, isReliableTotal, daysFromThu };
}
