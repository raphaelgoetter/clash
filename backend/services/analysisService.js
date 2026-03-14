// ============================================================
// analysisService.js — Core scoring and analysis logic
//
// All formulas are documented inline so that they can be
// tweaked as new data becomes available.
// ============================================================

// helper API wrappers needed by getPlayerAnalysis
import {
  fetchPlayer,
  fetchBattleLog,
  fetchClanMembers,
  fetchRaceLog,
  fetchCurrentRace,
} from './clashApi.js';

// ── Constants ─────────────────────────────────────────────────

const MS_PER_DAY = 1000 * 60 * 60 * 24;

// Clan War day resets at 10:40 heure de Paris (UTC+1 hiver, UTC+2 été).
// Le décalage UTC est calculé dynamiquement pour gérer le DST.

/** Décalage UTC→Paris en ms pour une date donnée (+3 600 000 hiver, +7 200 000 été) */
function parisOffsetMs(date = new Date()) {
  const p = new Date(date.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const u = new Date(date.toLocaleString('en-US', { timeZone: 'UTC' }));
  return p - u;
}

/** Nombre de ms à soustraire à un timestamp UTC pour obtenir le « jour GDC » (reset 10h40 Paris) */
export function warResetOffsetMs(date = new Date()) {
  return (10 * 60 + 40) * 60 * 1000 - parisOffsetMs(date);
}

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
// Tous les types en minuscules — la comparaison normalise b.type avec .toLowerCase()
const WAR_BATTLE_TYPES = new Set([
  'riverracepvp',
  'riverraceduel',
  'riverraceduelscolosseum',
  'riverraceboat',
  'clanwarbattle',
]);

/**
 * Filter a battle log to keep only Clan War battles.
 * @param {object[]} battleLog
 * @returns {object[]}
 */
export function filterWarBattles(battleLog) {
  return battleLog.filter((b) => WAR_BATTLE_TYPES.has((b.type ?? '').toLowerCase()));
}

/** Battle types considered as regular Ladder / Path of Legend. */
const LADDER_TYPES = new Set(['pvp', 'pathoflegend', 'ranked']);

/** Battle types considered as challenge / tournament. */
const CHALLENGE_TYPES = new Set([
  'challenge', 'grandchallenge', 'classicchallenge',
  'challengetournament', 'tournament',
]);

/** Battle types considered as friendly / training (not competitive). */
const FRIENDLY_TYPES = new Set(['training', 'friendly', 'clanmate', 'casual2v2', '2v2']);

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
    const t = (b.type ?? '').toLowerCase();
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
export function warDayKey(dateOrTs) {
  const d = dateOrTs instanceof Date ? dateOrTs : parseClashDate(dateOrTs);
  return new Date(d.getTime() - warResetOffsetMs(d)).toISOString().slice(0, 10);
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
  function fmtDate(iso) {
    const d = new Date(iso);
    const opts = { month: 'short', day: 'numeric' };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = 'numeric';
    return d.toLocaleDateString(undefined, opts);
  }
  const parts = recentDays.map(([k, n]) => {
    let label;
    if (k === todayWarDay) label = 'today';
    else if (k === yesterdayKey) label = 'yesterday';
    else label = fmtDate(k);
    // human‑friendly, e.g. "4× on Mar 5" or "1× yesterday"
    return `${n}× on ${label}`;
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
 * Total max = 32 pts  (12 + 10 + 5 + 3 + 2)
 *
 * Criteria:
 *  1. Régularité  /12 — decks used relative to ideal 16/week
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
export function computeWarScore(player, warHistory, warWinRate = null, lastSeen = null, discordLinked = false) {
  const r = (v) => Math.round(v * 10) / 10; // round to 1 decimal

  // filter out weeks that were explicitly ignored by earlier rules; keeping the
  // flag lets the UI still display them greyed-out
  const weeks = warHistory.weeks.filter((w) => !w.ignored);

  // 1. Régularité (0-12) — proportionnelle au nombre de decks joués
  // pendant les semaines terminées. On exclut la semaine en cours (isCurrent)
  // car elle n'est pas forcément complète. Une semaine parfaite vaut 16 decks.
  // le score est normalisé sur 12 points (équivalent à 100 % de decks complets).
  const totalWeeks     = warHistory.totalWeeks || 1;
  const weeksInClan    = Math.max(1, warHistory.streakInCurrentClan);
  // Semaines terminées dans le streak clan actuel (les N premières du tableau)
  const completedInClan = weeks
    .slice(0, weeksInClan)
    .filter((w) => !w.isCurrent);
  const completedCount = completedInClan.length;
  // nombre total de decks joués dans ces semaines
  const deckSum = completedInClan.reduce((s, w) => s + (w.decksUsed || 0), 0);
  const idealDecks = completedCount * 16;
  // count how many weeks didn't hit 16 decks
  const incompleteWeeks = completedInClan.filter((w) => (w.decksUsed || 0) < 16).length;
  // base ratio = total decks / ideal decks. then convert to 12-point scale.
  // apply a penalty of 0.5 point per incomplete week to discourage partial
  // weeks; this ensures a player who regularly quits early loses more than
  // one who simply has uneven deck counts.
  // the result is clamped between 0 and 12.
  const baseScore = completedCount > 0 ? (deckSum / (idealDecks || 1)) * 12 : 0;
  const regularite = r(Math.max(0, Math.min(12, baseScore - incompleteWeeks * 0.5)));

  // 2. Score moyen (0-10) — 3 000 fame = perfect
  const FAME_CAP       = 3000;
  const scoreMoyen     = r(Math.min(10, (warHistory.avgFame / FAME_CAP) * 10));

  // 3. Stabilité (0-8) — courbe doublée : 5 semaines consécutives = 8/8
  // (au lieu de 10 semaines), pour ne pas trop pénaliser les membres récents
  const stabilite      = r(Math.min(8, (warHistory.streakInCurrentClan / totalWeeks) * 16));

  // 4. Expérience trophées (0-3) — [4 000, 14 000] trophées actuels
  const TROPHY_MIN   = 4000;
  const TROPHY_CAP   = 14000;
  const experience   = r(Math.max(0, Math.min(3, (((player.trophies ?? 0) - TROPHY_MIN) / (TROPHY_CAP - TROPHY_MIN)) * 3)));

  // 5. Dons (0-2) — ≥ 500 cartes données cette saison = 2/2
  const DONATION_CAP = 500;
  const dons         = r(Math.min(2, ((player.donations ?? 0) / DONATION_CAP) * 2));

  // 6. Win Rate GDC (0-3) — optionnel, uniquement quand battlelog disponible
  const winRateGDC   = warWinRate !== null ? r(Math.min(3, warWinRate * 3)) : null;

  // 7. CW2 Battle Wins (0-8) — from ClanWarWins badge
  const CW2_CAP     = 250;
  const cw2Wins     = player.badges?.find((b) => b.name === 'ClanWarWins')?.progress ?? 0;
  const cw2Score    = r(Math.min(8, (cw2Wins / CW2_CAP) * 8));

  // 8. Last seen (0-3) — uniquement en contexte clan (lastSeen fourni depuis /members)
  let lastSeenScore = null;
  let lastSeenDays  = null;
  if (lastSeen) {
    lastSeenDays  = (Date.now() - parseClashDate(lastSeen).getTime()) / MS_PER_DAY;
    lastSeenScore = lastSeenDays <= 1 ? 5 : lastSeenDays <= 3 ? 3 : lastSeenDays <= 7 ? 1 : 0;
  }

  // 9. Discord (0-2) — lié au serveur Discord du clan
  const discordScore = discordLinked ? 2 : 0;

  const total    = r(regularite + scoreMoyen + stabilite + experience + dons + (winRateGDC ?? 0) + cw2Score + (lastSeenScore ?? 0) + discordScore);
  // Regularity now max 12 → base totals bump by +2; Discord always adds 2
  const maxScore = (winRateGDC !== null ? 46 : 43) + (lastSeenScore !== null ? 5 : 0) + 2;
  const pct      = Math.round((total / maxScore) * 100);

  let verdict, color;
  if (pct >= 75)      { verdict = 'High reliability';  color = 'green'; }
  else if (pct >= 56) { verdict = 'Moderate risk';     color = 'yellow'; }
  else if (pct >= 31) { verdict = 'High risk';         color = 'orange'; }
  else                { verdict = 'Extreme risk';      color = 'red'; }

  const breakdown = [
    {
      label:  'Regularity',
      score:  regularite,
      max:    12,
      detail: (() => {
        if (completedCount === 0) return 'No completed week in this clan yet';
        const pct = Math.round((deckSum / (idealDecks || 1)) * 100);
        const suffix = weeksInClan < totalWeeks
          ? ` — member for ${weeksInClan} week${weeksInClan > 1 ? 's' : ''}`
          : '';
        let txt = `${deckSum}/${idealDecks} decks across ${completedCount} week${completedCount > 1 ? 's' : ''} (${pct}%)`;
        if (incompleteWeeks > 0) {
          txt += ` — ${incompleteWeeks} incomplete week${incompleteWeeks > 1 ? 's' : ''} (-${(incompleteWeeks * 0.5).toFixed(1)} pts)`;
        }
        return txt + suffix;
      })(),
    },
    {
      label:  'Avg Score',
      score:  scoreMoyen,
      max:    10,
      detail: warHistory.avgFame
        ? `${warHistory.avgFame.toLocaleString('en-US')} fame / week (cap 3,000)`
        : 'No data',
    },
    {
      label:  'CW2 Battle Wins',
      score:  cw2Score,
      max:    8,
      detail: `${cw2Wins.toLocaleString('en-US')} total CW2 wins (cap 250)`,
    },
    {
      label:  'Stability',
      score:  stabilite,
      max:    8,
      detail: (() => {
        const s = warHistory.streakInCurrentClan;
        const base = `${s} consecutive week${s > 1 ? 's' : ''} in this clan`;
        return s < 5 ? `${base} (full score at 5 wks)` : base;
      })(),
    },
    ...(lastSeenScore !== null ? [{
      label:  'Last Seen',
      score:  lastSeenScore,
      max:    5,
      detail: lastSeenDays < 1 ? 'Active in the last 24 h'
            : lastSeenDays < 3 ? `Active ${(Math.round(lastSeenDays * 10) / 10).toFixed(1)} day(s) ago`
            : lastSeenDays < 7 ? `Active ${Math.round(lastSeenDays)} days ago`
            : `Last seen ${Math.round(lastSeenDays)} days ago ⚠️`,
    }] : []),
    ...(winRateGDC !== null ? [{
      label:  'Win Rate (War)',
      score:  winRateGDC,
      max:    3,
      detail: `${Math.round(warWinRate * 100)}% victories in River Race`,
    }] : []),
    {
      label:  'Experience',
      score:  experience,
      max:    3,
      detail: `${(player.trophies ?? 0).toLocaleString('en-US')} trophies (range 4,000–14,000)`,
    },
    {
      label:  'Donations',
      score:  dons,
      max:    2,
      detail: `${(player.donations ?? 0).toLocaleString('en-US')} cards donated (cap 500)`,
    },
    {
      label:  'Discord',
      score:  discordScore,
      max:    2,
      detail: discordLinked ? 'Discord account linked to the server' : 'Discord account not linked (/discord-link)',
    },
  ];

  return { total, maxScore, pct, verdict, color, breakdown };
}

/**
 * Fallback reliability from battle log only (used when no race log history available).
 * Applies the same /38‑pt scale as computeWarScore for consistency.
 *
 * Criteria (total /38):
 *  1. Activité GDC    /12 — decks/day (bonuses for 4‑deck days, penalties for <4)
 *  2. Activité générale /8 — combats compétitifs dans le log (cap 20)
 *  3. CW2 Wins        /8 — badge progress (cap 250)
 *  4. Win Rate GDC    /5 — % victoires sur combats GDC (0 if no GDC battles)
 *  5. Expérience      /3 — bestTrophies (cap 12 000)
 *  6. Dons            /2 — donations (cap 500)
 *
 * (+5 bonus pts possible for Last Seen when ≥16 war decks observed)
 *
 * @param {object}   player
 * @param {object[]} warLog       - Filtered war battles (expanded duels)
 * @param {object}   battleLogBreakdown - Output of categorizeBattleLog()
 */
export function computeWarReliabilityFallback(player, warLog, battleLogBreakdown, lastSeen = null, discordLinked = false, currentRaceDecks = 0) {
  const r = (v) => Math.round(v * 10) / 10;

  const bd = battleLogBreakdown ?? { total: warLog.length, gdc: warLog.length, ladder: 0, challenge: 0 };

  // Quand le battle log ne contient plus de combats GDC (ex. écrasés par des parties ladder),
  // on synthétise une entrée "aujourd'hui" à partir de decksUsed de la course en cours.
  const syntheticLog = warLog.length === 0 && currentRaceDecks > 0
    ? Array.from({ length: Math.min(4, currentRaceDecks) }, () => ({ battleTime: new Date().toISOString() }))
    : null;
  const effectiveLog = syntheticLog ?? warLog;

  // gdcCount = batailles réelles si disponibles, sinon total hebdo de la course (proxy)
  const gdcCount   = warLog.length > 0 ? warLog.length : currentRaceDecks;
  const gdcWins    = warLog.filter(isWarWin).length;
  const gdcWinRate = gdcCount > 0 ? gdcWins / gdcCount : 0;
  const competitive = gdcCount + bd.ladder + bd.challenge;

  // 1. War Activity (0-12) — based on decks/day, with bonuses/penalties
  // We still use dailyWarActivityScore to compute a baseline, but then
  // apply an extra boost for full 4‑deck days and a small penalty for each
  // day with <4 decks.  This rewards players who prioritise GDC battles.
  const activityResult = dailyWarActivityScore(effectiveLog);
  // count perfect and short days within window used by score
  const perfectDays = Object.values(activityResult.byDay).filter((d) => d >= 4).length;
  const shortDays   = Object.values(activityResult.byDay).filter((d) => d > 0 && d < 4).length;
  let activiteGDC = activityResult.score;
  activiteGDC += perfectDays * 0.2;    // +0.2 point per perfect day
  activiteGDC -= shortDays * 0.1;      // -0.1 point per short day
  activiteGDC = r(Math.min(12, Math.max(0, activiteGDC)));
  // Plafond de confiance : proportionnel aux batailles GDC observées dans le log.
  // Un joueur avec peu de données ne peut pas atteindre le score d'un vétéran,
  // quelle que soit la proportion faite — on manque de recul pour l'évaluer.
  // 16 batailles (1 semaine complète) = plafond entièrement levé.
  const confidenceCap = r(Math.min(12, (gdcCount / 16) * 12));
  activiteGDC = r(Math.min(activiteGDC, confidenceCap));

  // 2. Win Rate GDC (0-5) — minimum 10 combats requis, sinon exclu du score ET du max
  const winRateExcluded = gdcCount < 10;
  const winRateGDC = winRateExcluded ? 0 : r(gdcWinRate * 5);

  // 3. Activité générale (0-8)
  const activiteGen = r(Math.min(8, (competitive / 20) * 8));

  // 4. Expérience (0-3) — trophées actuels, plage [4 000, 14 000]
  const TROPHY_MIN = 4000;
  const TROPHY_CAP = 14000;
  const experience = r(Math.max(0, Math.min(3, (((player.trophies ?? 0) - TROPHY_MIN) / (TROPHY_CAP - TROPHY_MIN)) * 3)));

  // 5. Dons (0-2) — cap 500
  const DONATION_CAP = 500;
  const dons = r(Math.min(2, ((player.donations ?? 0) / DONATION_CAP) * 2));

  // 6. CW2 Battle Wins (0-8) — from ClanWarWins badge
  const CW2_CAP  = 250;
  const cw2Wins  = player.badges?.find((b) => b.name === 'ClanWarWins')?.progress ?? 0;
  const cw2Score = r(Math.min(8, (cw2Wins / CW2_CAP) * 8));

  // 7. Last seen (0-3) — only meaningful if we've seen several war days.
  let lastSeenScore = null;
  let lastSeenDays  = null;
  if (lastSeen && warLog.length >= 16) {
    // require about two weeks worth of war decks before counting this
    lastSeenDays  = (Date.now() - parseClashDate(lastSeen).getTime()) / MS_PER_DAY;
    lastSeenScore = lastSeenDays <= 1 ? 5 : lastSeenDays <= 3 ? 3 : lastSeenDays <= 7 ? 1 : 0;
  }

  // Discord (0-2) — lié au serveur Discord du clan
  const discordScore = discordLinked ? 2 : 0;

  const total    = r(activiteGDC + activiteGen + cw2Score + winRateGDC + experience + dons + (lastSeenScore ?? 0) + discordScore);
  // base max: 12+8+8+5+3+2=38, réduit à 33 si win rate exclu (<10 combats); Discord toujours +2
  const maxBase  = winRateExcluded ? 33 : 38;
  const maxScore = maxBase + (lastSeenScore !== null ? 5 : 0) + 2;
  const pct      = Math.round((total / maxScore) * 100);

  let verdict, color;
  if (pct >= 75)      { verdict = 'High reliability';  color = 'green'; }
  else if (pct >= 56) { verdict = 'Moderate risk';     color = 'yellow'; }
  else if (pct >= 31) { verdict = 'High risk';         color = 'orange'; }
  else                { verdict = 'Extreme risk';      color = 'red'; }

  return {
    total, maxScore, pct, verdict, color,
    isFallback: true,
    breakdown: [
      {
        label:  'War Activity',
        score:  activiteGDC,
        max:    12,
        detail: (() => {
          const parts = Object.entries(activityResult.byDay)
            .sort((a, b) => b[0].localeCompare(a[0]))
            .map(([k, n]) => `${n}× ${k}`);
          return parts.join(' · ');
        })(),
      },
      {
        label:  'General Activity',
        score:  activiteGen,
        max:    8,
        detail: `${competitive} competitive battles (${gdcCount} War + ${bd.ladder} Ladder + ${bd.challenge} Challenges)`,
      },
      {
        label:  'CW2 Battle Wins',
        score:  cw2Score,
        max:    8,
        detail: `${cw2Wins.toLocaleString('en-US')} total CW2 wins (cap 250)`,
      },
      {
        label:  'Win Rate (War)',
        score:  gdcCount > 0 ? r(Math.min(5, gdcWinRate * 5)) : 0,
        max:    5,
        excluded: winRateExcluded,
        detail: gdcCount === 0
          ? 'No data — no war battles found'
          : winRateExcluded
            ? `${Math.round(gdcWinRate * 100)}% wins (${gdcWins}W / ${gdcCount - gdcWins}L) — not counted (10 battles required)`
            : `${Math.round(gdcWinRate * 100)}% wins (${gdcWins}W / ${gdcCount - gdcWins}L)`,
      },
      ...(lastSeenScore !== null ? [{
        label:  'Last Seen',
        score:  lastSeenScore,
        max:    5,
        detail: lastSeenDays < 1 ? 'Active in the last 24 h'
              : lastSeenDays < 3 ? `Active ${(Math.round(lastSeenDays * 10) / 10).toFixed(1)} day(s) ago`
              : lastSeenDays < 7 ? `Active ${Math.round(lastSeenDays)} days ago`
              : `Last seen ${Math.round(lastSeenDays)} days ago ⚠️`,
      }] : []),
      {
        label:  'Experience',
        score:  experience,
        max:    3,
        detail: `${(player.trophies ?? 0).toLocaleString('en-US')} trophies (range 4,000–14,000)`,
      },
      {
        label:  'Donations',
        score:  dons,
        max:    2,
        detail: `${(player.donations ?? 0).toLocaleString('en-US')} cards donated (cap 500)`,
      },
      {
        label:  'Discord',
        score:  discordScore,
        max:    2,
        detail: discordLinked ? 'Discord account linked to the server' : 'Discord account not linked (/discord-link)',
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
 * Estime le nombre de victoires PvP depuis les données de fame.
 * PvP loss = 100 fame, PvP win = 200 fame.
 * Boat attacks : on suppose 200 fame chacun (valeur standard CW2).
 * @returns {{ wins: number, pvpDecks: number }}
 */
export function estimateWinsFromFame(fame, decksUsed, boatAttacks) {
  // Dans l'API Supercell : decksUsed = batailles PvP uniquement, boatAttacks = attaques bateau (compteur séparé).
  const pvpDecks = decksUsed;
  if (pvpDecks <= 0) return { wins: 0, pvpDecks: 0 };
  const pvpFame = Math.max(0, fame - boatAttacks * 200);
  // loss = 100 fame, win = 200 fame
  // wins × 200 + losses × 100 = pvpFame, wins + losses = pvpDecks
  // → wins = (pvpFame − 100 × pvpDecks) / 100
  const wins = Math.max(0, Math.min(pvpDecks, Math.round((pvpFame - 100 * pvpDecks) / 100)));
  return { wins, pvpDecks };
}

/**
 * Extract a player's week-by-week river race history from a clan race log.
 *
 * @param {string}   playerTag       Player tag (with or without #)
 * @param {object[]} raceLog         Array returned by /clans/{tag}/riverracelog
 * @param {string}   [currentClanTag] Tag of the player's current clan (to compute streak)
 */
export function buildWarHistory(playerTag, raceLog, currentClanTag = null, currentRace = null) {
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

  // Prépend la race en cours si le joueur y figure.
  // /currentriverrace expose .clan.participants[] directement (pas standings[]).
  if (currentRace?.clan?.participants) {
    const p = currentRace.clan.participants.find((x) => x.tag === normalized);
    if (p) {
      weeks.unshift({
        label:        `S${currentRace.seasonId ?? '?'}·W${(currentRace.sectionIndex ?? 0) + 1} (live)`,
        seasonId:     currentRace.seasonId,
        sectionIndex: currentRace.sectionIndex ?? 0,
        fame:         p.fame        ?? 0,
        decksUsed:    p.decksUsed   ?? 0,
        boatAttacks:  p.boatAttacks ?? 0,
        clanTag:      currentRace.clan.tag,
        isCurrent:    true,
      });
    }
  }

  // Semaines consécutives en cours dans le clan actuel (du plus récent vers le plus ancien)
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

  // Win rate historique estimé depuis la fame (semaines terminées uniquement, pas isCurrent)
  // Exige au moins 5 decks PvP pour être statistiquement significatif
  const MIN_PVP_DECKS = 5;
  const completedWeeks = weeksPlayed.filter((w) => !w.isCurrent);
  const completedParticipation = completedWeeks.length;
  let totalPvpDecks = 0, totalEstimatedWins = 0;
  for (const w of completedWeeks) {
    const { wins: wWins, pvpDecks: wPvp } = estimateWinsFromFame(w.fame, w.decksUsed, w.boatAttacks);
    totalPvpDecks      += wPvp;
    totalEstimatedWins += wWins;
  }
  const historicalWinRate = totalPvpDecks >= MIN_PVP_DECKS ? totalEstimatedWins / totalPvpDecks : null;

  return { weeks, totalFame, avgFame, maxFame, participation, completedParticipation, totalWeeks, streakInCurrentClan, historicalWinRate };
}

// ── Player full analysis ──────────────────────────────────────

/**
 * Produce the complete analysis object for a player.
 * @param {object}   player
 * @param {object[]} battleLog
 * @returns {object}
 */
export function analyzePlayer(player, battleLog, lastSeen = null, discordLinked = false) {
  // Categorise all raw entries before filtering
  const battleLogBreakdown = categorizeBattleLog(battleLog);

  // Filter to war battles only, then expand duel rounds into individual entries
  const warLog = expandDuelRounds(filterWarBattles(battleLog));

  // Fallback reliability (battle log only) — overridden in the route when race log is available
  const reliability = computeWarReliabilityFallback(player, warLog, battleLogBreakdown, lastSeen, discordLinked);
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

/**
 * Build the full player analysis previously located in routes/player.js.
 * This helper is exported so that other consumers (e.g. Discord commands)
 * can reuse the same logic and guarantee identical results.
 *
 * The implementation is essentially a copy of the old buildPlayerAnalysis
 * function, including caching of lastSeen and war history enrichment.
 * A small extra property (`overview.lastSeen`) is added to make it easier
 * for external callers to display the player's last activity.
 *
 * @param {string} tag - player tag (with or without leading '#')
 * @returns {Promise<object>} analysis payload
 */
export async function getPlayerAnalysis(tag, discordLinked = false) {
  const [player, battleLog] = await Promise.all([
    fetchPlayer(tag),
    fetchBattleLog(tag),
  ]);

  // Récupère lastSeen depuis le roster du clan (non disponible sur le profil joueur)
  let lastSeen = null;
  if (player.clan?.tag) {
    try {
      const members = await fetchClanMembers(player.clan.tag);
      const entry = members.find((m) => m.tag === player.tag);
      lastSeen = entry?.lastSeen ?? null;
    } catch (_) {
      // ignore, lastSeen remains null
    }
  }

  const analysis = analyzePlayer(player, battleLog, lastSeen, discordLinked);

  // Enrich with river race history if the player is currently in a clan.
  // We silently ignore failures so a missing/private war log doesn't block the response.
  let currentRaceMeta = null;
  if (player.clan?.tag) {
    try {
      const [raceLog, currentRace] = await Promise.all([
        fetchRaceLog(player.clan.tag),
        fetchCurrentRace(player.clan.tag).catch(() => null),
      ]);
      currentRaceMeta = { state: currentRace?.state ?? null, periodIndex: currentRace?.periodIndex ?? null };
      analysis.warHistory = buildWarHistory(player.tag, raceLog, player.clan.tag, currentRace);

      // Compute GDC win rate from battle log (available for all players)
      // Minimum 10 battles required for a meaningful sample — below that, return null
      // so the criterion is excluded from the score breakdown.
      const rawWarLog = expandDuelRounds(filterWarBattles(battleLog));
      const gdcWins = rawWarLog.filter(isWarWin).length;
      const warWinRate = rawWarLog.length >= 10 ? gdcWins / rawWarLog.length : null;

      // Build list of *prior* weeks (exclude live/current one) for history rules
      const prevWeeks = analysis.warHistory.weeks.filter((w) => !w.isCurrent);

      // if any previous week shows 16 or more decks, history is reliable
      const hasFullWeek = prevWeeks.some((w) => (w.decksUsed ?? 0) >= 16);

      // old rule remains as fallback: at least two completed weeks in clan
      const oldRule = analysis.warHistory.streakInCurrentClan >= 2
        && analysis.warHistory.completedParticipation >= 2;

      let hasEnoughHistory = hasFullWeek || oldRule;

      // additional handling: when player has ≥2 prior weeks and the *oldest*
      // one is incomplete (<16), treat it as a mid‑race arrival and **ignore it**
      // in all score computations. We keep the week in the history array so the
      // UI can render it greyed out, but mark it with an `ignored` flag and
      // recalc summary stats accordingly.
      if (prevWeeks.length >= 2) {
        const oldest = prevWeeks[prevWeeks.length - 1];
        if ((oldest.decksUsed ?? 0) < 16) {
          oldest.ignored = true;

          // recompute summary metrics excluding the ignored week
          const kept = analysis.warHistory.weeks.filter((w) => !w.ignored && (w.decksUsed ?? 0) > 0);
          const totalFame = kept.reduce((s, w) => s + (w.fame || 0), 0);
          analysis.warHistory.totalFame = totalFame;
          analysis.warHistory.participation = kept.length;
          analysis.warHistory.avgFame = kept.length ? Math.round(totalFame / kept.length) : 0;
          analysis.warHistory.maxFame = kept.reduce((m, w) => Math.max(m, w.fame || 0), 0);
          analysis.warHistory.completedParticipation = kept.filter((w) => !w.isCurrent).length;
          // and recompute historical win rate from the same kept weeks
          const MIN_PVP_DECKS = 5;
          let totalPvpDecks = 0, totalEstimatedWins = 0;
          for (const w of kept.filter((w) => !w.isCurrent)) {
            const { wins: wWins, pvpDecks: wPvp } = estimateWinsFromFame(w.fame, w.decksUsed, w.boatAttacks);
            totalPvpDecks      += wPvp;
            totalEstimatedWins += wWins;
          }
          analysis.warHistory.historicalWinRate = totalPvpDecks >= MIN_PVP_DECKS ? totalEstimatedWins / totalPvpDecks : null;
        }
      }

      // after any ignored-week adjustments the historical win rate may have changed
      const effectiveWinRate = analysis.warHistory.historicalWinRate ?? warWinRate;

      if (hasEnoughHistory) {
        analysis.warScore = computeWarScore(player, analysis.warHistory, effectiveWinRate, lastSeen, discordLinked);
        // si win rate exclu (< 10 batailles), ajouter une entrée informative marquée excluded
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
        const warLogFb = expandDuelRounds(filterWarBattles(battleLog));
        const bdFb = categorizeBattleLog(battleLog);
        // Si les combats GDC ont été chassés du battle log (fenêtre 30) par des parties ladder,
        // on passe decksUsed de la course en cours pour reconstituer l'activité.
        const racePartFb = currentRace?.clan?.participants?.find((p) => p.tag === player.tag);
        analysis.warScore = computeWarReliabilityFallback(player, warLogFb, bdFb, lastSeen, discordLinked, racePartFb?.decksUsed ?? 0);
      }
    } catch (_) {
      analysis.warHistory = null;
      analysis.warScore = analysis.reliability; // fallback
    }
  } else {
    analysis.warHistory = null;
    analysis.warScore = analysis.reliability; // fallback
  }

  // Résumé GDC semaine courante — calculé après warHistory pour utiliser la source fiable
  const currentWeek = analysis.warHistory?.weeks?.find((w) => w.isCurrent) ?? null;
  const raceTotalDecks = currentWeek?.decksUsed ?? null;
  const warSummary = buildCurrentWarDays(battleLog, raceTotalDecks, currentRaceMeta);

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
    warSummary.arrivedMidWar = true;
    warSummary.arrivedOnDay = warSummary.daysFromThu + 1; // 1=jeu, 2=ven, 3=sam, 4=dim
    warSummary.totalDecksUsed = 0;
    warSummary.isReliableTotal = true;
  }
  analysis.currentWarDays = warSummary;

  // expose lastSeen et discord pour les appelants externes
  analysis.overview.lastSeen = lastSeen;
  analysis.overview.discord = discordLinked;
  return analysis;
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
  if (score >= 75) {
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

// ── Current war week ──────────────────────────────────────────────────────────

/**
 * Calcule les données de la semaine de guerre en cours (jeu–dim).
 * Retourne null si on est hors période de guerre (lun–mer).
 *
 * @param {object[]} battleLog          Journal de batailles brut
 * @param {number|null} raceTotalDecks  decksUsed depuis currentriverrace (source fiable), ou null
 * @returns {{ days, totalDecksUsed, maxDecksElapsed, maxDecksWeek, isReliableTotal }|null}
 */
export function buildCurrentWarDays(battleLog, raceTotalDecks = null, raceMeta = null) {
  // Le jour GDC commence à 10h40 heure de Paris : on décale pour aligner sur le cycle GDC
  const now = new Date();
  const nowGdcDate = new Date(now.getTime() - warResetOffsetMs(now));

  // Déterminer le jour GDC courant
  // Priorité 1 : état de course depuis l'API /currentriverrace (source autoritaire)
  let daysFromThu;
  if (raceMeta?.state) {
    const { state, periodIndex } = raceMeta;
    // Journée d'entraînement → pas de période de guerre active
    if (state === 'trainingDay' || state === 'preparation') return null;
    // warDay / overtime / full → période active
    if (typeof periodIndex === 'number' && periodIndex >= 0 && periodIndex <= 3) {
      daysFromThu = periodIndex; // 0=Jeu, 1=Ven, 2=Sam, 3=Dim
    } else if (state === 'overtime') {
      daysFromThu = 3; // overtime se joue en dernier jour (dimanche)
    }
  }

  // Priorité 2 : calcul calendaire (fallback si currentRace non disponible)
  if (daysFromThu === undefined) {
    const dow = nowGdcDate.getUTCDay(); // 0=Dim, 1=Lun … 4=Jeu, 5=Ven, 6=Sam
    const isWarPeriod = dow === 0 || dow >= 4;
    if (!isWarPeriod) return null;
    daysFromThu = dow === 4 ? 0 : dow === 5 ? 1 : dow === 6 ? 2 : 3;
  }

  const thuGdcMs = nowGdcDate.getTime() - daysFromThu * MS_PER_DAY;

  const DAY_LABELS = ['Thu', 'Fri', 'Sat', 'Sun'];
  const days = DAY_LABELS.map((label, i) => ({
    key:      new Date(thuGdcMs + i * MS_PER_DAY).toISOString().slice(0, 10),
    label,
    count:    0,
    isPast:   i < daysFromThu,
    isToday:  i === daysFromThu,
    isFuture: i > daysFromThu,
  }));

  // Compte les combats GDC par jour depuis le battle log (peut être tronqué)
  for (const b of filterWarBattles(battleLog)) {
    const key = warDayKey(b.battleTime);
    const day = days.find((d) => d.key === key);
    if (day) day.count++;
  }

  const maxDecksElapsed = (daysFromThu + 1) * 4; // combats attendus jusqu'à aujourd'hui inclus
  const maxDecksWeek    = 16;                     // 4 jours × 4 combats

  // Source fiable : currentriverrace. Sinon : somme du battle log (potentiellement tronqué)
  const isReliableTotal  = raceTotalDecks !== null;
  const totalDecksUsed   = isReliableTotal ? raceTotalDecks : days.reduce((s, d) => s + d.count, 0);

  return { days, totalDecksUsed, maxDecksElapsed, maxDecksWeek, isReliableTotal, daysFromThu };
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
