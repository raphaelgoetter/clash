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

function frNum(n) {
  return Number(n ?? 0).toLocaleString("fr-FR");
}

function frDecimal(n, digits = 2) {
  return Number(n ?? 0).toLocaleString("fr-FR", {
    minimumFractionDigits: digits,
    maximumFractionDigits: digits,
  });
}

const QUALITY_LABELS = {
  unknown: "inconnu",
  veryGood: "très bon",
  good: "bon",
  average: "moyen",
  bad: "faible",
};

function scoreQuality(score, max) {
  if (max <= 0) return QUALITY_LABELS.unknown;
  const pct = (score / max) * 100;
  if (pct >= 90) return QUALITY_LABELS.veryGood;
  if (pct >= 75) return QUALITY_LABELS.good;
  if (pct >= 50) return QUALITY_LABELS.average;
  return QUALITY_LABELS.bad;
}

// Verdict final selon le pourcentage — libellé affiché + clé stable pour le
// matching côté frontend/bot (ne jamais matcher sur le texte affiché).
const VERDICT_TIERS = [
  {
    min: 75,
    verdict: "Très fiable",
    verdictKey: "highReliability",
    color: "green",
  },
  {
    min: 56,
    verdict: "Risque faible",
    verdictKey: "lowRisk",
    color: "yellow",
  },
  {
    min: 31,
    verdict: "Risque élevé",
    verdictKey: "highRisk",
    color: "orange",
  },
  {
    min: 0,
    verdict: "Risque extrême",
    verdictKey: "extremeRisk",
    color: "red",
  },
];

function computeVerdict(pct) {
  return (
    VERDICT_TIERS.find((tier) => pct >= tier.min) ??
    VERDICT_TIERS[VERDICT_TIERS.length - 1]
  );
}

// Libellé + couleur par clé de verdict — pour les modules qui calculent leurs
// propres seuils (ex. computeMemberReliability) mais doivent afficher le même texte.
export const VERDICT_BY_KEY = Object.fromEntries(
  VERDICT_TIERS.map((tier) => [
    tier.verdictKey,
    { verdict: tier.verdict, color: tier.color },
  ]),
);

function cw2Remark(cw2Score) {
  if (cw2Score >= 6) return "forte expérience en Guerre de Clans";
  if (cw2Score >= 4) return "bonne expérience en Guerre de Clans";
  if (cw2Score >= 2) return "un peu d'expérience en Guerre de Clans";
  return "peu d'expérience en Guerre de Clans";
}

function clanDurationText(weeks) {
  return weeks <= 0
    ? "Moins d'une semaine"
    : `${weeks} semaine${weeks > 1 ? "s" : ""}`;
}

function discordDetail(linked) {
  return linked
    ? "Compte Discord lié au serveur"
    : "Compte Discord non lié (/discord-link)";
}

function lastSeenDetail(lastSeenDays, maxTierDays = 3) {
  if (lastSeenDays < 1) return "Connecté au jeu dans les dernières 24 h";
  if (lastSeenDays < maxTierDays)
    return `Actif il y a ${frDecimal(Math.round(lastSeenDays * 10) / 10, 1)} jour(s)`;
  if (lastSeenDays < 7) return `Actif il y a ${Math.round(lastSeenDays)} jour(s)`;
  return `Dernière connexion il y a ${Math.round(lastSeenDays)} jour(s) ⚠️`;
}

// Libellés stables des critères du tableau de score (utilisés avec leur `key` associée).
const LABELS = {
  cw2Badge: "Badge CW2",
  regularity: "Régularité",
  stability: "Stabilité",
  pointsPerDeck: "Points / deck",
  experience: "Expérience",
  discord: "Discord",
  lastSeen: "Vu",
  warActivity: "Activité de guerre",
};

function scorePointsPerDeck(pointsPerDeck, maxPoints = 4) {
  if (!Number.isFinite(pointsPerDeck) || pointsPerDeck <= 0) return 0;
  const MIN_POINTS_PER_DECK = 100;
  const MAX_POINTS_PER_DECK = 180;
  const raw =
    ((pointsPerDeck - MIN_POINTS_PER_DECK) /
      (MAX_POINTS_PER_DECK - MIN_POINTS_PER_DECK)) *
    maxPoints;
  return Math.max(0, Math.min(maxPoints, raw));
}

export function summarizePointsPerDeckWeeks(weeks, maxWeeks = 3) {
  const recentWeeks = (weeks ?? [])
    .filter(
      (w) => !w?.isCurrent && !w?.ignored && typeof w?.decksUsed === "number",
    )
    .slice(0, maxWeeks);
  const totalDecks = recentWeeks.reduce(
    (sum, week) => sum + (week.decksUsed || 0),
    0,
  );
  const totalFame = recentWeeks.reduce(
    (sum, week) => sum + (week.fame || 0),
    0,
  );
  const pointsPerDeck = totalDecks > 0 ? totalFame / totalDecks : 0;
  return { recentWeeks, totalDecks, totalFame, pointsPerDeck };
}

function summarizeRegularityWeeks(weeks, maxWeeks = 5) {
  const recentWeeks = (weeks ?? [])
    .filter(
      (w) => !w?.isCurrent && !w?.ignored && typeof w?.decksUsed === "number",
    )
    .slice(0, maxWeeks);

  const windowWeeks = Array.from({ length: maxWeeks }, (_, index) => ({
    decksUsed: recentWeeks[index]?.decksUsed ?? 0,
  }));
  const completedWeeks = windowWeeks.filter(
    (week) => (week.decksUsed || 0) >= 16,
  );
  const fullWeekCount = completedWeeks.length;
  const score = maxWeeks > 0 ? (fullWeekCount / maxWeeks) * 10 : 0;

  return { recentWeeks, windowWeeks, fullWeekCount, score };
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
    return { score: 0, detail: "Aucun combat de guerre dans le journal de combats", byDay };

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
    return d.toLocaleDateString("fr-FR", opts);
  }
  const parts = recentDays.map(([k, n]) => {
    let label;
    if (k === todayWarDay) label = "aujourd'hui";
    else if (k === yesterdayKey) label = "hier";
    else label = fmtDate(k);
    return `${n}× le ${label}`;
  });
  const totalBattles = Object.values(byDay).reduce((s, n) => s + n, 0);
  const activeDays = sortedDays.length;
  const detail = `${parts.join(" · ")} — moyenne ${(avg * 4).toFixed(1)} sur 4 batailles/jour sur une fenêtre de ${window} jour(s) (${activeDays} jour${activeDays !== 1 ? "s" : ""} actif${activeDays !== 1 ? "s" : ""}, ${totalBattles} au total)`;

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
 * Compute the War Reliability Score from 7 weighted criteria.
 *
 * Criteria (max sans win rate / avec win rate) :
 *  1. Régularité     /12 — decks used relative to ideal 16/week
 *  2. Points / Deck  / 4 — River Race efficiency on the 3 most recent completed GDC weeks
 *  3. Stabilité      / 8 — consecutive weeks in current clan or family (cap 5 wks = 8)
 *  4. CW2 Wins       / 8 — badge progress (cap 250)
 *  5. Last Seen      / 5 — only in clan context (optional)
 *  6. Expérience     / 3 — trophies [4 000, 14 000]
 *  7. Discord        / 2 — lié au serveur Discord
 *
 * @param {object} player      - Player profile from Clash API
 * @param {object} warHistory  - Output of buildWarHistory()
 * @param {number|null} [warWinRate=null]  - Win rate on GDC battles (0-1).
 * @returns {{ total:number; maxScore:number; pct:number; verdict:string; verdictKey:string; color:string; breakdown:object[] }}
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

  // 1. Régularité (0-10) — proportionnelle aux semaines complètes sur une fenêtre fixe de 5 semaines.
  // On exclut la semaine en cours (isCurrent) car elle n'est pas forcément complète.
  const weeksInClan = warHistory.streakInCurrentClan;
  const completedRegularityWeeks = weeks.filter(
    (w) => !w.isCurrent && !w.ignored,
  );
  const regularityWindow = summarizeRegularityWeeks(
    completedRegularityWeeks,
    5,
  );
  const regularite = r(Math.min(10, regularityWindow.score));
  const regularityWindowDetail = regularityWindow.windowWeeks
    .map((week) => `${Math.min(week.decksUsed || 0, 16)}/16`)
    .join(" · ");

  // 2. Points / deck (0-4) — efficiency of the 3 most recent completed GDC weeks.
  const efficiencyHistory = summarizePointsPerDeckWeeks(
    completedRegularityWeeks,
    3,
  );
  const efficiencyScore = r(
    scorePointsPerDeck(efficiencyHistory.pointsPerDeck, 4),
  );

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

  // 4. CW2 badge (0-8) — from ClanWarWins badge
  const CW2_CAP = 250;
  const cw2Wins =
    player.badges?.find((b) => b.name === "ClanWarWins")?.progress ??
    player.cw2Progress ??
    0;
  const cw2Score = r(Math.min(8, (cw2Wins / CW2_CAP) * 8));

  // 5. Last seen (0-5) — uniquement en contexte clan (lastSeen fourni depuis /members)
  let lastSeenScore = null;
  let lastSeenDays = null;
  if (lastSeen) {
    lastSeenDays =
      (Date.now() - parseClashDate(lastSeen).getTime()) / MS_PER_DAY;
    lastSeenScore =
      lastSeenDays <= 1 ? 5 : lastSeenDays <= 3 ? 3 : lastSeenDays <= 7 ? 1 : 0;
  }

  // 7. Discord (0-2) — lié au serveur Discord du clan
  const discordScore = discordLinked ? 2 : 0;

  const total = r(
    regularite +
      efficiencyScore +
      stabilite +
      experience +
      cw2Score +
      (lastSeenScore ?? 0) +
      discordScore,
  );
  const maxScore = 35 + (lastSeenScore !== null ? 5 : 0);
  const pct = Math.round((total / maxScore) * 100);

  const { verdict, verdictKey, color } = computeVerdict(pct);

  const warHistoryWeeks = warHistory?.streakInCurrentClan ?? 0;
  const regularityQuality = scoreQuality(regularite, 10);
  const efficiencyQuality = scoreQuality(efficiencyScore, 4);

  const summary =
    `Régularité : ${regularityQuality} (${regularite}/10 sur ${regularityWindow.fullWeekCount}/5 semaines complètes : ${regularityWindowDetail}).\n` +
    `Points / deck : ${efficiencyQuality} (${efficiencyScore}/4 à partir de ${frDecimal(efficiencyHistory.pointsPerDeck)} pts/deck sur ${efficiencyHistory.recentWeeks.length} semaine(s)).\n` +
    `CW2 : ${cw2Remark(cw2Score)}.\n` +
    `Dans le clan : ${clanDurationText(warHistoryWeeks)}.`;

  const breakdown = [
    {
      key: "cw2Badge",
      label: LABELS.cw2Badge,
      score: cw2Score,
      max: 8,
      detail: `${frNum(cw2Wins)} victoires CW2 totales (max 250)`,
    },
    {
      key: "regularity",
      label: LABELS.regularity,
      score: regularite,
      max: 10,
      detail: (() => {
        if (regularityWindow.recentWeeks.length === 0)
          return "Aucune semaine terminée dans ce clan pour le moment";
        const suffix =
          weeksInClan <= 0
            ? " — arrivé récemment (< 1 semaine dans le clan)"
            : ` — membre depuis ${weeksInClan} semaine${weeksInClan > 1 ? "s" : ""}`;
        return `${regularityWindow.fullWeekCount}/5 semaines complètes (${regularityWindowDetail} ; semaines incomplètes comptent 0)${suffix}`;
      })(),
    },
    {
      key: "stability",
      label: LABELS.stability,
      score: stabilite,
      max: 8,
      detail: (() => {
        const s = warHistory.streakInFamily ?? warHistory.streakInCurrentClan;
        const isApiMaxWeeks = s >= 10;
        const base = `${isApiMaxWeeks ? "au moins " : ""}${s} semaine${s !== 1 ? "s" : ""} consécutive${s !== 1 ? "s" : ""} dans le clan ou la famille`;
        return s < 5 ? `${base} (score max à 5 semaines)` : base;
      })(),
    },
    {
      key: "pointsPerDeck",
      label: LABELS.pointsPerDeck,
      score: efficiencyScore,
      max: 4,
      detail:
        efficiencyHistory.recentWeeks.length > 0
          ? `${frNum(efficiencyHistory.totalFame)} points / ${efficiencyHistory.totalDecks} decks (${frDecimal(efficiencyHistory.pointsPerDeck)} pts/deck, plage 100–180, 3 dernières semaines terminées)`
          : "Aucune semaine terminée avec données GDC",
    },
    {
      key: "experience",
      label: LABELS.experience,
      score: experience,
      max: 3,
      detail: `${frNum(player.trophies ?? 0)} trophées (plage 4 000–14 000)`,
    },
    ...(lastSeenScore !== null
      ? [
          {
            key: "lastSeen",
            label: LABELS.lastSeen,
            score: lastSeenScore,
            max: 5,
            detail: lastSeenDetail(lastSeenDays, 3),
          },
        ]
      : []),
    {
      key: "discord",
      label: LABELS.discord,
      score: discordScore,
      max: 2,
      detail: discordDetail(discordLinked),
    },
  ];

  return { total, maxScore, pct, verdict, verdictKey, color, summary, breakdown };
}

/**
 * Fallback reliability from battle log only (used when no race log history available).
 * Applies the same scale as computeWarScore for consistency.
 *
 * Criteria (total /34 base, 31 if no last seen data) :
 *  1. Activité GDC    /8 — decks/day (bonuses for 4-deck days, penalties for <4)
 *  2. Activité générale /8 — combats compétitifs dans le log (cap 30)
 *  3. CW2 badge       /10 — badge progress (cap 250)
 *  4. Last Seen       /3 — last seen activity after ~16 war decks
 *  5. Expérience      /3 — bestTrophies (cap 12 000)
 *  (+2 Discord toujours)
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

  const byDayEntries = Object.entries(
    dailyWarReliabilityScore(effectiveLog, clanTag).byDay,
  ).sort((a, b) => a[0].localeCompare(b[0]));
  const lastWarDay = byDayEntries.length
    ? byDayEntries[byDayEntries.length - 1][0]
    : null;
  const daysSinceLastWar = lastWarDay
    ? Math.floor((Date.now() - new Date(lastWarDay).getTime()) / MS_PER_DAY)
    : null;

  // 1. War Activity (0-8) — uniquement basé sur les semaines GDC récupérées.
  // La fenêtre de référence est fixe à 5 semaines : les semaines manquantes
  // comptent comme 0 et le score atteint son maximum à partir de 5 semaines récupérées.
  const completedHistoryWeeks = (warHistory?.weeks ?? [])
    .filter((w) => !w.isCurrent && typeof w.decksUsed === "number")
    .slice(0, 5);
  const recoveredWeekSlots = Array.from(
    { length: 5 },
    (_, index) =>
      completedHistoryWeeks[index] ?? {
        decksUsed: 0,
        label: `slot${index + 1}`,
      },
  );
  const recoveredWeeksCount = completedHistoryWeeks.length;
  const activiteGDC = r(Math.min(8, (recoveredWeeksCount / 5) * 8));
  const warHistoryActivityDetail = recoveredWeekSlots
    .map((w) => `${w.decksUsed || 0}/16`)
    .join(" · ");

  // 2. Last Seen replacement (0-3) — shown whenever a lastSeen date is available
  let lastSeenScore = null;
  let lastSeenDays = null;
  if (lastSeen) {
    lastSeenDays =
      (Date.now() - parseClashDate(lastSeen).getTime()) / MS_PER_DAY;
    lastSeenScore =
      lastSeenDays <= 1 ? 3 : lastSeenDays <= 3 ? 2 : lastSeenDays <= 7 ? 1 : 0;
  }

  // 3. Régularité (0-12) — 5 semaines fixes, une semaine ne compte que si elle
  // est complète. Les semaines partielles ou absentes valent 0.
  const regularityWindow = summarizeRegularityWeeks(warHistory?.weeks ?? [], 5);
  const regulariteGDC = r(Math.min(10, regularityWindow.score));
  const regulariteGDCDetail = regularityWindow.windowWeeks
    .map((week) => `${Math.min(week.decksUsed || 0, 16)}/16`)
    .join(" · ");

  // 3c. Points / deck (0-4) — River Race efficiency on the 3 most recent completed weeks.
  const efficiencyHistory = summarizePointsPerDeckWeeks(
    warHistory?.weeks ?? [],
    3,
  );
  const efficiencyScore = r(
    scorePointsPerDeck(efficiencyHistory.pointsPerDeck, 4),
  );

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

  // 5. CW2 badge (0-10) — from ClanWarWins badge
  const CW2_CAP = 250;
  const cw2Wins =
    player.badges?.find((b) => b.name === "ClanWarWins")?.progress ?? 0;
  const cw2Score = r(Math.min(10, (cw2Wins / CW2_CAP) * 10));

  // 8. Discord (0-2) — lié au serveur Discord du clan
  const discordScore = discordLinked ? 2 : 0;

  const total = r(
    activiteGDC +
      regulariteGDC +
      efficiencyScore +
      cw2Score +
      (lastSeenScore ?? 0) +
      experience +
      discordScore,
  );
  const maxScore = 37 + (lastSeenScore !== null ? 3 : 0);
  const pct = Math.round((total / maxScore) * 100);

  const { verdict, verdictKey, color } = computeVerdict(pct);

  const warHistoryWeeks = warHistory?.streakInCurrentClan ?? 0;
  const warActivityQuality = scoreQuality(activiteGDC, 8);
  const regularityQuality = scoreQuality(regulariteGDC, 10);

  const warActivitySummaryLine = `Activité de guerre : ${warActivityQuality} (${activiteGDC}/8, ${recoveredWeeksCount}/5 semaines récupérées : ${warHistoryActivityDetail}).`;

  const regularitySummaryLine = `Régularité : ${regularityQuality} (${regulariteGDC}/10, ${regularityWindow.fullWeekCount}/5 semaines complètes : ${regulariteGDCDetail}).`;

  const efficiencySummaryLine =
    efficiencyHistory.recentWeeks.length > 0
      ? `Points / deck : ${scoreQuality(efficiencyScore, 4)} (${efficiencyScore}/4 à partir de ${frDecimal(efficiencyHistory.pointsPerDeck)} pts/deck sur ${efficiencyHistory.recentWeeks.length} semaine(s) terminée(s)).`
      : `Points / deck : ${QUALITY_LABELS.bad} (0/4, aucune semaine terminée avec données GDC).`;

  const summary =
    `${warActivitySummaryLine}\n` +
    `${regularitySummaryLine}\n` +
    `${efficiencySummaryLine}\n` +
    `Dernière bataille de guerre : ${lastWarDay || "aucune"}${daysSinceLastWar !== null ? ` (il y a ${daysSinceLastWar} jour(s))` : ""}.\n` +
    `Dans le clan : ${clanDurationText(warHistoryWeeks)}.\nCW2 : ${cw2Remark(cw2Score)}.`;

  return {
    total,
    maxScore,
    pct,
    verdict,
    verdictKey,
    color,
    isFallback: true,
    summary,
    breakdown: [
      {
        key: "cw2Badge",
        label: LABELS.cw2Badge,
        score: cw2Score,
        max: 10,
        detail: `${frNum(cw2Wins)} victoires CW2 totales (max 250)`,
      },
      {
        key: "warActivity",
        label: LABELS.warActivity,
        score: activiteGDC,
        max: 8,
        detail: warHistoryActivityDetail,
        explanation: `Basé sur ${recoveredWeeksCount} semaine(s) récupérée(s) depuis l'écran d'historique GDC. Dernière guerre : ${lastWarDay || "aucune"}${daysSinceLastWar !== null ? ` (il y a ${daysSinceLastWar} jour(s))` : ""}.`,
      },
      {
        key: "regularity",
        label: LABELS.regularity,
        score: regulariteGDC,
        max: 10,
        detail: regulariteGDCDetail,
        explanation: `Fenêtre de 5 semaines où seules les semaines complètes comptent et les semaines manquantes comptent 0 : ${regulariteGDCDetail}.`,
      },
      {
        key: "pointsPerDeck",
        label: LABELS.pointsPerDeck,
        score: efficiencyScore,
        max: 4,
        detail:
          efficiencyHistory.recentWeeks.length > 0
            ? `${frNum(efficiencyHistory.totalFame)} points / ${efficiencyHistory.totalDecks} decks (${frDecimal(efficiencyHistory.pointsPerDeck)} pts/deck, plage 100–180, 3 dernières semaines terminées)`
            : "Aucune semaine terminée avec données GDC",
      },
      ...(lastSeenScore !== null
        ? [
            {
              key: "lastSeen",
              label: LABELS.lastSeen,
              score: lastSeenScore,
              max: 3,
              detail: lastSeenDetail(lastSeenDays, 3),
            },
          ]
        : []),
      {
        key: "experience",
        label: LABELS.experience,
        score: experience,
        max: 3,
        detail: `${frNum(player.trophies ?? 0)} trophées (plage 4 000–14 000)`,
      },
      {
        key: "discord",
        label: LABELS.discord,
        score: discordScore,
        max: 2,
        detail: discordDetail(discordLinked),
      },
    ],
  };
}
