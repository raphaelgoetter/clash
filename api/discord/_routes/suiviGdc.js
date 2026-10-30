// Suivi GDC des membres (staff) : /promote, /demote, /chelem, /fail,
// /late, /late-ping, /top-players, /recap, et leurs boutons.
//
// Routage extrait de api/discord/interactions.js : chaque bloc répond à
// Discord via `res` s'il reconnaît l'interaction, sinon la fonction rend
// la main sans rien envoyer et le routeur essaie le module suivant.

import { getDiscordLinks } from "../../../backend/services/discordLinks.js";
import { loadSnapshots } from "../../../backend/services/snapshot.js";
import {
  toPublicSeasonId,
  toPublicWeekId,
} from "@clash/clash-royale/dateUtils.js";
import { fetchRaceLog } from "@clash/clash-royale/clashApi.js";
import { loadClanCache } from "../../../backend/services/clanCache.js";
import {
  runBackground,
  TRUST_ROYALE_URL,
  trustPlayerUrl,
  trustClanUrl,
  buildDiscordWebhookUrl,
  RELIABILITY_ICON,
  formatParisObservationTime,
  mapWithConcurrency,
  parseBattleTimestamp,
  normalizeClanTag,
} from "../_lib/commun.js";

// Badge d'historique de /fail en émojis standards : les émojis personnalisés
// de deckUsageBadge() (~29 caractères chacun) font déborder la description.
function failDeckBadge(decksUsed, ignored, maxDecks = 16) {
  if (ignored) return "⚪";
  if (decksUsed >= maxDecks) return "🟢";
  if (decksUsed >= maxDecks - 4) return "🟡";
  return "🔴";
}

// ============================================================
// /recap — récap GDC saison passée (bottom 10 La Resistance / top 10 Les
// Resistants). Source des points : raceLog brut (participants de chaque
// semaine terminée), pas warHistory — voir plan pour la justification
// (raceLog validé identique aux snapshots sur 8 semaines de recoupement,
// et plus complet à l'instant T).
// ============================================================

const RECAP_CLANS = {
  clan1: { tag: "Y8JUPC9C", name: "La Resistance" },
  clan2: { tag: "LRQP20V9", name: "Les Resistants" },
};

// L'API riverracelog ne renvoie que les 10 dernières semaines terminées, sans
// pagination possible (limite dure de l'API Clash Royale, testée en live) —
// ça couvre au mieux 2 saisons pleines, donc /recap ne propose que -1/-2.
async function resolveRecapSeasonId(raceLog, currentRace, offset) {
  const { computeCurrentSeasonId } =
    await import("@clash/clash-royale/dateUtils.js");
  const currentSeasonId = computeCurrentSeasonId(currentRace, raceLog);
  const seasonCounts = {};
  for (const r of raceLog) {
    seasonCounts[r.seasonId] = (seasonCounts[r.seasonId] || 0) + 1;
  }
  const sortedSeasons = Object.keys(seasonCounts)
    .map(Number)
    .sort((a, b) => b - a);
  const currentSeasonIsComplete =
    currentSeasonId && (seasonCounts[currentSeasonId] ?? 0) >= 4;
  const completedSeasons = sortedSeasons.filter(
    (sid) =>
      (seasonCounts[sid] ?? 0) >= 4 &&
      (sid !== currentSeasonId || currentSeasonIsComplete),
  );
  return completedSeasons[offset - 1] ?? null;
}

function aggregateRecapSeasonStats(raceLog, seasonId, clanTag) {
  const weeks = raceLog.filter((r) => r.seasonId === seasonId);
  const totals = new Map();
  for (const w of weeks) {
    const standing = (w.standings || []).find(
      (s) => s.clan?.tag?.toUpperCase() === `#${clanTag}`,
    );
    for (const p of standing?.clan?.participants ?? []) {
      const tag = p.tag?.toUpperCase();
      if (!tag) continue;
      const entry = totals.get(tag) ?? { fame: 0, decksUsed: 0 };
      entry.fame += Number(p.fame) || 0;
      entry.decksUsed += Number(p.decksUsed) || 0;
      totals.set(tag, entry);
    }
  }
  return totals;
}

// Récupère + agrège les données d'un clan pour la saison ciblée, et
// sélectionne les 10 membres actuels les plus extrêmes sur pointsSaison
// (direction "asc" = les plus faibles, "desc" = les plus élevés). Cette
// sélection initiale est figée : les boutons de tri ne font ensuite que
// réordonner ces mêmes 10 joueurs (voir buildRecapRows).
async function buildRecapClanSection(
  clanTag,
  clanFallbackName,
  seasonOffset,
  direction,
  applyMinDecksFilter,
) {
  const { fetchCurrentRace } =
    await import("@clash/clash-royale/clashApi.js");

  const [raceLog, currentRace] = await Promise.all([
    fetchRaceLog(`#${clanTag}`),
    fetchCurrentRace(`#${clanTag}`).catch(() => null),
  ]);

  const seasonId = await resolveRecapSeasonId(
    raceLog,
    currentRace,
    seasonOffset,
  );
  if (!seasonId) {
    return {
      seasonId: null,
      clanName: clanFallbackName,
      members: [],
      excluded: [],
      raceLogUnavailable: false,
    };
  }

  const totals = aggregateRecapSeasonStats(raceLog, seasonId, clanTag);

  const endpoint = `${TRUST_ROYALE_URL}/api/clan/${encodeURIComponent(clanTag)}/analysis?fast=true`;
  const apiResp = await fetch(endpoint, {
    headers: { Accept: "application/json" },
  });
  if (!apiResp.ok) {
    throw new Error(`Erreur API clan ${clanFallbackName} (${apiResp.status})`);
  }
  const data = await apiResp.json();
  const currentMembers = Array.isArray(data.members) ? data.members : [];

  // En dessous de 16 decks (une semaine complète), l'échantillon est trop
  // faible pour être classé équitablement — exclus du classement, mais
  // listés au footer. Les membres à 0 deck (pas présents cette saison-là)
  // sont silencieusement ignorés : ils n'ont simplement pas participé.
  // Uniquement pertinent pour le bottom scoreurs (clan1) — un top scoreur
  // avec aussi peu de decks n'apparaîtrait de toute façon jamais en tête.
  const MIN_DECKS_FOR_RANKING = 16;
  const merged = [];
  const excluded = [];
  for (const m of currentMembers) {
    const tag = String(m.tag || "").toUpperCase();
    const totalsEntry = totals.get(tag);
    const decksJoues = totalsEntry?.decksUsed ?? 0;
    if (applyMinDecksFilter && decksJoues < MIN_DECKS_FOR_RANKING) {
      if (decksJoues > 0) excluded.push(m.name);
      continue;
    }
    if (!decksJoues) continue; // pas de deck joué cette saison-là → pas de classement possible
    merged.push({
      tag,
      name: m.name,
      isNew: !!m.isNew,
      reliability: m.reliability,
      color: m.color,
      discord: !!m.discord,
      pointsSaison: totalsEntry.fame,
      decksJoues,
      pointsPerDeck: Math.round(totalsEntry.fame / decksJoues),
    });
  }

  merged.sort((a, b) =>
    direction === "asc"
      ? a.pointsSaison - b.pointsSaison
      : b.pointsSaison - a.pointsSaison,
  );

  return {
    seasonId,
    clanName: data.clan?.name || clanFallbackName,
    members: merged.slice(0, 10),
    excluded,
    raceLogUnavailable: !!data.raceLogUnavailable,
  };
}

async function buildRecapData(seasonOffset) {
  const [clan1, clan2] = await Promise.all([
    buildRecapClanSection(
      RECAP_CLANS.clan1.tag,
      RECAP_CLANS.clan1.name,
      seasonOffset,
      "asc",
      true,
    ),
    buildRecapClanSection(
      RECAP_CLANS.clan2.tag,
      RECAP_CLANS.clan2.name,
      seasonOffset,
      "desc",
      false,
    ),
  ]);
  const seasonId = clan1.seasonId ?? clan2.seasonId;
  const observedAt = await formatParisObservationTime();
  return { clan1, clan2, seasonId, observedAt };
}

const RECAP_DISCORD_LINK_EMOJI = "<:discord:1526507049779990601>";

// Indentation visuelle de la 2e ligne (2 espaces normaux sont collapsés par
// certains rendus) — Braille Pattern Blank, largeur visible non collapsée.
const RECAP_INDENT = "⠀⠀";

// Réordonne (sans jamais resélectionner) les 10 membres déjà choisis, selon
// la métrique active — le plus faible/pire de la métrique termine toujours
// en bas de liste (idx le plus élevé), que ce soit clan1 (pires) ou clan2
// (meilleurs) : direction "desc" place les plus forts en tête, "asc" les
// plus faibles en tête.
function buildRecapRows(members, sortMode, direction, reliabilityUnavailable) {
  const metricOf = (m) => {
    if (sortMode === "pointsPerDeck") {
      return Number.isFinite(m.pointsPerDeck) ? m.pointsPerDeck : -1;
    }
    if (sortMode === "decksUsed") return m.decksJoues ?? 0;
    return m.pointsSaison ?? 0;
  };

  const sorted = [...members].sort((a, b) => {
    const diff = metricOf(a) - metricOf(b);
    return direction === "asc" ? diff : -diff;
  });

  const fmt = (n) => (Number.isFinite(n) ? n.toLocaleString("fr-FR") : "—");

  return sorted.map((m, idx) => {
    const rank = idx + 1;
    const newIcon = m.isNew ? " 🆕" : "";

    const statParts = [];
    if (!reliabilityUnavailable && Number.isFinite(m.reliability)) {
      const icon = RELIABILITY_ICON[m.color] ?? "⚪";
      statParts.push(`${icon} ${Math.round(m.reliability)}%`);
    }
    statParts.push(`🏆 ${fmt(m.pointsSaison)}`);
    statParts.push(`⚡ ${fmt(m.pointsPerDeck)}`);
    statParts.push(`<:cards:1493711279121104926> ${m.decksJoues}`);
    if (m.discord) statParts.push(RECAP_DISCORD_LINK_EMOJI);

    return (
      `${rank}. [${m.name}](${trustPlayerUrl(m.tag)})${newIcon}\n` +
      `${RECAP_INDENT}${statParts.join(" · ")}`
    );
  });
}

function buildRecapComponents(seasonOffset, sortMode) {
  const pointsSaisonActive = sortMode === "pointsSaison";
  const pointsDeckActive = sortMode === "pointsPerDeck";
  const decksActive = sortMode === "decksUsed";

  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: pointsSaisonActive ? 3 : 1,
          label: "🏆 Points/saison",
          custom_id: `recap_sort:${seasonOffset}:pointsSaison`,
          disabled: pointsSaisonActive,
        },
        {
          type: 2,
          style: pointsDeckActive ? 3 : 1,
          label: "⚡ Points/deck",
          custom_id: `recap_sort:${seasonOffset}:pointsPerDeck`,
          disabled: pointsDeckActive,
        },
        {
          type: 2,
          style: decksActive ? 3 : 1,
          label: "🎮 Decks joués",
          custom_id: `recap_sort:${seasonOffset}:decksUsed`,
          disabled: decksActive,
        },
        {
          type: 2,
          style: 2,
          label: "🔄",
          custom_id: `recap_refresh:${seasonOffset}:${sortMode}`,
          disabled: false,
        },
      ],
    },
  ];
}

function buildRecapFooter({ seasonId, observedAt, clan1, clan2 }) {
  const suffix = observedAt ? ` Fait le ${observedAt}.` : "";
  let text = `Récapitulatif Saison S${toPublicSeasonId(seasonId)}.${suffix}`;

  const MAX_NAMES_PER_CLAN = 10;
  const excludedGroups = [clan1, clan2]
    .filter((c) => Array.isArray(c.excluded) && c.excluded.length > 0)
    .map((c) => {
      const shown = c.excluded.slice(0, MAX_NAMES_PER_CLAN).join(", ");
      const extra =
        c.excluded.length > MAX_NAMES_PER_CLAN
          ? ` +${c.excluded.length - MAX_NAMES_PER_CLAN}`
          : "";
      return `${c.clanName} : ${shown}${extra}`;
    });

  if (excludedGroups.length) {
    text += `\nExclus car moins de 16 decks joués — ${excludedGroups.join(" · ")}.`;
  }

  if (clan1.raceLogUnavailable || clan2.raceLogUnavailable) {
    text +=
      "\n⚠️ Fiabilité indisponible temporairement pour " +
      [
        clan1.raceLogUnavailable && clan1.clanName,
        clan2.raceLogUnavailable && clan2.clanName,
      ]
        .filter(Boolean)
        .join(" et ") +
      " (données partielles) — réessaie dans quelques instants.";
  }

  return text;
}

// Utilise `description` (limite 4096) plutôt que des `fields` (limite 1024
// chacun) : avec lien Vercel + emoji custom par ligne, 10 lignes dépassent
// facilement 1024 caractères (voir AGENTS.md — règle description vs fields).
function buildRecapPayload({
  clan1,
  clan2,
  seasonId,
  sortMode,
  seasonOffset,
  observedAt,
}) {
  // "desc" pour les 2 : le meilleur de chaque groupe en tête, le pire tout en
  // bas — pour clan1 (bottom scoreurs), ça place le plus faible (le vrai
  // problème) en dernière ligne, la plus visible.
  const clan1Rows = buildRecapRows(
    clan1.members,
    sortMode,
    "desc",
    clan1.raceLogUnavailable,
  );
  const clan2Rows = buildRecapRows(
    clan2.members,
    sortMode,
    "desc",
    clan2.raceLogUnavailable,
  );

  const description =
    `**${clan1.clanName} (bottom scoreurs) :**\n` +
    (clan1Rows.length ? clan1Rows.join("\n") : "Aucune donnée.") +
    "\n\n" +
    `**${clan2.clanName} (top scoreurs) :**\n` +
    (clan2Rows.length ? clan2Rows.join("\n") : "Aucune donnée.");

  return {
    embeds: [
      {
        title: `<:stats:1499284927894650950> Récap GDC : saison S${toPublicSeasonId(seasonId)}`,
        color: 0x5865f2,
        description,
        footer: {
          text: buildRecapFooter({ seasonId, observedAt, clan1, clan2 }),
        },
      },
    ],
    components: buildRecapComponents(seasonOffset, sortMode),
  };
}

const RECAP_CACHE_TTL_MS = 60 * 1000;

const recapCache = new Map();

function getCachedRecapData(seasonOffset) {
  const key = String(seasonOffset);
  const entry = recapCache.get(key);
  if (!entry) return null;
  if (Date.now() - entry.cachedAt > RECAP_CACHE_TTL_MS) {
    recapCache.delete(key);
    return null;
  }
  return entry.data;
}

function setCachedRecapData(seasonOffset, data) {
  recapCache.set(String(seasonOffset), { cachedAt: Date.now(), data });
}

const ROLE_FR = {
  leader: "chef",
  coleader: "chef adjoint",
  coLeader: "chef adjoint",
  elder: "aîné",
  member: "membre",
};

function formatDiscordRole(role) {
  const normalized = String(role || "member")
    .trim()
    .toLowerCase();
  return `(${ROLE_FR[normalized] ?? ROLE_FR.member})`;
}

function formatDiscordRoleWithTiming(role, timingLabels = []) {
  const normalized = String(role || "member")
    .trim()
    .toLowerCase();
  const parts = [ROLE_FR[normalized] ?? ROLE_FR.member, ...timingLabels];
  return `(${parts.join(" · ")})`;
}

function normalizeTag(tag) {
  return String(tag || "")
    .toUpperCase()
    .replace(/^#/, "");
}

async function readClanCacheMembers(clanTag) {
  const data = await loadClanCache(clanTag);
  const members = Array.isArray(data?.members) ? data.members : [];
  return new Map(
    members.map((member) => [
      normalizeTag(member.tag),
      {
        name: member.name || normalizeTag(member.tag),
        role: member.role || "member",
        tag: member.tag || `#${normalizeTag(member.tag)}`,
        arrivalStreakInCurrentClan: member.arrivalStreakInCurrentClan,
        arrivalTotalWeeks: member.arrivalTotalWeeks,
        firstSeenAt: member.firstSeenAt,
      },
    ]),
  );
}

const FAIL_WAR_DAY_LABELS = [
  "Jeudi (J1)",
  "Vendredi (J2)",
  "Samedi (J3)",
  "Dimanche (J4)",
];

const FAIL_WAR_DAY_SHORT_LABELS = ["J1", "J2", "J3", "J4"];

function isWarDayPeriod(currentRace) {
  return (
    currentRace?.periodType === "warDay" ||
    currentRace?.periodType === "colosseum" ||
    currentRace?.state === "warDay" ||
    currentRace?.state === "overtime" ||
    currentRace?.state === "full"
  );
}

const LATE_TAG_FOOTER_LEGEND =
  "Légende tags : in-extremis = dernière heure avant reset";

function buildRaceTimeHistogram(entries, resetUtcMinutes = 580) {
  const counts = Array(24).fill(0);

  for (const b of entries || []) {
    if (!/riverRace/i.test(String(b?.type || ""))) continue;
    const parsed = parseBattleTimestamp(
      b?.battleTime ||
        b?.battleTimeStamp ||
        b?.battle_time ||
        b?.battleTimeStampLocal,
    );
    if (!parsed || Number.isNaN(parsed.getTime())) continue;

    const minutes = parsed.getUTCHours() * 60 + parsed.getUTCMinutes();
    const offset = (((minutes - resetUtcMinutes) % 1440) + 1440) % 1440;
    const bin = Math.floor(offset / 60);
    counts[bin] += 1;
  }

  return counts;
}

function computeRaceTimeTagLabels(counts) {
  const tags = [];
  if ((counts?.[23] || 0) > 0) {
    tags.push("in-extremis");
  }
  return tags;
}

async function buildLateTimingTagsByPlayer(playerTags) {
  const cleanTags = [...new Set(playerTags.map((t) => String(t || "").trim()))]
    .filter(Boolean)
    .map((t) => (t.startsWith("#") ? t : `#${t}`));
  const byTag = new Map();

  await mapWithConcurrency(cleanTags, 8, async (rawTag) => {
    const cleanTag = rawTag.replace(/^#/, "").toUpperCase();
    const abortCtrl = new AbortController();
    const abortTimer = setTimeout(() => abortCtrl.abort(), 4500);
    try {
      const apiResp = await fetch(
        `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(cleanTag)}/analysis`,
        {
          headers: { Accept: "application/json" },
          signal: abortCtrl.signal,
        },
      );
      if (!apiResp.ok) return;

      const data = await apiResp.json();
      const resetUtcMinutes = Number.isFinite(data?.warResetUtcMinutes)
        ? data.warResetUtcMinutes
        : 580;
      const counts = buildRaceTimeHistogram(
        data?.battleLog || [],
        resetUtcMinutes,
      );
      const labels = computeRaceTimeTagLabels(counts);
      if (labels.length > 0) {
        byTag.set(`#${cleanTag}`, labels);
      }
    } catch {
      // best effort : on garde la commande fonctionnelle sans ces tags
    } finally {
      clearTimeout(abortTimer);
    }
  });

  return byTag;
}

function buildLateSummary(participants, currentMembers, maxSlots = 50) {
  // Slots GDC : maximum 50 slots par journée. Un joueur occupe un slot dès
  // qu'il joue au moins 1 deck aujourd'hui, même s'il quitte le clan plus
  // tard pendant la même journée.
  const currentMemberTags = new Set(currentMembers.map((m) => m.tag));
  const currentMemberByTag = new Map(
    currentMembers.map((m) => [(m.tag || "").toUpperCase(), m]),
  );
  const currentParticipants = participants.filter((p) =>
    currentMemberTags.has(p.tag),
  );
  const totalPlayed = participants.reduce(
    (sum, p) => sum + (p.decksUsedToday ?? 0),
    0,
  );
  const slotsOccupied = participants.filter(
    (p) => (p.decksUsedToday ?? 0) > 0,
  ).length;
  const slotsAvailable = Math.max(0, maxSlots - slotsOccupied);
  const exClanPlayedToday = participants
    .filter((p) => !currentMemberTags.has(p.tag) && (p.decksUsedToday ?? 0) > 0)
    .sort(
      (a, b) =>
        (b.decksUsedToday ?? 0) - (a.decksUsedToday ?? 0) ||
        a.name.localeCompare(b.name, "fr"),
    );

  return {
    currentMemberTags,
    currentMemberByTag,
    currentParticipants,
    totalPlayed,
    slotsOccupied,
    slotsAvailable,
    exClanPlayedToday,
  };
}

function buildLateComponents(clanVal) {
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          label: "🔄 Rafraîchir",
          custom_id: `late_refresh:${clanVal}`,
          disabled: false,
        },
      ],
    },
  ];
}

async function buildLateReportPayload(resolved, clanVal) {
  // Helper : race une promise contre un timeout
  const withTimeout = (promise, ms, label) =>
    Promise.race([
      promise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error(`Timeout ${label} (${ms}ms)`)), ms),
      ),
    ]);

  try {
    console.log("[/late] start, clan:", resolved.tag);
    const { fetchCurrentRace, fetchClanMembers } =
      await import("@clash/clash-royale/clashApi.js");
    console.log("[/late] import OK");

    const [race, currentMembers, links] = await withTimeout(
      Promise.all([
        fetchCurrentRace(`#${resolved.tag}`),
        fetchClanMembers(`#${resolved.tag}`),
        getDiscordLinks(),
      ]),
      20000,
      "fetch initial",
    );

    const participants = race?.clan?.participants ?? [];

    const { warResetOffsetMs } =
      await import("@clash/clash-royale/dateUtils.js");
    const resetUtcMs = warResetOffsetMs(resolved.tag);
    // Garde calendaire : hors jeu–dim (après reset lundi), jamais en mode GDC
    // même si l'API retourne encore periodType='warDay' transitoirement.
    // periodIndex n'est PAS utilisé : il est cumulatif sur la saison et
    // n'indique pas à lui seul l'état de la GDC.
    const _gdcDow = new Date(Date.now() - resetUtcMs).getUTCDay();
    const isCalendarWarDay = _gdcDow === 0 || _gdcDow >= 4;
    const isWarDay =
      isCalendarWarDay &&
      (race?.periodType === "warDay" ||
        race?.state === "warDay" ||
        race?.state === "overtime" ||
        race?.state === "full");

    // Hors journée de GDC : afficher un message explicite et ne rien calculer
    if (!isWarDay) {
      return {
        kind: "no-war-day",
        content: `<:cards:1493711279121104926> **${resolved.name}** — Aucune journée de GDC en cours (période d'entraînement).`,
      };
    }

    // Récupération éventuelle des statuts isNew/isFamilyTransfer pour /late
    // Timeout court (10s) car ces annotations sont facultatives — le /late doit
    // impérativement s'exécuter en moins de 60s (limite Vercel, fonction interactions.js).
    const analysisMap = new Map();
    try {
      const abortCtrl = new AbortController();
      const abortTimer = setTimeout(() => abortCtrl.abort(), 10000);
      const apiResp = await fetch(
        `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(resolved.tag)}/analysis`,
        {
          headers: { Accept: "application/json" },
          signal: abortCtrl.signal,
        },
      );
      clearTimeout(abortTimer);
      if (apiResp.ok) {
        const analysis = await apiResp.json();
        (analysis.members || []).forEach((m) => {
          if (m?.tag) analysisMap.set((m.tag || "").toUpperCase(), m);
        });
      }
    } catch (err) {
      // ignore, annotations sont facultatives
    }

    const {
      currentMemberTags,
      currentMemberByTag,
      currentParticipants,
      totalPlayed,
      slotsOccupied,
      slotsAvailable,
      exClanPlayedToday,
    } = buildLateSummary(participants, currentMembers);

    // Joueurs en retard : membres actuels qui n'ont pas encore joué leurs 4 decks du jour
    const late = participants
      .filter(
        (p) => currentMemberTags.has(p.tag) && (p.decksUsedToday ?? 0) < 4,
      )
      .map((p) => ({ ...p, missing: 4 - (p.decksUsedToday ?? 0) }))
      .sort(
        (a, b) => b.missing - a.missing || a.name.localeCompare(b.name, "fr"),
      );

    const lateTimingTagsByTag = await buildLateTimingTagsByPlayer(
      late.map((pl) => pl.tag),
    );

    // Pseudos Discord — timeout 10s, non-bloquant (pings optionnels)
    const guildId = process.env.DISCORD_GUILD_ID;
    const botToken = process.env.DISCORD_TOKEN;
    let guildMembers = [];
    try {
      const guildRes = await withTimeout(
        fetch(
          `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`,
          { headers: { Authorization: `Bot ${botToken}` } },
        ),
        10000,
        "guild members",
      );
      guildMembers = guildRes.ok ? await guildRes.json() : [];
    } catch {
      // pings Discord optionnels — on continue sans eux
    }
    const memberById = new Map(guildMembers.map((m) => [m.user?.id, m]));

    // Heure de Paris au moment de la commande
    const now = new Date();
    const p = new Date(
      now.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
    );
    const parisTime = `${String(p.getHours()).padStart(2, "0")}h${String(p.getMinutes()).padStart(2, "0")}`;

    const msOfDayUtc =
      now.getUTCHours() * 3600000 + now.getUTCMinutes() * 60000;
    if (msOfDayUtc < resetUtcMs) p.setDate(p.getDate() - 1);
    const WAR_DAY_LABELS = {
      4: "Jeudi (J1)",
      5: "Vendredi (J2)",
      6: "Samedi (J3)",
      0: "Dimanche (J4)",
    };
    const warDayLabel = WAR_DAY_LABELS[p.getDay()] ?? "Jour de GDC";

    // Decks déjà joués aujourd'hui par tous les participants de la course
    // et slots occupés par ceux qui ont déjà joué au moins un combat.

    // Points du jour uniquement pour GDC classique (warDay).
    // Après le reset (msOfDayUtc >= resetUtcMs) : p.fame est déjà remis à zéro
    // par l'API → on l'utilise directement sans soustraction.
    // Avant le reset : p.fame est cumulatif sur la semaine → on soustrait la fame
    // cumulée du dernier snapshot (veille) pour obtenir uniquement la fame du jour.
    // Pour Colisée, la fame est toujours cumulative → on l'affiche telle quelle.
    const isAfterReset = msOfDayUtc >= resetUtcMs;
    const prevCumulByTag = new Map();
    if (isWarDay && !isAfterReset) {
      const pad2 = (n) => String(n).padStart(2, "0");
      // p a déjà été ajusté (setDate -1) donc correspond au jour GDC courant
      const realDayToday = `${p.getFullYear()}-${pad2(p.getMonth() + 1)}-${pad2(p.getDate())}`;
      try {
        const snapData = await loadSnapshots(resolved.tag);
        if (Array.isArray(snapData)) {
          // _cumulFame est cumulatif sur toute la semaine GDC : on prend
          // le dernier snapshot du jour GDC précédent (realDay < realDayToday
          // où realDayToday est la date GDC du jour courant, corrigée pré-reset).
          // Note : l'écart de ~400 pts est inévitable car le snapshot est pris
          // ~37 min avant le reset (pas exactement à 09h54 UTC).
          const allDays = snapData.flatMap((w) => w.days ?? []);
          const prevDay = allDays
            .filter(
              (d) =>
                d.realDay &&
                d.realDay < realDayToday &&
                d._cumulFame &&
                Object.keys(d._cumulFame).length > 0,
            )
            .sort((a, b) => b.realDay.localeCompare(a.realDay))[0];
          if (prevDay?._cumulFame) {
            // Vérifier que prevDay est bien le jour calendaire immédiatement avant
            // realDayToday. Sur J1, le dernier snapshot disponible est celui de J4
            // de la semaine précédente → la soustraction serait fausse (elle donnerait
            // ~400 pts au lieu des vrais points J1).
            const realDayTodayMs = new Date(
              realDayToday + "T00:00:00Z",
            ).getTime();
            const prevDayExpected = new Date(realDayTodayMs - 86400000)
              .toISOString()
              .slice(0, 10);
            if (prevDay.realDay === prevDayExpected) {
              for (const [tag, fame] of Object.entries(prevDay._cumulFame)) {
                prevCumulByTag.set(tag, fame ?? 0);
              }
            }
          }
        }
      } catch (_) {
        // snapshot indisponible — on affichera la fame hebdomadaire (dégradé acceptable)
      }
    }

    const totalFame = currentParticipants.reduce((sum, pl) => {
      const rawFame = pl.fame ?? 0;
      const plTag = pl.tag.startsWith("#") ? pl.tag : `#${pl.tag}`;
      const todayFame =
        isWarDay && !isAfterReset
          ? Math.max(0, rawFame - (prevCumulByTag.get(plTag) ?? 0))
          : rawFame;
      return sum + todayFame;
    }, 0);

    // Decks manquants (pré-calculé)
    const totalMissing = late.reduce((sum, pl) => sum + pl.missing, 0);
    const hideDetails = totalMissing > 100;

    // Attaques bateaux (cumul)
    const boatAttackers = currentParticipants.filter(
      (pl) => (pl.boatAttacks ?? 0) > 0,
    );
    const totalBoatAttacks = boatAttackers.reduce(
      (sum, pl) => sum + (pl.boatAttacks ?? 0),
      0,
    );
    const boatNames = boatAttackers
      .map((pl) => {
        const plTag = pl.tag.startsWith("#") ? pl.tag : `#${pl.tag}`;
        const playerUrl = trustPlayerUrl(plTag);
        return `[${pl.name}](${playerUrl})`;
      })
      .join(", ");

    // Construction de la liste par groupe
    const lateHeader =
      late.length === 0
        ? `Aucun joueur en retard à ${parisTime}`
        : `- ${late.length} joueur${late.length > 1 ? "s" : ""} en retard à ${parisTime}`;
    const descLines = [
      lateHeader,
      `- ${totalPlayed} deck${totalPlayed > 1 ? "s" : ""} joué${totalPlayed > 1 ? "s" : ""}`,
      `- ${slotsOccupied} slots occupés`,
    ];
    if (late.length > 0) {
      descLines.push(
        `- ${totalMissing} deck${totalMissing > 1 ? "s" : ""} manquant${totalMissing > 1 ? "s" : ""}`,
      );
    }
    if (totalBoatAttacks > 0) {
      descLines.push(
        `- ${totalBoatAttacks} attaque${totalBoatAttacks > 1 ? "s" : ""} bateau (cumul) (${boatNames})`,
      );
    }

    if (hideDetails) {
      descLines.push(
        "",
        "Pas de liste détaillée car il y a plus de 100 decks manquants",
      );
    } else {
      for (const count of [4, 3, 2, 1]) {
        const group = late.filter((pl) => pl.missing === count);
        if (!group.length) continue;
        descLines.push("");
        descLines.push(`**Manque ${count} deck${count > 1 ? "s" : ""}**`);
        for (const pl of group) {
          const tag = pl.tag.startsWith("#") ? pl.tag : `#${pl.tag}`;
          const playerUrl = trustPlayerUrl(tag);
          const memberInfo = currentMemberByTag.get(tag.toUpperCase());
          const role = (memberInfo?.role || "member").toLowerCase();
          const timingLabels = lateTimingTagsByTag.get(tag.toUpperCase()) || [];
          const roleText = formatDiscordRoleWithTiming(role, timingLabels);
          const discordId = links[tag];
          const guildMember = discordId ? memberById.get(discordId) : null;
          const discordPart = guildMember ? ` <@${discordId}>` : "";
          const memberAnalysis = analysisMap.get(tag.toUpperCase()) || {};
          const newTag = memberAnalysis.isNew ? " 🆕" : "";
          descLines.push(
            `• [${pl.name}](${playerUrl})${newTag} ${roleText}${discordPart}`,
          );
        }
      }
    }

    if (exClanPlayedToday.length > 0) {
      descLines.push("");
      descLines.push("**Anciens participants joués aujourd'hui**");
      for (const pl of exClanPlayedToday) {
        const tag = pl.tag.startsWith("#") ? pl.tag : `#${pl.tag}`;
        const playerUrl = trustPlayerUrl(tag);
        const played = pl.decksUsedToday ?? 0;
        const discordId = links[tag];
        const guildMember = discordId ? memberById.get(discordId) : null;
        const discordPart = guildMember ? ` <@${discordId}>` : "";
        descLines.push(
          `• [${pl.name}](${playerUrl}) — ${played} deck${played > 1 ? "s" : ""}${discordPart}`,
        );
      }
    }

    // Discord limite les descriptions d'embed à 4096 caractères
    let description = descLines.join("\n");
    if (description.length > 4000) {
      console.warn(
        "[/late] description trop longue:",
        description.length,
        "chars, troncature",
      );
      description = description.slice(0, 3950) + "\n…*(liste tronquée)*";
    }

    const embed = {
      title: `<:late:1504138659622948985> ${resolved.name}, retardataires de ${warDayLabel}`,
      description,
      color: 0xe67e22,
    };
    if (!hideDetails) {
      embed.footer = { text: LATE_TAG_FOOTER_LEGEND };
    }

    console.log(
      "[/late] embed construit, late:",
      late.length,
      "descLen:",
      description.length,
    );

    return {
      kind: "success",
      embeds: [embed],
      components: buildLateComponents(clanVal),
    };
  } catch (err) {
    console.error("[/late] erreur:", err.message);
    return { kind: "error", content: `Erreur : ${err.message}` };
  }
}

let warClinchLogCache = null;

async function loadWarClinchLog() {
  if (warClinchLogCache) return warClinchLogCache;
  try {
    const { readFile } = await import("fs/promises");
    const { fileURLToPath } = await import("url");
    const { default: path } = await import("path");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const filePath = path.resolve(__dirname, "../../../data/war-clinch-log.json");
    const raw = await readFile(filePath, "utf-8");
    warClinchLogCache = JSON.parse(raw);
  } catch {
    warClinchLogCache = {};
  }
  return warClinchLogCache;
}

async function hasProvenEarlyWinByDay3(clanTag, weekId) {
  if (!weekId) return false;
  const log = await loadWarClinchLog();
  const key = `${normalizeClanTag(clanTag).replace("#", "")}:${weekId}`;
  return log?.[key]?.known === true && log?.[key]?.isClinched === true;
}

export async function routeSuiviGdc(body, res, { authorizedPingIds }) {
  // Commande /promote
  if (body.type === 2 && body.data?.name === "promote") {
    // parse options
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    if (!clanOpt?.value) {
      res.status(200).json({
        type: 4,
        data: {
          content: "Option obligatoire manquante : `clan`.",
          flags: 64,
        },
      });
      return;
    }
    const min = 2600;
    let clanVal = (clanOpt?.value || "1").toString().trim().toLowerCase();
    // Résoudre clan de façon synchrone (pas d'await) avant le type:5
    const CLAN_MAP = {
      1: { index: 0, name: "La Resistance", tag: "Y8JUPC9C" },
      la: { index: 0, name: "La Resistance", tag: "Y8JUPC9C" },
      2: { index: 1, name: "Les Resistants", tag: "LRQP20V9" },
      les: { index: 1, name: "Les Resistants", tag: "LRQP20V9" },
      3: { index: 2, name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];
    const clanName = resolved.name;
    const clanTag = resolved.tag;

    // defer response IMMÉDIATEMENT — avant tout await
    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const { fetchClanMembers } =
          await import("@clash/clash-royale/clashApi.js");
        const { computeTopPlayers } =
          await import("../../../backend/services/topplayers.js");
        // fetch clan members to get roles
        const members = await fetchClanMembers(`#${clanTag}`);
        const { fetchRaceLog } =
          await import("@clash/clash-royale/clashApi.js");
        const raceLog = await fetchRaceLog(`#${clanTag}`);
        const top = await computeTopPlayers(clanTag, members, [min], raceLog);
        let players = top.playersByQuota[min] || [];
        players = players.slice().sort((a, b) => b.fame - a.fame);

        // Déduire le weekId depuis le raceLog (première entrée = semaine précédente)
        const { computePrevWeekId } =
          await import("@clash/clash-royale/dateUtils.js");
        const weekId = computePrevWeekId(raceLog) || "S?";
        const earlyWinByDay3 = await hasProvenEarlyWinByDay3(clanTag, weekId);

        let description;
        if (players.length === 0) {
          description = earlyWinByDay3
            ? "Aucun joueur n'a atteint 2600 pts la semaine précédente car il y a eu une victoire anticipée dès le jour 3"
            : "Aucun joueur n'a atteint 2600 pts la semaine précédente.";
        } else {
          const rows = players.map((p, idx) => {
            const playerUrl = trustPlayerUrl(p.tag);
            const fameStr = Number.isFinite(p.fame)
              ? p.fame.toLocaleString("fr-FR")
              : "0";
            const normalizedRole = String(p.role || "member")
              .trim()
              .toLowerCase();
            const promotionMarker = normalizedRole === "member" ? "🔼 " : "";
            return `${idx + 1}. [${p.name}](${playerUrl}) · **${fameStr} pts** · ${promotionMarker}${formatDiscordRole(p.role)}`;
          });
          description = rows.join("\n");
        }
        const embed = {
          title: `<:victory:1504136468900352070> ${clanName} (scores ≥ ${min} pts)`,
          color: 0x5865f2,
          description,
          footer: {
            text: `Quota : ${min} · Semaine : ${toPublicWeekId(weekId)}`,
          },
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

  // Commande /top-players
  if (body.type === 2 && body.data?.name === "top-players") {
    const numberOpt = body.data.options?.find((o) => o.name === "number");
    const periodOpt = body.data.options?.find((o) => o.name === "period");

    const allowedNumbers = [3, 5, 10];
    const requestedNumber = Number(numberOpt?.value ?? 5) || 5;
    const limit = allowedNumbers.includes(requestedNumber)
      ? requestedNumber
      : 5;
    const period = (periodOpt?.value || "week").toString().toLowerCase();

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const { fetchRaceLog, fetchClanMembers, fetchCurrentRace } =
          await import("@clash/clash-royale/clashApi.js");

        const CLANS = [
          { name: "La Resistance", tag: "Y8JUPC9C" },
          { name: "Les Resistants", tag: "LRQP20V9" },
          { name: "Les Revoltes", tag: "QU9UQJRL" },
        ];

        const allMembers = new Map(); // tag -> { name, role, clan }
        const allTeams = [];

        let currentSeason = null;
        let defaultSeason = null; // determined from first clan race log, same logic as /chelem
        const clanRaceLogs = {};

        const {
          computeCurrentSeasonId,
          computeCurrentWeekId,
          computePrevWeekId,
        } = await import("@clash/clash-royale/dateUtils.js");

        // Récupère la course en cours pour détecter le rollover de saison (ex. S131→S132)
        let currentRaceRef = null;
        try {
          currentRaceRef = await fetchCurrentRace(`#${CLANS[0].tag}`);
        } catch (_) {
          // fallback : pas de détection de rollover
        }

        for (const clan of CLANS) {
          const [raceLog, members] = await Promise.all([
            fetchRaceLog(`#${clan.tag}`),
            fetchClanMembers(`#${clan.tag}`),
          ]);

          if (Array.isArray(raceLog) && raceLog.length > 0) {
            clanRaceLogs[clan.tag] = raceLog;

            if (currentSeason === null) {
              currentSeason = computeCurrentSeasonId(currentRaceRef, raceLog);
            }

            if (defaultSeason === null) {
              // Saison par défaut = la plus récente saison TERMINÉE.
              // On exclut la saison active (currentSeason) car elle est encore en cours.
              const localSeasonCounts = {};
              for (const week of raceLog) {
                const sid = week?.seasonId;
                if (sid == null) continue;
                localSeasonCounts[sid] = (localSeasonCounts[sid] || 0) + 1;
              }

              const sortedSeasons = Object.keys(localSeasonCounts)
                .map(Number)
                .sort((a, b) => b - a);
              defaultSeason =
                sortedSeasons.find(
                  (sid) => sid !== currentSeason && localSeasonCounts[sid] >= 4,
                ) ??
                sortedSeasons.find((sid) => sid !== currentSeason) ??
                sortedSeasons[0];
            }

            const lastWeek = raceLog[0];
            const standing = Array.isArray(lastWeek?.standings)
              ? lastWeek.standings.find(
                  (s) => s.clan?.tag?.toUpperCase() === `#${clan.tag}`,
                )
              : null;
            const participants = standing?.clan?.participants ?? [];

            // we will populate `allTeams` after accumulations.

            members.forEach((m) => {
              const normalized = m.tag?.toUpperCase?.() || "";
              if (!normalized) return;
              if (
                !allMembers.has(normalized) ||
                allMembers.get(normalized).clan === "La Resistance"
              ) {
                allMembers.set(normalized, {
                  name: m.name,
                  role: m.role || "member",
                  clan: clan.name,
                });
              }
            });
          }
        }

        // Build record for week mode.
        if (period === "week") {
          for (const clan of CLANS) {
            const raceLog = clanRaceLogs[clan.tag];
            const lastWeek =
              Array.isArray(raceLog) && raceLog.length > 0 ? raceLog[0] : null;
            const standing = Array.isArray(lastWeek?.standings)
              ? lastWeek.standings.find(
                  (s) => s.clan?.tag?.toUpperCase() === `#${clan.tag}`,
                )
              : null;
            const participants = standing?.clan?.participants ?? [];
            for (const p of participants) {
              const tag = p.tag?.toUpperCase?.() || "";
              // allMembers vient d'un fetch live (fetchClanMembers) : un tag
              // absent signifie que le joueur a quitté/été exclu du clan
              // depuis — on l'exclut du classement, comme déjà fait pour le
              // mode all-time ci-dessous.
              if (!tag || !allMembers.has(tag)) continue;
              const role = allMembers.get(tag)?.role || "member";
              allTeams.push({
                tag,
                name: p.name || "",
                clan: clan.name,
                role,
                fame: p.fame || 0,
              });
            }
          }
        }

        let title;
        let footer;
        let players = [];

        if (period === "season") {
          if (defaultSeason == null && currentSeason == null) {
            throw new Error("Impossible de trouver une saison dans les logs.");
          }

          const selectedSeason = defaultSeason;
          if (selectedSeason == null) {
            throw new Error("Impossible de déterminer la saison cible.");
          }

          title = `🏆 <:topplayers:1493708397407899648> Meilleurs joueurs sur toute la saison S${toPublicSeasonId(selectedSeason)}`;
          footer = `😎 Meilleurs joueurs de la saison précédente (S${toPublicSeasonId(selectedSeason)})`;

          const seasonTotals = new Map();

          for (const clan of CLANS) {
            const raceLog = clanRaceLogs[clan.tag];
            if (!Array.isArray(raceLog)) continue;
            const weeks = raceLog.filter((w) => w.seasonId === selectedSeason);
            for (const week of weeks) {
              const standing = Array.isArray(week.standings)
                ? week.standings.find(
                    (s) => s.clan?.tag?.toUpperCase() === `#${clan.tag}`,
                  )
                : null;
              const participants = standing?.clan?.participants ?? [];
              for (const p of participants) {
                const tag = p.tag?.toUpperCase?.() || "";
                // Même filtre que pour le mode week/all-time : exclure les
                // joueurs qui ne sont plus membres actuellement du clan.
                if (!tag || !allMembers.has(tag)) continue;
                const existing = seasonTotals.get(tag) || {
                  name: p.name || "",
                  fame: 0,
                };
                existing.name = existing.name || p.name || "";
                existing.fame += p.fame || 0;
                existing.clan = allMembers.get(tag)?.clan || clan.name;
                existing.role = allMembers.get(tag)?.role || "member";
                seasonTotals.set(tag, existing);
              }
            }
          }

          const seasonSorted = Array.from(seasonTotals.entries())
            .map(([tag, data]) => ({ tag, ...data }))
            .sort(
              (a, b) =>
                b.fame - a.fame ||
                a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
            );
          if (seasonSorted.length <= limit) {
            players = seasonSorted;
          } else {
            const cutoffFame = seasonSorted[limit - 1].fame;
            players = seasonSorted.filter((p) => p.fame >= cutoffFame);
          }
        } else if (period === "all-time") {
          title = `<:topplayers:1493708397407899648> Meilleurs joueurs`;
          footer = "📆 Sur tout la période fournie par l'API (10 semaines max)";

          const allTimeTotals = new Map();

          for (const clan of CLANS) {
            const raceLog = clanRaceLogs[clan.tag];
            if (!Array.isArray(raceLog)) continue;
            for (const week of raceLog) {
              const standing = Array.isArray(week.standings)
                ? week.standings.find(
                    (s) => s.clan?.tag?.toUpperCase() === `#${clan.tag}`,
                  )
                : null;
              const participants = standing?.clan?.participants ?? [];
              const weekId =
                week?.seasonId != null && week?.sectionIndex != null
                  ? `S${week.seasonId}W${week.sectionIndex + 1}`
                  : null;
              for (const p of participants) {
                const tag = p.tag?.toUpperCase?.() || "";
                if (!tag || !allMembers.has(tag)) continue;
                const fame = p.fame || 0;
                const existing = allTimeTotals.get(tag);
                if (!existing || fame > existing.fame) {
                  allTimeTotals.set(tag, {
                    tag,
                    name: p.name || "",
                    fame,
                    weekId,
                    clan: allMembers.get(tag)?.clan || clan.name,
                    role: allMembers.get(tag)?.role || "member",
                  });
                }
              }
            }
          }

          const allTimeSorted = Array.from(allTimeTotals.values()).sort(
            (a, b) =>
              b.fame - a.fame ||
              a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
          );
          if (allTimeSorted.length <= limit) {
            players = allTimeSorted;
          } else {
            const cutoffFame = allTimeSorted[limit - 1].fame;
            players = allTimeSorted.filter((p) => p.fame >= cutoffFame);
          }
        } else {
          const weekRef = (function () {
            for (const clan of CLANS) {
              const raceLog = clanRaceLogs[clan.tag];
              const prevWeekId = computePrevWeekId(raceLog);
              if (prevWeekId) return prevWeekId;
            }
            return null;
          })();
          const publicWeekLabel = weekRef ? toPublicWeekId(weekRef) : "S?-W?";

          title = `<:topplayers:1493708397407899648> Meilleurs joueurs de la semaine ${publicWeekLabel}`;
          footer = `😎 Meilleurs joueurs de la semaine précédente (${publicWeekLabel})`;

          const weekSorted = allTeams.sort(
            (a, b) =>
              b.fame - a.fame ||
              a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
          );
          if (weekSorted.length <= limit) {
            players = weekSorted;
          } else {
            const cutoffFame = weekSorted[limit - 1].fame;
            players = weekSorted.filter((p) => p.fame >= cutoffFame);
          }
        }

        if (players.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: "Aucun joueur trouvé pour la période demandée.",
              flags: 64,
            }),
          });
          return;
        }

        const rows = players
          .map((p, idx) => {
            const playerUrl = trustPlayerUrl(p.tag);
            const name = p.name || p.tag;
            const clan = p.clan || "?";
            const fame = p.fame || 0;
            const fameStr = fame.toLocaleString("fr-FR");
            const weekLabel = p.weekId ? ` (${p.weekId})` : "";
            return `${idx + 1}. [${name}](${playerUrl}) (${clan})\n**${fameStr} pts**${weekLabel}`;
          })
          .join("\n");

        const embed = {
          title,
          color: 0x5865f2,
          description: `Classement au sein de la famille\n\n${rows}`,
          image: {
            url: `${TRUST_ROYALE_URL}/images/banner1.webp`,
          },
          footer: { text: footer },
        };

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            embeds: [embed],
            allowed_mentions: { parse: [] },
          }),
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

  // Commande /demote
  if (body.type === 2 && body.data?.name === "demote") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    if (!clanOpt?.value) {
      res.status(200).json({
        type: 4,
        data: {
          content: "Option obligatoire manquante : `clan`.",
          flags: 64,
        },
      });
      return;
    }
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
        const { fetchRaceLog } =
          await import("@clash/clash-royale/clashApi.js");
        const apiUrl = `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(resolved.tag)}/analysis?includeTopPlayers=false&includeUncomplete=true&fast=true`;
        const apiResp = await fetch(apiUrl);
        if (!apiResp.ok) {
          const msg = `Erreur API : ${apiResp.status}`;
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: msg, flags: 64 }),
          });
          return;
        }

        const analysis = await apiResp.json();
        const raceLog = await fetchRaceLog(`#${resolved.tag}`);
        const { computePrevWeekId } =
          await import("@clash/clash-royale/dateUtils.js");
        const weekIdFromLog = computePrevWeekId(raceLog);
        const earlyWinByDay3 = await hasProvenEarlyWinByDay3(
          resolved.tag,
          weekIdFromLog,
        );
        const uncompleteAll = analysis.uncomplete?.players || [];
        const uncomplete = uncompleteAll.filter((p) => p.inClan);
        // 12 si la ligne d'arrivée a été franchie au reset du J4 (journées
        // suivantes sans aucun point, donc non attendues), 16 sinon.
        const maxDecks = analysis.uncomplete?.maxDecks ?? 16;
        const decksRatio = `${maxDecks}/${maxDecks}`;

        if (uncomplete.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `✅ Aucun joueur en fail ${decksRatio} dans ${resolved.name}.`,
              flags: 64,
            }),
          });
          return;
        }

        const sorted = uncomplete
          .slice()
          .sort((a, b) => a.decks - b.decks || a.name.localeCompare(b.name));

        const arrived = sorted.filter((p) => p.joinedThisWeek);
        const regular = sorted.filter((p) => !p.joinedThisWeek);

        const MAX_ARRIVED = 10;
        const MAX_REGULAR = 25;
        const allRows = [];

        if (regular.length > 0) {
          regular.slice(0, MAX_REGULAR).forEach((p, i) => {
            const playerUrl = trustPlayerUrl(p.tag);
            const isNew = p.isNew ? " 🆕" : "";
            const role = formatDiscordRole(p.role);
            allRows.push(
              `${i + 1}. [${p.name}](${playerUrl})${isNew} • ${role} • **${p.decks} decks**`,
            );
          });
        }

        if (arrived.length > 0) {
          if (allRows.length > 0) allRows.push("");
          allRows.push("Arrivés en cours de GDC:");
          arrived.slice(0, MAX_ARRIVED).forEach((p, i) => {
            const playerUrl = trustPlayerUrl(p.tag);
            const isNew = p.isNew ? " 🆕" : "";
            const role = formatDiscordRole(p.role);
            allRows.push(
              `${i + 1}. [${p.name}](${playerUrl})${isNew} • ${role} • **${p.decks} decks**`,
            );
          });
        }

        const demoteHeader =
          maxDecks < 16
            ? `Joueurs n'ayant pas joué ${decksRatio} decks (ligne d'arrivée franchie, journées suivantes non comptabilisées)`
            : earlyWinByDay3
              ? "Joueurs n'ayant pas joué 16/16 decks car il y a eu une victoire anticipée dès le jour 3"
              : "Joueurs n'ayant pas joué 16/16 decks";
        let description = `${demoteHeader}\n${allRows.join("\n")}`;
        // Discord limite les embeds à 4096 caractères pour description
        if (description.length > 4090) {
          const trimmed = allRows
            .join("\n")
            .slice(0, 4000)
            .split("\n")
            .slice(0, -1)
            .join("\n");
          description = `${demoteHeader}\n${trimmed}\n...liste tronquée`;
        }
        const clanUrl = trustClanUrl(resolved.tag);

        const weekId =
          weekIdFromLog ||
          analysis.prevWeekId ||
          analysis.clanWarSummary?.weekId ||
          "S?";
        const embed = {
          title: `<:interrogation:1493849417520906271> ${resolved.name} · Oublis`,
          url: clanUrl,
          color: 0xf1c40f,
          description,
          footer: {
            text: `Combats non joués · Semaine : ${toPublicWeekId(weekId)}`,
          },
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

  // Commande /chelem
  if (body.type === 2 && body.data?.name === "chelem") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const seasonOpt = body.data.options?.find((o) => o.name === "season");

    const clanVal = (clanOpt?.value || "1").toString().trim().toLowerCase();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    const requestedSeason =
      seasonOpt && !Number.isNaN(parseInt(seasonOpt.value, 10))
        ? parseInt(seasonOpt.value, 10)
        : null;

    // Réponse différée obligatoire (sinon Discord timeout)
    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const { fetchRaceLog, fetchClanMembers, fetchCurrentRace } =
          await import("@clash/clash-royale/clashApi.js");
        const [raceLog, currentRace] = await Promise.all([
          fetchRaceLog(`#${resolved.tag}`),
          fetchCurrentRace(`#${resolved.tag}`).catch(() => null),
        ]);
        if (!Array.isArray(raceLog) || raceLog.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: "Impossible de récupérer le race log du clan.",
              flags: 64,
            }),
          });
          return;
        }

        const { computeCurrentSeasonId } =
          await import("@clash/clash-royale/dateUtils.js");

        // Saison par défaut = la plus récente saison TERMINÉE dans le log.
        // Si toutes les semaines de la saison courante sont déjà dans le raceLog (>= 4),
        // c'est que la saison est terminée (ex. Colisée fini) → on peut l'utiliser comme défaut.
        const currentSeasonId = computeCurrentSeasonId(currentRace, raceLog);
        const seasonCounts = {};
        for (const r of raceLog) {
          seasonCounts[r.seasonId] = (seasonCounts[r.seasonId] || 0) + 1;
        }
        const sortedSeasons = Object.keys(seasonCounts)
          .map(Number)
          .sort((a, b) => b - a);
        const currentSeasonIsComplete =
          currentSeasonId && (seasonCounts[currentSeasonId] ?? 0) >= 4;
        const defaultSeason = currentSeasonIsComplete
          ? (sortedSeasons.find((sid) => seasonCounts[sid] >= 4) ??
            sortedSeasons[0])
          : (sortedSeasons.find(
              (sid) => sid !== currentSeasonId && seasonCounts[sid] >= 4,
            ) ??
            sortedSeasons.find((sid) => sid !== currentSeasonId) ??
            sortedSeasons[0]);

        const seasonId = requestedSeason ?? defaultSeason;
        if (!seasonId) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: "Impossible de déterminer la saison cible.",
              flags: 64,
            }),
          });
          return;
        }

        const weeks = raceLog.filter((r) => r.seasonId === seasonId);
        if (weeks.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Aucune donnée trouvée pour la saison ${seasonId}.`,
              flags: 64,
            }),
          });
          return;
        }

        const { countedWarDaysFromRaceLog } =
          await import("../../../backend/services/warStandings.js");
        // Decks attendus par semaine : 16, ou 12 si la ligne d'arrivée a été
        // franchie au reset du J4 (journées suivantes sans aucun point).
        let decksPerPlayer = 0;
        const fullSets = weeks.map((w) => {
          const standing = (w.standings || []).find(
            (s) => s.clan?.tag?.toUpperCase() === `#${resolved.tag}`,
          );
          const participants = standing?.clan?.participants ?? [];
          const maxDecks =
            countedWarDaysFromRaceLog(standing?.clan, w.createdDate) * 4;
          decksPerPlayer += maxDecks;
          return new Set(
            participants
              .filter((p) => (p.decksUsed ?? 0) >= maxDecks)
              .map((p) => p.tag.toUpperCase()),
          );
        });

        const intersection = fullSets.reduce((acc, set) => {
          if (!acc) return set;
          return new Set([...acc].filter((t) => set.has(t)));
        }, null);

        const fullTags = intersection ? [...intersection] : [];

        // Noms depuis le raceLog en priorité (couvre les joueurs qui ont quitté le clan depuis).
        // On parcourt toutes les semaines de la saison ciblée pour construire le dictionnaire.
        const nameFromLog = {};
        for (const w of weeks) {
          const standing = (w.standings || []).find(
            (s) => s.clan?.tag?.toUpperCase() === `#${resolved.tag}`,
          );
          for (const p of standing?.clan?.participants ?? []) {
            if (p.tag && p.name) nameFromLog[p.tag.toUpperCase()] = p.name;
          }
        }

        const clanMembers = await fetchClanMembers(`#${resolved.tag}`);
        const memberByTag = Object.fromEntries(
          clanMembers.map((m) => [m.tag.toUpperCase(), m]),
        );

        const players = fullTags
          .map((tag) => {
            const m = memberByTag[tag];
            // Nom depuis le raceLog si disponible, sinon depuis le roster actuel
            const name = nameFromLog[tag] ?? m?.name ?? tag;
            const role = m ? formatDiscordRole(m.role) : "(parti)";
            return { tag, name, role };
          })
          .sort((a, b) =>
            a.name.localeCompare(b.name, "fr", { sensitivity: "base" }),
          );

        let description;
        if (players.length === 0) {
          description = `Aucun joueur n'a joué 100% des decks toutes les semaines de la saison ${seasonId}.`;
        } else {
          const MAX_ROWS = 80;
          const rows = players.map((p, idx) => {
            const playerUrl = trustPlayerUrl(p.tag);
            return `${idx + 1}. [${p.name}](${playerUrl}) · ${p.role}`;
          });
          const visibleRows = rows.slice(0, MAX_ROWS);
          description = visibleRows.join("\n");
          if (rows.length > MAX_ROWS) {
            description += `\n...et ${rows.length - MAX_ROWS} autres`;
          }
        }

        const embed = {
          title: `<:topplayers:1493708397407899648> ${resolved.name} — saison ${seasonId}`,
          color: 0x5865f2,
          description,
          footer: {
            text: `${players.length} joueur(s) ont joué 100% des decks (${decksPerPlayer} decks)`,
          },
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

  // Commande /fail
  if (body.type === 2 && body.data?.name === "fail") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const clanVal = (clanOpt?.value || "1").toString().trim();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      const normalizeTag = (tag) =>
        String(tag || "")
          .toUpperCase()
          .replace(/^#/, "");

      const formatStatus = (role) => {
        const normalized = String(role || "member")
          .trim()
          .toLowerCase();
        return ROLE_FR[normalized] ?? ROLE_FR.member;
      };

      try {
        const { fetchCurrentRace, fetchRaceLog, fetchClanMembers } =
          await import("@clash/clash-royale/clashApi.js");
        const { getSnapshotsForWeeks, getCurrentWarDayIndex } =
          await import("../../../backend/services/snapshot.js");
        const {
          computeCurrentWeekId,
          computePrevWeekId,
          warResetOffsetMs,
          parseClashDate,
        } = await import("@clash/clash-royale/dateUtils.js");

        const [race, initialRaceLog, currentMembers] = await Promise.all([
          fetchCurrentRace(`#${resolved.tag}`),
          fetchRaceLog(`#${resolved.tag}`),
          fetchClanMembers(`#${resolved.tag}`).catch(() => null),
        ]);
        let raceLog = initialRaceLog;
        // null (pas [] явно) si l'appel live échoue, pour ne pas vider la
        // liste à tort en cas d'erreur réseau — voir filtre plus bas.
        const currentMemberTags = Array.isArray(currentMembers)
          ? new Set(currentMembers.map((m) => normalizeTag(m.tag)))
          : null;

        const isCalendarWarDay =
          new Date(Date.now() - warResetOffsetMs(resolved.tag)).getUTCDay() ===
            0 ||
          new Date(Date.now() - warResetOffsetMs(resolved.tag)).getUTCDay() >=
            4;
        const isWarDay = isCalendarWarDay && isWarDayPeriod(race);

        let prevDayIndex = null;

        if (isWarDay) {
          const currentDayIndex = getCurrentWarDayIndex(race, resolved.tag);
          prevDayIndex =
            currentDayIndex !== null && currentDayIndex > 0
              ? currentDayIndex - 1
              : null;
        } else if (race && race.sectionIndex !== undefined) {
          prevDayIndex = 3;
        }

        if (prevDayIndex === null) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `<:cards:1493711279121104926> **${resolved.name}** — Aucune journée de GDC en cours.`,
              flags: 64,
            }),
          });
          return;
        }

        // Autour du reset quotidien, `currentriverrace` bascule instantanément
        // sur la nouvelle journée alors que `riverracelog` (l'historique) met
        // couramment 1-2 min de plus à s'actualiser côté Supercell. Si on lit
        // raceLog dans cette fenêtre, raceLog[0] pointe encore vers l'avant-
        // dernière semaine terminée, et /fail rapporte des échecs d'une
        // semaine périmée en les étiquetant "hier". On ne retente que dans
        // une courte fenêtre après le reset, pour ne pas fausser le cas
        // normal (mercredi, raceLog[0] datant légitimement de lundi).
        if (!isWarDay) {
          const resetOffset = warResetOffsetMs(resolved.tag);
          const nowGdc = new Date(Date.now() - resetOffset);
          const lastResetBoundary = new Date(
            Date.UTC(
              nowGdc.getUTCFullYear(),
              nowGdc.getUTCMonth(),
              nowGdc.getUTCDate(),
            ) + resetOffset,
          );
          const minutesSinceReset =
            (Date.now() - lastResetBoundary.getTime()) / 60000;
          const isRaceLogStale = () => {
            const createdDate = raceLog?.[0]?.createdDate;
            if (!createdDate) return true;
            return (
              parseClashDate(createdDate).getTime() <
              lastResetBoundary.getTime()
            );
          };

          if (
            minutesSinceReset >= 0 &&
            minutesSinceReset < 10 &&
            isRaceLogStale()
          ) {
            await new Promise((resolve) => setTimeout(resolve, 5000));
            raceLog = await fetchRaceLog(`#${resolved.tag}`);
            if (isRaceLogStale()) {
              await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  content: `⏳ ${resolved.name} — La GDC vient tout juste de se terminer, les données ne sont pas encore synchronisées côté Supercell. Réessayez dans une minute.`,
                  flags: 64,
                }),
              });
              return;
            }
          }
        }

        const currentWeekId = isWarDay
          ? computeCurrentWeekId(race, raceLog)
          : computePrevWeekId(raceLog);
        if (!currentWeekId) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Erreur : impossible de déterminer la semaine GDC courante.`,
              flags: 64,
            }),
          });
          return;
        }

        const snapshots = await getSnapshotsForWeeks(resolved.tag, [
          currentWeekId,
        ]);
        const weekSnaps = snapshots[currentWeekId] || [];
        const prevDaySnap = weekSnaps[prevDayIndex];
        if (
          !prevDaySnap ||
          !prevDaySnap.decks ||
          Object.keys(prevDaySnap.decks).length === 0
        ) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `❌ Pas de données de decks disponibles pour ${FAIL_WAR_DAY_LABELS[prevDayIndex]}.`,
              flags: 64,
            }),
          });
          return;
        }

        const snapshotMembersByTag = await readClanCacheMembers(resolved.tag);
        if (snapshotMembersByTag.size === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `❌ Impossible de charger la liste des membres de ${resolved.name}.`,
              flags: 64,
            }),
          });
          return;
        }
        // Le cache disque (bundle régénéré ~1x/heure) peut ne pas encore
        // connaître un membre arrivé très récemment. On complète avec la
        // liste live (déjà récupérée plus haut) pour ne jamais faire
        // disparaître un joueur en échec juste parce qu'il vient de
        // rejoindre le clan.
        if (Array.isArray(currentMembers)) {
          for (const m of currentMembers) {
            const tag = normalizeTag(m.tag);
            if (!snapshotMembersByTag.has(tag)) {
              snapshotMembersByTag.set(tag, {
                name: m.name || tag,
                role: m.role || "member",
                tag: m.tag || `#${tag}`,
                arrivalStreakInCurrentClan: undefined,
                arrivalTotalWeeks: undefined,
              });
            }
          }
        }

        // dayEntry.decks (cron horaire + correction post-reset) et
        // decksPreReset (figé ~2 min avant le reset, jamais corrigé après)
        // peuvent chacun rater une fenêtre différente : on prend le max par
        // joueur, comme dans notifyWarSummary.js, pour rester cohérent entre
        // les commandes.
        const mergedDaySnapDecks = (snap) => {
          const merged = { ...(snap?.decks || {}) };
          for (const [tag, value] of Object.entries(
            snap?.decksPreReset || {},
          )) {
            if (!Number.isFinite(value)) continue;
            if (!Number.isFinite(merged[tag]) || value > merged[tag]) {
              merged[tag] = value;
            }
          }
          return merged;
        };

        const decksByTag = new Map(
          Object.entries(mergedDaySnapDecks(prevDaySnap)).map(
            ([tag, value]) => [
              normalizeTag(tag),
              Number.isFinite(value) ? Math.max(0, Math.min(4, value)) : 0,
            ],
          ),
        );

        // Le snapshot disque du jour le plus récent est écrit par un cron
        // GitHub Actions puis déployé sur Vercel : entre la capture et la
        // mise en ligne du commit, il peut y avoir 15-20 min de décalage.
        // Si /fail est lancée dans cette fenêtre, on lit un total figé
        // avant les derniers combats du jour (faux positifs). On recoupe
        // donc avec les compteurs live de l'API (toujours à jour) : en
        // soustrayant du cumul hebdomadaire live les jours antérieurs
        // (déjà stables, hors fenêtre à risque), on isole le total du
        // jour recherché et on garde le max avec la valeur disque.
        const priorDaysTotalByTag = new Map();
        for (let i = 0; i < prevDayIndex; i++) {
          for (const [rawTag, value] of Object.entries(
            mergedDaySnapDecks(weekSnaps[i]),
          )) {
            if (!Number.isFinite(value)) continue;
            const tag = normalizeTag(rawTag);
            const clamped = Math.max(0, Math.min(4, value));
            priorDaysTotalByTag.set(
              tag,
              (priorDaysTotalByTag.get(tag) || 0) + clamped,
            );
          }
        }

        let liveCumulativeParticipants = null;
        if (isWarDay) {
          liveCumulativeParticipants = race?.clan?.participants || null;
        } else {
          const normalizedClanTag = `#${resolved.tag}`;
          const standing = raceLog?.[0]?.standings?.find(
            (s) => s.clan?.tag === normalizedClanTag,
          );
          liveCumulativeParticipants = standing?.clan?.participants || null;
        }

        if (Array.isArray(liveCumulativeParticipants)) {
          for (const p of liveCumulativeParticipants) {
            const tag = normalizeTag(p.tag);
            const cumulative = Number(p.decksUsed) || 0;
            const today = isWarDay ? Number(p.decksUsedToday) || 0 : 0;
            const priorDays = priorDaysTotalByTag.get(tag) || 0;
            const isolated = Math.max(
              0,
              Math.min(4, cumulative - today - priorDays),
            );
            const diskValue = decksByTag.has(tag) ? decksByTag.get(tag) : 0;
            decksByTag.set(tag, Math.max(diskValue, isolated));
          }
        }

        const failedPlayers = Array.from(snapshotMembersByTag.entries())
          .map(([normalizedTag, member]) => ({
            name: member.name || "Inconnu",
            tag: member.tag || `#${normalizedTag}`,
            role: member.role || "member",
            decks: decksByTag.has(normalizedTag)
              ? decksByTag.get(normalizedTag)
              : 0,
            arrivalStreak: member.arrivalStreakInCurrentClan,
            arrivalWeeks: member.arrivalTotalWeeks,
            firstSeenAt: member.firstSeenAt,
            // snapshotMembersByTag vient du cache disque (potentiellement
            // périmé de plusieurs heures) : un joueur exclu du clan entre
            // deux rafraîchissements y traîne encore. On ne le retire pas de
            // la liste (il a quand même manqué ses combats), on l'annote
            // pour l'afficher avec un statut "Parti" au lieu de son ancien
            // rôle. currentMemberTags === null (appel live échoué) → on ne
            // marque personne comme parti pour ne pas afficher de faux
            // positifs en cas d'erreur réseau ponctuelle.
            hasLeft: currentMemberTags
              ? !currentMemberTags.has(
                  normalizeTag(member.tag || normalizedTag),
                )
              : false,
          }))
          // Les joueurs arrivés en cours de semaine sont inclus comme les
          // autres (annotés 🆕 plus bas via arrivalWeeks) : un membre qui
          // vient de rejoindre doit quand même jouer ses decks du jour.
          .filter((p) => p.decks < 4)
          .sort((a, b) =>
            a.name.localeCompare(b.name, "fr", {
              numeric: true,
              sensitivity: "base",
            }),
          );

        const warDayLabel =
          FAIL_WAR_DAY_SHORT_LABELS[prevDayIndex] || "jour précédent";
        if (failedPlayers.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `✅ Aucun joueur fail ${warDayLabel} dans ${resolved.name}.`,
              flags: 64,
            }),
          });
          return;
        }

        const DETAILABLE_FAIL_LIMIT = 15;
        if (failedPlayers.length > DETAILABLE_FAIL_LIMIT) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `⚠️ ${failedPlayers.length} joueurs ont manqué ${warDayLabel} dans ${resolved.name}. Trop nombreux pour afficher les détails dans une seule commande.`,
              flags: 64,
            }),
          });
          return;
        }

        const fetchLines = await Promise.all(
          failedPlayers.map(async (player) => {
            const tag = player.tag.startsWith("#")
              ? player.tag
              : `#${player.tag}`;
            try {
              const apiResp = await fetch(
                `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(tag)}/analysis?fast=true`,
                { headers: { Accept: "application/json" } },
              );
              if (!apiResp.ok) throw new Error(`API joueur ${apiResp.status}`);
              const analysis = await apiResp.json();
              if (analysis.warHistoryDegraded) {
                throw new Error(
                  "Historique de guerre temporairement indisponible",
                );
              }
              const weeks = Array.isArray(analysis.warHistory?.weeks)
                ? analysis.warHistory.weeks.filter(
                    (w) => !w.isCurrent && Number(w.decksUsed) > 0,
                  )
                : [];
              const recent = weeks.slice(0, 8);
              const decksLine = recent
                .map((w) => {
                  const deckCount = Number(w.decksUsed || 0);
                  const badge = failDeckBadge(
                    deckCount,
                    Boolean(w.ignored),
                    w.maxDecks,
                  );
                  return `${badge} ${String(deckCount).padStart(2, " ")}`;
                })
                .join("   ");
              const totalFame = recent.reduce(
                (sum, w) => sum + (Number(w.fame) || 0),
                0,
              );
              const totalDecks = recent.reduce(
                (sum, w) => sum + (Number(w.decksUsed) || 0),
                0,
              );
              const avgPerDeck = totalDecks
                ? Math.round(totalFame / totalDecks)
                : 0;
              const status = player.hasLeft
                ? "Parti"
                : formatStatus(player.role);
              const isNew =
                Number.isFinite(player.arrivalWeeks) &&
                player.arrivalWeeks <= 1;
              const newTag = isNew ? " 🆕" : "";
              return `- [${player.name}](${trustPlayerUrl(tag)})${newTag} (${status}) manque ${4 - player.decks} :\n  Historique : ${decksLine}\n  Pts/deck moyen : ${avgPerDeck}`;
            } catch (err) {
              const status = player.hasLeft
                ? "Parti"
                : formatStatus(player.role);
              return `- [${player.name}](${trustPlayerUrl(tag)}) (${status}) manque ${4 - player.decks} : données historiques indisponibles`;
            }
          }),
        );

        const failCount = failedPlayers.length;
        const failLabel =
          failCount === 1 ? "Joueur en échec" : "Joueurs en échec";
        // Une ligne joueur pèse ~400 caractères (émojis personnalisés) : on
        // découpe en plusieurs embeds sous la limite de 4096 de la description,
        // un par message pour rester sous les 6000 caractères par message.
        const descriptions = [];
        let current = "Historique des dernières GDC :";
        for (const line of fetchLines) {
          if (current.length + 1 + line.length > 4096) {
            descriptions.push(current);
            current = line;
          } else {
            current += `\n${line}`;
          }
        }
        descriptions.push(current);

        for (const [i, description] of descriptions.entries()) {
          const embed = { color: 0xe74c3c, description };
          if (i === 0) {
            embed.title = `<:boohoo:1493849412387209357> ${resolved.name} — ${failCount} ${failLabel} hier (${warDayLabel})`;
            embed.url = trustClanUrl(resolved.tag);
          }
          if (i === descriptions.length - 1) {
            embed.footer = {
              text: `Données pour ${warDayLabel} — ${toPublicWeekId(currentWeekId)}`,
            };
          }
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ embeds: [embed] }),
          });
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

  // Commande /late
  if (body.type === 2 && body.data?.name === "late") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const clanVal = (clanOpt?.value || "1").toString().trim();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    res.status(200).json({ type: 5 });
    const webhookUrl = buildDiscordWebhookUrl(body);

    runBackground(async () => {
      // Envoie systématiquement quelque chose au webhook Discord (évite le freeze "thinking...")
      const sendToWebhook = async (payload) => {
        const r = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          console.error(
            `[/late] webhook Discord HTTP ${r.status}:`,
            txt.slice(0, 300),
          );
        }
      };

      const payload = await buildLateReportPayload(resolved, clanVal);

      if (payload.kind === "success") {
        await sendToWebhook({
          embeds: payload.embeds,
          components: payload.components,
          allowed_mentions: { parse: [] },
        });
      } else if (payload.kind === "no-war-day") {
        await sendToWebhook({ content: payload.content });
      } else {
        await sendToWebhook({ content: payload.content, flags: 64 });
      }
    });
    return;
  }

  // Commande /late-ping
  if (body.type === 2 && body.data?.name === "late-ping") {
    const discordUserId = body.member?.user?.id ?? body.user?.id;
    if (!discordUserId || !authorizedPingIds.has(discordUserId)) {
      return res.status(200).json({
        type: 4,
        data: {
          content: "🚫 Vous n'etes pas autorise a utiliser cette commande.",
          flags: 64,
        },
      });
    }

    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const clanVal = (clanOpt?.value || "1").toString().trim();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      const withTimeout = (promise, ms, label) =>
        Promise.race([
          promise,
          new Promise((_, reject) =>
            setTimeout(
              () => reject(new Error(`Timeout ${label} (${ms}ms)`)),
              ms,
            ),
          ),
        ]);

      const sendToWebhook = async (payload) => {
        const r = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          console.error(
            `[/late-ping] webhook Discord HTTP ${r.status}:`,
            txt.slice(0, 300),
          );
        }
      };

      try {
        console.log("[/late-ping] start, clan:", resolved.tag);
        const { fetchCurrentRace, fetchClanMembers } =
          await import("@clash/clash-royale/clashApi.js");
        console.log("[/late-ping] import OK");

        const [race, currentMembers, links] = await withTimeout(
          Promise.all([
            fetchCurrentRace(`#${resolved.tag}`),
            fetchClanMembers(`#${resolved.tag}`),
            getDiscordLinks(),
          ]),
          20000,
          "fetch initial",
        );

        const participants = race?.clan?.participants ?? [];

        const { warResetOffsetMs } =
          await import("@clash/clash-royale/dateUtils.js");
        const resetUtcMs = warResetOffsetMs(resolved.tag);
        const _gdcDow = new Date(Date.now() - resetUtcMs).getUTCDay();
        const isCalendarWarDay = _gdcDow === 0 || _gdcDow >= 4;
        const isWarDay =
          isCalendarWarDay &&
          (race?.periodType === "warDay" ||
            race?.state === "warDay" ||
            race?.state === "overtime" ||
            race?.state === "full");

        if (!isWarDay) {
          await sendToWebhook({
            content: `<:cards:1493711279121104926> **${resolved.name}** — Aucune journée de GDC en cours (période d'entraînement).`,
          });
          return;
        }

        const analysisMap = new Map();
        try {
          const abortCtrl = new AbortController();
          const abortTimer = setTimeout(() => abortCtrl.abort(), 10000);
          const apiResp = await fetch(
            `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(resolved.tag)}/analysis`,
            {
              headers: { Accept: "application/json" },
              signal: abortCtrl.signal,
            },
          );
          clearTimeout(abortTimer);
          if (apiResp.ok) {
            const analysis = await apiResp.json();
            (analysis.members || []).forEach((m) => {
              if (m?.tag) analysisMap.set((m.tag || "").toUpperCase(), m);
            });
          }
        } catch (err) {
          // ignore, annotations sont facultatives
        }

        const {
          currentMemberTags,
          currentMemberByTag,
          currentParticipants,
          totalPlayed,
          slotsOccupied,
          slotsAvailable,
          exClanPlayedToday,
        } = buildLateSummary(participants, currentMembers);

        const late = participants
          .filter(
            (p) => currentMemberTags.has(p.tag) && (p.decksUsedToday ?? 0) < 4,
          )
          .map((p) => ({ ...p, missing: 4 - (p.decksUsedToday ?? 0) }))
          .sort(
            (a, b) =>
              b.missing - a.missing || a.name.localeCompare(b.name, "fr"),
          );

        const lateTimingTagsByTag = await buildLateTimingTagsByPlayer(
          late.map((pl) => pl.tag),
        );

        const guildId = process.env.DISCORD_GUILD_ID;
        const botToken = process.env.DISCORD_TOKEN;
        let guildMembers = [];
        try {
          const guildRes = await withTimeout(
            fetch(
              `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`,
              { headers: { Authorization: `Bot ${botToken}` } },
            ),
            10000,
            "guild members",
          );
          guildMembers = guildRes.ok ? await guildRes.json() : [];
        } catch {
          // pings Discord optionnels — on continue sans eux
        }
        const memberById = new Map(guildMembers.map((m) => [m.user?.id, m]));

        const now = new Date();
        const p = new Date(
          now.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
        );
        const parisTime = `${String(p.getHours()).padStart(2, "0")}h${String(p.getMinutes()).padStart(2, "0")}`;

        const msOfDayUtc =
          now.getUTCHours() * 3600000 + now.getUTCMinutes() * 60000;
        if (msOfDayUtc < resetUtcMs) p.setDate(p.getDate() - 1);
        const WAR_DAY_LABELS = {
          4: "Jeudi (J1)",
          5: "Vendredi (J2)",
          6: "Samedi (J3)",
          0: "Dimanche (J4)",
        };
        const warDayLabel = WAR_DAY_LABELS[p.getDay()] ?? "Jour de GDC";

        const isAfterReset = msOfDayUtc >= resetUtcMs;
        const prevCumulByTag = new Map();
        if (isWarDay && !isAfterReset) {
          const pad2 = (n) => String(n).padStart(2, "0");
          const realDayToday = `${p.getFullYear()}-${pad2(p.getMonth() + 1)}-${pad2(p.getDate())}`;
          try {
            const snapData = await loadSnapshots(resolved.tag);
            if (Array.isArray(snapData)) {
              const prevDay = snapData
                .flatMap((w) => w.days ?? [])
                .filter(
                  (d) =>
                    d.realDay &&
                    d.realDay < realDayToday &&
                    d._cumulFame &&
                    Object.keys(d._cumulFame).length > 0,
                )
                .sort((a, b) => b.realDay.localeCompare(a.realDay))[0];
              if (prevDay?._cumulFame) {
                const realDayTodayMs = new Date(
                  realDayToday + "T00:00:00Z",
                ).getTime();
                const prevDayExpected = new Date(realDayTodayMs - 86400000)
                  .toISOString()
                  .slice(0, 10);
                if (prevDay.realDay === prevDayExpected) {
                  for (const [tag, fame] of Object.entries(
                    prevDay._cumulFame,
                  )) {
                    prevCumulByTag.set(tag, fame ?? 0);
                  }
                }
              }
            }
          } catch (_) {
            // snapshot indisponible — on affichera la fame hebdomadaire (dégradé acceptable)
          }
        }

        const totalFame = currentParticipants.reduce((sum, pl) => {
          const rawFame = pl.fame ?? 0;
          const plTag = pl.tag.startsWith("#") ? pl.tag : `#${pl.tag}`;
          const todayFame =
            isWarDay && !isAfterReset
              ? Math.max(0, rawFame - (prevCumulByTag.get(plTag) ?? 0))
              : rawFame;
          return sum + todayFame;
        }, 0);

        const totalMissing = late.reduce((sum, pl) => sum + pl.missing, 0);
        const hideDetails = totalMissing > 100;

        const boatAttackers = currentParticipants.filter(
          (pl) => (pl.boatAttacks ?? 0) > 0,
        );
        const totalBoatAttacks = boatAttackers.reduce(
          (sum, pl) => sum + (pl.boatAttacks ?? 0),
          0,
        );
        const boatNames = boatAttackers
          .map((pl) => {
            const plTag = pl.tag.startsWith("#") ? pl.tag : `#${pl.tag}`;
            const playerUrl = trustPlayerUrl(plTag);
            return `[${pl.name}](${playerUrl})`;
          })
          .join(", ");

        const lateHeader =
          late.length === 0
            ? `Aucun joueur en retard à ${parisTime}`
            : `- ${late.length} joueur${late.length > 1 ? "s" : ""} en retard à ${parisTime}`;
        const descLines = [
          lateHeader,
          `- ${totalPlayed} deck${totalPlayed > 1 ? "s" : ""} joué${totalPlayed > 1 ? "s" : ""}`,
          `- ${slotsOccupied} slots occupés`,
        ];
        if (late.length > 0) {
          descLines.push(
            `- ${totalMissing} deck${totalMissing > 1 ? "s" : ""} manquant${totalMissing > 1 ? "s" : ""}`,
          );
        }
        if (totalBoatAttacks > 0) {
          descLines.push(
            `- ${totalBoatAttacks} attaque${totalBoatAttacks > 1 ? "s" : ""} bateau (cumul) (${boatNames})`,
          );
        }

        const mentionIds = new Set();

        if (hideDetails) {
          descLines.push(
            "",
            "Pas de liste détaillée car il y a plus de 100 decks manquants",
          );
        } else {
          for (const count of [4, 3, 2, 1]) {
            const group = late.filter((pl) => pl.missing === count);
            if (!group.length) continue;
            descLines.push("");
            descLines.push(`**Manque ${count} deck${count > 1 ? "s" : ""}**`);
            for (const pl of group) {
              const tag = pl.tag.startsWith("#") ? pl.tag : `#${pl.tag}`;
              const playerUrl = trustPlayerUrl(tag);
              const memberInfo = currentMemberByTag.get(tag.toUpperCase());
              const role = (memberInfo?.role || "member").toLowerCase();
              const timingLabels =
                lateTimingTagsByTag.get(tag.toUpperCase()) || [];
              const roleText = formatDiscordRoleWithTiming(role, timingLabels);
              const discordId = links[tag];
              const guildMember = discordId ? memberById.get(discordId) : null;
              const discordPart = guildMember ? ` <@${discordId}>` : "";
              if (guildMember && discordId) {
                mentionIds.add(discordId);
              }
              const memberAnalysis = analysisMap.get(tag.toUpperCase()) || {};
              const newTag = memberAnalysis.isNew ? " 🆕" : "";
              descLines.push(
                `• [${pl.name}](${playerUrl})${newTag} ${roleText}${discordPart}`,
              );
            }
          }
        }

        if (exClanPlayedToday.length > 0) {
          descLines.push("");
          descLines.push("**Anciens participants joués aujourd'hui**");
          for (const pl of exClanPlayedToday) {
            const tag = pl.tag.startsWith("#") ? pl.tag : `#${pl.tag}`;
            const playerUrl = trustPlayerUrl(tag);
            const played = pl.decksUsedToday ?? 0;
            const discordId = links[tag];
            const guildMember = discordId ? memberById.get(discordId) : null;
            const discordPart = guildMember ? ` <@${discordId}>` : "";
            descLines.push(
              `• [${pl.name}](${playerUrl}) — ${played} deck${played > 1 ? "s" : ""}${discordPart}`,
            );
          }
        }

        let description = descLines.join("\n");
        if (description.length > 4000) {
          console.warn(
            "[/late-ping] description trop longue:",
            description.length,
            "chars, troncature",
          );
          description = description.slice(0, 3950) + "\n…*(liste tronquée)*";
        }

        const embed = {
          description,
          color: 0xe67e22,
          footer: {
            text: `${resolved.name}, retardataires de ${warDayLabel} • ${LATE_TAG_FOOTER_LEGEND}`,
          },
        };

        console.log(
          "[/late-ping] envoi embed, late:",
          late.length,
          "descLen:",
          description.length,
          "mentions:",
          mentionIds.size,
        );
        const mentionLine = Array.from(mentionIds)
          .map((id) => `<@${id}>`)
          .join(" ");
        const contentParts = ["GDC : Soldat, il te reste des decks à jouer !"];
        if (mentionLine) contentParts.push(mentionLine);
        await sendToWebhook({
          content: contentParts.join("\n"),
          embeds: [embed],
          allowed_mentions: { parse: [], users: Array.from(mentionIds) },
        });
      } catch (err) {
        console.error("[/late-ping] erreur:", err.message);
        await sendToWebhook({ content: `Erreur : ${err.message}`, flags: 64 });
      }
    });
    return;
  }

  // ── /recap ──
  if (body.type === 2 && body.data?.name === "recap") {
    const seasonOpt = body.data.options?.find((o) => o.name === "saison");
    const seasonOffset = seasonOpt?.value === "-2" ? 2 : 1;
    const sortMode = "pointsSaison";

    res.status(200).json({ type: 5 });
    const webhookUrl = buildDiscordWebhookUrl(body);

    runBackground(async () => {
      try {
        const { clan1, clan2, seasonId, observedAt } =
          await buildRecapData(seasonOffset);

        if (!seasonId) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Aucune donnée disponible pour la saison ${seasonOpt?.value || "-1"}.`,
              flags: 64,
            }),
          });
          return;
        }

        setCachedRecapData(seasonOffset, {
          clan1,
          clan2,
          seasonId,
          observedAt,
        });

        const payload = buildRecapPayload({
          clan1,
          clan2,
          seasonId,
          sortMode,
          seasonOffset,
          observedAt,
        });

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
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

  // ── MessageComponent : boutons de tri /recap ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("recap_")
  ) {
    const parts = body.data.custom_id.split(":");
    if (parts.length < 3) {
      return res
        .status(200)
        .json({ type: 4, data: { content: "Erreur interne.", flags: 64 } });
    }

    const action = parts[0]; // "recap_sort" | "recap_refresh"
    const seasonOffset = Number(parts[1]) || 1;
    const sortMode = parts[2];

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

    const cachedData = getCachedRecapData(seasonOffset);
    const shouldFetch = action === "recap_refresh" || !cachedData;

    if (!shouldFetch) {
      return res.status(200).json({
        type: 7,
        data: buildRecapPayload({
          clan1: cachedData.clan1,
          clan2: cachedData.clan2,
          seasonId: cachedData.seasonId,
          sortMode,
          seasonOffset,
          observedAt: cachedData.observedAt,
        }),
      });
    }

    res.status(200).json({ type: 6 });

    runBackground(async () => {
      try {
        const { clan1, clan2, seasonId, observedAt } =
          await buildRecapData(seasonOffset);

        if (!seasonId) {
          await fetch(originalWebhookUrl, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: "Aucune donnée disponible pour cette saison.",
            }),
          });
          return;
        }

        setCachedRecapData(seasonOffset, {
          clan1,
          clan2,
          seasonId,
          observedAt,
        });

        await fetch(originalWebhookUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(
            buildRecapPayload({
              clan1,
              clan2,
              seasonId,
              sortMode,
              seasonOffset,
              observedAt,
            }),
          ),
        });
      } catch (err) {
        await fetch(originalWebhookUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err?.message || "inconnue"}`,
          }),
        });
      }
    });

    return;
  }

  // ── MessageComponent : bouton refresh /late ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("late_refresh:")
  ) {
    const parts = body.data.custom_id.split(":");
    const clanVal = parts[1] || "1";
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];

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

    // Pas de cache pour /late : toujours un recalcul complet, comme la commande initiale
    res.status(200).json({ type: 6 });

    runBackground(async () => {
      const payload = await buildLateReportPayload(resolved, clanVal);

      const patchBody =
        payload.kind === "success"
          ? {
              embeds: payload.embeds,
              components: payload.components,
              allowed_mentions: { parse: [] },
            }
          : { content: payload.content, embeds: [], components: [] };

      const r = await fetch(originalWebhookUrl, {
        method: "PATCH",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(patchBody),
      });
      if (!r.ok) {
        const txt = await r.text().catch(() => "");
        console.error(
          `[late_refresh] PATCH Discord HTTP ${r.status}:`,
          txt.slice(0, 300),
        );
      }
    });

    return;
  }
}
