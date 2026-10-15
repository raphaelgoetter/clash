// Commandes centrées sur un clan : /combats-clan, /trust-clan,
// /champion-history, /compare, /top-clans, /clan, /family, /stats-clan,
// et leurs boutons (pagination, rafraîchissement, tris).
//
// Routage extrait de api/discord/interactions.js : chaque bloc répond à
// Discord via `res` s'il reconnaît l'interaction, sinon la fonction rend
// la main sans rien envoyer et le routeur essaie le module suivant.

import { getLeagueName } from "../../../backend/services/warLeagues.js";
import { roundProjectedFame } from "../../../backend/services/projectionFormat.js";
import { getDiscordLinks } from "../../../backend/services/discordLinks.js";
import {
  getStoredWarMatchupPerformanceSamples,
} from "../../../backend/services/matchupPerformance.js";
import {
  handleHistory as handleChampionHistory,
  handleHistoryPage as handleChampionHistoryPage,
} from "../_handlers/championHistory.js";
import {
  aggregateMatchupPerformance,
} from "../../../backend/services/analysisService.js";
import {
  runBackground,
  TRUST_ROYALE_URL,
  trustPlayerUrl,
  trustClanUrl,
  FAMILY_CLAN_TAGS,
  buildDiscordWebhookUrl,
  COLOR_MAP,
  RELIABILITY_ICON,
  formatParisObservationTime,
  mapWithConcurrency,
  getWarDayLabel,
  getCombatsDayBadge,
} from "../_lib/commun.js";

const ALLOWED_CLAN_TAGS = new Set(FAMILY_CLAN_TAGS);

// Clans famille où la GDC n'est plus obligatoire : /clan masque les données
// de fiabilité GDC et affiche à la place trophées, Discord et nouveaux membres.
const NO_WAR_FAMILY_CLAN_TAGS = new Set(["QU9UQJRL"]);

const CLAN_TYPE_FR = {
  open: "Ouvert",
  inviteOnly: "Sur invitation",
  closed: "Fermé",
};

const CLAN_STATUS_ICON = {
  open: "<:success:1499002702208958577>",
  inviteOnly: "<:warning:1499002725965500577>",
  closed: "<:error:1499002755841265826>",
};

function clanStatusLabel(type) {
  const icon = CLAN_STATUS_ICON[type] ?? "";
  const label = CLAN_TYPE_FR[type] ?? type ?? "—";
  return icon ? `${icon} ${label}` : label;
}

function findClanLeaderValue(members) {
  const leader = (members || []).find((m) => m.role === "leader");
  return leader ? `[${leader.name}](${trustPlayerUrl(leader.tag)})` : "—";
}

function getStatsClanScenario(isWarPeriod) {
  return isWarPeriod
    ? { key: "current" } // GDC en cours : semaine actuelle
    : { key: "training" }; // entraînement : semaine passée
}

function getStatsClanPeriodForMember(member, scenarioKey) {
  const weeks = Array.isArray(member?.warHistory?.weeks)
    ? member.warHistory.weeks
    : [];
  if (scenarioKey === "current") {
    return weeks.find((week) => week?.isCurrent && !week?.ignored) ?? null;
  }
  return (
    weeks.find(
      (week) =>
        !week?.isCurrent && !week?.ignored && (week?.decksUsed ?? 0) > 0,
    ) ?? null
  );
}

function getStatsClanMetrics(member, scenarioKey) {
  const period = getStatsClanPeriodForMember(member, scenarioKey);
  const decksUsed = Number(period?.decksUsed);
  const fame = Number(period?.fame);

  return {
    period,
    avgFame: Number.isFinite(fame) ? Math.round(fame) : null,
    pointsPerDeck:
      Number.isFinite(fame) && Number.isFinite(decksUsed) && decksUsed > 0
        ? Math.round(fame / decksUsed)
        : null,
  };
}

// Écart victoires réelles - attendues (cf. formatMatchupPerformanceField),
// null sous 4 combats GDC.
function getStatsClanPerformanceDiff(member) {
  const performance = member.performance;
  return performance && performance.battles >= 4 ? performance.diff : null;
}

function sortStatsClanMembers(members, sortMode) {
  return [...members].sort((a, b) => {
    if (sortMode === "pointsPerDeck") {
      const pa = Number.isFinite(a.pointsPerDeck) ? a.pointsPerDeck : -1;
      const pb = Number.isFinite(b.pointsPerDeck) ? b.pointsPerDeck : -1;
      return pb - pa;
    }
    if (sortMode === "decksUsed") {
      const da = Number.isFinite(a.period?.decksUsed) ? a.period.decksUsed : -1;
      const db = Number.isFinite(b.period?.decksUsed) ? b.period.decksUsed : -1;
      if (db !== da) return db - da;
      const fa = Number.isFinite(a.avgFame) ? a.avgFame : -1;
      const fb = Number.isFinite(b.avgFame) ? b.avgFame : -1;
      return fb - fa;
    }
    if (sortMode === "performance") {
      const pa = getStatsClanPerformanceDiff(a) ?? -Infinity;
      const pb = getStatsClanPerformanceDiff(b) ?? -Infinity;
      if (pa === pb) return 0;
      return pb > pa ? 1 : -1;
    }
    const fa = Number.isFinite(a.avgFame) ? a.avgFame : -1;
    const fb = Number.isFinite(b.avgFame) ? b.avgFame : -1;
    return fb - fa;
  });
}

function buildStatsClanComponents(clanVal, sortMode) {
  const sortButton = (mode, label) => ({
    type: 2,
    style: sortMode === mode ? 3 : 1,
    label,
    custom_id: `stats_clan_sort:${clanVal}:${mode}`,
    disabled: sortMode === mode,
  });

  return [
    {
      type: 1,
      components: [
        sortButton("avgFame", "🏆 Pts/semaine"),
        sortButton("pointsPerDeck", "📈 Pts/deck"),
        sortButton("decksUsed", "🃏 Decks joués"),
        sortButton("performance", "🎯 Performance"),
        {
          type: 2,
          style: 2,
          label: "🔄",
          custom_id: `stats_clan_refresh:${clanVal}:${sortMode}`,
          disabled: false,
        },
      ],
    },
  ];
}

// Performance GDC (3 semaines) de tous les membres, lue en une commande Redis
// et stockée dans `data` avant sa mise en cache : les clics de tri suivants
// répondent ainsi sans nouvel appel. Facultative : un échec n'empêche pas
// l'affichage (colonne P à « — »).
async function attachStatsClanPerformance(data) {
  const members = Array.isArray(data?.members) ? data.members : [];
  try {
    const samplesByTag = await getStoredWarMatchupPerformanceSamples(
      members.map((member) => member.tag),
    );
    data.performanceByTag = Object.fromEntries(
      Object.entries(samplesByTag).map(([tag, samples]) => [
        tag,
        aggregateMatchupPerformance(samples),
      ]),
    );
  } catch (err) {
    console.warn("[stats-clan] performance indisponible:", err.message);
    data.performanceByTag = {};
  }
}

// Une ligne par membre : données d'abord (largeurs proches d'une ligne à
// l'autre) et pseudo en fin de ligne ; la donnée du tri actif est en gras.
// Emojis Unicode (1-2 caractères) : des emojis personnalisés (~28 caractères
// chacun) dépasseraient la limite de 4096 caractères de l'embed.
function buildStatsClanRows(data, scenarioKey, sortMode) {
  const members = Array.isArray(data?.members) ? data.members : [];
  const performanceByTag = data?.performanceByTag ?? {};

  const normalizedMembers = members.map((member) => {
    const metrics = getStatsClanMetrics(member, scenarioKey);
    const tagKey = String(member.tag || "")
      .replace(/^#/, "")
      .toUpperCase();
    return {
      ...member,
      period: metrics.period,
      avgFame: metrics.avgFame,
      pointsPerDeck: metrics.pointsPerDeck,
      performance: performanceByTag[tagKey] ?? null,
    };
  });

  const sorted = sortStatsClanMembers(normalizedMembers, sortMode);
  const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString("fr-FR") : "—");
  const fmtDiff = (diff) => {
    if (diff === null) return "—";
    const rounded = Math.round(diff * 10) / 10;
    const abs = Math.abs(rounded).toFixed(1).replace(".", ",");
    return `${rounded >= 0 ? "+" : "-"}${abs}`;
  };
  const bold = (mode, str) =>
    sortMode === mode && str !== "—" ? `**${str}**` : str;

  return sorted.map((m, idx) => {
    const decksUsed = Number(m.period?.decksUsed);
    const columns = [
      `🏆 ${bold("avgFame", fmt(m.avgFame))}`,
      `📈 ${bold("pointsPerDeck", fmt(m.pointsPerDeck))}`,
      `🃏 ${bold("decksUsed", fmt(Number.isFinite(decksUsed) ? Math.round(decksUsed) : null))}`,
      `🎯 ${bold("performance", fmtDiff(getStatsClanPerformanceDiff(m)))}`,
    ];
    const name = `${m.isNew ? "🆕 " : ""}${m.name}`;
    return `${idx + 1}. ${columns.join(" ")} · ${name}`;
  });
}

const STATS_CLAN_ROWS_PER_EMBED = 25;

function buildStatsClanPayload({
  data,
  clanName,
  clanTag,
  clanVal,
  sortMode,
  isWarPeriod,
}) {
  const scenario = getStatsClanScenario(isWarPeriod);
  const rows = buildStatsClanRows(data, scenario.key, sortMode);

  // Plusieurs embeds dans un même message : au-delà d'une quarantaine de
  // lignes à 4 emojis, Discord affiche les numéros de liste mais plus leur
  // contenu (constaté sur 50 membres, ~2700 caractères pourtant).
  const embeds = [];
  for (let i = 0; i < rows.length; i += STATS_CLAN_ROWS_PER_EMBED) {
    embeds.push({
      color: 0x5865f2,
      description: rows
        .slice(i, i + STATS_CLAN_ROWS_PER_EMBED)
        .join(String.fromCharCode(10)),
    });
  }
  if (embeds.length === 0) embeds.push({ color: 0x5865f2 });
  embeds[0].title = `<:stats:1499284927894650950> Stats GDC : ${clanName}`;
  embeds[0].url = trustClanUrl(clanTag);

  return {
    embeds,
    components: buildStatsClanComponents(clanVal, sortMode),
  };
}

const STATS_CLAN_CACHE_TTL_MS = 60 * 1000;

const statsClanAnalysisCache = new Map();

function getStatsClanCacheKey(clanTag) {
  return String(clanTag || "")
    .replace(/^#/, "")
    .toUpperCase();
}

function getCachedStatsClanAnalysis(clanTag) {
  const key = getStatsClanCacheKey(clanTag);
  const entry = statsClanAnalysisCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > STATS_CLAN_CACHE_TTL_MS) {
    statsClanAnalysisCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedStatsClanAnalysis(clanTag, data) {
  const key = getStatsClanCacheKey(clanTag);
  if (!key || !data) return;
  statsClanAnalysisCache.set(key, {
    cachedAt: Date.now(),
    data,
  });
}

function buildCompareComponents(clanVal, sortMode) {
  const currentActive = sortMode === "current";
  const projectionActive = sortMode === "projection";

  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: currentActive ? 3 : 1,
          label: "📍 Actuel",
          custom_id: `compare_sort:${clanVal}:current`,
          disabled: currentActive,
        },
        {
          type: 2,
          style: projectionActive ? 3 : 1,
          label: "📈 Projection",
          custom_id: `compare_sort:${clanVal}:projection`,
          disabled: projectionActive,
        },
        {
          type: 2,
          style: 2,
          label: "🔄",
          custom_id: `compare_refresh:${clanVal}:${sortMode}`,
          disabled: false,
        },
      ],
    },
  ];
}

const COMPARE_CACHE_TTL_MS = 60 * 1000;

const compareAnalysisCache = new Map();

function getCompareCacheKey(clanTag) {
  return String(clanTag || "")
    .replace(/^#/, "")
    .toUpperCase();
}

function getCachedCompareAnalysis(clanTag) {
  const key = getCompareCacheKey(clanTag);
  const entry = compareAnalysisCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > COMPARE_CACHE_TTL_MS) {
    compareAnalysisCache.delete(key);
    return null;
  }
  return entry;
}

function setCachedCompareAnalysis(clanTag, data) {
  const key = getCompareCacheKey(clanTag);
  if (!key || !data) return null;
  const cachedAt = Date.now();
  compareAnalysisCache.set(key, { cachedAt, data });
  return cachedAt;
}

async function computeCalendarIsWarPeriod(clanTag, data) {
  // Garde calendaire locale : ne pas se fier à data.isWarPeriod qui peut venir
  // d'un cache statique généré pendant la GDC (lun–mer : false, jeu–dim : true).
  const { warResetOffsetMs } =
    await import("../../../backend/services/dateUtils.js");
  const dow = new Date(Date.now() - warResetOffsetMs(clanTag)).getUTCDay();
  return (dow === 0 || dow >= 4) && data?.isWarPeriod === true;
}

// clan.currentFame est la fame cumulée hebdomadaire (pertinente uniquement en
// Colisée) ; en GDC normale, les "points actuels" affichés par l'API sont
// clan.clanScore (points de la période courante). Même logique que
// frontend/warGroup.js pour rester cohérent entre le site et le bot.
function getCurrentPts(clan, isColosseum) {
  return isColosseum ? clan.currentFame : clan.clanScore;
}

function sortCompareRaceGroup(raceGroup, sortMode, isWarPeriod, isColosseum) {
  return [...raceGroup].sort((a, b) => {
    if (isWarPeriod && sortMode === "current") {
      return (
        (getCurrentPts(b, isColosseum) ?? 0) -
        (getCurrentPts(a, isColosseum) ?? 0)
      );
    }
    if (isWarPeriod) {
      // sortMode === "projection" (comportement par défaut en période GDC)
      const aClinched = a.isClinchedWin ? 1 : 0;
      const bClinched = b.isClinchedWin ? 1 : 0;
      if (aClinched !== bClinched) return bClinched - aClinched;
      return (b.projectedFame ?? 0) - (a.projectedFame ?? 0);
    }
    // Hors période GDC : fallback unique quel que soit sortMode demandé
    return (b.lastWarFame ?? 0) - (a.lastWarFame ?? 0);
  });
}

function buildCompareFooter({
  sortMode,
  isWarPeriod,
  anyClinched,
  observedAt,
}) {
  const suffix = observedAt ? ` Fait le ${observedAt}.` : "";
  if (!isWarPeriod) return `Trié par Total Dernière GDC.${suffix}`;
  if (sortMode === "current") return `Trié par Points actuels.${suffix}`;
  return anyClinched
    ? `Trié par Projection · ✅ = victoire mathématiquement assurée.${suffix}`
    : `Trié par Projection en fin de journée.${suffix}`;
}

function buildComparePayload({
  data,
  resolved,
  clanVal,
  sortMode,
  isWarPeriod,
  observedAt,
}) {
  const raceGroup = Array.isArray(data?.raceGroup) ? data.raceGroup : [];
  const ownTag = `#${resolved.tag}`.toUpperCase();
  const isColosseum = data?.isColosseum === true;

  const sorted = sortCompareRaceGroup(
    raceGroup,
    sortMode,
    isWarPeriod,
    isColosseum,
  );
  const fmt = (n) => (typeof n === "number" ? n.toLocaleString("fr-FR") : "—");

  const rows = sorted.map((clan, idx) => {
    const clanTag = (clan.tag ?? "").toUpperCase();
    const isOwn = clanTag === ownTag;
    const url = trustClanUrl(clanTag);
    const rank = `**#${idx + 1}**`;
    const nameStr = `**[${clan.name ?? clanTag}](${url})**`;
    const bold = isOwn ? "__" : "";

    const trophies =
      !isWarPeriod && clan.clanWarTrophies != null
        ? `<:trophy2:1493677804733337621> ${fmt(clan.clanWarTrophies)}`
        : "";

    const prevWarStr =
      clan.prevWarFame != null
        ? `<:battle:1493710671244689449> ${fmt(clan.prevWarFame)} (n-2)`
        : "";

    let trend = "";
    if (clan.lastWarFame != null && clan.prevWarFame != null) {
      if (clan.lastWarFame > clan.prevWarFame) trend = " ⬆";
      else if (clan.lastWarFame < clan.prevWarFame) trend = " ⬇";
    }
    const lastWarStr =
      clan.lastWarFame != null
        ? `<:battle:1493710671244689449> **${fmt(clan.lastWarFame)}** (Last)${trend}`
        : "";

    const line1 = `${rank} ${bold}${nameStr}${bold} ${trophies}`.trim();
    let line2;

    if (isWarPeriod) {
      const decks = `<:cards:1493711279121104926> ${clan.decksToday != null ? clan.decksToday : "?"} decks`;
      const eff = `<:cible:1493711597682557019> ${clan.ptsPerDeck != null ? clan.ptsPerDeck.toFixed(2) : "?"} pts/d`;
      const currentBold = sortMode === "current";
      const currentFameOrScore = getCurrentPts(clan, isColosseum);
      const currentPtsVal =
        currentFameOrScore != null ? fmt(currentFameOrScore) : null;
      const currentPts =
        currentPtsVal != null
          ? `<:trophy2:1493677804733337621> Points actuels : ${currentBold ? `**${currentPtsVal}**` : currentPtsVal}`
          : "";
      // Projection du classement/trophées de fin de journée (pts de bataille
      // extrapolés). En GDC normale, la vraie position de course (progression
      // du bateau) est distincte et affichée séparément (ligne "Bateau" ci-
      // dessous) — voir backend/services/warStandings.js.
      let proj;
      if (clan.isClinchedWin) {
        proj = "<:projection:1499275709078700073> ✅ Victoire";
      } else {
        const projRounded = roundProjectedFame(
          clan.projectedFame,
          clan.decksToday,
          clan.targetDecksToday,
        );
        const projVal = projRounded != null ? fmt(projRounded) : "?";
        proj = `<:projection:1499275709078700073> Projection: ${currentBold ? projVal : `**${projVal}**`}`;
      }
      const boat =
        !isColosseum && clan.raceProgress != null
          ? `⛵ Bateau : ${fmt(clan.raceProgress)}`
          : "";
      const line2a = [decks, eff].filter(Boolean).join(" · ");
      const line2b = [currentPts, proj].filter(Boolean).join(" · ");
      const line2c = boat;
      line2 = [line2a, line2b, line2c].filter(Boolean).join("\n");
    } else {
      line2 = [prevWarStr, lastWarStr].filter(Boolean).join(" · ");
    }

    return `${line1}\n${line2}`;
  });

  const anyClinched = isWarPeriod && sorted.some((c) => c.isClinchedWin);
  const footerText = buildCompareFooter({
    sortMode,
    isWarPeriod,
    isColosseum,
    anyClinched,
    observedAt,
  });

  return {
    embeds: [
      {
        title: `<:trophy2:1493677804733337621> ${isColosseum ? "Groupe de Colisée" : "Groupe de GDC"} — ${resolved.name}`,
        color: 0x9b59b6,
        description: rows.join("\n\n"),
        image: { url: `${TRUST_ROYALE_URL}/images/banner2.webp` },
        footer: { text: footerText },
      },
    ],
    components: buildCompareComponents(clanVal, sortMode),
  };
}

const LEAGUE_ICON_SPECIFIC = {
  "Or 2": "<:gold2:1506200349424488448>",
  "Légendaire 1": "<:leg1:1506200350250762311>",
  "Légendaire 2": "<:leg2:1506200352372822016>",
};

const LEAGUE_ICON_GENERIC = {
  "Bronze 1": "<:bronze:1506201933331824721>",
  "Bronze 2": "<:bronze:1506201933331824721>",
  "Bronze 3": "<:bronze:1506201933331824721>",
  "Argent 1": "<:silver:1506201931922800730>",
  "Argent 2": "<:silver:1506201931922800730>",
  "Argent 3": "<:silver:1506201931922800730>",
  "Or 1": "<:gold:1506201934477004880>",
  "Or 2": "<:gold:1506201934477004880>",
  "Or 3": "<:gold:1506201934477004880>",
  "Légendaire 1": "<:legendary1:1506218399498244166>",
  "Légendaire 2": "<:legendary2:1506217437601992734>",
  "Légendaire 3": "<:legendary3:1506218625508573225>",
};

function warLeagueLabel(trophies, isFamilyClan = false) {
  const label = getLeagueName(trophies ?? 0) ?? "Bronze 1";
  const icon = isFamilyClan
    ? (LEAGUE_ICON_SPECIFIC[label] ?? LEAGUE_ICON_GENERIC[label])
    : LEAGUE_ICON_GENERIC[label];
  return icon ? `${icon} ${label}` : label;
}

function buildClanComponents(clanTag) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "🔄 Rafraîchir",
          custom_id: `clan_refresh:${clanTag}`,
          disabled: false,
        },
      ],
    },
  ];
}

async function buildClanReportPayload(resolved) {
  const isFamilyClan = ALLOWED_CLAN_TAGS.has(resolved.tag.toUpperCase());
  const isNoWarClan = NO_WAR_FAMILY_CLAN_TAGS.has(resolved.tag.toUpperCase());

  try {
    const analysisEndpoint = `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(
      resolved.tag,
    )}/analysis?fast=true&includeRaceGroup=false`;
    const liteEndpoint = `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(
      resolved.tag,
    )}/lite`;

    async function fetchJsonWithTimeout(endpoint, timeoutMs) {
      const abortCtrl = new AbortController();
      const abortTimer = setTimeout(() => abortCtrl.abort(), timeoutMs);
      try {
        const response = await fetch(endpoint, {
          headers: { Accept: "application/json" },
          signal: abortCtrl.signal,
        });
        return response;
      } finally {
        clearTimeout(abortTimer);
      }
    }

    let apiResp = null;
    let usedLiteFallback = false;

    try {
      apiResp = await fetchJsonWithTimeout(
        isFamilyClan ? analysisEndpoint : liteEndpoint,
        isFamilyClan ? 12000 : 18000,
      );
    } catch (fetchErr) {
      if (isFamilyClan) {
        usedLiteFallback = true;
        try {
          apiResp = await fetchJsonWithTimeout(liteEndpoint, 12000);
        } catch (liteErr) {
          const msg =
            fetchErr.name === "AbortError" || liteErr.name === "AbortError"
              ? `⏱️ L'analyse du clan a pris trop longtemps. Réessayez dans 30 secondes.`
              : `Erreur réseau : ${liteErr.message}`;
          return { kind: "error", content: msg };
        }
      } else {
        const msg =
          fetchErr.name === "AbortError"
            ? `⏱️ L'analyse du clan a pris trop longtemps. Réessayez dans 30 secondes.`
            : `Erreur réseau : ${fetchErr.message}`;
        return { kind: "error", content: msg };
      }
    }

    if (!apiResp.ok && isFamilyClan) {
      usedLiteFallback = true;
      try {
        apiResp = await fetchJsonWithTimeout(liteEndpoint, 12000);
      } catch (_) {
        // Preserve original status message below.
      }
    }

    if (!apiResp || !apiResp.ok) {
      return {
        kind: "error",
        content: `Erreur API clan (${apiResp?.status ?? "inconnu"}). Réessayez dans quelques instants.`,
      };
    }

    const analysis = await apiResp.json();
    const clan = analysis.clan || {};
    const members = analysis.members || [];
    const liteMembers = analysis.isLite ? members : [];
    const summary = analysis.summary || {};
    const lastWarSummary = analysis.lastWarSummary || null;
    const hasReliabilityDetails =
      isFamilyClan && !analysis.isLite && !usedLiteFallback;

    if (hasReliabilityDetails && analysis.raceLogUnavailable) {
      return {
        kind: "error",
        content: `⚠️ Données partielles pour ${clan.name || "ce clan"} : l'API Clash Royale n'a pas répondu pour l'historique de guerre du clan, les scores de fiabilité affichés seraient incorrects. Réessaie la commande dans quelques instants.`,
      };
    }

    const fmt = (n) =>
      typeof n === "number" ? n.toLocaleString("fr-FR") : "—";
    const fmtInt = (n) =>
      Number.isFinite(n) ? Math.round(n).toLocaleString("fr-FR") : "—";
    const avgScore = summary.avgScore ?? 0;
    const embedColor =
      hasReliabilityDetails && !isNoWarClan
        ? avgScore >= 75
          ? COLOR_MAP.green
          : avgScore >= 56
            ? COLOR_MAP.yellow
            : avgScore >= 31
              ? COLOR_MAP.orange
              : COLOR_MAP.red
        : 0x99aab5;

    const MEMBER_LIMIT = 10;
    const topReliable = hasReliabilityDetails
      ? [...members]
          .sort(
            (a, b) => Number(b.reliability ?? 0) - Number(a.reliability ?? 0),
          )
          .slice(0, MEMBER_LIMIT)
      : [];
    const topRisky = hasReliabilityDetails
      ? members
          .filter(
            (m) =>
              m.verdictKey === "highRisk" || m.verdictKey === "extremeRisk",
          )
          .sort(
            (a, b) => Number(a.reliability ?? 0) - Number(b.reliability ?? 0),
          )
          .slice(0, MEMBER_LIMIT)
      : [];
    const newMembers = hasReliabilityDetails
      ? members
          .filter((m) => m.isNew)
          .sort((a, b) => {
            const aStreak = Number.isFinite(a.arrivalStreakInCurrentClan)
              ? Number(a.arrivalStreakInCurrentClan)
              : Number.POSITIVE_INFINITY;
            const bStreak = Number.isFinite(b.arrivalStreakInCurrentClan)
              ? Number(b.arrivalStreakInCurrentClan)
              : Number.POSITIVE_INFINITY;
            if (aStreak !== bStreak) return aStreak - bStreak;

            const aWeeks = Number.isFinite(a.arrivalTotalWeeks)
              ? Number(a.arrivalTotalWeeks)
              : Number.POSITIVE_INFINITY;
            const bWeeks = Number.isFinite(b.arrivalTotalWeeks)
              ? Number(b.arrivalTotalWeeks)
              : Number.POSITIVE_INFINITY;
            if (aWeeks !== bWeeks) return aWeeks - bWeeks;

            return Number(b.reliability ?? 0) - Number(a.reliability ?? 0);
          })
          .slice(0, MEMBER_LIMIT)
      : [];

    const rosterForNoWarStats = hasReliabilityDetails ? members : liteMembers;

    function avgTrophiesPerPlayer(list) {
      if (!Array.isArray(list) || list.length === 0) return null;
      const sum = list.reduce((s, m) => s + (Number(m.trophies) || 0), 0);
      return sum / list.length;
    }

    let discordLinkedCount = 0;
    if (isNoWarClan) {
      const links = await getDiscordLinks();
      discordLinkedCount = rosterForNoWarStats.filter((m) => {
        const tag = m.tag?.startsWith("#") ? m.tag : `#${m.tag}`;
        return Boolean(links[tag]);
      }).length;
    }

    function memberLine(m) {
      if (isNoWarClan) return `- [${m.name}](${trustPlayerUrl(m.tag)})`;
      const icon = RELIABILITY_ICON[m.color] ?? RELIABILITY_ICON.orange;
      const pct = Math.round(Number(m.reliability ?? 0));
      return `- [${m.name}](${trustPlayerUrl(m.tag)}) · ${icon} ${pct}%`;
    }

    function formatMemberListValue(list, emptyText = "Aucun") {
      if (!Array.isArray(list) || list.length === 0) return emptyText;

      const lines = list.map(memberLine);
      const MAX_FIELD_LEN = 1024;
      let value = "";
      let used = 0;

      for (let i = 0; i < lines.length; i += 1) {
        const candidate = value ? `${value}\n${lines[i]}` : lines[i];
        if (candidate.length > MAX_FIELD_LEN) {
          break;
        }
        value = candidate;
        used = i + 1;
      }

      const remaining = lines.length - used;
      if (remaining > 0) {
        const suffix = `\n… +${remaining} autre${remaining > 1 ? "s" : ""}`;
        if ((value + suffix).length <= MAX_FIELD_LEN) {
          value += suffix;
        } else if (value.length > suffix.length) {
          value = `${value.slice(0, MAX_FIELD_LEN - suffix.length)}${suffix}`;
        } else {
          value = `… +${remaining} autre${remaining > 1 ? "s" : ""}`;
        }
      }

      return value || emptyText;
    }

    function findLeaderValue() {
      return findClanLeaderValue(hasReliabilityDetails ? members : liteMembers);
    }

    const clanUrl = trustClanUrl(resolved.tag);
    const fields = [
      // Rangée 1 : Membres | Statut | Chef
      {
        name: "Membres",
        value: `<:members:1506175789731811399> ${clan.members ?? "?"} / 50`,
        inline: true,
      },
      {
        name: "Statut",
        value: clanStatusLabel(clan.type),
        inline: true,
      },
      {
        name: "Chef",
        value: findLeaderValue(),
        inline: true,
      },
      // Rangée 2 : Trophées GDC | Ligue | Fiabilité GDC (pas de fiabilité hors clan famille en GDC)
      {
        name: "Trophées GDC",
        value: `<:trophy2:1493677804733337621> ${fmt(clan.clanWarTrophies)}`,
        inline: true,
      },
      {
        name: "Ligue",
        value: warLeagueLabel(clan.clanWarTrophies ?? 0, isFamilyClan),
        inline: true,
      },
      hasReliabilityDetails && !isNoWarClan
        ? {
            name: "Fiabilité GDC",
            value: `<:warn:1506174837519945800> **${avgScore}%**`,
            inline: true,
          }
        : { name: "​", value: "​", inline: true },
      // Rangée 3 : Trophées | CS atteints | (spacer)
      {
        name: "Trophées",
        value: `<:trophy:1498645869224792105> ${fmt(clan.clanScore)}`,
        inline: true,
      },
      {
        name: "CS atteints",
        value: `<:CS:1549458633396588544> ${
          typeof clan.supremeChampionsCount === "number"
            ? clan.supremeChampionsCount
            : "—"
        }`,
        inline: true,
      },
      { name: "​", value: "​", inline: true },
      // Rangée 4 : Moyenne/joueur (ou Trophées/joueur) | Points/deck (ou Discord)
      isNoWarClan
        ? {
            name: "Trophées/joueur",
            value: `<:trophy:1498645869224792105> ${fmtInt(avgTrophiesPerPlayer(rosterForNoWarStats))}`,
            inline: true,
          }
        : {
            name: "Moyenne/joueur",
            value: `${fmtInt(lastWarSummary?.averagePerPlayer)} pts`,
            inline: true,
          },
      isNoWarClan
        ? {
            name: "Discord",
            value: `<:discord:1526507049779990601> ${discordLinkedCount}/${clan.members ?? "?"}`,
            inline: true,
          }
        : {
            name: "Points/deck",
            value: `${fmtInt(lastWarSummary?.pointsPerDeck)} pts`,
            inline: true,
          },
      { name: "​", value: "​", inline: true },
    ];

    // Rangée 5 : listes membres (uniquement pour les clans famille)
    if (hasReliabilityDetails) {
      fields.push({ name: "​", value: "​", inline: false });
      if (!isNoWarClan) {
        fields.push({
          name: `Top fiables (${topReliable.length})`,
          value: formatMemberListValue(topReliable, "Aucun"),
          inline: true,
        });
        fields.push({
          name: `Top risqués (${topRisky.length})`,
          value: formatMemberListValue(topRisky, "Aucun ✅"),
          inline: true,
        });
      }
      fields.push({
        name: `Nouveaux (${newMembers.length})`,
        value: formatMemberListValue(newMembers, "Aucun"),
        inline: true,
      });
    }

    const clanTag = (clan.tag ?? `#${resolved.tag}`).replace(/^#/, "");
    const observedAt = await formatParisObservationTime();
    const embed = {
      title: `${clan.name ?? resolved.name} | #${clanTag}`,
      url: clanUrl,
      description: `${clan.description ?? ""}${usedLiteFallback ? "\n\n⚠️ Données de fiabilité temporairement indisponibles, affichage allégé." : ""}`,
      color: embedColor,
      fields,
      footer: { text: `Observation du clan faite le ${observedAt}` },
    };

    return {
      kind: "success",
      embeds: [embed],
      components: buildClanComponents(resolved.tag),
    };
  } catch (err) {
    return { kind: "error", content: `Erreur : ${err.message}` };
  }
}

export async function routeClan(body, res) {
  // ── /combats-clan ──
  if (body.type === 2 && body.data?.name === "combats-clan") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");

    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };

    const clanVal = (clanOpt?.value || "1").toString().trim();
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    const webhookUrl = buildDiscordWebhookUrl(body);
    if (!webhookUrl) {
      console.error("Discord webhook URL non construite pour /combats-clan");
      return res.status(200).json({
        type: 4,
        data: {
          content:
            "Configuration Discord incomplète : impossible de répondre à l'interaction.",
          flags: 64,
        },
      });
    }

    res.status(200).json({ type: 5 });

    runBackground(async () => {
      try {
        const endpoint = `${TRUST_ROYALE_URL}/api/clan/${encodeURIComponent(resolved.tag)}/analysis?fast=true`;

        const abortCtrl = new AbortController();
        const abortTimer = setTimeout(() => abortCtrl.abort(), 20000);
        let apiResp;
        try {
          apiResp = await fetch(endpoint, {
            headers: { Accept: "application/json" },
            signal: abortCtrl.signal,
          });
        } finally {
          clearTimeout(abortTimer);
        }

        if (!apiResp.ok) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Erreur API (${apiResp.status}). Réessayez dans quelques instants.`,
              flags: 64,
            }),
          });
          return;
        }

        const data = await apiResp.json();

        // Un rate limit de l'API Clash Royale pendant la récupération du
        // battle log des membres (fréquent avec ~50 combattants à requêter
        // d'un coup) fait retomber le détail par jour à 0 partout (battle
        // log vide, cf. buildCurrentWarDays) sans casser le total fiable
        // (source live currentriverrace) — d'où des decks manquants
        // corrects mais un détail par jour totalement faux. On préfère
        // bloquer plutôt qu'afficher des jours à 0 trompeurs.
        if (data.rateLimited) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `⚠️ L'API Clash Royale a limité les requêtes pendant l'analyse de ${data.clan?.name || resolved.name} : le détail par jour serait peu fiable. Réessaie la commande dans quelques instants.`,
              flags: 64,
            }),
          });
          return;
        }

        const members = Array.isArray(data.members) ? data.members : [];
        const clanName = data.clan?.name || resolved.name;

        // Hors période de GDC : aucun membre n'a de warDays exploitable
        // (buildCurrentWarDays() renvoie null hors calendrier GDC).
        const anyWarDays = members.some((m) => m.warDays != null);
        if (!anyWarDays) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Pas de GDC en cours pour ${clanName}.`,
              flags: 64,
            }),
          });
          return;
        }

        // Les joueurs arrivés en cours de semaine sont inclus comme tout le
        // monde : totalDecksUsed vaut 0 pour eux dans ce cas (cf.
        // buildCurrentWarDays), donc ils remontent normalement s'ils n'ont
        // pas encore joué depuis leur arrivée.
        //
        // maxDecksElapsed compte la journée du jour comme pleinement écoulée
        // (utile pour d'autres usages), mais tant qu'elle n'est pas terminée
        // il est normal qu'un joueur n'ait pas encore joué ses 4 decks —
        // on ne doit donc juger un joueur QUE sur les jours déjà clos
        // (ni aujourd'hui, ni les jours à venir). decksUsedToday (source
        // live, fiable) est retiré du total pour isoler les decks joués sur
        // les jours clos, comparés à leur maximum théorique.
        const MS_PER_DAY = 24 * 60 * 60 * 1000;
        const missing = members
          .filter((m) => m.warDays)
          .map((m) => {
            const wd = m.warDays;
            const todayDay = wd.days.find((d) => d.isToday);
            const todayCount = todayDay?.count ?? 0;
            // Jour réel d'arrivée dans le clan (0=jeudi … 3=dimanche),
            // déduit de firstSeenAt/warStartMs plutôt que du champ
            // arrivedOnDay du backend (qui suppose toujours une arrivée
            // "aujourd'hui", donc faux pour un joueur arrivé plus tôt dans
            // la semaine — il ne serait alors jamais jugé). Un joueur
            // présent avant le début de la GDC est jugé depuis le jour 1.
            let arrivalDayIndex = 0;
            if (wd.warStartMs != null && m.firstSeenAt) {
              const diffDays = Math.floor(
                (Date.parse(m.firstSeenAt) - wd.warStartMs) / MS_PER_DAY,
              );
              arrivalDayIndex = Math.min(3, Math.max(0, diffDays));
            }
            const completedDaysCount = Math.max(
              0,
              wd.daysFromThu - arrivalDayIndex,
            );
            const completedMax = completedDaysCount * 4;
            const completedUsed = Math.max(
              0,
              (wd.totalDecksUsed ?? 0) - todayCount,
            );
            return {
              member: m,
              missingCount: completedMax - completedUsed,
            };
          })
          .filter((x) => x.missingCount > 0)
          .sort(
            (a, b) =>
              b.missingCount - a.missingCount ||
              a.member.name.localeCompare(b.member.name),
          );

        if (missing.length === 0) {
          const embed = {
            title: `✅ Decks manquants GDC : ${clanName}`,
            url: trustClanUrl(resolved.tag),
            color: 0x2ecc71,
            description:
              "Tout le monde a joué ses decks du jour cette semaine !",
          };
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ embeds: [embed] }),
          });
          return;
        }

        const currentDayNum = (missing[0].member.warDays.daysFromThu ?? 0) + 1;

        const MAX_MEMBERS_LISTED = 20;
        if (missing.length > MAX_MEMBERS_LISTED) {
          const embed = {
            title: `<:sweat:1504139431106576405> Decks manquants GDC J${currentDayNum} : ${clanName}`,
            url: trustClanUrl(resolved.tag),
            color: 0xe67e22,
            description: `${missing.length} joueurs manquent des decks cette semaine — trop nombreux pour être listés ici. Voir le détail joueur par joueur avec /combats.`,
          };
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ embeds: [embed] }),
          });
          return;
        }

        const rows = missing.map(({ member, missingCount }) => {
          const dayBadges = member.warDays.days
            .map((day) => {
              const label = getWarDayLabel(day.key);
              const badge = getCombatsDayBadge(day.count, {
                isFuture: day.isFuture,
                isToday: day.isToday,
              });
              if (day.isFuture) return `${badge} ${label}`;
              const count = day.count ?? 0;
              return `${badge} ${label} (${count}/4)`;
            })
            .join(" · ");
          return `**[${member.name}](${trustPlayerUrl(member.tag)})** (${member.tag}) — ${missingCount} deck${missingCount === 1 ? "" : "s"} manquant${missingCount === 1 ? "" : "s"} (J${currentDayNum} en cours)\n${dayBadges}`;
        });

        // Pagination (sécurité, normalement tout tient sur une page) : même
        // logique de chunking que /stats-clan.
        const DESC_MAX = 4096;
        const pages = [];
        let currentPage = [];
        let currentLen = 0;
        for (const row of rows) {
          const rowLen = row.length + 2;
          if (currentLen + rowLen > DESC_MAX && currentPage.length > 0) {
            pages.push(currentPage);
            currentPage = [row];
            currentLen = rowLen;
          } else {
            currentPage.push(row);
            currentLen += rowLen;
          }
        }
        if (currentPage.length > 0) pages.push(currentPage);

        // ⚠️ Limite résiduelle connue (même source que /combats) : le détail
        // par jour vient du battle log de chaque joueur, plafonné aux ~25-30
        // combats les plus récents côté API Clash Royale — un jour ancien
        // peut donc ponctuellement être sous-estimé si beaucoup de combats
        // (GDC ou non) ont eu lieu depuis. Le nombre de decks manquants
        // ci-dessus reste fiable : il est calculé à partir du total
        // hebdomadaire live (decksUsed/decksUsedToday), pas d'une somme des
        // jours.
        const caveat =
          "-# ⚠️ Le détail par jour peut, rarement, sous-estimer un jour ancien (historique de combats limité) — le nombre de decks manquants reste fiable.\n\n";

        const embed = {
          title: `<:sweat:1504139431106576405> Decks manquants GDC J${currentDayNum} : ${clanName}`,
          url: trustClanUrl(resolved.tag),
          color: 0xe67e22,
          description: caveat + pages[0].join("\n\n"),
          footer: {
            text: `${missing.length} joueur${missing.length === 1 ? "" : "s"} en défaut${pages.length > 1 ? ` · page 1/${pages.length}` : ""} · Détail complet avec /combats`,
          },
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
        });

        for (let i = 1; i < pages.length; i++) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              embeds: [
                {
                  color: 0xe67e22,
                  description: pages[i].join("\n\n"),
                  footer: {
                    text: `${missing.length} joueur${missing.length === 1 ? "" : "s"} en défaut · page ${i + 1}/${pages.length} · Détail complet avec /combats`,
                  },
                },
              ],
            }),
          });
        }
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur lors de l'analyse : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /trust-clan
  if (body.type === 2 && body.data?.name === "trust-clan") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const clanVal = (clanOpt?.value || "1").toString().trim().toLowerCase();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const abortCtrl = new AbortController();
        const abortTimer = setTimeout(() => abortCtrl.abort(), 50000);
        let apiResp;
        try {
          apiResp = await fetch(
            `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(resolved.tag)}/analysis?fast=true`,
            {
              headers: { Accept: "application/json" },
              signal: abortCtrl.signal,
            },
          );
        } catch (fetchErr) {
          clearTimeout(abortTimer);
          const msg =
            fetchErr.name === "AbortError"
              ? `⏱️ L'analyse du clan a pris trop longtemps. Réessayez dans 30 secondes (le cache est en cours de préchauffage).`
              : `Erreur réseau : ${fetchErr.message}`;
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: msg, flags: 64 }),
          });
          return;
        }
        clearTimeout(abortTimer);
        if (!apiResp.ok) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Erreur API clan (${apiResp.status}). Réessayez dans quelques instants.`,
              flags: 64,
            }),
          });
          return;
        }
        const analysis = await apiResp.json();

        if (analysis.raceLogUnavailable) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `⚠️ Données partielles pour ${resolved.name} : l'API Clash Royale n'a pas répondu pour l'historique de guerre du clan, les scores de fiabilité affichés seraient incorrects. Réessaie la commande dans quelques instants.`,
              flags: 64,
            }),
          });
          return;
        }

        const members = analysis.members || [];

        const filtered = members
          .filter(
            (m) =>
              m.verdictKey === "highRisk" || m.verdictKey === "extremeRisk",
          )
          .sort((a, b) => {
            // Risque le plus élevé en premier (score le plus bas = plus risqué)
            const scoreA = Number(a.reliability ?? 0);
            const scoreB = Number(b.reliability ?? 0);
            if (scoreA !== scoreB) return scoreA - scoreB;
            // En cas d'égalité, trier par verdict (extrême avant high)
            const severity = { extremeRisk: 0, highRisk: 1 };
            return (
              (severity[a.verdictKey] || 0) - (severity[b.verdictKey] || 0)
            );
          });

        if (filtered.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `✅ Aucun membre avec un risque Élevé/Extrême trouvé dans ${resolved.name}.`,
              flags: 64,
            }),
          });
          return;
        }

        const VERDICT_EMOJI = {
          highReliability: RELIABILITY_ICON.green,
          lowRisk: RELIABILITY_ICON.yellow,
          highRisk: RELIABILITY_ICON.orange,
          extremeRisk: RELIABILITY_ICON.red,
        };
        const VERDICT_SHORT_LABEL = {
          extremeRisk: "Extrême",
          highRisk: "Élevé",
        };
        const clanUrl = trustClanUrl(resolved.tag);
        const allRows = filtered.map((m) => {
          const newTag = m.isNew ? " 🆕" : "";
          const emoji = VERDICT_EMOJI[m.verdictKey] ?? RELIABILITY_ICON.red;
          const pct = Math.round(Number(m.reliability ?? 0));
          const verdictLabel =
            VERDICT_SHORT_LABEL[m.verdictKey] || m.verdict || "";
          const playerUrl = trustPlayerUrl(m.tag);
          return `- [${m.name}](${playerUrl})${newTag} · ${emoji} ${verdictLabel} (${pct}%)`;
        });

        let description;
        const MAX_ROWS = 80;
        if (allRows.length <= MAX_ROWS) {
          description = allRows.join("\n");
        } else {
          description =
            allRows.slice(0, MAX_ROWS).join("\n") +
            `\n...et ${allRows.length - MAX_ROWS} autres`;
        }

        const weekId =
          analysis.prevWeekId || analysis.clanWarSummary?.weekId || "S?";
        const embed = {
          title: `<:sweat:1504139431106576405> ${resolved.name} (${filtered.length} risqués)`,
          url: clanUrl,
          color: 0xe67e22,
          description,
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds: [embed] }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /champion-history — registre des vrais champions GDC passés
  // d'un clan (pas de pronostics/votes, voir backend/services/championHistory.js)
  if (body.type === 2 && body.data?.name === "champion-history") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const clanVal = clanOpt?.value || "1";
    res.status(200).json({ type: 5 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleChampionHistory(webhookUrl, clanVal));
    return;
  }

  // Commande /compare
  if (body.type === 2 && body.data?.name === "compare") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const clanVal = (clanOpt?.value || "1").toString().trim().toLowerCase();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    res.status(200).json({ type: 5 });
    const webhookUrl = buildDiscordWebhookUrl(body);

    runBackground(async () => {
      try {
        const apiUrl = `${TRUST_ROYALE_URL}/api/clan/${resolved.tag}/analysis?includeRaceGroup=true&includeTopPlayers=false&includeUncomplete=false&fast=true&force=true`;
        const apiRes = await fetch(apiUrl);
        if (!apiRes.ok) throw new Error(`API ${apiRes.status}`);
        const data = await apiRes.json();

        const raceGroup = data.raceGroup;
        if (!Array.isArray(raceGroup) || raceGroup.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Aucun groupe de course trouvé pour **${resolved.name}** (données indisponibles ou phase de préparation).`,
              flags: 64,
            }),
          });
          return;
        }

        const cachedAt = setCachedCompareAnalysis(resolved.tag, data);
        const isWarPeriod = await computeCalendarIsWarPeriod(
          resolved.tag,
          data,
        );
        const sortMode = isWarPeriod ? "projection" : "current";
        const observedAt = await formatParisObservationTime(new Date(cachedAt));
        const payload = buildComparePayload({
          data,
          resolved,
          clanVal,
          sortMode,
          isWarPeriod,
          observedAt,
        });

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            ...payload,
            allowed_mentions: { parse: [] },
          }),
        });
      } catch (err) {
        console.error("[/compare] erreur:", err.message);
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /top-clans
  if (body.type === 2 && body.data?.name === "top-clans") {
    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const TOP_CLANS_WINDOW = 50;
        const startOpt = body.data.options?.find((o) => o.name === "start");
        const startRank = Math.max(
          1,
          Math.min(970, parseInt(startOpt?.value ?? 1, 10) || 1),
        );

        const FRANCE_ID = "57000087";
        // Limite : assez pour couvrir la tranche + trouver les clans famille (~rang 300-400)
        const fetchLimit = Math.max(startRank + (TOP_CLANS_WINDOW - 1), 500);

        const { fetchClanWarRankings } =
          await import("../../../backend/services/clashApi.js");

        // Récupérer le leaderboard GDC France
        const allClans = await fetchClanWarRankings(FRANCE_ID, fetchLimit);

        // Extraire la tranche demandée
        const slice = allClans.filter(
          (c) => c.rank >= startRank && c.rank < startRank + TOP_CLANS_WINDOW,
        );

        if (slice.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Aucun clan trouvé à partir du rang #${startRank} dans le classement France.`,
              flags: 64,
            }),
          });
          return;
        }

        // Identifier les clans famille absents de la tranche
        const normalizeTag = (raw) =>
          (raw ?? "").replace(/^#/, "").toUpperCase();
        const sliceTags = new Set(slice.map((c) => normalizeTag(c.tag)));
        const familyOutside = allClans.filter(
          (c) =>
            FAMILY_CLAN_TAGS.has(normalizeTag(c.tag)) &&
            !sliceTags.has(normalizeTag(c.tag)),
        );

        // Formateur de médaille/rang
        const rankLabel = (r) => {
          if (r === 1) return "🥇";
          if (r === 2) return "🥈";
          if (r === 3) return "🥉";
          return `**#${r}**`;
        };

        // Formateur de variation de rang (previousRank - rank)
        const rankDelta = (rank, previousRank) => {
          if (previousRank == null || previousRank === -1) return " 🆕";
          const delta = previousRank - rank;
          if (delta > 0) return ` ▲${delta}`;
          if (delta < 0) return ` ▼${Math.abs(delta)}`;
          return " →";
        };

        const fmt = (n) =>
          typeof n === "number" ? n.toLocaleString("fr-FR") : "—";

        // Formateur d'une entrée de clan (2 lignes)
        const formatEntry = (clan) => {
          const rawTag = (clan.tag ?? "").toUpperCase();
          const tag = normalizeTag(clan.tag);
          const isFamily = FAMILY_CLAN_TAGS.has(tag);
          const familyIcon = isFamily ? " 🏠" : "";
          const label = rankLabel(clan.rank);
          const delta = rankDelta(clan.rank, clan.previousRank);
          const name = clan.name ?? tag;
          const members = clan.members != null ? `${clan.members}/50` : "?/50";
          const trophyValue =
            clan.clanWarTrophies ?? clan.clanScore ?? clan.trophies ?? null;
          const trophies = fmt(trophyValue);

          const line1 = `${label}${delta}${familyIcon} **${name}** · \`${rawTag}\``;
          const line2 = `┣ <:trophy2:1493677804733337621> ${trophies} · <:members:1506175789731811399> ${members}`;
          return `${line1}\n${line2}`;
        };

        // Construire les entrées de la tranche
        const sliceRows = slice.map((clan) => formatEntry(clan));
        // Construire les entrées des clans famille hors tranche
        const familyRows = familyOutside.map((clan) => formatEntry(clan));

        // Grouper par 25 clans
        const groupBy = (arr, size) => {
          const groups = [];
          for (let i = 0; i < arr.length; i += size)
            groups.push(arr.slice(i, i + size));
          return groups;
        };
        const sliceGroups = groupBy(sliceRows, 25);
        const familyGroups = groupBy(familyRows, 25);

        const endRank =
          slice[slice.length - 1]?.rank ?? startRank + (TOP_CLANS_WINDOW - 1);

        const sendWebhook = async (payload) => {
          const resp = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
          });
          if (!resp.ok) {
            const text = await resp.text();
            console.error(
              "[/top-clans] Discord webhook error:",
              resp.status,
              text,
            );
            throw new Error(`Discord ${resp.status}: ${text.slice(0, 800)}`);
          }
        };

        const sendGroup = async (group, title, color, footer) => {
          await sendWebhook({
            embeds: [
              {
                title,
                color,
                description: group.join("\n"),
                ...(footer ? { footer } : {}),
              },
            ],
            allowed_mentions: { parse: [] },
          });
        };

        // Message 1 : clans #1 → #25
        await sendGroup(
          sliceGroups[0],
          `🏆 Classement France GDC — #${startRank} → #${endRank}`,
          0xf1c40f,
          sliceGroups.length === 1 && familyGroups.length === 0
            ? {
                text: `France · Trophées GDC · ${allClans.length} clans chargés`,
              }
            : null,
        );

        // Message 2 : clans #26 → #50 (si existants)
        if (sliceGroups.length > 1) {
          await sendGroup(
            sliceGroups[1],
            `🏆 Classement France GDC (suite) — #${startRank} → #${endRank}`,
            0xf1c40f,
            familyGroups.length === 0
              ? {
                  text: `France · Trophées GDC · ${allClans.length} clans chargés`,
                }
              : null,
          );
        }

        // Message 3 (et +) : clans famille hors tranche
        for (let i = 0; i < familyGroups.length; i++) {
          await sendGroup(
            familyGroups[i],
            familyGroups.length > 1
              ? `🏠 Clans famille (hors tranche) — ${familyRows.length} clan${familyRows.length > 1 ? "s" : ""}`
              : "🏠 Clans famille (hors tranche)",
            0x3498db,
            i === familyGroups.length - 1
              ? {
                  text: `France · Trophées GDC · ${allClans.length} clans chargés`,
                }
              : null,
          );
        }
      } catch (err) {
        console.error("[/top-clans] erreur:", err.message);
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  if (body.type === 2 && body.data?.name === "clan") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const tagOpt = body.data.options?.find((o) => o.name === "tag");

    if (!clanOpt && !tagOpt) {
      return res.status(200).json({
        type: 4,
        data: {
          content: "Veuillez sélectionner un clan ou fournir un tag.",
          flags: 64,
        },
      });
    }

    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };

    let resolved;
    if (tagOpt) {
      const rawTag = tagOpt.value.trim().toUpperCase().replace(/^#/, "");
      resolved = { tag: rawTag, name: `#${rawTag}` };
    } else {
      const clanVal = (clanOpt.value || "1").toString().trim();
      resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];
    }

    res.status(200).json({ type: 5 });
    const webhookUrl = buildDiscordWebhookUrl(body);

    runBackground(async () => {
      const payload = await buildClanReportPayload(resolved);
      if (payload.kind === "success") {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: payload.embeds,
            components: payload.components,
          }),
        });
      } else {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: payload.content, flags: 64 }),
        });
      }
    });
    return;
  }

  if (body.type === 2 && body.data?.name === "family") {
    const familyClanDefs = [
      { name: "La Resistance", tag: "Y8JUPC9C" },
      { name: "Les Resistants", tag: "LRQP20V9" },
      { name: "Les Revoltes", tag: "QU9UQJRL" },
      { name: "La Treve", tag: "QUV220GJ" },
    ];

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        async function fetchJsonWithTimeout(endpoint, timeoutMs) {
          const abortCtrl = new AbortController();
          const abortTimer = setTimeout(() => abortCtrl.abort(), timeoutMs);
          try {
            const response = await fetch(endpoint, {
              headers: { Accept: "application/json" },
              signal: abortCtrl.signal,
            });
            return response;
          } finally {
            clearTimeout(abortTimer);
          }
        }

        const clanResults = await mapWithConcurrency(
          familyClanDefs,
          4,
          async ({ name, tag }) => {
            const analysisEndpoint = `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(
              tag,
            )}/analysis?fast=true&includeRaceGroup=false`;
            const liteEndpoint = `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(
              tag,
            )}/lite`;
            const isAllowed = ALLOWED_CLAN_TAGS.has(tag.toUpperCase());
            let apiResp = null;
            let usedLiteFallback = false;

            if (isAllowed) {
              try {
                apiResp = await fetchJsonWithTimeout(analysisEndpoint, 12000);
              } catch (err) {
                usedLiteFallback = true;
              }
              if (!apiResp || !apiResp.ok) {
                try {
                  apiResp = await fetchJsonWithTimeout(liteEndpoint, 12000);
                } catch (err) {
                  apiResp = null;
                }
              }
            } else {
              try {
                apiResp = await fetchJsonWithTimeout(liteEndpoint, 12000);
              } catch (err) {
                apiResp = null;
              }
            }

            if (!apiResp || !apiResp.ok) {
              return {
                name,
                tag,
                error: `Impossible de charger les données du clan ${name} (${tag}).`,
              };
            }

            const analysis = await apiResp.json();
            const clan = analysis.clan || {};
            const leaderMembers = analysis.members || [];
            return {
              name: clan.name || name,
              tag,
              description: clan.description || "",
              members: clan.members ?? clan.memberCount ?? "—",
              clanWarTrophies: clan.clanWarTrophies ?? 0,
              type: clan.type,
              requiredTrophies: clan.requiredTrophies,
              clanScore: clan.clanScore,
              supremeChampionsCount: clan.supremeChampionsCount,
              leaderValue: findClanLeaderValue(leaderMembers),
              isFamilyClan: true,
              usedLiteFallback,
            };
          },
        );

        const embeds = clanResults.map((clanResult) => {
          if (clanResult.error) {
            return {
              title: `${clanResult.name} | #${clanResult.tag}`,
              description: clanResult.error,
              color: 0xe74c3c,
            };
          }

          return {
            title: `<:laresistance:1514545454527025182> ${clanResult.name} | #${clanResult.tag}`,
            url: trustClanUrl(clanResult.tag),
            description: clanResult.description,
            color: 0x5865f2,
            fields: [
              // Rangée 1 : Membres | Statut | Chef
              {
                name: "Membres",
                value: `<:members:1506175789731811399> ${clanResult.members}`,
                inline: true,
              },
              {
                name: "Statut",
                value: clanStatusLabel(clanResult.type),
                inline: true,
              },
              {
                name: "Chef",
                value: clanResult.leaderValue,
                inline: true,
              },
              // Rangée 2 : Trophées GDC | Ligue | (pas de fiabilité dans /family)
              {
                name: "Trophées GDC",
                value: `<:trophy2:1493677804733337621> ${clanResult.clanWarTrophies}`,
                inline: true,
              },
              {
                name: "Ligue",
                value: warLeagueLabel(clanResult.clanWarTrophies, true),
                inline: true,
              },
              { name: "​", value: "​", inline: true },
              // Rangée 3 : Trophées | CS atteints | (spacer)
              {
                name: "Trophées",
                value: `<:trophy:1498645869224792105> ${
                  typeof clanResult.clanScore === "number"
                    ? clanResult.clanScore.toLocaleString("fr-FR")
                    : "—"
                }`,
                inline: true,
              },
              {
                name: "CS atteints",
                value: `<:CS:1549458633396588544> ${
                  typeof clanResult.supremeChampionsCount === "number"
                    ? clanResult.supremeChampionsCount
                    : "—"
                }`,
                inline: true,
              },
              { name: "​", value: "​", inline: true },
            ],
          };
        });

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ embeds }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // ── /stats-clan ──
  if (body.type === 2 && body.data?.name === "stats-clan") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");

    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };

    const clanVal = (clanOpt?.value || "1").toString().trim();
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];
    const sortMode = "avgFame";

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const endpoint = `${TRUST_ROYALE_URL}/api/clan/${encodeURIComponent(resolved.tag)}/analysis?fast=true`;

        const abortCtrl = new AbortController();
        const abortTimer = setTimeout(() => abortCtrl.abort(), 20000);
        let apiResp;
        try {
          apiResp = await fetch(endpoint, {
            headers: { Accept: "application/json" },
            signal: abortCtrl.signal,
          });
        } finally {
          clearTimeout(abortTimer);
        }

        if (!apiResp.ok) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Erreur API (${apiResp.status}). Réessayez dans quelques instants.`,
              flags: 64,
            }),
          });
          return;
        }

        const data = await apiResp.json();

        if (data.raceLogUnavailable) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `⚠️ Données partielles pour ${resolved.name} : l'API Clash Royale n'a pas répondu pour l'historique de guerre du clan, les stats affichées seraient incorrectes. Réessaie la commande dans quelques instants.`,
              flags: 64,
            }),
          });
          return;
        }

        await attachStatsClanPerformance(data);
        setCachedStatsClanAnalysis(resolved.tag, data);
        const members = Array.isArray(data.members) ? data.members : [];
        const clanInfo = data.clan || {};
        const clanName = clanInfo.name || resolved.name;
        const isWarPeriod = await computeCalendarIsWarPeriod(
          resolved.tag,
          data,
        );

        if (members.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: "Aucun membre trouvé.",
              flags: 64,
            }),
          });
          return;
        }

        const payload = buildStatsClanPayload({
          data,
          clanName,
          clanTag: resolved.tag,
          clanVal,
          sortMode,
          isWarPeriod,
        });

        const firstResp = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });

        if (!firstResp.ok) {
          const text = await firstResp.text().catch(() => "");
          console.error(
            "stats-clan webhook failed:",
            firstResp.status,
            text,
          );
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `⚠️ Erreur d'envoi (${firstResp.status}). Les données sont peut-être trop volumineuses.`,
              flags: 64,
            }),
          });
          return;
        }
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // ── MessageComponent : bouton "Précédents" du registre des champions ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("champion_history_page:")
  ) {
    const [, clanVal, offsetStr] = body.data.custom_id.split(":");
    const offset = parseInt(offsetStr, 10) || 0;
    res.status(200).json({ type: 6 });
    const webhookUrl = buildDiscordWebhookUrl(body);
    const originalWebhookUrl = webhookUrl
      ? `${webhookUrl}/messages/@original`
      : null;
    runBackground(() =>
      handleChampionHistoryPage(originalWebhookUrl, clanVal, offset),
    );
    return;
  }

  // ── MessageComponent : boutons de tri stats-clan ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("stats_clan_")
  ) {
    const parts = body.data.custom_id.split(":");
    if (parts.length < 3) {
      return res
        .status(200)
        .json({ type: 4, data: { content: "Erreur interne.", flags: 64 } });
    }

    const action = parts[0];
    const clanVal = parts[1];
    const sortMode = parts[2];

    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];
    const clanTag = resolved.tag;
    const webhookUrl = buildDiscordWebhookUrl(body);
    const originalWebhookUrl = webhookUrl
      ? `${webhookUrl}/messages/@original`
      : null;

    if (!originalWebhookUrl) {
      return res.status(200).json({
        type: 4,
        data: {
          content:
            "Configuration Discord incomplète : impossible de répondre à l'interaction.",
          flags: 64,
        },
      });
    }

    const cachedData = getCachedStatsClanAnalysis(clanTag);
    const shouldFetch = action === "stats_clan_refresh" || !cachedData;

    if (!shouldFetch) {
      const clanInfo = cachedData.clan || {};
      const clanName = clanInfo.name || resolved.name;
      const isWarPeriod = await computeCalendarIsWarPeriod(clanTag, cachedData);
      return res.status(200).json({
        type: 7,
        data: buildStatsClanPayload({
          data: cachedData,
          clanName,
          clanTag,
          clanVal,
          isWarPeriod,
          sortMode,
        }),
      });
    }

    res.status(200).json({ type: 6 });

    runBackground(async () => {
      let data = cachedData;
      const endpoint = `${TRUST_ROYALE_URL}/api/clan/${encodeURIComponent(
        clanTag,
      )}/analysis?fast=true`;
      const abortCtrl = new AbortController();
      const abortTimer = setTimeout(() => abortCtrl.abort(), 15000);
      try {
        const apiResp = await fetch(endpoint, {
          headers: { Accept: "application/json" },
          signal: abortCtrl.signal,
        });
        if (!apiResp.ok) {
          await fetch(originalWebhookUrl, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Erreur API (${apiResp.status}). Réessayez dans quelques instants.`,
            }),
          });
          return;
        }
        data = await apiResp.json();

        if (data.raceLogUnavailable) {
          await fetch(originalWebhookUrl, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `⚠️ Données partielles pour ${resolved.name} : l'API Clash Royale n'a pas répondu pour l'historique de guerre du clan. Réessaie dans quelques instants.`,
            }),
          });
          return;
        }

        await attachStatsClanPerformance(data);
        setCachedStatsClanAnalysis(clanTag, data);
      } catch (err) {
        const message =
          err?.name === "AbortError"
            ? "⏱️ Le rafraîchissement a pris trop de temps. Réessayez."
            : `Erreur : ${err?.message || "inconnue"}`;
        await fetch(originalWebhookUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: message }),
        });
        return;
      } finally {
        clearTimeout(abortTimer);
      }

      const clanInfo = data.clan || {};
      const clanName = clanInfo.name || resolved.name;
      const isWarPeriod = await computeCalendarIsWarPeriod(clanTag, data);
      await fetch(originalWebhookUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildStatsClanPayload({
            data,
            clanName,
            clanTag,
            clanVal,
            isWarPeriod,
            sortMode,
          }),
        ),
      });
    });

    return;
  }

  // ── MessageComponent : boutons de tri /compare ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("compare_")
  ) {
    const parts = body.data.custom_id.split(":");
    if (parts.length < 3) {
      return res
        .status(200)
        .json({ type: 4, data: { content: "Erreur interne.", flags: 64 } });
    }

    const action = parts[0];
    const clanVal = parts[1];
    const sortMode = parts[2];

    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];
    const clanTag = resolved.tag;
    const webhookUrl = buildDiscordWebhookUrl(body);
    const originalWebhookUrl = webhookUrl
      ? `${webhookUrl}/messages/@original`
      : null;

    if (!originalWebhookUrl) {
      return res.status(200).json({
        type: 4,
        data: {
          content:
            "Configuration Discord incomplète : impossible de répondre à l'interaction.",
          flags: 64,
        },
      });
    }

    const cachedEntry = getCachedCompareAnalysis(clanTag);
    const shouldFetch = action === "compare_refresh" || !cachedEntry;

    if (!shouldFetch) {
      const isWarPeriod = await computeCalendarIsWarPeriod(
        clanTag,
        cachedEntry.data,
      );
      const observedAt = await formatParisObservationTime(
        new Date(cachedEntry.cachedAt),
      );
      return res.status(200).json({
        type: 7,
        data: buildComparePayload({
          data: cachedEntry.data,
          resolved,
          clanVal,
          sortMode,
          isWarPeriod,
          observedAt,
        }),
      });
    }

    res.status(200).json({ type: 6 });

    runBackground(async () => {
      let data = cachedEntry?.data;
      let cachedAt = cachedEntry?.cachedAt;
      const endpoint = `${TRUST_ROYALE_URL}/api/clan/${encodeURIComponent(
        clanTag,
      )}/analysis?includeRaceGroup=true&includeTopPlayers=false&includeUncomplete=false&fast=true&force=true`;
      const abortCtrl = new AbortController();
      const abortTimer = setTimeout(() => abortCtrl.abort(), 15000);
      try {
        const apiResp = await fetch(endpoint, {
          headers: { Accept: "application/json" },
          signal: abortCtrl.signal,
        });
        if (!apiResp.ok) {
          await fetch(originalWebhookUrl, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Erreur API (${apiResp.status}). Réessayez dans quelques instants.`,
            }),
          });
          return;
        }
        data = await apiResp.json();
        cachedAt = setCachedCompareAnalysis(clanTag, data);
      } catch (err) {
        const message =
          err?.name === "AbortError"
            ? "⏱️ Le rafraîchissement a pris trop de temps. Réessayez."
            : `Erreur : ${err?.message || "inconnue"}`;
        await fetch(originalWebhookUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: message }),
        });
        return;
      } finally {
        clearTimeout(abortTimer);
      }

      const isWarPeriod = await computeCalendarIsWarPeriod(clanTag, data);
      const observedAt = await formatParisObservationTime(new Date(cachedAt));
      await fetch(originalWebhookUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(
          buildComparePayload({
            data,
            resolved,
            clanVal,
            sortMode,
            isWarPeriod,
            observedAt,
          }),
        ),
      });
    });

    return;
  }

  // ── MessageComponent : bouton refresh /clan ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("clan_refresh:")
  ) {
    const parts = body.data.custom_id.split(":");
    const tag = (parts[1] || "").toUpperCase();
    if (!tag) {
      return res
        .status(200)
        .json({ type: 4, data: { content: "Erreur interne.", flags: 64 } });
    }

    const FAMILY_NAME_BY_TAG = {
      Y8JUPC9C: "La Resistance",
      LRQP20V9: "Les Resistants",
      QU9UQJRL: "Les Revoltes",
    };
    const resolved = { tag, name: FAMILY_NAME_BY_TAG[tag] ?? `#${tag}` };

    const webhookUrl = buildDiscordWebhookUrl(body);
    const originalWebhookUrl = webhookUrl
      ? `${webhookUrl}/messages/@original`
      : null;

    if (!originalWebhookUrl) {
      return res.status(200).json({
        type: 4,
        data: {
          content:
            "Configuration Discord incomplète : impossible de répondre à l'interaction.",
          flags: 64,
        },
      });
    }

    // Pas de cache pour /clan : toujours un recalcul complet, comme la commande initiale
    res.status(200).json({ type: 6 });

    runBackground(async () => {
      const payload = await buildClanReportPayload(resolved);
      const patchBody =
        payload.kind === "success"
          ? { embeds: payload.embeds, components: payload.components }
          : { content: payload.content, embeds: [], components: [] };

      const r = await fetch(originalWebhookUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.error(
          `[clan_refresh] PATCH Discord HTTP ${r.status}:`,
          txt.slice(0, 300),
        );
      }
    });

    return;
  }
}
