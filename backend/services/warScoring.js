// ============================================================
// warScoring.js — Calcul des scores de fiabilité GDC.
// Deux modes : score principal (computeWarScore) depuis l'historique
// de course, et mode fallback (computeWarReliabilityFallback) depuis
// le battle log uniquement.
// ============================================================

import {
  parseClashDate,
  warDayKey,
  warResetOffsetMs,
  MS_PER_DAY,
} from "./dateUtils.js";
import { isWarWin } from "./battleLogUtils.js";

// ── Helpers privés ────────────────────────────────────────────

function scoreQuality(score, max) {
  if (max <= 0) return "unknown";
  const pct = (score / max) * 100;
  if (pct >= 90) return "very good";
  if (pct >= 75) return "good";
  if (pct >= 50) return "average";
  return "bad";
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
function dailyWarReliabilityScore(warLog, clanTag = null) {
  const MAX_WINDOW = 14;

  // Construit la map jour GDC → nombre de batailles
  const byDay = {};
  for (const b of warLog) {
    const key = warDayKey(b.battleTime, clanTag);
    byDay[key] = (byDay[key] ?? 0) + 1;
  }

  if (Object.keys(byDay).length === 0)
    return { score: 0, detail: "No war battles in battle log", byDay };

  // Détermine la fenêtre effective ancrée sur le dernier jour de guerre actif.
  // On n'inclut pas aujourd'hui si aucune bataille n'a encore eu lieu (journée en cours).
  const todayWarDay = warDayKey(new Date(), clanTag);
  const yesterdayWarDay = new Date(new Date(todayWarDay).getTime() - MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
  const hasActivityToday = (byDay[todayWarDay] ?? 0) > 0;
  const anchorDay = hasActivityToday ? todayWarDay : yesterdayWarDay;

  const sortedDays = Object.keys(byDay).sort();
  const firstDay = sortedDays[0];

  const daysSinceFirst = Math.max(
    0,
    Math.round(
      (new Date(anchorDay).getTime() - new Date(firstDay).getTime()) /
        MS_PER_DAY,
    ),
  );
  const window = Math.min(MAX_WINDOW, daysSinceFirst + 1);

  // Somme pondérée sur la fenêtre (aujourd'hui = index 0, plus ancien = index window-1)
  let weightedSum = 0;
  let weightTotal = 0;
  for (let i = 0; i < window; i++) {
    const d = new Date(new Date(anchorDay).getTime() - i * MS_PER_DAY);
    const key = d.toISOString().slice(0, 10);
    const battles = byDay[key] ?? 0;
    const daily = Math.min(4, battles) / 4;
    const weight = window - i;
    weightedSum += daily * weight;
    weightTotal += weight;
  }

  const avg = weightedSum / weightTotal;
  const score = Math.round(avg * 100) / 10;

  // Construit le détail lisible
  const recentDays = Object.entries(byDay)
    .sort((a, b) => b[0].localeCompare(a[0]))
    .slice(0, 3);
  const yesterdayKey = new Date(new Date(todayWarDay).getTime() - MS_PER_DAY)
    .toISOString()
    .slice(0, 10);
  function fmtDate(iso) {
    const d = new Date(iso);
    const opts = { month: "short", day: "numeric" };
    if (d.getFullYear() !== new Date().getFullYear()) opts.year = "numeric";
    return d.toLocaleDateString(undefined, opts);
  }
  const parts = recentDays.map(([k, n]) => {
    let label;
    if (k === todayWarDay) label = "today";
    else if (k === yesterdayKey) label = "yesterday";
    else label = fmtDate(k);
    return `${n}× on ${label}`;
  });
  const totalBattles = Object.values(byDay).reduce((s, n) => s + n, 0);
  const activeDays = sortedDays.length;
  const detail = `${parts.join(" · ")} — avg ${(avg * 4).toFixed(1)}/4 battles/day over ${window}-day window (${activeDays} active day${activeDays !== 1 ? "s" : ""}, ${totalBattles} total)`;

  return { score, detail, byDay };
}

// ── Donation scoring ──────────────────────────────────────────

// Total donations is a stable cumulative metric (unlike weekly donations).
// We map it to a small, bounded score to keep it comparable with other criteria.
const DONATION_TOTAL_MIN = 2000;
const DONATION_TOTAL_MAX = 100000;

export function scoreTotalDonations(totalDonations, maxPoints = 2) {
  const effective = Math.max(0, (totalDonations ?? 0) - DONATION_TOTAL_MIN);
  const scale = DONATION_TOTAL_MAX - DONATION_TOTAL_MIN;
  if (scale <= 0) return 0;
  return Math.min(maxPoints, (effective / scale) * maxPoints);
}

/**
 * Estime le nombre de victoires PvP depuis les données de points.
 * PvP loss = 100 points, PvP win = 200 points.
 * Boat attacks : on suppose 200 points chacun (valeur standard CW2).
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
  const wins = Math.max(
    0,
    Math.min(pvpDecks, Math.round((pvpFame - 100 * pvpDecks) / 100)),
  );
  return { wins, pvpDecks };
}

// ── Score principal (depuis historique de course) ─────────────

/**
 * Compute the War Reliability Score from 9 weighted criteria.
 *
 * Criteria (max sans win rate / avec win rate) :
 *  1. Régularité  /12 — decks used relative to ideal 16/week
 *  2. Score moyen /10 — average fame per played week (cap 3 000)
 *  3. Stabilité   / 8 — consecutive weeks in current clan or family (cap 5 wks = 8)
 *  4. CW2 Wins    / 8 — badge progress (cap 250)
 *  5. Last Seen   / 5 — only in clan context (optional)
 *  6. Win Rate    / 3 — optional, only when battle log available
 *  7. Expérience  / 3 — trophies [4 000, 14 000]
 *  8. Dons        / 2 — totalDonations (cap 100 000)
 *  9. Discord     / 2 — lié au serveur Discord
 *
 * @param {object} player      - Player profile from Clash API
 * @param {object} warHistory  - Output of buildWarHistory()
 * @param {number|null} [warWinRate=null]  - Win rate on GDC battles (0-1).
 * @returns {{ total:number; maxScore:number; pct:number; verdict:string; color:string; breakdown:object[] }}
 */
export function computeWarScore(
  player,
  warHistory,
  warWinRate = null,
  lastSeen = null,
  discordLinked = false,
) {
  const r = (v) => Math.round(v * 10) / 10;

  // Filtre les semaines ignorées (elles restent dans le tableau pour l'affichage)
  const weeks = warHistory.weeks.filter((w) => !w.ignored);

  // 1. Régularité (0-12) — proportionnelle aux decks joués sur les semaines terminées.
  // On exclut la semaine en cours (isCurrent) car elle n'est pas forcément complète.
  const totalWeeks = warHistory.totalWeeks || 1;
  const weeksInClan = warHistory.streakInCurrentClan;
  const completedRegularityWeeks = weeks.filter(
    (w) => !w.isCurrent && !w.ignored,
  );
  const weeksForRegularity = completedRegularityWeeks;
  const completedCount = weeksForRegularity.length;
  const deckSum = weeksForRegularity.reduce(
    (s, w) => s + (w.decksUsed || 0),
    0,
  );
  const idealDecks = completedCount * 16;
  const incompleteWeeks = weeksForRegularity.filter(
    (w) => (w.decksUsed || 0) < 16,
  ).length;
  // Pénalité de 0.5 pt par semaine incomplète pour décourager les participations partielles.
  const baseScore = completedCount > 0 ? (deckSum / (idealDecks || 1)) * 12 : 0;
  const regularite = r(
    Math.max(0, Math.min(12, baseScore - incompleteWeeks * 0.5)),
  );

  // 2. Score moyen (0-10) — 1 000 fame = 0, 3 000 fame = 10
  const FAME_MIN = 1000;
  const FAME_CAP = 3000;
  const rawAvgScore =
    warHistory.avgFame <= 0 || warHistory.avgFame < FAME_MIN
      ? 0
      : Math.min(
          10,
          ((warHistory.avgFame - FAME_MIN) / (FAME_CAP - FAME_MIN)) * 10,
        );
  const scoreMoyen = r(rawAvgScore);

  // 3. Stabilité (0-8) — échelle absolue : 5 semaines consécutives dans le clan ou la famille = 8/8
  // streak=0→0, 1→1.6, 2→3.2, 3→4.8, 4→6.4, 5+→8.0
  const familyStreak =
    warHistory.streakInFamily ?? warHistory.streakInCurrentClan;
  const stabilite = r(Math.min(8, familyStreak * 1.6));

  // 4. Expérience trophées (0-3) — [4 000, 14 000] trophées actuels
  const TROPHY_MIN = 4000;
  const TROPHY_CAP = 14000;
  const experience = r(
    Math.max(
      0,
      Math.min(
        3,
        (((player.trophies ?? 0) - TROPHY_MIN) / (TROPHY_CAP - TROPHY_MIN)) * 3,
      ),
    ),
  );

  // 5. Dons (0-2) — basé sur les donations cumulées (totalDonations).
  const totalDonations = player.totalDonations ?? player.donations ?? 0;
  const dons = r(scoreTotalDonations(totalDonations, 2));

  // 6. Win Rate GDC (0-3) — optionnel, uniquement quand battlelog disponible
  const winRateGDC =
    warWinRate !== null ? r(Math.min(3, warWinRate * 3)) : null;

  // 7. CW2 Battle Wins (0-8) — from ClanWarWins badge
  const CW2_CAP = 250;
  const cw2Wins =
    player.badges?.find((b) => b.name === "ClanWarWins")?.progress ??
    player.cw2Progress ??
    0;
  const cw2Score = r(Math.min(8, (cw2Wins / CW2_CAP) * 8));

  // 8. Last seen (0-5) — uniquement en contexte clan (lastSeen fourni depuis /members)
  let lastSeenScore = null;
  let lastSeenDays = null;
  if (lastSeen) {
    lastSeenDays =
      (Date.now() - parseClashDate(lastSeen).getTime()) / MS_PER_DAY;
    lastSeenScore =
      lastSeenDays <= 1 ? 5 : lastSeenDays <= 3 ? 3 : lastSeenDays <= 7 ? 1 : 0;
  }

  // 9. Discord (0-2) — lié au serveur Discord du clan
  const discordScore = discordLinked ? 2 : 0;

  const total = r(
    regularite +
      scoreMoyen +
      stabilite +
      experience +
      dons +
      (winRateGDC ?? 0) +
      cw2Score +
      (lastSeenScore ?? 0) +
      discordScore,
  );
  const maxScore =
    (winRateGDC !== null ? 46 : 43) + (lastSeenScore !== null ? 5 : 0) + 2;
  const pct = Math.round((total / maxScore) * 100);

  let verdict, color;
  if (pct >= 75) {
    verdict = "High reliability";
    color = "green";
  } else if (pct >= 56) {
    verdict = "Low risk";
    color = "yellow";
  } else if (pct >= 31) {
    verdict = "High risk";
    color = "orange";
  } else {
    verdict = "Extreme risk";
    color = "red";
  }

  const warHistoryWeeks = warHistory?.streakInCurrentClan ?? 0;
  const regularityQuality = scoreQuality(regularite, 12);
  const cw2Remark =
    cw2Score >= 6
      ? "strong experience in Clan Wars"
      : cw2Score >= 4
        ? "solid Clan Wars experience"
        : cw2Score >= 2
          ? "some Clan Wars experience"
          : "limited Clan Wars background";
  const clanDurationText =
    warHistoryWeeks <= 0 ? "Less than one week" : `${warHistoryWeeks} week(s)`;

  const summary =
    `Regularity: ${regularityQuality} (${regularite}/12 from ${deckSum}/${idealDecks} decks across ${completedCount} week(s) (${incompleteWeeks} incomplete)).\n` +
    `CW2: ${cw2Remark}.\n` +
    `In clan: ${clanDurationText}.`;

  const breakdown = [
    {
      label: "Regularity",
      score: regularite,
      max: 12,
      detail: (() => {
        if (completedCount === 0) return "No completed week in this clan yet";
        const pct = Math.round((deckSum / (idealDecks || 1)) * 100);
        const isApiMaxWeeks = weeksInClan >= 10;
        const suffix =
          weeksInClan < totalWeeks
            ? weeksInClan === 0
              ? ` — joined recently (< 1 week in this clan)`
              : ` — member for ${isApiMaxWeeks ? "at least " : ""}${weeksInClan} week${weeksInClan > 1 ? "s" : ""}`
            : "";
        let txt = `${deckSum}/${idealDecks} decks across ${completedCount} week${completedCount > 1 ? "s" : ""} (${pct}%)`;
        if (incompleteWeeks > 0) {
          txt += ` — ${incompleteWeeks} incomplete week${incompleteWeeks > 1 ? "s" : ""} (-${(incompleteWeeks * 0.5).toFixed(1)} pts)`;
        }
        return txt + suffix;
      })(),
    },
    {
      label: "Avg Score",
      score: scoreMoyen,
      max: 10,
      detail: warHistory.avgFame
        ? `${warHistory.avgFame.toLocaleString("en-US")} points / week (average weekly fame, 1,000–3,000)`
        : "No data",
    },
    {
      label: "CW2 Battle Wins",
      score: cw2Score,
      max: 8,
      detail: `${cw2Wins.toLocaleString("en-US")} total CW2 wins (cap 250)`,
    },
    {
      label: "Stability",
      score: stabilite,
      max: 8,
      detail: (() => {
        const s = warHistory.streakInFamily ?? warHistory.streakInCurrentClan;
        const isApiMaxWeeks = s >= 10;
        const base = `${isApiMaxWeeks ? "at least " : ""}${s} consecutive week${s !== 1 ? "s" : ""} in this clan or family`;
        return s < 5 ? `${base} (full score at 5 wks)` : base;
      })(),
    },
    ...(lastSeenScore !== null
      ? [
          {
            label: "Last Seen",
            score: lastSeenScore,
            max: 5,
            detail:
              lastSeenDays < 1
                ? "today"
                : lastSeenDays < 2
                  ? "1 day"
                  : `${Math.round(lastSeenDays)} days`,
          },
        ]
      : []),
    ...(winRateGDC !== null
      ? [
          {
            label: "Win Rate (War)",
            score: winRateGDC,
            max: 3,
            detail: `${Math.round(warWinRate * 100)}% victories in River Race`,
          },
        ]
      : []),
    {
      label: "Experience",
      score: experience,
      max: 3,
      detail: `${(player.trophies ?? 0).toLocaleString("en-US")} trophies (range 4000–14000)`,
    },
    {
      label: "Donations",
      score: dons,
      max: 2,
      detail: `${totalDonations.toLocaleString("en-US")} total cards donated (cap 100000)`,
    },
    {
      label: "Discord",
      score: discordScore,
      max: 2,
      detail: discordLinked
        ? "Discord account linked to the server"
        : "Discord account not linked (/discord-link)",
    },
  ];

  return { total, maxScore, pct, verdict, color, summary, breakdown };
}

/**
 * Fallback reliability from battle log only (used when no race log history available).
 * Applies the same scale as computeWarScore for consistency.
 *
 * Criteria (total /38 base) :
 *  1. Activité GDC    /12 — decks/day (bonuses for 4-deck days, penalties for <4)
 *  2. Activité générale /8 — combats compétitifs dans le log (cap 30)
 *  3. CW2 Wins        /8 — badge progress (cap 250)
 *  4. Win Rate GDC    /5 — % victoires sur combats GDC (0 if no GDC battles)
 *  5. Expérience      /3 — bestTrophies (cap 12 000)
 *  6. Dons            /2 — totalDonations (stable cumulative metric)
 *  (+2 Discord toujours ; +5 Last Seen si ≥16 war decks observés)
 *
 * @param {object}   player
 * @param {object[]} warLog              - Filtered war battles (expanded duels)
 * @param {object}   battleLogBreakdown  - Output of categorizeBattleLog()
 */
export function computeWarReliabilityFallback(
  player,
  warLog,
  battleLogBreakdown,
  lastSeen = null,
  discordLinked = false,
  currentRaceDecks = 0,
  warHistory = null,
  clanTag = null,
) {
  const r = (v) => Math.round(v * 10) / 10;

  const bd = battleLogBreakdown ?? {
    total: warLog.length,
    gdc: warLog.length,
    ladder: 0,
    challenge: 0,
  };

  // Quand le battle log ne contient plus de combats GDC (écrasés par des parties ladder),
  // on synthétise une entrée "aujourd'hui" depuis decksUsed de la course en cours.
  const syntheticLog =
    warLog.length === 0 && currentRaceDecks > 0
      ? Array.from({ length: Math.min(4, currentRaceDecks) }, () => ({
          battleTime: new Date().toISOString(),
        }))
      : null;
  const effectiveLog = syntheticLog ?? warLog;

  const gdcCount = warLog.length > 0 ? warLog.length : currentRaceDecks;
  const gdcWins = warLog.filter(isWarWin).length;
  const gdcWinRate = gdcCount > 0 ? gdcWins / gdcCount : 0;
  const competitive = gdcCount + bd.ladder + bd.challenge;

  // 1. War Activity (0-12) — basé sur decks/jour, avec bonus/pénalités
  const activityResult = dailyWarReliabilityScore(effectiveLog, clanTag);
  const perfectDays = Object.values(activityResult.byDay).filter(
    (d) => d >= 4,
  ).length;
  const shortDays = Object.values(activityResult.byDay).filter(
    (d) => d > 0 && d < 4,
  ).length;
  let activiteGDC = activityResult.score;
  activiteGDC += perfectDays * 0.2;
  activiteGDC -= shortDays * 0.1;
  activiteGDC = r(Math.min(12, Math.max(0, activiteGDC)));
  // Plafond de confiance : 16 batailles (1 semaine complète) = plafond entièrement levé.
  const confidenceCap = r(Math.min(12, (gdcCount / 16) * 12));
  activiteGDC = r(Math.min(activiteGDC, confidenceCap));

  // 2. Win Rate GDC (0-5) — minimum 10 combats requis
  const winRateExcluded = gdcCount < 10;
  const winRateGDC = winRateExcluded ? 0 : r(gdcWinRate * 5);

  // 3. Activité générale (0-8) — 30 combats compétitifs requis pour score max
  const warRatio = competitive > 0 ? gdcCount / competitive : 0;
  const warFactor = 0.5 + 0.5 * warRatio;
  const baseGeneral = (competitive / 30) * 8;
  const activiteGen = r(Math.min(8, baseGeneral * warFactor));

  // 4. Expérience (0-3) — trophées actuels, plage [4 000, 14 000]
  const TROPHY_MIN = 4000;
  const TROPHY_CAP = 14000;
  const experience = r(
    Math.max(
      0,
      Math.min(
        3,
        (((player.trophies ?? 0) - TROPHY_MIN) / (TROPHY_CAP - TROPHY_MIN)) * 3,
      ),
    ),
  );

  // 5. Dons (0-2) — basé sur les donations cumulées
  const totalDonations = player.totalDonations ?? player.donations ?? 0;
  const dons = r(scoreTotalDonations(totalDonations, 2));

  // 6. CW2 Battle Wins (0-8) — from ClanWarWins badge
  const CW2_CAP = 250;
  const cw2Wins =
    player.badges?.find((b) => b.name === "ClanWarWins")?.progress ?? 0;
  const cw2Score = r(Math.min(8, (cw2Wins / CW2_CAP) * 8));

  // 7. Last seen (0-5) — exige environ deux semaines de decks GDC avant de compter
  let lastSeenScore = null;
  let lastSeenDays = null;
  if (lastSeen && warLog.length >= 16) {
    lastSeenDays =
      (Date.now() - parseClashDate(lastSeen).getTime()) / MS_PER_DAY;
    lastSeenScore =
      lastSeenDays <= 1 ? 5 : lastSeenDays <= 3 ? 3 : lastSeenDays <= 7 ? 1 : 0;
  }

  // 8. Discord (0-2) — lié au serveur Discord du clan
  const discordScore = discordLinked ? 2 : 0;

  const total = r(
    activiteGDC +
      activiteGen +
      cw2Score +
      winRateGDC +
      experience +
      dons +
      (lastSeenScore ?? 0) +
      discordScore,
  );
  // base max: 12+8+8+5+3+2=38, réduit à 33 si win rate exclu (<10 combats); Discord toujours +2
  const maxBase = winRateExcluded ? 33 : 38;
  const maxScore = maxBase + (lastSeenScore !== null ? 5 : 0) + 2;
  const pct = Math.round((total / maxScore) * 100);

  let verdict, color;
  if (pct >= 75) {
    verdict = "High reliability";
    color = "green";
  } else if (pct >= 56) {
    verdict = "Low risk";
    color = "yellow";
  } else if (pct >= 31) {
    verdict = "High risk";
    color = "orange";
  } else {
    verdict = "Extreme risk";
    color = "red";
  }

  const warHistoryWeeks = warHistory?.streakInCurrentClan ?? 0;
  const warActivityQuality = scoreQuality(activiteGDC, 12);
  const cw2Remark =
    cw2Score >= 6
      ? "strong experience in Clan Wars"
      : cw2Score >= 4
        ? "solid Clan Wars experience"
        : cw2Score >= 2
          ? "some Clan Wars experience"
          : "limited Clan Wars background";
  const clanDurationText =
    warHistoryWeeks <= 0 ? "Less than one week" : `${warHistoryWeeks} week(s)`;

  const byDayEntries = Object.entries(activityResult.byDay).sort((a, b) =>
    a[0].localeCompare(b[0]),
  );
  const lastWarDay = byDayEntries.length
    ? byDayEntries[byDayEntries.length - 1][0]
    : null;
  const daysSinceLastWar = lastWarDay
    ? Math.floor((Date.now() - new Date(lastWarDay).getTime()) / MS_PER_DAY)
    : null;
  const activeDaysCount = Object.keys(activityResult.byDay).length;
  const windowDays = 14;
  const inactiveDays = Math.max(0, windowDays - activeDaysCount);

  const summary =
    `War Activity: ${warActivityQuality} (${activiteGDC}/12, ${perfectDays} full days, ${shortDays} short days, ${inactiveDays} inactive days in ${windowDays}-day window).\n` +
    `Last war battle: ${lastWarDay || "none"}${daysSinceLastWar !== null ? ` (${daysSinceLastWar} day(s) ago)` : ""}.\n` +
    `In clan: ${clanDurationText}.\nCW2: ${cw2Remark}.`;

  return {
    total,
    maxScore,
    pct,
    verdict,
    color,
    isFallback: true,
    summary,
    breakdown: [
      {
        label: "War Activity",
        score: activiteGDC,
        max: 12,
        detail: (() => {
          const parts = Object.entries(activityResult.byDay)
            .sort((a, b) => b[0].localeCompare(a[0]))
            .map(([k, n]) => `${n}× ${k}`);
          return parts.join(" · ");
        })(),
        explanation: `In recent ${windowDays}-day window: ${perfectDays} full days, ${shortDays} short days, ${inactiveDays} inactive days; last war: ${lastWarDay || "none"}${daysSinceLastWar !== null ? ` (${daysSinceLastWar} day(s) ago)` : ""}.`,
      },
      {
        label: "General Activity",
        score: activiteGen,
        max: 8,
        detail: `${competitive} competitive battles (${gdcCount} War + ${bd.ladder} Ladder + ${bd.challenge} Challenges)`,
      },
      {
        label: "CW2 Battle Wins",
        score: cw2Score,
        max: 8,
        detail: `${cw2Wins.toLocaleString("en-US")} total CW2 wins (cap 250)`,
      },
      {
        label: "Win Rate (War)",
        score: gdcCount > 0 ? r(Math.min(5, gdcWinRate * 5)) : 0,
        max: 5,
        excluded: winRateExcluded,
        detail:
          gdcCount === 0
            ? "No data — no war battles found"
            : winRateExcluded
              ? `${Math.round(gdcWinRate * 100)}% wins (${gdcWins}W / ${gdcCount - gdcWins}L) — not counted (10 battles required)`
              : `${Math.round(gdcWinRate * 100)}% wins (${gdcWins}W / ${gdcCount - gdcWins}L)`,
      },
      ...(lastSeenScore !== null
        ? [
            {
              label: "Last Seen",
              score: lastSeenScore,
              max: 5,
              detail:
                lastSeenDays < 1
                  ? "Active in the last 24 h"
                  : lastSeenDays < 3
                    ? `Active ${(Math.round(lastSeenDays * 10) / 10).toFixed(1)} day(s) ago`
                    : lastSeenDays < 7
                      ? `Active ${Math.round(lastSeenDays)} days ago`
                      : `Last seen ${Math.round(lastSeenDays)} days ago ⚠️`,
            },
          ]
        : []),
      {
        label: "Experience",
        score: experience,
        max: 3,
        detail: `${(player.trophies ?? 0).toLocaleString("en-US")} trophies (range 4,000–14,000)`,
      },
      {
        label: "Donations",
        score: dons,
        max: 2,
        detail: `${totalDonations.toLocaleString("en-US")} total cards donated (cap 100000)`,
      },
      {
        label: "Discord",
        score: discordScore,
        max: 2,
        detail: discordLinked
          ? "Discord account linked to the server"
          : "Discord account not linked (/discord-link)",
      },
    ],
  };
}

// Legacy stability score (conservée pour rétrocompatibilité)
export function computeStabilityScore(player) {
  const totalDonations = player.totalDonations ?? player.donations ?? 0;
  const battleCount = player.battleCount ?? 0;
  const expLevel = player.expLevel ?? 1;
  const raw = (totalDonations / 1000) * (battleCount / 2000) * (expLevel * 1.5);
  const score = Math.min(100, Math.round(raw * 10) / 10);
  let label;
  if (score >= 40) label = "High stability";
  else if (score >= 15) label = "Medium stability";
  else label = "Low stability";
  return { score, label };
}
