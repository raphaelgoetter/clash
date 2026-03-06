// ============================================================
// analysisService.js — Core scoring and analysis logic
//
// All formulas are documented inline so that they can be
// tweaked as new data becomes available.
// ============================================================

// ── Constants ─────────────────────────────────────────────────

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Clan War day resets at 10:40 UTC every day.
// Shifting timestamps back by this offset lets us floor to the correct war day.
const WAR_DAY_RESET_MS = (10 * 60 + 40) * 60 * 1000; // 640 minutes in ms

// ── Date utilities ────────────────────────────────────────────

/**
 * Parse a Clash Royale timestamp string (YYYYMMDDTHHmmss.000Z) into a Date.
 * @param {string} ts
 * @returns {Date}
 */
function parseClashDate(ts) {
  if (!ts) return new Date(0);
  // Format: 20240315T123456.000Z → standard ISO-ish
  const iso = ts.replace(
    /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})\.(\d{3})Z$/,
    '$1-$2-$3T$4:$5:$6.$7Z'
  );
  return new Date(iso);
}

/**
 * Clan War battle types in the Clash Royale API.
 * Covers both current River Race format and legacy war format.
 */
const WAR_BATTLE_TYPES = new Set([
  'riverRacePvP',
  'riverRaceDuel',
  'riverRaceDuelColosseum',
  'riverRaceBoat',
  'clanWarBattle',
]);

/**
 * Filter a battle log to keep only Clan War battles.
 * @param {object[]} battleLog
 * @returns {object[]}
 */
export function filterWarBattles(battleLog) {
  return battleLog.filter((b) => WAR_BATTLE_TYPES.has(b.type));
}

/** Battle types considered as regular Ladder / Path of Legend. */
const LADDER_TYPES = new Set(['pvp', 'pathOfLegend', 'ranked']);

/** Battle types considered as challenge / tournament. */
const CHALLENGE_TYPES = new Set([
  'challenge', 'grandChallenge', 'classicChallenge',
  'challengeTournament', 'tournament',
]);

/** Battle types considered as friendly / training (not competitive). */
const FRIENDLY_TYPES = new Set(['training', 'friendly', 'clanMate', 'casual2v2', '2v2']);

/**
 * Categorise all entries of a raw battle log into 4 buckets.
 * Returns counts per category + total entries.
 *
 * @param {object[]} rawBattleLog
 * @returns {{ total:number; gdc:number; ladder:number; challenge:number; friendly:number; other:number }}
 */
export function categorizeBattleLog(rawBattleLog) {
  let gdc = 0, ladder = 0, challenge = 0, friendly = 0, other = 0;
  for (const b of rawBattleLog) {
    const t = b.type ?? '';
    if (WAR_BATTLE_TYPES.has(t))  gdc++;
    else if (LADDER_TYPES.has(t)) ladder++;
    else if (CHALLENGE_TYPES.has(t)) challenge++;
    else if (FRIENDLY_TYPES.has(t))  friendly++;
    else other++;
  }
  return { total: rawBattleLog.length, gdc, ladder, challenge, friendly, other };
}

/**
 * Flatten a war battle log so that duel entries are expanded into
 * individual rounds. Each round gets the timestamp of the parent duel.
 *
 * Rationale: a riverRaceDuel entry in the API represents a best-of-3
 * series but physically counts as multiple battles played. Expanding
 * rounds gives a more accurate per-day count.
 *
 * @param {object[]} warLog
 * @returns {object[]}
 */
export function expandDuelRounds(warLog) {
  const expanded = [];
  for (const battle of warLog) {
    const myEntry  = battle.team?.[0];
    const oppEntry = battle.opponent?.[0];
    if (battle.type === 'riverRaceDuel' && Array.isArray(myEntry?.rounds)) {
      // One synthetic entry per round — store per-round crowns so win detection is accurate.
      // The parent crowns represent the duel total and must NOT be used per-round.
      myEntry.rounds.forEach((round, i) => {
        const oppRound = oppEntry?.rounds?.[i] ?? {};
        expanded.push({
          ...battle,
          _roundIndex:    i,
          _roundCrownsMe:  round.crowns   ?? 0,
          _roundCrownsOpp: oppRound.crowns ?? 0,
        });
      });
    } else {
      expanded.push(battle);
    }
  }
  return expanded;
}

/**
 * Determine whether an (optionally expanded) battle entry is a win.
 * For rounds expanded from a riverRaceDuel, uses the per-round crowns
 * stored by expandDuelRounds rather than the parent duel total.
 * @param {object} b
 * @returns {boolean}
 */
export function isWarWin(b) {
  if (b._roundIndex !== undefined) {
    return (b._roundCrownsMe ?? 0) > (b._roundCrownsOpp ?? 0);
  }
  return (b.team?.[0]?.crowns ?? 0) > (b.opponent?.[0]?.crowns ?? 0);
}

/** Whether an (optionally expanded) battle entry is a loss. */
export function isWarLoss(b) {
  if (b._roundIndex !== undefined) {
    return (b._roundCrownsMe ?? 0) < (b._roundCrownsOpp ?? 0);
  }
  return (b.team?.[0]?.crowns ?? 0) < (b.opponent?.[0]?.crowns ?? 0);
}

/** Number of crowns scored by the player in an (optionally expanded) battle. */
export function getMyBattleCrowns(b) {
  if (b._roundIndex !== undefined) return b._roundCrownsMe ?? 0;
  return b.team?.[0]?.crowns ?? 0;
}

/**
 * Count battles that occurred within the last `days` calendar days.
 * @param {object[]} battleLog
 * @param {number} days
 * @returns {number}
 */
function battlesInLastDays(battleLog, days) {
  const cutoff = Date.now() - days * MS_PER_DAY;
  return battleLog.filter((b) => parseClashDate(b.battleTime).getTime() >= cutoff).length;
}

/**
 * Return the war-day key (YYYY-MM-DD) for a timestamp, accounting for the
 * 10:40 UTC daily reset. Any battle before 10:40 UTC belongs to the previous war day.
 * @param {Date|string} dateOrTs
 * @returns {string}
 */
function warDayKey(dateOrTs) {
  const ms = (dateOrTs instanceof Date ? dateOrTs : parseClashDate(dateOrTs)).getTime();
  return new Date(ms - WAR_DAY_RESET_MS).toISOString().slice(0, 10);
}

/**
 * Compute a 0-10 War Activity score that rewards doing all 4 daily battles.
 *
 * Algorithm:
 *  - Use a sliding window of up to 14 war days, anchored at today.
 *  - The window shrinks to the number of days since the player's first GDC battle
 *    in the log, so new members are not penalised for days before they joined.
 *  - Each war day scores min(battles, 4) / 4  (0 = skipped, 1 = all 4 done).
 *  - Linear recency weighting: today gets weight=W, oldest gets weight=1.
 *  - Final score = (weighted sum / max weighted sum) × 10.
 *
 * @param {object[]} warLog - Expanded, filtered GDC battle log
 * @returns {{ score: number, detail: string, byDay: Object<string,number> }}
 */
function dailyWarActivityScore(warLog) {
  const MAX_WINDOW = 14;

  // Build war-day → battle count map
  const byDay = {};
  for (const b of warLog) {
    const key = warDayKey(b.battleTime);
    byDay[key] = (byDay[key] ?? 0) + 1;
  }

  if (Object.keys(byDay).length === 0) return { score: 0, detail: 'No war battles in battle log', byDay };

  // Determine effective window anchored at the most recent active war day.
  // We do NOT include today in the window if there are no battles yet today,
  // because the current war day is still in progress (reset at 10:40 UTC).
  const todayWarDay      = warDayKey(new Date());
  const yesterdayWarDay  = new Date(new Date(todayWarDay).getTime() - MS_PER_DAY).toISOString().slice(0, 10);
  const hasActivityToday = (byDay[todayWarDay] ?? 0) > 0;
  const anchorDay        = hasActivityToday ? todayWarDay : yesterdayWarDay;

  const sortedDays  = Object.keys(byDay).sort();
  const firstDay    = sortedDays[0];

  // Days from firstDay up to and including anchorDay
  const daysSinceFirst = Math.max(0, Math.round(
    (new Date(anchorDay).getTime() - new Date(firstDay).getTime()) / MS_PER_DAY
  ));
  const window = Math.min(MAX_WINDOW, daysSinceFirst + 1);

  // Weighted sum over the window (anchorDay = index 0, oldest = index window-1)
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < window; i++) {
    const d   = new Date(new Date(anchorDay).getTime() - i * MS_PER_DAY);
    const key = d.toISOString().slice(0, 10);
    const battles = byDay[key] ?? 0;
    const daily   = Math.min(4, battles) / 4;
    const weight  = window - i; // today = window, oldest = 1
    weightedSum  += daily * weight;
    weightTotal  += weight;
  }

  const avg   = weightedSum / weightTotal; // 0-1
  const score = Math.round(avg * 100) / 10; // 0-10, 1 decimal

  // Build detail string
  const recentDays = Object.entries(byDay)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 3);
  const yesterdayKey  = new Date(new Date(todayWarDay).getTime() - MS_PER_DAY).toISOString().slice(0, 10);
  const parts = recentDays.map(([k, n]) => {
    const label = k === todayWarDay ? 'today' : k === yesterdayKey ? 'yesterday' : k;
    return `${n} ${label}`;
  });
  const totalBattles = Object.values(byDay).reduce((s, n) => s + n, 0);
  const activeDays   = sortedDays.length;
  const detail = `${parts.join(' · ')} — avg ${(avg * 4).toFixed(1)}/4 battles/day over ${window}-day window (${activeDays} active day${activeDays !== 1 ? 's' : ''}, ${totalBattles} total)`;

  return { score, detail, byDay };
}

/**
 * Build a battles-per-day map for the last `days` days.
 * Returns an array of { date: 'YYYY-MM-DD', count: number }.
 * @param {object[]} battleLog
 * @param {number} days
 * @returns {{ date: string; count: number }[]}
 */
export function buildDailyActivity(battleLog, days = 30) {
  const now = new Date();
  const map = {};

  // Pre-fill every day with 0
  for (let i = days - 1; i >= 0; i--) {
    const d = new Date(now - i * MS_PER_DAY);
    const key = d.toISOString().slice(0, 10);
    map[key] = 0;
  }

  const cutoff = Date.now() - days * MS_PER_DAY;
  battleLog.forEach((b) => {
    const ts = parseClashDate(b.battleTime);
    if (ts.getTime() >= cutoff) {
      const key = ts.toISOString().slice(0, 10);
      if (key in map) map[key]++;
    }
  });

  return Object.entries(map).map(([date, count]) => ({ date, count }));
}

// ── War score (5 criteria) ────────────────────────────────────

/**
 * Compute the War Reliability Score from 5 weighted criteria.
 * Total max = 30 pts  (10 + 10 + 5 + 3 + 2)
 *
 * Criteria:
 *  1. Régularité  /10 — participation rate (no 0-deck weeks)
 *  2. Score moyen /10 — average fame per played week (cap 3 000)
 *  3. Stabilité   / 5 — consecutive weeks in current clan (cap = totalWeeks)
 *  4. Expérience  / 3 — best-trophy road score (≥ 12 000 = 3/3)
 *  5. Dons        / 2 — cards donated this season (≥ 500 = 2/2)
 *
 * @param {object} player      - Player profile from Clash API
 * @param {object} warHistory  - Output of buildWarHistory()
 * @param {number|null} [warWinRate=null]  - Win rate on GDC battles (0-1). When provided,
 *                                           adds a 6th criterion /5 and maxScore becomes 35.
 * @returns {{ total:number; maxScore:number; pct:number; verdict:string; color:string; breakdown:object[] }}
 */
export function computeWarScore(player, warHistory, warWinRate = null) {
  const r = (v) => Math.round(v * 10) / 10; // round to 1 decimal

  // 1. Régularité (0-10)
  // Dénominateur = semaines passées dans le clan actuel, pas le total historique
  // → un joueur arrivé il y a 1 semaine et ayant joué cette semaine obtient 10/10
  const playedWeeks    = warHistory.weeks.filter((w) => w.decksUsed > 0).length;
  const totalWeeks     = warHistory.totalWeeks || 1;
  const weeksInClan    = Math.max(1, warHistory.streakInCurrentClan);
  const regularite     = r(Math.min(10, (playedWeeks / weeksInClan) * 10));

  // 2. Score moyen (0-10) — 3 000 fame = perfect
  const FAME_CAP       = 3000;
  const scoreMoyen     = r(Math.min(10, (warHistory.avgFame / FAME_CAP) * 10));

  // 3. Stabilité (0-5) — courbe doublée : 5 semaines consécutives = 5/5
  // (au lieu de 10 semaines), pour ne pas trop pénaliser les membres récents
  const stabilite      = r(Math.min(5, (warHistory.streakInCurrentClan / totalWeeks) * 10));

  // 4. Expérience trophées (0-3) — ≥ 12 000 best trophies = 3/3
  const TROPHY_CAP   = 12000;
  const experience   = r(Math.min(3, ((player.bestTrophies ?? 0) / TROPHY_CAP) * 3));

  // 5. Dons (0-2) — ≥ 500 cartes données cette saison = 2/2
  const DONATION_CAP = 500;
  const dons         = r(Math.min(2, ((player.donations ?? 0) / DONATION_CAP) * 2));

  // 6. Win Rate GDC (0-5) — optionnel, uniquement quand battlelog disponible
  const winRateGDC   = warWinRate !== null ? r(Math.min(5, warWinRate * 5)) : null;

  // 7. CW2 Battle Wins (0-10) — from ClanWarWins badge
  const CW2_CAP     = 250;
  const cw2Wins     = player.badges?.find((b) => b.name === 'ClanWarWins')?.progress ?? 0;
  const cw2Score    = r(Math.min(10, (cw2Wins / CW2_CAP) * 10));

  const total    = r(regularite + scoreMoyen + stabilite + experience + dons + (winRateGDC ?? 0) + cw2Score);
  const maxScore = winRateGDC !== null ? 45 : 40;
  const pct      = Math.round((total / maxScore) * 100);

  let verdict, color;
  if (pct >= 76)      { verdict = 'High reliability';  color = 'green'; }
  else if (pct >= 61) { verdict = 'Moderate risk';     color = 'yellow'; }
  else if (pct >= 31) { verdict = 'High risk';         color = 'orange'; }
  else                { verdict = 'Extreme risk';      color = 'red'; }

  const breakdown = [
    {
      label:  'Regularity',
      score:  regularite,
      max:    10,
      detail: (() => {
        if (!warHistory.totalWeeks) return 'No data';
        const suffix = weeksInClan < totalWeeks
          ? ` (member for ${weeksInClan} week${weeksInClan > 1 ? 's' : ''})`
          : '';
        return `${playedWeeks} / ${weeksInClan} weeks played${suffix}`;
      })(),
    },
    {
      label:  'Avg Score',
      score:  scoreMoyen,
      max:    10,
      detail: warHistory.avgFame
        ? `${warHistory.avgFame.toLocaleString('en-US')} fame / week (max 3,000)`
        : 'No data',
    },
    {
      label:  'Stability',
      score:  stabilite,
      max:    5,
      detail: (() => {
        const s = warHistory.streakInCurrentClan;
        const base = `${s} consecutive week${s > 1 ? 's' : ''} in this clan`;
        return s < 5 ? `${base} (full score at 5 wks)` : base;
      })(),
    },
    {
      label:  'Experience',
      score:  experience,
      max:    3,
      detail: `${(player.bestTrophies ?? 0).toLocaleString('en-US')} best trophies (cap 12,000)`,
    },
    {
      label:  'Donations',
      score:  dons,
      max:    2,
      detail: `${(player.donations ?? 0).toLocaleString('en-US')} cards donated (cap 500)`,
    },
    ...(winRateGDC !== null ? [{
      label:  'Win Rate (War)',
      score:  winRateGDC,
      max:    5,
      detail: `${Math.round(warWinRate * 100)}% victories in River Race`,
    }] : []),
    {
      label:  'CW2 Battle Wins',
      score:  cw2Score,
      max:    10,
      detail: `${cw2Wins.toLocaleString('en-US')} total CW2 wins (cap 250)`,
    },
  ];

  return { total, maxScore, pct, verdict, color, breakdown };
}

/**
 * Fallback reliability from battle log only (used when no race log history available).
 * Applies the same /30-pt scale as computeWarScore for consistency.
 *
 * Criteria (total /30):
 *  1. Activité GDC    /10 — nb combats GDC dans les 30 entrées du log (cap 10)
 *  2. Win Rate GDC    /10 — % victoires sur combats GDC (0 if no GDC battles)
 *  3. Activité générale /5 — combats compétitifs dans le log (cap 20)
 *  4. Expérience       /3 — bestTrophies (cap 12 000) — même critère que warScore
 *  5. Dons             /2 — donations (cap 500)         — même critère que warScore
 *
 * @param {object}   player
 * @param {object[]} warLog       - Filtered war battles (expanded duels)
 * @param {object}   battleLogBreakdown - Output of categorizeBattleLog()
 */
export function computeWarReliabilityFallback(player, warLog, battleLogBreakdown) {
  const r = (v) => Math.round(v * 10) / 10;

  const bd = battleLogBreakdown ?? { total: warLog.length, gdc: warLog.length, ladder: 0, challenge: 0 };

  // Use warLog.length as GDC count: it's the expanded set (rounds from duels included)
  const gdcCount   = warLog.length;
  const gdcWins    = warLog.filter(isWarWin).length;
  const gdcWinRate = gdcCount > 0 ? gdcWins / gdcCount : 0;
  const competitive = gdcCount + bd.ladder + bd.challenge;

  // 1. War Activity (0-10) — daily-based: rewards doing all 4 battles/day
  const activityResult = dailyWarActivityScore(warLog);
  const activiteGDC    = r(Math.min(10, activityResult.score));

  // 2. Win Rate GDC (0-10)
  const winRateGDC = gdcCount > 0 ? r(gdcWinRate * 10) : 0;

  // 3. Activité générale (0-5)
  const activiteGen = r(Math.min(5, (competitive / 20) * 5));

  // 4. Expérience (0-3) — bestTrophies cap 12 000
  const TROPHY_CAP = 12000;
  const experience = r(Math.min(3, ((player.bestTrophies ?? 0) / TROPHY_CAP) * 3));

  // 5. Dons (0-2) — cap 500
  const DONATION_CAP = 500;
  const dons = r(Math.min(2, ((player.donations ?? 0) / DONATION_CAP) * 2));

  // 6. CW2 Battle Wins (0-10) — from ClanWarWins badge
  const CW2_CAP  = 250;
  const cw2Wins  = player.badges?.find((b) => b.name === 'ClanWarWins')?.progress ?? 0;
  const cw2Score = r(Math.min(10, (cw2Wins / CW2_CAP) * 10));

  const total    = r(activiteGDC + winRateGDC + activiteGen + experience + dons + cw2Score);
  const maxScore = 40;
  const pct      = Math.round((total / maxScore) * 100);

  let verdict, color;
  if (pct >= 76)      { verdict = 'High reliability';  color = 'green'; }
  else if (pct >= 61) { verdict = 'Moderate risk';     color = 'yellow'; }
  else if (pct >= 31) { verdict = 'High risk';         color = 'orange'; }
  else                { verdict = 'Extreme risk';      color = 'red'; }

  return {
    total, maxScore, pct, verdict, color,
    isFallback: true,
    breakdown: [
      {
        label:  'War Activity',
        score:  activiteGDC,
        max:    10,
        detail: activityResult.detail,
      },
      {
        label:  'Win Rate (War)',
        score:  winRateGDC,
        max:    10,
        detail: gdcCount > 0
          ? `${Math.round(gdcWinRate * 100)}% wins (${gdcWins}W / ${gdcCount - gdcWins}L)`
          : 'No data — no war battles found',
      },
      {
        label:  'General Activity',
        score:  activiteGen,
        max:    5,
        detail: `${competitive} competitive battles (${gdcCount} War + ${bd.ladder} Ladder + ${bd.challenge} Challenges)`,
      },
      {
        label:  'Experience',
        score:  experience,
        max:    3,
        detail: `${(player.bestTrophies ?? 0).toLocaleString('en-US')} best trophies (cap 12,000)`,
      },
      {
        label:  'Donations',
        score:  dons,
        max:    2,
        detail: `${(player.donations ?? 0).toLocaleString('en-US')} cards donated (cap 500)`,
      },
      {
        label:  'CW2 Battle Wins',
        score:  cw2Score,
        max:    10,
        detail: `${cw2Wins.toLocaleString('en-US')} total CW2 wins (cap 250)`,
      },
    ],
  };
}

// Legacy stability (kept for potential reuse)
export function computeStabilityScore(player) {
  const donations = player.donations ?? 0;
  const battleCount = player.battleCount ?? 0;
  const expLevel = player.expLevel ?? 1;
  const raw = (donations / 1000) * (battleCount / 2000) * (expLevel * 1.5);
  const score = Math.min(100, Math.round(raw * 10) / 10);
  let label;
  if (score >= 40) label = 'High stability';
  else if (score >= 15) label = 'Medium stability';
  else label = 'Low stability';
  return { score, label };
}

// ── River Race history ────────────────────────────────────────

/**
 * Extract a player's week-by-week river race history from a clan race log.
 *
 * @param {string}   playerTag       Player tag (with or without #)
 * @param {object[]} raceLog         Array returned by /clans/{tag}/riverracelog
 * @param {string}   [currentClanTag] Tag of the player's current clan (to compute streak)
 */
export function buildWarHistory(playerTag, raceLog, currentClanTag = null) {
  const normalized = playerTag.startsWith('#') ? playerTag : `#${playerTag}`;
  const normClan   = currentClanTag
    ? (currentClanTag.startsWith('#') ? currentClanTag : `#${currentClanTag}`)
    : null;
  const weeks = [];

  for (const race of raceLog) {
    for (const standing of race.standings ?? []) {
      const p = standing.clan?.participants?.find((x) => x.tag === normalized);
      if (p) {
        weeks.push({
          label:       `S${race.seasonId}·W${race.sectionIndex + 1}`,
          seasonId:    race.seasonId,
          sectionIndex: race.sectionIndex,
          fame:        p.fame      ?? 0,
          decksUsed:   p.decksUsed ?? 0,
          boatAttacks: p.boatAttacks ?? 0,
          clanTag:     standing.clan.tag,
        });
        break;
      }
    }
  }

  // Consecutive weeks (most-recent first) the player was in their current clan
  let streakInCurrentClan = 0;
  if (normClan) {
    for (const w of weeks) {
      if (w.clanTag === normClan) streakInCurrentClan++;
      else break;
    }
  }

  const weeksPlayed  = weeks.filter((w) => w.decksUsed > 0);
  const totalFame    = weeksPlayed.reduce((s, w) => s + w.fame, 0);
  const participation = weeksPlayed.length;
  const totalWeeks   = raceLog.length;
  const avgFame      = participation ? Math.round(totalFame / participation) : 0;
  const maxFame      = weeksPlayed.reduce((m, w) => Math.max(m, w.fame), 0);

  return { weeks, totalFame, avgFame, maxFame, participation, totalWeeks, streakInCurrentClan };
}

// ── Player full analysis ──────────────────────────────────────

/**
 * Produce the complete analysis object for a player.
 * @param {object}   player
 * @param {object[]} battleLog
 * @returns {object}
 */
export function analyzePlayer(player, battleLog) {
  // Categorise all raw entries before filtering
  const battleLogBreakdown = categorizeBattleLog(battleLog);

  // Filter to war battles only, then expand duel rounds into individual entries
  const warLog = expandDuelRounds(filterWarBattles(battleLog));

  // Fallback reliability (battle log only) — overridden in the route when race log is available
  const reliability = computeWarReliabilityFallback(player, warLog, battleLogBreakdown);
  const dailyActivity = buildDailyActivity(warLog, 7);

  const wins            = warLog.filter(isWarWin).length;
  const losses          = warLog.filter(isWarLoss).length;
  const threeCrowns     = warLog.filter((b) => getMyBattleCrowns(b) === 3).length;
  const totalBattlesInLog = warLog.length;
  const winRate         = totalBattlesInLog > 0 ? Math.round((wins / totalBattlesInLog) * 100) : 0;

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
      wins,
      losses,
      winRate,
      donations:    player.donations ?? 0,
      threeCrowns,
      battleLogBreakdown,   // counts per category across all 30 entries
    },
    recentActivity: {
      dailyActivity,
      apiLimitNote: 'Battle log capped at 30 entries by the Clash Royale API.',
    },
    reliability, // fallback — replaced by warScore when race log available
  };
}

// ── Clan analysis ─────────────────────────────────────────────

/**
 * Compute a lightweight activity score for a clan member.
 * Uses only data available from the /members endpoint (no battle log).
 *
 * Score (0–100):
 *   = min(100, (donations / 300 * 40) + (trophies / 10000 * 40) + (expLevel / 60 * 20))
 *
 * @param {object} member
 * @returns {{ score: number; verdict: string; color: string }}
 */
export function computeMemberActivityScore(member) {
  const donations = member.donations ?? 0;
  const trophies = member.trophies ?? 0;
  const expLevel = member.expLevel ?? 1;

  const donationPart = Math.min(40, (donations / 300) * 40);
  const trophyPart = Math.min(40, (trophies / 10000) * 40);
  const expPart = Math.min(20, (expLevel / 60) * 20);

  const score = Math.round(donationPart + trophyPart + expPart);

  let verdict, color;
  if (score >= 76) {
    verdict = 'High reliability';
    color = 'green';
  } else if (score >= 61) {
    verdict = 'Moderate risk';
    color = 'yellow';
  } else if (score >= 31) {
    verdict = 'High risk';
    color = 'orange';
  } else {
    verdict = 'Extreme risk';
    color = 'red';
  }

  return { score, verdict, color };
}

/**
 * Enrich an array of clan members with activity scores.
 * @param {object[]} members
 * @returns {object[]}
 */
export function analyzeClanMembers(members) {
  return members.map((m) => {
    const { score, verdict, color } = computeMemberActivityScore(m);
    return {
      name: m.name,
      tag: m.tag,
      role: m.role,
      trophies: m.trophies ?? 0,
      donations: m.donations ?? 0,
      donationsReceived: m.donationsReceived ?? 0,
      expLevel: m.expLevel ?? 1,
      activityScore: score,
      verdict,
      color,
    };
  });
}
