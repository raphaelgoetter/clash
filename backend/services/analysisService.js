// ============================================================
// analysisService.js — Core scoring and analysis logic
//
// All formulas are documented inline so that they can be
// tweaked as new data becomes available.
// ============================================================

// ── Constants ─────────────────────────────────────────────────

const MS_PER_DAY = 1000 * 60 * 60 * 24;

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
function expandDuelRounds(warLog) {
  const expanded = [];
  for (const battle of warLog) {
    if (battle.type === 'riverRaceDuel' && Array.isArray(battle.team?.[0]?.rounds)) {
      // One synthetic entry per round, keeping the parent battleTime
      const rounds = battle.team[0].rounds;
      rounds.forEach((round, i) => {
        expanded.push({
          ...battle,
          _roundIndex: i,
          // Keep parent timestamp (rounds don't have individual timestamps)
        });
      });
    } else {
      expanded.push(battle);
    }
  }
  return expanded;
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

// ── Stability score ───────────────────────────────────────────

/**
 * Estimate how "stable" a player account is based on donations,
 * battle count and experience level.
 *
 * Formula:
 *   stabilityScore = (donations / 1000) * (battleCount / 2000) * (expLevel * 1.5)
 *
 * The result is then clamped to [0, 100].
 *
 * @param {object} player  - Player profile from the Clash API
 * @returns {{ score: number; label: string }}
 */
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

// ── War reliability score ─────────────────────────────────────

/**
 * Predict war participation probability from weighted indicators.
 *
 * Formula (raw):
 *   warReliabilityScore =
 *       (recentBattles7d * 2)
 *     + (donations / 200)
 *     + (battleCount / 500)
 *     + (expLevel * 3)
 *
 * Max theoretical value used for normalisation: 200
 * Normalised score: raw / 200 * 100, clamped to [0, 100].
 *
 * @param {object}   player    - Player profile
 * @param {object[]} battleLog - Battle log array
 * @returns {{ score: number; verdict: string; color: string; reasons: string[] }}
 */
export function computeWarReliability(player, battleLog) {
  const recentBattles7d = battlesInLastDays(battleLog, 7);
  const recentBattles24h = battlesInLastDays(battleLog, 1);
  const recentBattles30d = battlesInLastDays(battleLog, 30);
  const donations = player.donations ?? 0;
  const battleCount = player.battleCount ?? 0;
  const expLevel = player.expLevel ?? 1;

  const raw =
    recentBattles7d * 2 +
    donations / 200 +
    battleCount / 500 +
    expLevel * 3;

  // Normalise against a reasonable maximum (200) then cap at 100
  const score = Math.min(100, Math.round((raw / 200) * 100));

  // ── Verdict ───────────────────────────────────────────────
  let verdict, color;
  if (score >= 70) {
    verdict = 'Highly reliable for clan wars';
    color = 'green';
  } else if (score >= 40) {
    verdict = 'Moderate reliability – monitor participation';
    color = 'yellow';
  } else {
    verdict = 'High risk of inactivity in clan wars';
    color = 'red';
  }

  // ── Reasons ───────────────────────────────────────────────
  const reasons = [];
  if (recentBattles7d >= 10) reasons.push('High clan war activity this week');
  else if (recentBattles7d >= 5) reasons.push('Moderate clan war activity this week');
  else reasons.push('Low clan war activity this week');

  if (donations >= 500) reasons.push('Strong donation history');
  else if (donations >= 100) reasons.push('Regular donations');
  else reasons.push('Few or no donations recorded');

  if (expLevel >= 40) reasons.push('Experienced account (high exp level)');
  else if (expLevel >= 20) reasons.push('Moderately experienced account');
  else reasons.push('New or low-level account');

  if (recentBattles24h >= 3) reasons.push('Very active in clan wars in the last 24 hours');
  if (recentBattles30d >= 30) reasons.push('Consistently active in clan wars over the last 30 days');

  return {
    score,
    verdict,
    color,
    reasons,
    metrics: {
      recentBattles24h,
      recentBattles7d,
      recentBattles30d,
      donations,
      battleCount,
      expLevel,
    },
  };
}

// ── Player full analysis ──────────────────────────────────────

/**
 * Produce the complete analysis object for a player.
 * @param {object}   player
 * @param {object[]} battleLog
 * @returns {object}
 */
export function analyzePlayer(player, battleLog) {
  // Filter to war battles only, then expand duel rounds into individual entries
  const warLog = expandDuelRounds(filterWarBattles(battleLog));

  const stability = computeStabilityScore(player);
  const reliability = computeWarReliability(player, warLog);
  // Limit chart to 7 days: the API returns only 30 battles total, and a player
  // who also plays regular PvP matches will quickly exhaust that window.
  const dailyActivity = buildDailyActivity(warLog, 7);

  const wins = warLog.filter((b) => b.team?.[0]?.crowns > (b.opponent?.[0]?.crowns ?? 0)).length;
  const losses = warLog.filter((b) => b.team?.[0]?.crowns < (b.opponent?.[0]?.crowns ?? 0)).length;
  const threeCrowns = warLog.filter((b) => b.team?.[0]?.crowns === 3).length;
  const totalBattlesInLog = warLog.length;
  const winRate = totalBattlesInLog > 0 ? Math.round((wins / totalBattlesInLog) * 100) : 0;

  return {
    overview: {
      name: player.name,
      tag: player.tag,
      trophies: player.trophies,
      bestTrophies: player.bestTrophies,
      expLevel: player.expLevel,
      clan: player.clan
        ? { name: player.clan.name, tag: player.clan.tag }
        : null,
      role: player.role ?? null,
    },
    activityIndicators: {
      totalWarBattles: totalBattlesInLog,
      wins,
      losses,
      winRate,
      donations: player.donations ?? 0,
      threeCrowns,
    },
    recentActivity: {
      last7d: reliability.metrics.recentBattles7d,
      last30d: reliability.metrics.recentBattles30d,
      dailyActivity,
      // The Clash Royale API returns at most 30 battles. For players who
      // also play regular PvP, war battles older than a few days may
      // not appear in the log.
      apiLimitNote: 'Battle log capped at 30 entries by the Clash Royale API.',
    },
    stability,
    reliability,
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
  if (score >= 70) {
    verdict = 'Highly reliable';
    color = 'green';
  } else if (score >= 40) {
    verdict = 'Moderate reliability';
    color = 'yellow';
  } else {
    verdict = 'High risk';
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
