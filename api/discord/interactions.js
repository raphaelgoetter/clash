// Fonction Vercel dédiée pour les interactions Discord.
// Utilise waitUntil de @vercel/functions pour maintenir la fonction active
// après avoir répondu type:5 à Discord (deferred).
import { createPublicKey, verify } from "node:crypto";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { waitUntil } from "@vercel/functions";
import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import { getLeagueName } from "../../backend/services/warLeagues.js";
import { getDiscordLinks } from "../../backend/services/discordLinks.js";
import {
  fetchClan,
  fetchClanMembers,
  fetchPlayer,
  fetchRaceLog,
  fetchCards,
} from "../../backend/services/clashApi.js";
import {
  TOTAL_CARDS,
  TOTAL_EVOLUTIONS,
  TOTAL_HEROES,
  normLevel,
  countEvolved,
  countHeroes,
  TOUR_REQ,
  computeTourLevel,
} from "../../backend/services/collectionConstants.js";
import { getOrSet } from "../../backend/services/cache.js";
import {
  handleStart as handleChampionStart,
  handleEnd as handleChampionEnd,
  handleCount as handleChampionCount,
  handleHistory as handleChampionHistory,
  handleSelectInteraction as handleChampionSelect,
} from "./handlers/championPredictions.js";
import { isJoinedThisWar } from "../../backend/services/arrivalUtils.js";
import {
  summarizeWarDecks,
  summarizeWarDecksForMatchup,
} from "../../backend/services/analysisService.js";
import { loadClanCache } from "../../backend/services/clanCache.js";

const _require = createRequire(import.meta.url);
const COLLECTION_LEVELS = _require("../../data/collection_levels.json");
const __dirname = path.dirname(fileURLToPath(import.meta.url));

function parseRewardTypeFromLevel(level) {
  const mysteryBox = String(level?.MysteryBox || "");
  const consumable = String(level?.Consumable || "");
  const resource = String(level?.Resource || "");

  if (resource === "Diamonds") return "gems";

  const consumableMap = {
    WildcardCommon: "common_wc",
    WildcardRare: "rare_wc",
    WildcardEpic: "epic_wc",
    WildcardLegendary: "legendary_wc",
    WildcardChampion: "champion_wc",
  };
  if (consumableMap[consumable]) return consumableMap[consumable];

  if (mysteryBox === "LegendaryLuckyDrop_NoUpgrade") return "lucky_chest_4star";
  if (mysteryBox === "ChampionLuckyDrop") return "lucky_chest_5star";
  if (mysteryBox === "EVO_Shard_5Star") return "evo_box";

  if (level?.Banner) return "banner";

  return null;
}

function parseArenaMeta(chestArena) {
  if (!chestArena) return {};
  const raw = String(chestArena);

  const simpleMatch = /^Arena(\d+)$/.exec(raw);
  if (simpleMatch) {
    return { arenaLevel: Number(simpleMatch[1]) };
  }

  const prefixedMatch = /^Arena_(.+)$/.exec(raw);
  if (prefixedMatch) {
    return { arenaLabel: prefixedMatch[1].replaceAll("_", " ") };
  }

  return { arenaLabel: raw };
}

const COLLECTION_REWARDS = COLLECTION_LEVELS.map((level) => {
  const cl = Number(level?.RequiredLevel);
  const type = parseRewardTypeFromLevel(level);
  if (!Number.isFinite(cl) || !type) return null;

  const qty = Number(level?.Amount);
  const reward = {
    cl,
    type,
    qty: Number.isFinite(qty) ? qty : 1,
  };

  if (level?.Banner) reward.label = String(level.Banner);

  const arenaMeta = parseArenaMeta(level?.ChestArena);
  if (arenaMeta.arenaLevel != null) reward.arenaLevel = arenaMeta.arenaLevel;
  if (arenaMeta.arenaLabel) reward.arenaLabel = arenaMeta.arenaLabel;

  return reward;
})
  .filter(Boolean)
  .sort((a, b) => a.cl - b.cl);

// Maintient la fonction Vercel active le temps de l'exécution asynchrone.
function runBackground(fn) {
  try {
    if (typeof waitUntil === "function") {
      waitUntil(fn());
    } else {
      // En environnement non-Vercel (dev), on exécute quand même pour éviter le timeout.
      fn().catch((err) => console.error("runBackground fallback error:", err));
    }
  } catch (err) {
    console.error("runBackground error:", err);
    fn().catch((err2) => console.error("runBackground fallback error:", err2));
  }
}

function getStatsClanScenario(data) {
  const isWarPeriod = Boolean(data?.isWarPeriod);
  return isWarPeriod
    ? { key: "current", label: "GDC en cours — semaine actuelle" }
    : { key: "training", label: "Entraînement — semaine passée" };
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

function buildStatsClanFooter({
  sortMode,
  scenarioLabel,
  pageIndex,
  pageCount,
}) {
  const sortLabel =
    sortMode === "pointsPerDeck" ? "Points par deck" : "Points par semaine";
  const base = `Tri : ${sortLabel} · 🏆 moyenne · ⚡ pts/deck · Scénario : ${scenarioLabel}`;
  return pageCount > 1 ? `${base} · Page ${pageIndex + 1}/${pageCount}` : base;
}

function getStatsClanSortLabel(sortMode) {
  if (sortMode === "pointsPerDeck") return "Points par deck";
  if (sortMode === "decksUsed") return "Decks joués";
  return "Points par semaine";
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
    const fa = Number.isFinite(a.avgFame) ? a.avgFame : -1;
    const fb = Number.isFinite(b.avgFame) ? b.avgFame : -1;
    return fb - fa;
  });
}

function buildStatsClanComponents(clanVal, sortMode) {
  const avgFameActive = sortMode === "avgFame";
  const ppdActive = sortMode === "pointsPerDeck";
  const decksActive = sortMode === "decksUsed";

  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: avgFameActive ? 3 : 1,
          label: "🏆 Points/semaine",
          custom_id: `stats_clan_sort:avgFame:${clanVal}`,
          disabled: avgFameActive,
        },
        {
          type: 2,
          style: ppdActive ? 3 : 1,
          label: "⚡ Points/deck",
          custom_id: `stats_clan_sort:pointsPerDeck:${clanVal}`,
          disabled: ppdActive,
        },
        {
          type: 2,
          style: decksActive ? 3 : 1,
          label: "🎮 Decks joués",
          custom_id: `stats_clan_sort:decksUsed:${clanVal}`,
          disabled: decksActive,
        },
      ],
    },
  ];
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

// Vérifie la signature Ed25519 envoyée par Discord.
function verifyDiscordSignature(signature, timestamp, rawBody) {
  const publicKeyHex = process.env.DISCORD_PUBLIC_KEY;
  if (!publicKeyHex || !signature || !timestamp) return false;
  try {
    // Encapsule la clé publique brute dans le format SPKI DER attendu par Node.js
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const pubKeyDer = Buffer.concat([
      spkiPrefix,
      Buffer.from(publicKeyHex, "hex"),
    ]);
    const publicKey = createPublicKey({
      key: pubKeyDer,
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(timestamp + rawBody),
      publicKey,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

function getStatsClanSortLabel(sortMode) {
  if (sortMode === "pointsPerDeck") return "Points par deck";
  if (sortMode === "decksUsed") return "Decks joués";
  return "Points par semaine";
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
    const fa = Number.isFinite(a.avgFame) ? a.avgFame : -1;
    const fb = Number.isFinite(b.avgFame) ? b.avgFame : -1;
    return fb - fa;
  });
}

function buildStatsClanComponents(clanVal, sortMode) {
  const avgFameActive = sortMode === "avgFame";
  const ppdActive = sortMode === "pointsPerDeck";
  const decksActive = sortMode === "decksUsed";

  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: avgFameActive ? 3 : 1,
          label: "🏆 Points/semaine",
          custom_id: `stats_clan_sort:avgFame:${clanVal}`,
          disabled: avgFameActive,
        },
        {
          type: 2,
          style: ppdActive ? 3 : 1,
          label: "⚡ Points/deck",
          custom_id: `stats_clan_sort:pointsPerDeck:${clanVal}`,
          disabled: ppdActive,
        },
        {
          type: 2,
          style: decksActive ? 3 : 1,
          label: "🎮 Decks joués",
          custom_id: `stats_clan_sort:decksUsed:${clanVal}`,
          disabled: decksActive,
        },
      ],
    },
  ];
}

const COLOR_MAP = {
  green: 0x2ecc71,
  yellow: 0xf1c40f,
  orange: 0xe67e22,
  red: 0xe74c3c,
};

function warLeagueLabel(trophies, isFamilyClan = false) {
  const label = getLeagueName(trophies ?? 0, "fr") ?? "Bronze 1";
  const icon = isFamilyClan
    ? (LEAGUE_ICON_SPECIFIC[label] ?? LEAGUE_ICON_GENERIC[label])
    : LEAGUE_ICON_GENERIC[label];
  return icon ? `${icon} ${label}` : label;
}
const CARD_DEF_CACHE_TTL = 24 * 60 * 60 * 1000;
const CARD_ICON_CACHE = new Map();
const TAG_AUTOCOMPLETE_COMMANDS = new Set([
  "trust",
  "stats",
  "matchup",
  "collection",
]);
const TAG_NAME_CACHE_TTL = 6 * 60 * 60 * 1000;
const tagNameCache = new Map();

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

function extractOpponentTagsFromBattleLog(battleLog) {
  const tags = new Set();
  for (const battle of Array.isArray(battleLog) ? battleLog : []) {
    const opponentEntry = Array.isArray(battle?.opponent)
      ? battle.opponent[0]
      : battle?.opponent;
    const tag = normalizeTag(opponentEntry?.tag);
    if (tag) tags.add(tag);
  }
  return [...tags];
}

async function buildOpponentStatsByTag(battleLog, excludeTag = null) {
  const tags = extractOpponentTagsFromBattleLog(battleLog);
  const map = new Map();
  let loaded = 0;
  const maxFetches = 8;

  for (const tag of tags) {
    if (loaded >= maxFetches) break;
    if (excludeTag && normalizeTag(excludeTag) === tag) continue;
    try {
      const resp = await fetch(
        `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(`#${tag}`)}/analysis?fast=true`,
        { headers: { Accept: "application/json" } },
      );
      if (!resp.ok) continue;
      const analysis = await resp.json();
      if (analysis && typeof analysis === "object") {
        map.set(tag, analysis);
      }
      loaded += 1;
    } catch (err) {
      console.error(
        "Impossible de charger les stats du joueur adverse :",
        tag,
        err?.message || err,
      );
    }
  }
  return map;
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

function getCurrentWarDayIndex(currentRace) {
  if (!currentRace || typeof currentRace.periodIndex !== "number") return null;
  const index = currentRace.periodIndex;
  return index >= 0 && index <= 3 ? index : null;
}

function getPreviousWarDayIndex(currentRace) {
  const index = getCurrentWarDayIndex(currentRace);
  if (index === null || index <= 0) return null;
  return index - 1;
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

async function mapWithConcurrency(items, limit, mapper) {
  const result = Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const index = cursor;
      cursor += 1;
      result[index] = await mapper(items[index], index);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () =>
    worker(),
  );
  await Promise.all(workers);
  return result;
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

function parseBattleTimestamp(value) {
  if (!value) return null;
  const d = new Date(value);
  if (!Number.isNaN(d.getTime())) return d;

  // fallback: format 20240315T123456.000Z
  const m = /^(.{8}T.{6}\.\d{3}Z)$/.exec(value);
  if (m) {
    const iso = `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}T${value.slice(9, 11)}:${value.slice(11, 13)}:${value.slice(13, 15)}.${value.slice(16, 19)}Z`;
    const d2 = new Date(iso);
    if (!Number.isNaN(d2.getTime())) return d2;
  }

  return null;
}

// Icône selon le ratio score/max : ✅ ≥ 75 %, ⚠️ ≥ 40 %, ❌ sinon
function criterionIcon(score, max) {
  const r = max > 0 ? score / max : 0;
  if (r >= 0.75) return "✅";
  if (r >= 0.4) return "⚠️";
  return "❌";
}

function deckUsageBadge(decksUsed, ignored = false) {
  if (ignored) return "⚪";
  if (typeof decksUsed !== "number" || Number.isNaN(decksUsed)) return "❔";
  if (decksUsed >= 16) return "<:success:1499002702208958577>";
  if (decksUsed >= 12) return "<:warning:1499002725965500577>";
  return "<:error:1499002755841265826>";
}

function formatDeckHistory(weeks) {
  return weeks
    .map((w) => {
      const badge = deckUsageBadge(w.decksUsed, w.ignored);
      const deck = String(w.decksUsed ?? "-");
      return `${badge} ${deck.padStart(2, " ")}`;
    })
    .join("  ");
}

function formatPointHistory(weeks) {
  return weeks
    .map((w) => String(Number.isFinite(w.fame) ? w.fame : 0))
    .join(" · ");
}

function buildHistoryCodeBlock(weeks) {
  const deckLine = `- **Decks :** ${formatDeckHistory(weeks)}`;
  const pointLine = `- **Points :** ${formatPointHistory(weeks)}`;
  return `${deckLine}\n${pointLine}`;
}

async function loadCardDefinitions() {
  const { value } = await getOrSet(
    "clashCardDefinitions",
    () => fetchCards(),
    CARD_DEF_CACHE_TTL,
  );
  return Array.isArray(value) ? value : [];
}

async function fetchImageDataUrl(url, signal) {
  if (!url) return null;
  if (CARD_ICON_CACHE.has(url)) return CARD_ICON_CACHE.get(url);

  const res = await fetch(url, { signal });
  if (!res.ok) return null;

  const buffer = Buffer.from(await res.arrayBuffer());
  const type = res.headers.get("content-type") || "image/png";
  const dataUrl = `data:${type};base64,${buffer.toString("base64")}`;
  CARD_ICON_CACHE.set(url, dataUrl);
  return dataUrl;
}

function escapeText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

async function buildWarDecksImage(warDecks) {
  if (!Array.isArray(warDecks) || warDecks.length === 0) return null;
  let cardDefinitions = [];
  try {
    cardDefinitions = await loadCardDefinitions();
  } catch (err) {
    console.error(
      "Impossible de charger les définitions de cartes pour l'image :",
      err?.message || err,
    );
    cardDefinitions = [];
  }
  const cardById = new Map(
    cardDefinitions
      .filter((card) => card && card.id !== undefined)
      .map((card) => [String(card.id), card]),
  );

  const rows = warDecks.slice(0, 4);
  const cardWidth = 152;
  const cardHeight = 204;
  const cardGap = 8;
  const padding = 20;
  const topLabelHeight = 0;
  const labelSpacing = 0;
  const matchTopSpacing = 6;
  const textLineHeight = 16;
  const deckSpacing = 0;
  const width = padding * 2 + 8 * cardWidth + 7 * cardGap;
  const height =
    padding * 2 +
    topLabelHeight +
    rows.reduce((sum, deck) => {
      const matches = Array.isArray(deck.matches) ? deck.matches : [];
      const matchCount = Math.min(matches.length, 4);
      const matchBlock =
        matchCount > 0 ? matchTopSpacing + matchCount * textLineHeight : 0;
      return sum + cardHeight + matchBlock + deckSpacing;
    }, 0);

  const uniqueUrls = new Map();
  for (const deck of rows) {
    const ids = Array.isArray(deck.cardIds) ? deck.cardIds : [];
    for (const id of ids) {
      const card = cardById.get(String(id));
      if (card?.iconUrls?.medium) {
        uniqueUrls.set(card.iconUrls.medium, null);
      }
    }
  }

  const abortController = new AbortController();
  const abortTimeout = setTimeout(() => abortController.abort(), 9000);
  try {
    await Promise.all(
      [...uniqueUrls.keys()].map(async (url) => {
        try {
          uniqueUrls.set(
            url,
            await fetchImageDataUrl(url, abortController.signal),
          );
        } catch (err) {
          console.error(
            "Impossible de charger l'icône de carte :",
            url,
            err?.message || err,
          );
          uniqueUrls.set(url, null);
        }
      }),
    );
  } catch (err) {
    console.error(
      "Erreur lors de la récupération des images de cartes :",
      err?.message || err,
    );
  } finally {
    clearTimeout(abortTimeout);
  }

  function escapeText(value) {
    return String(value || "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;");
  }

  const deckRows = rows.map((deck, deckIndex) => {
    const yStart = rows.slice(0, deckIndex).reduce((sum, prevDeck) => {
      const matches = Array.isArray(prevDeck.matches) ? prevDeck.matches : [];
      const matchCount = Math.min(matches.length, 4);
      return (
        sum +
        cardHeight +
        labelSpacing +
        matchCount * textLineHeight +
        deckSpacing
      );
    }, padding + topLabelHeight);

    const ids = Array.isArray(deck.cardIds) ? deck.cardIds : [];
    const cardsSvg = ids
      .slice(0, 8)
      .map((id, index) => {
        const card = cardById.get(String(id));
        const url = card?.iconUrls?.medium
          ? uniqueUrls.get(card.iconUrls.medium)
          : null;
        const x = padding + index * (cardWidth + cardGap);
        return url
          ? `<image x="${x}" y="${yStart}" width="${cardWidth}" height="${cardHeight}" href="${url}" preserveAspectRatio="xMidYMid slice"/>`
          : `<rect x="${x}" y="${yStart}" width="${cardWidth}" height="${cardHeight}" rx="12" ry="12" fill="#1f2937"/>`;
      })
      .join("");

    const labelY = yStart + cardHeight + 6;
    const matchLines = Array.isArray(deck.matches) ? deck.matches : [];
    const renderedMatchLines = matchLines.slice(0, 4).map((match, index) => {
      const opponentName = escapeText(match.opponentName || "?");
      const score = escapeText(match.score || "?");
      const resultIcon =
        match.result === "win"
          ? "<:success:1499002702208958577>"
          : "<:error:1499002755841265826>";
      const matchup = Number.isFinite(match.matchup)
        ? `${Math.round(match.matchup * 100)}%`
        : "?";
      const line = `- 👥 ${opponentName} ${resultIcon} ${score} ⚡ ${matchup}`;
      const lineY = labelY + 12 + index * textLineHeight;
      return `<text x="${padding}" y="${lineY}" font-family="Inter, system-ui, sans-serif" font-size="14" fill="#e2e8f0">${escapeText(line)}</text>`;
    });

    return `
      ${cardsSvg}
      ${renderedMatchLines.join("")}
    `;
  });

  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decks GDC">
  <rect width="100%" height="100%" rx="24" fill="#0f172a" />
  ${deckRows.join("")}
</svg>`;

  const svgBuffer = Buffer.from(svg, "utf8");
  try {
    const resvg = new Resvg(svgBuffer, {
      fitTo: { mode: "width", value: width },
      background: "#0f172a",
    });
    const pngData = resvg.render();
    return {
      buffer: Buffer.from(pngData.asPng()),
      mimeType: "image/png",
      filename: "matchup-decks.png",
    };
  } catch (err) {
    console.error("Resvg a échoué pour l'image de deck :", err?.message || err);
    return null;
  }
}

function computeAverageMatchupFromWarDecks(warDecks) {
  if (!Array.isArray(warDecks)) return null;
  const matchups = [];
  for (const deck of warDecks) {
    for (const match of Array.isArray(deck.matches) ? deck.matches : []) {
      if (Number.isFinite(match.matchup)) {
        matchups.push(match.matchup);
      }
    }
  }
  if (matchups.length === 0) return null;
  return matchups.reduce((sum, matchup) => sum + matchup, 0) / matchups.length;
}

function buildWarDecksTextFallbackImage(warDecks) {
  const lines = [];
  if (!Array.isArray(warDecks) || warDecks.length === 0) {
    lines.push("Aucune donnée GDC à afficher.");
  } else {
    const dayGroups = new Map();
    for (
      let deckIndex = 0;
      deckIndex < Math.min(warDecks.length, 4);
      deckIndex += 1
    ) {
      const deck = warDecks[deckIndex];
      const deckLabel = deck.label || `Deck ${deckIndex + 1}`;
      const matchLines = Array.isArray(deck.matches) ? deck.matches : [];

      matchLines.slice(0, 4).forEach((match, matchIndex) => {
        const dayKey = match.dayKey || "";
        const group = dayGroups.get(dayKey) ?? {
          dayKey,
          dayLabel: getWarDayLabel(dayKey),
          decks: new Map(),
        };
        const deckGroup = group.decks.get(deckLabel) ?? {
          label: deckLabel,
          matches: [],
        };
        if (deckGroup.matches.length < 4) {
          deckGroup.matches.push({
            matchIndex,
            ...match,
          });
        }
        group.decks.set(deckLabel, deckGroup);
        dayGroups.set(dayKey, group);
      });
    }

    if (dayGroups.size === 0) {
      lines.push("Aucune donnée de match GDC disponible.");
    } else {
      const sortedDays = [...dayGroups.values()].sort((a, b) =>
        b.dayKey.localeCompare(a.dayKey),
      );
      for (const group of sortedDays.slice(0, 4)) {
        lines.push(`**${group.dayLabel}**`);
        for (const deckGroup of group.decks.values()) {
          for (const [innerIndex, match] of deckGroup.matches.entries()) {
            const opponentName = escapeText(match.opponentName || "?");
            const resultIcon =
              match.result === "win"
                ? "<:success:1499002702208958577>"
                : "<:error:1499002755841265826>";
            const matchup = Number.isFinite(match.matchup)
              ? `${Math.round(match.matchup * 100)}%`
              : "?";
            lines.push(
              `• ${deckGroup.label} #${innerIndex + 1} : <:members:1506175789731811399> ${opponentName} ${resultIcon} ${escapeText(match.score || "?")} ⚡ ${matchup}`,
            );
          }
        }
      }
    }
  }

  const width = 760;
  const lineHeight = 24;
  const height = 40 + lines.length * lineHeight;
  const svg = `<?xml version="1.0" encoding="UTF-8"?>
<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" xmlns="http://www.w3.org/2000/svg" role="img" aria-label="Decks GDC fallback">
  <rect width="100%" height="100%" rx="24" fill="#0f172a" />
  ${lines
    .map(
      (line, index) =>
        `<text x="24" y="${40 + index * lineHeight}" font-family="sans-serif" font-size="16" fill="#e2e8f0">${escapeText(
          line,
        )}</text>`,
    )
    .join("")}
</svg>`;
  const svgBuffer = Buffer.from(svg, "utf8");
  try {
    const resvg = new Resvg(svgBuffer, {
      fitTo: { mode: "width", value: width },
      background: "#0f172a",
    });
    const pngData = resvg.render();
    return {
      buffer: Buffer.from(pngData.asPng()),
      mimeType: "image/png",
      filename: "matchup-decks-fallback.png",
    };
  } catch (err) {
    console.error("Resvg fallback a échoué :", err?.message || err);
    return null;
  }
}

async function sendDiscordWebhookEmbedWithImage(webhookUrl, embed, image) {
  try {
    if (!image?.buffer) {
      return await fetch(webhookUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ embeds: [embed] }),
      });
    }

    const filename = image.filename || "matchup-decks.png";
    const contentType = image.mimeType || "image/png";
    const form = new FormData();
    if (embed?.description) {
      form.append(
        "payload_json",
        JSON.stringify({ content: embed.description }),
      );
    }
    const blob = new Blob([image.buffer], { type: contentType });
    form.append("file", blob, filename);
    return await fetch(webhookUrl, { method: "POST", body: form });
  } catch (err) {
    console.error("Erreur d'envoi webhook Discord :", err);
    return {
      ok: false,
      status: 0,
      statusText: err?.message || "Network error",
      text: async () => String(err?.message || "Network error"),
    };
  }
}

async function sendDiscordWebhookFile(webhookUrl, image, options = {}) {
  try {
    const filename = image.filename || "matchup-decks.png";
    const contentType = image.mimeType || "image/png";
    const form = new FormData();
    const payload = {};
    if (typeof options === "string") {
      payload.content = options;
    } else if (options?.content) {
      payload.content = options.content;
    }
    let useIndexedFile = false;
    if (options?.embed) {
      payload.embeds = [options.embed];
      if (options.embed.image?.url?.startsWith("attachment://")) {
        payload.attachments = [
          {
            id: 0,
            filename,
          },
        ];
        useIndexedFile = true;
      }
    }
    form.append("payload_json", JSON.stringify(payload));
    const blob = new Blob([image.buffer], { type: contentType });
    if (useIndexedFile) {
      form.append("files[0]", blob, filename);
    } else {
      form.append("file", blob, filename);
    }
    const response = await fetch(webhookUrl, { method: "POST", body: form });
    if (!response.ok) {
      const text = await response.text();
      console.error(
        "Discord file webhook failed:",
        response.status,
        response.statusText,
        text,
      );
    }
    return response;
  } catch (err) {
    console.error("Erreur d'envoi webhook Discord (file) :", err);
    return {
      ok: false,
      status: 0,
      statusText: err?.message || "Network error",
      text: async () => String(err?.message || "Network error"),
    };
  }
}

const WAR_DAY_SHORT_LABELS_BY_UTC_DAY = {
  4: "J1",
  5: "J2",
  6: "J3",
  0: "J4",
};

function getWarDayLabel(dayKey) {
  if (!dayKey) return "Jour GDC";
  const date = new Date(`${dayKey}T00:00:00Z`);
  return WAR_DAY_SHORT_LABELS_BY_UTC_DAY[date.getUTCDay()] || dayKey;
}

function getWarMatchTypeLabel(type) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "riverracepvp") return "(PvP)";
  if (normalized === "riverraceboat") return "(Bateau)";
  if (normalized === "riverraceduel" || normalized === "riverraceduelcolosseum")
    return "(Duel)";
  return "";
}

function formatWarDecksField(warDecks) {
  if (!Array.isArray(warDecks)) return null;

  const maxDecks = 4;
  const maxDays = 4;
  const maxMatchesPerDeck = 4;
  const dayGroups = new Map();
  const deckOrder = [];

  warDecks.forEach((deck, deckIndex) => {
    const deckLabel = deck.label || `Deck ${deckIndex + 1}`;
    if (!deckOrder.includes(deckLabel)) deckOrder.push(deckLabel);
    const matchLines = Array.isArray(deck.matches) ? deck.matches : [];

    matchLines.forEach((match, matchIndex) => {
      const dayKey = match.dayKey || "";
      const group = dayGroups.get(dayKey) ?? {
        dayKey,
        dayLabel: getWarDayLabel(dayKey),
        decks: new Map(),
      };

      const deckGroup = group.decks.get(deckLabel) ?? {
        deckLabel,
        matches: [],
      };
      deckGroup.matches.push({ matchIndex, ...match });
      group.decks.set(deckLabel, deckGroup);
      dayGroups.set(dayKey, group);
    });
  });

  if (dayGroups.size === 0) return null;

  const sortedDays = [...dayGroups.values()]
    .sort((a, b) => b.dayKey.localeCompare(a.dayKey))
    .slice(0, maxDays);

  const getWarMatchPoints = (match) => {
    const type = String(match.type || "").toLowerCase();
    const result = match.result === "win" ? "win" : "loss";
    if (type === "riverracepvp") return result === "win" ? 200 : 100;
    if (type === "riverraceboat") return result === "win" ? 125 : 75;
    if (type === "riverraceduel" || type === "riverraceduelcolosseum")
      return result === "win" ? 250 : 100;
    return 0;
  };

  const groupBlocks = sortedDays.map((group, groupIndex) => {
    const isOldestDay = groupIndex === sortedDays.length - 1;
    const deckLabels = [...group.decks.keys()].slice(0, maxDecks);
    const displayedMatches = [];
    const deckLines = [];
    const groupLines = groupIndex > 0 ? [""] : [];

    let deckCount = 0;
    for (const [deckIndex, deckLabel] of deckLabels.entries()) {
      const deckGroup = group.decks.get(deckLabel);
      if (!deckGroup) continue;
      deckCount += 1;
      if (deckCount > maxDecks) break;
      const displayDeckLabel = deckGroup.label || `Deck ${deckIndex + 1}`;

      deckGroup.matches
        .slice(0, maxMatchesPerDeck)
        .forEach((match, matchIndex) => {
          const opponentName = escapeText(match.opponentName || "?");
          const resultEmoji =
            match.result === "win"
              ? "<:success:1499002702208958577>"
              : "<:error:1499002755841265826>";
          const score = escapeText(match.score || "?");
          const matchup = Number.isFinite(match.matchup)
            ? `${Math.round(match.matchup * 100)}%`
            : "?";
          const typeLabel = getWarMatchTypeLabel(match.type);
          const displayLabelWithType = [displayDeckLabel, typeLabel]
            .filter(Boolean)
            .join(" ");
          deckLines.push(
            `• ${displayLabelWithType} : <:members:1506175789731811399> ${opponentName} ${resultEmoji} ${score} ⚡ ${matchup}`,
          );
          displayedMatches.push(match);
        });
    }

    // Ajouter "Manquant" pour les jours incomplets (sauf le plus ancien, tronqué par l'API)
    if (!isOldestDay && displayedMatches.length < 4) {
      const missingCount = 4 - displayedMatches.length;
      for (let i = 0; i < missingCount; i++) {
        displayedMatches.push({
          result: "loss",
          type: null,
          matchup: null,
          opponentName: "Manquant",
          opponentTourLevel: null,
          score: "0-0",
        });
        deckLines.push(`• Manquant <:error:1499002755841265826> ⚡ ?`);
      }
    }

    // Stats calculées uniquement sur les combats affichés + Manquant
    const points = displayedMatches.reduce(
      (sum, match) => sum + getWarMatchPoints(match),
      0,
    );
    const wins = displayedMatches.filter((m) => m.result === "win").length;
    const total = displayedMatches.length;
    const winRate = total > 0 ? Math.round((wins / total) * 100) : 0;
    const showStats = isOldestDay ? displayedMatches.length >= 4 : true;
    const daySuffix = showStats ? `(${points}pts · winrate ${winRate}%)` : "";

    groupLines.push(`**${group.dayLabel}${daySuffix ? ` ${daySuffix}` : ""}**`);
    groupLines.push(...deckLines);
    return groupLines.join("\n");
  });

  let blocks = groupBlocks;
  let value = blocks.join("\n");

  const maxDescriptionLength = 4096;
  while (value.length > maxDescriptionLength && blocks.length > 1) {
    // Si le texte est trop long, on commence par tronquer le bloc le plus récent,
    // afin de préserver les jours plus anciens comme J2 tant que possible.
    const trimIndex = 0;
    const trimLines = blocks[trimIndex].split("\n");
    if (trimLines.length > 2) {
      trimLines.pop();
      blocks[trimIndex] = trimLines.join("\n");
    } else {
      blocks = blocks.filter((_, index) => index !== trimIndex);
    }
    value = blocks.join("\n");
  }

  if (value.length > maxDescriptionLength && blocks.length === 1) {
    const lines = value.split("\n");
    while (value.length > maxDescriptionLength && lines.length > 1) {
      lines.pop();
      value = lines.join("\n");
    }
  }

  return value;
}

function buildScoreBreakdownCodeBlock(score) {
  const breakdown = Array.isArray(score?.breakdown) ? score.breakdown : [];
  if (breakdown.length === 0) {
    return "Aucun détail de fiabilité disponible.";
  }

  const orderedBreakdown = [...breakdown].sort((a, b) => b.max - a.max);
  const rows = [];
  let maxLabel = 0;
  for (const item of orderedBreakdown) {
    const label = LABEL_FR[item.label] || item.label;
    if (label.length > maxLabel) maxLabel = label.length;
  }
  for (const item of orderedBreakdown) {
    const icon = criterionIcon(item.score, item.max);
    const label = LABEL_FR[item.label] || item.label;
    const scoreStr = `${item.score}/${item.max}`;
    rows.push(`${icon} ${label.padEnd(maxLabel)} ${scoreStr}`);
  }
  return "```\n" + rows.join("\n") + "\n```";
}

const SCORE_BADGES = {
  success: "<:success:1499002702208958577>",
  warning: "<:warning:1499002725965500577>",
  error: "<:error:1499002755841265826>",
};

function scoreBadge(score, max) {
  const r = max > 0 ? score / max : 0;
  if (r >= 0.75) return SCORE_BADGES.success;
  if (r >= 0.4) return SCORE_BADGES.warning;
  return SCORE_BADGES.error;
}

function buildReliabilityFields(score) {
  const breakdown = Array.isArray(score?.breakdown) ? score.breakdown : [];
  if (breakdown.length === 0) return null;

  const orderedBreakdown = [...breakdown].sort((a, b) => b.max - a.max);
  const lines = orderedBreakdown.map((item) => {
    const badge = scoreBadge(item.score, item.max);
    const label = LABEL_FR[item.label] || item.label;
    return `${badge} ${label} (${item.score}/${item.max})`;
  });

  return [
    {
      name: "Détails fiabilité :",
      value: lines.join("\n") || "\u200b",
      inline: false,
    },
  ];
}

function isRiverRaceBattle(type) {
  const t = (type ?? "").toLowerCase();
  return [
    "riverracepvp",
    "riverraceduel",
    "riverraceduelscolosseum",
    "riverraceboat",
    "clanwarbattle",
  ].includes(t);
}

function formatParisHourRange(startUtcMinutes) {
  const pad = (value) => String(value).padStart(2, "0");
  const baseUtc = new Date(Date.UTC(2000, 0, 1, 0, 0, 0));
  const startUtc = new Date(baseUtc.getTime() + startUtcMinutes * 60000);
  const endUtc = new Date(startUtc.getTime() + 60 * 60000);

  const startParis = new Date(
    startUtc.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  const endParis = new Date(
    endUtc.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );

  return `${pad(startParis.getHours())}h${pad(startParis.getMinutes())} - ${pad(
    endParis.getHours(),
  )}h${pad(endParis.getMinutes())}`;
}

function buildAverageRaceTimeRange(battleLog, clanTag) {
  if (!Array.isArray(battleLog) || battleLog.length === 0) return null;
  const CLAN_RESETS_UTC = { Y8JUPC9C: 590 };
  const normalizedTag = (clanTag ?? "").replace(/^#/, "").toUpperCase();
  const resetUtcMinutes = CLAN_RESETS_UTC[normalizedTag] ?? 580;
  const counts = Array(24).fill(0);
  let totalGdc = 0;

  for (const b of battleLog) {
    if (!isRiverRaceBattle(b.type)) continue;
    const parsed = parseBattleTimestamp(
      b.battleTime ||
        b.battleTimeStamp ||
        b.battle_time ||
        b.battleTimeStampLocal,
    );
    if (!parsed) continue;
    const minutes = parsed.getUTCHours() * 60 + parsed.getUTCMinutes();
    const offset = (((minutes - resetUtcMinutes) % 1440) + 1440) % 1440;
    const bin = Math.floor(offset / 60);
    counts[bin] += 1;
    totalGdc += 1;
  }

  if (totalGdc === 0) return null;
  const maxCount = Math.max(...counts);
  if (maxCount <= 0) return null;
  const bin = counts.findIndex((c) => c === maxCount);
  return formatParisHourRange((resetUtcMinutes + bin * 60) % 1440);
}

function buildSparkline(values) {
  if (!Array.isArray(values) || values.length === 0) return "";
  const min = Math.min(...values);
  const max = Math.max(...values);
  if (min === max) return "█".repeat(values.length);
  const blocks = ["▁", "▂", "▃", "▄", "▅", "▆", "▇", "█"];
  return values
    .map((value) => {
      const ratio = (value - min) / (max - min);
      const index = Math.min(
        blocks.length - 1,
        Math.max(0, Math.round(ratio * (blocks.length - 1))),
      );
      return blocks[index];
    })
    .join("");
}

// Construit la section "Autres comptes connus" pour un tag donné.
// Renvoie un field Discord ou null si aucun autre compte n'est trouvé.
async function buildOtherAccountsField(playerTag, discordLinks) {
  const normalizedTag = normalizeClashTag(playerTag);
  const discordUserId = discordLinks[normalizedTag];
  if (!discordUserId) return null;

  const otherTags = Object.entries(discordLinks)
    .filter(
      ([t, uid]) =>
        String(uid) === String(discordUserId) &&
        normalizeClashTag(t) !== normalizedTag,
    )
    .map(([t]) => normalizeClashTag(t));

  if (otherTags.length === 0) return null;

  const resolved = await Promise.all(
    otherTags.map(async (t) => {
      try {
        const p = await fetchPlayer(t);
        const name = String(p?.name ?? "").trim() || t;
        const clanName = p?.clan?.name ?? null;
        return { tag: t, name, clanName };
      } catch {
        return { tag: t, name: t, clanName: null };
      }
    }),
  );

  const lines = resolved.map(({ tag, name, clanName }) => {
    const url = trustPlayerUrl(tag);
    const clan = clanName ? ` (${clanName})` : "";
    return `- [${name}](${url})${clan}`;
  });

  return {
    name: "Autres comptes connus :",
    value: lines.join("\n"),
    inline: false,
  };
}

// Convertit un critère de breakdown en field Discord (inline)
// et effectue la traduction française des libellés.
const LABEL_FR = {
  "War Activity": "Activité de GDC",
  "CW2 badge": "Badge CW2",
  "CW2 Battle Wins": "Badge CW2",
  "General Activity": "Activité générale",
  Experience: "Expérience",
  Regularity: "Régularité",
  "Avg Score": "Points / deck",
  "Points / Deck": "Points / deck",
  Stability: "Stabilité",
  "Last Seen": "Connexion régulière",
  Points: "Points",
  "Member Reliability": "Fiabilité membre",
  "Historical Win Rate": "Winrate historique",
  // fallback: other labels can be added if needed
};
function breakdownField(item) {
  const icon = criterionIcon(item.score, item.max);
  let label = LABEL_FR[item.label] || item.label;
  if (item.label === "Discord")
    label = `Discord (${item.score > 0 ? "oui" : "non"})`;
  return {
    name: `${icon} ${label}`,
    value: `${item.score}/${item.max}`,
    inline: true,
  };
}

// simple utility used by promote handler
function capitalize(str) {
  return str && str.length ? str[0].toUpperCase() + str.slice(1) : "";
}

function normalizeClanTag(tag) {
  if (!tag) return "";
  const raw = String(tag).trim().toUpperCase();
  return raw.startsWith("#") ? raw : `#${raw}`;
}

let warClinchLogCache = null;

async function loadWarClinchLog() {
  if (warClinchLogCache) return warClinchLogCache;
  try {
    const { readFile } = await import("fs/promises");
    const { fileURLToPath } = await import("url");
    const { default: path } = await import("path");
    const __dirname = path.dirname(fileURLToPath(import.meta.url));
    const filePath = path.resolve(__dirname, "../../data/war-clinch-log.json");
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

// Calcule la largeur visuelle d'une chaîne en monospace :
// les symboles Misc, CJK et emoji comptent pour 2 colonnes,
// les caractères ASCII normaux pour 1.
function displayWidth(str) {
  let w = 0;
  for (const ch of str) {
    const cp = ch.codePointAt(0);
    if (
      (cp >= 0x1100 && cp <= 0x115f) ||
      (cp >= 0x2e80 && cp <= 0x9fff) ||
      (cp >= 0xa000 && cp <= 0xa4cf) ||
      (cp >= 0xac00 && cp <= 0xd7af) ||
      (cp >= 0xf900 && cp <= 0xfaff) ||
      (cp >= 0xfe10 && cp <= 0xfe6f) ||
      (cp >= 0xff00 && cp <= 0xff60) ||
      (cp >= 0xffe0 && cp <= 0xffe6) ||
      (cp >= 0x1f004 && cp <= 0x1ffff) ||
      (cp >= 0x2600 && cp <= 0x27bf) // Misc Symbols : ♠♦♥♣☆ etc.
    ) {
      w += 2;
    } else {
      w += 1;
    }
  }
  return w;
}

// Équivalent de padEnd mais qui tient compte de la largeur visuelle.
function padEndDisplay(str, width) {
  const dw = displayWidth(str);
  return str + " ".repeat(Math.max(0, width - dw));
}

// ── Discord Links — stockage GitHub ─────────────────────────────────────────
// Les liens Clash tag → Discord user ID sont persistés dans data/discord-links.json
// via l'API GitHub Contents pour survivre aux redéploiements Vercel.

async function readDiscordLinks() {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token) return { links: {}, sha: null };
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/data/discord-links.json`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!res.ok) return { links: {}, sha: null };
    const data = await res.json();
    const links = JSON.parse(
      Buffer.from(data.content, "base64").toString("utf8"),
    );
    return { links, sha: data.sha };
  } catch {
    return { links: {}, sha: null };
  }
}

function normalizeClashTag(tag) {
  if (!tag) return "";
  const raw = String(tag).trim().toUpperCase();
  if (!raw) return "";
  return raw.startsWith("#") ? raw : `#${raw}`;
}

function getLinkedTagsForDiscordUser(links, discordUserId) {
  const userId = String(discordUserId ?? "").trim();
  if (!userId) return [];

  const tags = [];
  for (const [tag, linkedUserId] of Object.entries(links ?? {})) {
    if (String(linkedUserId) !== userId) continue;
    const normalizedTag = normalizeClashTag(tag);
    if (normalizedTag) tags.push(normalizedTag);
  }

  return [...new Set(tags)].sort((a, b) => a.localeCompare(b));
}

function getCachedTagName(tag) {
  const entry = tagNameCache.get(tag);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > TAG_NAME_CACHE_TTL) {
    tagNameCache.delete(tag);
    return null;
  }
  return entry.name;
}

async function getClashTagName(tag) {
  const normalizedTag = normalizeClashTag(tag);
  if (!normalizedTag) return null;

  const cachedName = getCachedTagName(normalizedTag);
  if (cachedName) return cachedName;

  try {
    const player = await fetchPlayer(normalizedTag);
    const name = String(player?.name ?? "").trim();
    if (name) {
      tagNameCache.set(normalizedTag, { name, updatedAt: Date.now() });
      return name;
    }
  } catch {
    // Si le profil n'est pas disponible, on conserve juste le tag.
  }

  return null;
}

async function buildTagAutocompleteChoices(body, links) {
  const focusedOption = body.data?.options?.find((option) => option.focused);
  const currentValue = String(focusedOption?.value ?? "")
    .trim()
    .toUpperCase();
  const prefix = currentValue.replace(/^#/, "");
  const discordUserId = body.member?.user?.id ?? body.user?.id ?? "";

  const linkedTags = getLinkedTagsForDiscordUser(links, discordUserId);
  const filteredTags = prefix
    ? linkedTags.filter((tag) => tag.slice(1).startsWith(prefix))
    : linkedTags;

  const limitedTags = filteredTags.slice(0, 25);
  const resolvedNames = await Promise.all(
    limitedTags.map(async (tag) => ({ tag, name: await getClashTagName(tag) })),
  );

  return resolvedNames.map(({ tag, name }) => ({
    name: name ? `${name} (${tag})` : tag,
    value: tag,
  }));
}

async function writeDiscordLinks(links, sha, message) {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;
  if (!repo || !token || !sha) return false;
  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/data/discord-links.json`,
      {
        method: "PUT",
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          message,
          content: Buffer.from(JSON.stringify(links, null, 2) + "\n").toString(
            "base64",
          ),
          sha,
        }),
      },
    );
    return res.ok;
  } catch {
    return false;
  }
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const signature = req.headers["x-signature-ed25519"];
  const timestamp = req.headers["x-signature-timestamp"];

  // Lecture du corps brut (nécessaire pour vérifier la signature)
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  const rawBody = Buffer.concat(chunks).toString("utf8");

  // Vérification de signature obligatoire *avant tout*, y compris pour les PINGs.
  // Discord teste explicitement que le endpoint rejette les requêtes sans signature valide.
  if (!verifyDiscordSignature(signature, timestamp, rawBody)) {
    return res.status(401).end("invalid request signature");
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).end("invalid json");
  }

  // Discord PING — répond après vérification de signature (requis par Discord pour valider l'endpoint)
  if (body.type === 1) {
    return res.status(200).json({ type: 1 });
  }

  // Vérification de la liste blanche des serveurs autorisés.
  // Effectuée en premier, avant tout traitement métier, pour minimiser le temps d'exécution.
  const authorizedGuilds = (process.env.AUTHORIZED_GUILD_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  const authorizedPingIds = new Set(
    (process.env.AUTHORIZED_PING_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );

  // Autocomplete pour /champion select: — challengers de la session active
  if (body.type === 4 && body.data?.name === "champion") {
    const focused = body.data.options?.find((o) => o.focused);
    if (focused?.name !== "select") {
      return res.status(200).json({ type: 8, data: { choices: [] } });
    }

    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const clanVal = clanOpt?.value || "1";
    const CLAN_MAP = {
      1: { tag: "Y8JUPC9C" },
      la: { tag: "Y8JUPC9C" },
      2: { tag: "LRQP20V9" },
      les: { tag: "LRQP20V9" },
      3: { tag: "QU9UQJRL" },
    };
    const resolved =
      CLAN_MAP[String(clanVal).trim().toLowerCase()] ?? CLAN_MAP["1"];

    try {
      const { getActiveSessionByClan } =
        await import("../../backend/services/championPredictions.js");
      const active = await getActiveSessionByClan(resolved.tag);
      if (!active) {
        return res.status(200).json({ type: 8, data: { choices: [] } });
      }

      const input = (focused.value || "").toLowerCase();
      const challengerChoices = active.session.challengers
        .filter(
          (c) =>
            !input ||
            c.name.toLowerCase().includes(input) ||
            c.tag.toLowerCase().includes(input),
        )
        .map((c, idx) => ({
          name: `${idx + 1}. ${c.name} — ${Number.isFinite(c.fame) ? c.fame.toLocaleString("fr-FR") : "0"} pts`,
          value: c.tag,
        }))
        .slice(0, 24);

      // Ajouter "Autre" comme dernier choix
      challengerChoices.push({
        name: `9. Autre (pas dans la liste)`,
        value: "__other__",
      });

      return res
        .status(200)
        .json({ type: 8, data: { choices: challengerChoices } });
    } catch {
      return res.status(200).json({ type: 8, data: { choices: [] } });
    }
  }

  if (body.type === 4 && TAG_AUTOCOMPLETE_COMMANDS.has(body.data?.name)) {
    if (
      authorizedGuilds.length > 0 &&
      !authorizedGuilds.includes(body.guild_id)
    ) {
      return res.status(200).json({ type: 8, data: { choices: [] } });
    }

    const links = await getDiscordLinks();
    const choices = await buildTagAutocompleteChoices(body, links);
    return res.status(200).json({ type: 8, data: { choices } });
  }

  if (
    authorizedGuilds.length > 0 &&
    !authorizedGuilds.includes(body.guild_id)
  ) {
    return res.status(200).json({
      type: 4,
      data: {
        content:
          "🚫 Ce serveur n'est pas autorisé à utiliser l'instance officielle de TrustRoyale. Contactez l'administrateur pour enregistrer votre guilde.",
        flags: 64,
      },
    });
  }

  // Commande /trust
  if (body.type === 2 && body.data?.name === "trust") {
    const tagOption = body.data.options?.find((o) => o.name === "tag");
    const rawTag = tagOption?.value?.trim();
    if (!rawTag) {
      return res.status(200).json({
        type: 4,
        data: {
          content: "Veuillez fournir un tag de joueur (ex: `#ABC123`).",
          flags: 64,
        },
      });
    }

    // Réponse différée immédiate — satisfait la fenêtre de 3 s de Discord.
    // waitUntil garantit que Vercel maintient la fonction active jusqu'à la fin de l'analyse.
    res.status(200).json({ type: 5 });

    const tag = rawTag.startsWith("#") ? rawTag : `#${rawTag}`;
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        // Appel interne à notre propre endpoint d'analyse (évite de redupliquer la logique)
        // On utilise l'URL canonique pour éviter les redirections vers une instance froide
        const apiResp = await fetch(
          `https://trustroyale.vercel.app/api/player/${encodeURIComponent(tag)}/analysis?fast=true`,
          { headers: { Accept: "application/json" } },
        );

        // --- déclencher snapshots pour tous les clans autorisés ---
        // c'est léger (3 appels à RoyaleAPI) et fait gagner un cycle aux visiteurs.
        // Si l'un d'eux échoue, on s'en fiche.
        const [{ ALLOWED_CLANS }, { fetchRaceLog }, { recordSnapshot }] =
          await Promise.all([
            import("../../backend/routes/clan.js"),
            import("../../backend/services/clashApi.js"),
            import("../../backend/services/snapshot.js"),
          ]);
        ALLOWED_CLANS.forEach((clanTag) => {
          fetchRaceLog(clanTag)
            .then((log) => {
              if (Array.isArray(log) && log.length) {
                const standing = log[0].standings.find(
                  (s) => s.clan?.tag?.toUpperCase() === `#${clanTag}`,
                );
                const participants = standing?.clan?.participants || [];
                const weekId = `S${log[0].seasonId}W${log[0].sectionIndex + 1}`;
                recordSnapshot(clanTag, participants, weekId).catch((err) =>
                  console.warn(
                    "[snapshot] recordSnapshot failed for",
                    clanTag,
                    ":",
                    err.message,
                  ),
                );
              }
            })
            .catch((err) =>
              console.warn(
                "[snapshot] fetchRaceLog failed for",
                clanTag,
                ":",
                err.message,
              ),
            );
        });

        if (!apiResp.ok) {
          const msg =
            apiResp.status === 404
              ? `Joueur \`${tag}\` introuvable.`
              : `Erreur API (${apiResp.status}).`;
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: msg, flags: 64 }),
          });
          return;
        }

        const analysis = await apiResp.json();
        const score = analysis.warScore ?? analysis.reliability;
        const { total, maxScore, pct, color, verdict } = score;
        const icon = RELIABILITY_ICON[color] ?? "⚪";
        const embedColor = COLOR_MAP[color] ?? 0x808080;
        const verdictFr = FR_VERDICTS[color] ?? verdict ?? "Fiabilité inconnue";

        const breakdownFields = buildReliabilityFields(score);
        const description = `${tag}`;

        const discordLinks = await getDiscordLinks();
        const otherAccountsField = await buildOtherAccountsField(
          tag,
          discordLinks,
        );

        const fields = [
          {
            name: "Fiabilité :",
            value: `${icon} ${pct} % (${verdictFr})`,
            inline: false,
          },
          ...(breakdownFields ?? []),
          ...(otherAccountsField ? [otherAccountsField] : []),
        ];

        const embed = {
          title: `<:interrogation:1493849417520906271> Joueur : ${analysis.overview.name}`,
          url: trustPlayerUrl(tag),
          color: embedColor,
          description,
          fields,
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
            content: `Erreur lors de l'analyse : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /help
  if (body.type === 2 && body.data?.name === "help") {
    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const embed = {
          title:
            "<:interrogation:1493849417520906271> TrustRoyale — Guide des commandes",
          color: 0x5865f2,
          description:
            "**Trust**\n" +
            "Commande : `/trust tag:#TAG`\n" +
            "Usage : donne le score de fiabilité d'un joueur à partir de son tag\n\n" +
            "**Stats**\n" +
            "Commande : `/stats tag:#TAG`\n" +
            "Usage : affiche les statistiques GDC détaillées d'un membre de la famille\n\n" +
            "**Trust Clan**\n" +
            "Commande : `/trust-clan clan:N`\n" +
            "Usage : liste les membres risqués du clan\n\n" +
            "**Promote**\n" +
            "Commande : `/promote clan:N`\n" +
            "Usage : liste les joueurs ≥ 2600 pts semaine précédente\n\n" +
            "**Quota**\n" +
            "Commande : `/quota clan:N quota:[1600|1800|2000|2200|2400]`\n" +
            "Usage : affiche la moyenne GDC et les joueurs sous quota (semaine précédente)\n\n" +
            "**Demote**\n" +
            "Commande : `/demote clan:N`\n" +
            "Usage : liste les joueurs n'ayant pas joué 16/16 decks (semaine précédente)\n\n" +
            "**Fail**\n" +
            "Commande : `/fail clan:N`\n" +
            "Usage : affiche les joueurs qui ont manqué une journée de GDC hier\n\n" +
            "**Late**\n" +
            "Commande : `/late clan:N`\n" +
            "Usage : liste les retardataires GDC actuels (à faire avant reset)\n\n" +
            "**Late Ping**\n" +
            "Commande : `/late-ping clan:N`\n" +
            "Usage : liste les retardataires GDC actuels avec ping Discord des membres liés (réservé au staff)\n\n" +
            "**Compare**\n" +
            "Commande : `/compare clan:N`\n" +
            "Usage : compare les 5 clans du groupe GDC\n\n" +
            "**Family**\n" +
            "Commande : `/family`\n" +
            "Usage : affiche un résumé des clans de la famille\n\n" +
            "**Clan**\n" +
            "Commande : `/clan clan:N|tag:#TAG`\n" +
            "Usage : affiche la fiche récapitulative d'un clan (famille ou tag libre)\n\n" +
            "**Stats Clan**\n" +
            "Commande : `/stats-clan clan:N`\n" +
            "Usage : statistiques GDC détaillées de tous les membres, avec boutons pour changer le tri\n\n" +
            "**Chelem**\n" +
            "Commande : `/chelem clan:N [season:X]`\n" +
            "Usage : joueurs ayant fait 16/16 decks toutes semaines d'une saison entière\n\n" +
            "**Top Players**\n" +
            "Commande : `/top-players number:[3|5|10] period:[week|season|all-time]`\n" +
            "Usage : meilleurs joueurs de toute la famille (semaine, saison précédente ou tous les temps)\n\n" +
            "**Top Clans**\n" +
            "Commande : `/top-clans [start:N]`\n" +
            "Usage : affiche 30 clans du classement France GDC à partir du rang N (défaut : 1)\n\n" +
            "**Collection**\n" +
            "Commande : `/collection tag:#TAG`\n" +
            "Usage : statistiques de collection (cartes, niveaux, évolutions, héros, niveau de collection)\n\n" +
            "**Pronostics GDC**\n" +
            "Commande : `/champion select:NOM` ou menu déroulant\n" +
            "Usage : vote pour un challenger dans les pronostics en cours\n\n" +
            "**Décompte Votes**\n" +
            "Commande : `/champion-count clan:CLAN`\n" +
            "Usage : état des votes en cours\n\n" +
            "**Historique Champions**\n" +
            "Commande : `/champion-history clan:CLAN`\n" +
            "Usage : historique des champions GDC passés\n\n" +
            "**Discord Link**\n" +
            "Commande : `/discord-link tag:#TAG [tag2] [tag3]`\n" +
            "Usage : lie ton tag Clash à Discord (à faire par un membre)\n\n" +
            "**Discord Check**\n" +
            "Commande : `/discord-check clan:N`\n" +
            "Usage : vérifie la présence Discord des membres d'un clan\n\n" +
            "**Help**\n" +
            "Commande : `/help`\n" +
            "Usage : affiche cette fenêtre",
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
          await import("../../backend/services/clashApi.js");
        const { computeTopPlayers } =
          await import("../../backend/services/topplayers.js");
        // fetch clan members to get roles
        const members = await fetchClanMembers(`#${clanTag}`);
        const { fetchRaceLog } =
          await import("../../backend/services/clashApi.js");
        const raceLog = await fetchRaceLog(`#${clanTag}`);
        const top = await computeTopPlayers(clanTag, members, [min], raceLog);
        let players = top.playersByQuota[min] || [];
        players = players.slice().sort((a, b) => b.fame - a.fame);

        // Déduire le weekId depuis le raceLog (première entrée = semaine précédente)
        const { computePrevWeekId } =
          await import("../../backend/services/dateUtils.js");
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
            text: `Quota : ${min} · Semaine : ${weekId}`,
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

  // Commande /quota
  if (body.type === 2 && body.data?.name === "quota") {
    const clanOpt = body.data.options?.find((o) => o.name === "clan");
    const quotaOpt = body.data.options?.find((o) => o.name === "quota");
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

    const quota = Number(quotaOpt?.value);
    const allowedQuotas = [1600, 1800, 2000, 2200, 2400];
    const quotaValue =
      Number.isFinite(quota) && allowedQuotas.includes(quota) ? quota : 2000;
    const clanVal = (clanOpt?.value || "1").toString().trim().toLowerCase();
    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      la: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      les: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];
    const clanName = resolved.name;
    const clanTag = resolved.tag;

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const clan = await fetchClan(`#${clanTag}`);
        const clanMembers = await fetchClanMembers(`#${clanTag}`);
        const memberTags = new Set(
          clanMembers.map((m) =>
            String(m.tag || "")
              .replace(/^#/, "")
              .toUpperCase(),
          ),
        );
        const raceLog = await fetchRaceLog(`#${clanTag}`);
        const decksPerDay = Math.min(
          4,
          Math.max(1, Math.floor((clan.clanWarTrophies ?? 0) / 1000) + 1),
        );
        const maxDecks = decksPerDay * 4;
        const { buildWarHistory } =
          await import("../../backend/services/warHistory.js");
        const streakCache = new Map();
        const getStreak = (tag) => {
          const norm = tag.startsWith("#") ? tag : `#${tag}`;
          if (!streakCache.has(norm)) {
            const history = buildWarHistory(norm, raceLog, `#${clanTag}`);
            streakCache.set(norm, history.streakInCurrentClan);
          }
          return streakCache.get(norm);
        };
        const clanTagNorm = String(clanTag).replace(/^#/, "").toUpperCase();
        const weekEntries = (Array.isArray(raceLog) ? raceLog.slice(0, 2) : [])
          .map((entry) => {
            if (entry.seasonId == null || entry.sectionIndex == null)
              return null;
            const weekId = `S${entry.seasonId}W${entry.sectionIndex + 1}`;
            const standing = (entry.standings ?? []).find(
              (s) =>
                String(s.clan?.tag || "")
                  .replace(/^#/, "")
                  .toUpperCase() === clanTagNorm,
            );
            const participants = (standing?.clan?.participants ?? []).filter(
              (p) =>
                memberTags.has(
                  String(p.tag || "")
                    .replace(/^#/, "")
                    .toUpperCase(),
                ),
            );
            const activePlayers = participants.filter(
              (p) =>
                (Number.isFinite(p.decksUsed) && p.decksUsed > 0) ||
                (Number.isFinite(p.fame) && p.fame > 0),
            );
            const totalFame = activePlayers.reduce(
              (sum, p) => sum + (Number.isFinite(p.fame) ? p.fame : 0),
              0,
            );
            const average =
              activePlayers.length > 0
                ? Math.round(totalFame / activePlayers.length)
                : 0;
            const below = activePlayers
              .slice()
              .filter(
                (p) => (Number.isFinite(p.fame) ? p.fame : 0) < quotaValue,
              );
            const arrivals = below.filter((p) =>
              isJoinedThisWar(
                getStreak(p.tag),
                null,
                p.decksUsed ?? 0,
                maxDecks,
              ),
            );
            return {
              weekId,
              activePlayers,
              average,
              belowQuota: below
                .filter(
                  (p) =>
                    !isJoinedThisWar(
                      getStreak(p.tag),
                      null,
                      p.decksUsed ?? 0,
                      maxDecks,
                    ),
                )
                .sort(
                  (a, b) =>
                    (Number.isFinite(a.fame) ? a.fame : 0) -
                    (Number.isFinite(b.fame) ? b.fame : 0),
                ),
              arrivalsExcluded: arrivals.length,
              arrivalsExcludedNames: arrivals.map((p) => p.name),
              topPlayers: activePlayers
                .slice()
                .sort(
                  (a, b) =>
                    (Number.isFinite(b.fame) ? b.fame : 0) -
                    (Number.isFinite(a.fame) ? a.fame : 0),
                )
                .slice(0, 5),
            };
          })
          .filter(Boolean);

        const fmt = (n) =>
          Number.isFinite(n) ? n.toLocaleString("fr-FR") : "?";
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
        const warLeagueLabel = (trophies) => {
          const label = getLeagueName(trophies ?? null, "fr") || "—";
          const icon = LEAGUE_ICON_GENERIC[label];
          return icon ? `${icon} ${label}` : label;
        };
        const league = warLeagueLabel(clan.clanWarTrophies ?? 0);
        const clanUrl = trustClanUrl(resolved.tag);
        const { computePrevWeekId } =
          await import("../../backend/services/dateUtils.js");
        const weekId = computePrevWeekId(raceLog) || "S?";

        const formatPlayerList = (players, fallback) => {
          if (!players || players.length === 0) return fallback;
          return players
            .map((p, idx) => {
              const playerUrl = trustPlayerUrl(p.tag);
              return `${idx + 1}. [${p.name}](${playerUrl}) · **${fmt(
                p.fame,
              )} pts**`;
            })
            .join("\n");
        };

        const formatBelowQuota = (players) => {
          if (!players || players.length === 0)
            return "✅ Aucun joueur en dessous du quota.";
          if (players.length > 25) {
            return `${players.length} joueurs n'ont pas atteint ${fmt(quotaValue)} pts.`;
          }
          const text = formatPlayerList(
            players,
            "✅ Aucun joueur en dessous du quota.",
          );
          return text.length > 1020
            ? `${players.length} joueurs n'ont pas atteint ${fmt(quotaValue)} pts.`
            : text;
        };

        const fields = [
          {
            name: "Clan",
            value: `<:members:1506175789731811399> ${clan.members ?? "?"} / 50\n<:trophy2:1493677804733337621> ${fmt(
              clan.clanWarTrophies,
            )}`,
            inline: false,
          },
        ];

        const formatPlayerLink = (p) => {
          if (!p) return "";
          const playerUrl = trustPlayerUrl(p.tag);
          const deckCount = Number.isFinite(p.decksUsed) ? p.decksUsed : null;
          const deckSuffix =
            deckCount != null && deckCount < 16 ? ` (${deckCount})` : "";
          return `[${p.name}](${playerUrl}) · ${fmt(p.fame)} pts${deckSuffix}`;
        };

        const formatTop5Field = (entry) => {
          if (!entry) return "Aucune donnée.";
          const lines = [`<:victory:1504136468900352070> **Top 5**`];
          (entry.topPlayers || []).forEach((p, idx) => {
            lines.push(`${idx + 1}. ${formatPlayerLink(p)}`);
          });
          return lines.join("\n");
        };

        const formatUnderQuotaField = (entry) => {
          if (!entry) return "Aucune donnée.";
          const below = entry.belowQuota || [];
          if (below.length === 0) return "✅ Aucun joueur sous quota.";
          const lines = [];
          for (let idx = 0; idx < below.length && idx < 10; idx += 1) {
            lines.push(`${idx + 1}. ${formatPlayerLink(below[idx])}`);
          }
          let result = lines.join("\n");
          if (below.length > 10) {
            result += `\n... +${below.length - 10} autres`;
          }
          return result;
        };

        const sem1 = weekEntries[0];
        const sem2 = weekEntries[1];
        const totalExcluded =
          (sem1?.arrivalsExcluded ?? 0) + (sem2?.arrivalsExcluded ?? 0);
        const excludedNames = [
          ...(sem1?.arrivalsExcludedNames ?? []),
          ...(sem2?.arrivalsExcludedNames ?? []),
        ];
        const excludedSuffix =
          excludedNames.length > 0
            ? (() => {
                const joined = excludedNames.join(", ");
                if (joined.length <= 1970) return ` (${joined})`;
                let truncated = "";
                for (const name of excludedNames) {
                  const candidate = truncated ? `${truncated}, ${name}` : name;
                  if (candidate.length > 1970) break;
                  truncated = candidate;
                }
                const remaining =
                  excludedNames.length - truncated.split(", ").length;
                return ` (${truncated}, …${remaining})`;
              })()
            : "";

        fields.push({
          name: `Semaine -1 — ${fmt(sem1?.average ?? 0)} pts`,
          value: formatTop5Field(sem1),
          inline: true,
        });
        fields.push({
          name: `Semaine -2 — ${fmt(sem2?.average ?? 0)} pts`,
          value: formatTop5Field(sem2),
          inline: true,
        });
        fields.push({ name: "\u200b", value: "\u200b", inline: false });
        fields.push({
          name: "<:sweat:1504139431106576405> Sous-quota S-1",
          value: formatUnderQuotaField(sem1),
          inline: true,
        });
        fields.push({
          name: "<:sweat:1504139431106576405> Sous-quota S-2",
          value: formatUnderQuotaField(sem2),
          inline: true,
        });

        const embed = {
          title: `Quota ${fmt(quotaValue)} pts — ${clanName}`,
          url: clanUrl,
          color: 0x5865f2,
          fields,
          footer: {
            text: `Données des 2 dernières semaines de GDC · Arrivés en cours de GDC exclus${excludedSuffix}`,
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

  // Commande /stats
  if (body.type === 2 && body.data?.name === "stats") {
    const tagOption = body.data.options?.find((o) => o.name === "tag");
    const rawTag = tagOption?.value?.trim();
    if (!rawTag) {
      return res.status(200).json({
        type: 4,
        data: {
          content: "Veuillez fournir un tag de joueur (ex: `#ABC123`).",
          flags: 64,
        },
      });
    }

    res.status(200).json({ type: 5 });
    const tag = rawTag.startsWith("#") ? rawTag : `#${rawTag}`;
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const apiResp = await fetch(
          `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(tag)}/analysis?fast=true`,
          { headers: { Accept: "application/json" } },
        );

        if (!apiResp.ok) {
          const msg =
            apiResp.status === 404
              ? `Joueur \`${tag}\` introuvable.`
              : `Erreur API (${apiResp.status}).`;
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: msg, flags: 64 }),
          });
          return;
        }

        const analysis = await apiResp.json();
        const score = analysis.warScore ?? analysis.reliability;
        const { pct, color, verdict } = score;
        const icon = RELIABILITY_ICON[color] ?? "⚪";
        const verdictFr = FR_VERDICTS[color] ?? verdict ?? "Fiabilité inconnue";

        const warHistory = analysis.warHistory;
        const completedWeeks = Array.isArray(warHistory?.weeks)
          ? warHistory.weeks.filter((w) => !w.isCurrent)
          : [];
        const availableWeeks = completedWeeks.length;
        const latestWeeks = completedWeeks.slice(0, 12);
        const displayedWeeks = latestWeeks.length;
        const maxDisplayedWeeks = 12;

        const deckHistory = latestWeeks.length
          ? formatDeckHistory(latestWeeks)
          : "Aucune semaine GDC terminée trouvée.";
        const pointHistory = latestWeeks.length
          ? formatPointHistory(latestWeeks)
          : "Aucune semaine GDC terminée trouvée.";
        let warDecks = summarizeWarDecks(analysis.battleLog ?? []);
        if (!warDecks.length) {
          try {
            const battleLogResp = await fetch(
              `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(tag)}/battlelog`,
              { headers: { Accept: "application/json" } },
            );
            if (battleLogResp.ok) {
              const battleLog = await battleLogResp.json();
              warDecks = summarizeWarDecks(battleLog ?? []);
            }
          } catch {
            // On garde le résumé déjà calculé si le fallback échoue.
          }
        }
        const warDecksField = formatWarDecksField(warDecks);

        const historyCodeBlock = latestWeeks.length
          ? buildHistoryCodeBlock(latestWeeks)
          : "Aucune semaine GDC terminée trouvée.";

        const currentClanName =
          analysis.overview.clan?.name ||
          analysis.overview.clan?.tag ||
          "Aucun";
        const currentClanTag = analysis.overview.clan?.tag || null;
        const currentClanLink = currentClanTag
          ? `[${currentClanName}](${trustClanUrl(currentClanTag)})`
          : currentClanName;
        const currentClanWeeks = Number.isFinite(
          warHistory?.streakInCurrentClan,
        )
          ? warHistory.streakInCurrentClan
          : 0;
        const familyWeeks = completedWeeks.filter((w) =>
          FAMILY_CLAN_TAGS.has(normalizeClanTag(w.clanTag)),
        ).length;
        const previousClanWeek = (warHistory?.weeks ?? []).find(
          (w) =>
            !w.isCurrent &&
            currentClanTag &&
            normalizeClanTag(w.clanTag) !== normalizeClanTag(currentClanTag),
        );
        const previousClanName =
          previousClanWeek?.clanName || previousClanWeek?.clanTag || null;
        const previousClanTag = previousClanWeek?.clanTag ?? null;
        const previousClanLink = previousClanName
          ? previousClanTag
            ? `[${previousClanName}](${trustClanUrl(previousClanTag)})`
            : previousClanName
          : null;
        const previousClanLine = previousClanLink
          ? `**Précédent :** ${previousClanLink}\n`
          : `**Précédent :** Inconnu\n`;
        const currentClanWeeksPrefix =
          currentClanWeeks > 0 && currentClanWeeks === availableWeeks
            ? "≥ "
            : "";
        const familyWeeksPrefix =
          familyWeeks > 0 && familyWeeks === availableWeeks ? "≥ " : "";

        const avgFame = Number.isFinite(warHistory?.avgFame)
          ? warHistory.avgFame
          : 0;
        const allTimeRecord = Number.isFinite(warHistory?.maxFame)
          ? warHistory.maxFame
          : 0;
        const totalFame = Number.isFinite(warHistory?.totalFame)
          ? warHistory.totalFame
          : 0;
        const totalDecks = Array.isArray(warHistory?.weeks)
          ? warHistory.weeks
              .filter((w) => !w.ignored)
              .reduce((sum, w) => sum + (Number(w.decksUsed) || 0), 0)
          : 0;
        const pointsPerDeck = totalDecks
          ? Number((totalFame / totalDecks).toFixed(2))
          : null;
        const averageHourRange = buildAverageRaceTimeRange(
          analysis.battleLog,
          analysis.overview.clan?.tag,
        );

        const breakdownFields = buildReliabilityFields(score);
        const detailLines = [
          `- **Moyenne par semaine :** ${avgFame}`,
          `- **Record de points :** ${allTimeRecord}`,
        ];
        if (pointsPerDeck !== null) {
          detailLines.push(`- **Points par deck :** ${pointsPerDeck}`);
        }

        const clanLines = [
          `- **Actuel :** ${currentClanLink} (depuis ${currentClanWeeksPrefix}${currentClanWeeks} semaine${currentClanWeeks === 1 ? "" : "s"})`,
          `- **Précédent :** ${previousClanLink || "Inconnu"}`,
        ];
        if (familyWeeks > 0) {
          clanLines.push(
            `- **Stabilité dans la Famille :** ${familyWeeksPrefix}${familyWeeks} semaine${familyWeeks === 1 ? "" : "s"}`,
          );
        }

        const fields = [
          {
            name: "Fiabilité :",
            value: `${icon} ${Math.round(pct)}% (${verdictFr})`,
            inline: false,
          },
          ...(breakdownFields ?? []),
          {
            name: "Clans :",
            value: clanLines.join("\n"),
            inline: false,
          },
          {
            name: `Historique GDC (${displayedWeeks} ${displayedWeeks === 1 ? "dernière semaine" : "dernières semaines"}) :`,
            value: historyCodeBlock,
            inline: false,
          },
        ];

        if (displayedWeeks > 0) {
          fields.push({
            name: "Détails GDC :",
            value: detailLines.join("\n"),
            inline: false,
          });
        }

        if (warDecksField) {
          // /stats ne doit plus afficher les decks GDC, ce bloc est réservé à /matchup.
        }

        const discordLinks = await getDiscordLinks();
        const otherAccountsField = await buildOtherAccountsField(
          tag,
          discordLinks,
        );
        if (otherAccountsField) {
          fields.push(otherAccountsField);
        }

        const embed = {
          title: `<:stats:1499284927894650950> Stats complètes : ${analysis.overview.name}`,
          url: trustPlayerUrl(tag),
          color: COLOR_MAP[color] ?? 0x808080,
          description: `${tag} · <:xp:1498645264079257730> ${analysis.overview.expLevel ?? "N/A"} · <:trophy:1498645869224792105> ${analysis.overview.trophies ?? 0}`,
          fields,
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
            content: `Erreur lors de l'analyse : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /matchup
  if (body.type === 2 && body.data?.name === "matchup") {
    const tagOption = body.data.options?.find((o) => o.name === "tag");
    const rawTag = tagOption?.value?.trim();
    if (!rawTag) {
      return res.status(200).json({
        type: 4,
        data: {
          content: "Veuillez fournir un tag de joueur (ex: `#ABC123`).",
          flags: 64,
        },
      });
    }

    const webhookUrl = buildDiscordWebhookUrl(body);
    if (!webhookUrl) {
      console.error("Discord webhook URL non construite pour /matchup");
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
    const tag = rawTag.startsWith("#") ? rawTag : `#${rawTag}`;

    runBackground(async () => {
      try {
        const apiResp = await fetch(
          `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(tag)}/analysis?fast=true`,
          { headers: { Accept: "application/json" } },
        );

        if (!apiResp.ok) {
          const msg =
            apiResp.status === 404
              ? `Joueur \`${tag}\` introuvable.`
              : `Erreur API (${apiResp.status}).`;
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: msg, flags: 64 }),
          });
          return;
        }

        const analysis = await apiResp.json();
        let warDecks = [];
        try {
          const battleLogResp = await fetch(
            `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(tag)}/battlelog`,
            { headers: { Accept: "application/json" } },
          );
          if (battleLogResp.ok) {
            const battleLog = await battleLogResp.json();
            const opponentStatsByTag = await buildOpponentStatsByTag(
              battleLog ?? [],
              tag,
            );
            warDecks = summarizeWarDecksForMatchup(
              battleLog ?? [],
              64,
              null,
              analysis.overview.clan?.tag,
              {
                playerWinRate: analysis.activityIndicators?.winRate,
                playerCollectionLevel: analysis.overview?.collectionLevel,
                playerCw2Wins: analysis.overview?.clanWarWins,
                playerTrophies: analysis.overview?.trophies,
                opponentStatsByTag,
              },
            );
          } else {
            const opponentStatsByTag = await buildOpponentStatsByTag(
              analysis.battleLog ?? [],
              tag,
            );
            warDecks = summarizeWarDecksForMatchup(
              analysis.battleLog ?? [],
              64,
              null,
              analysis.overview.clan?.tag,
              {
                playerWinRate: analysis.activityIndicators?.winRate,
                playerCollectionLevel: analysis.overview?.collectionLevel,
                playerCw2Wins: analysis.overview.clanWarWins,
                playerTrophies: analysis.overview?.trophies,
                opponentStatsByTag,
              },
            );
          }
        } catch {
          const opponentStatsByTag = await buildOpponentStatsByTag(
            analysis.battleLog ?? [],
            tag,
          );
          warDecks = summarizeWarDecksForMatchup(
            analysis.battleLog ?? [],
            64,
            null,
            analysis.overview.clan?.tag,
            {
              playerWinRate: analysis.activityIndicators?.winRate,
              playerCollectionLevel: analysis.overview?.collectionLevel,
              playerCw2Wins: analysis.overview?.clanWarWins,
              playerTrophies: analysis.overview?.trophies,
              opponentStatsByTag,
            },
          );
        }

        let deckImage = null;
        const warDecksField = formatWarDecksField(warDecks);
        try {
          deckImage = await buildWarDecksImage(warDecks);
        } catch {
          deckImage = null;
        }
        if (!deckImage && Array.isArray(warDecks) && warDecks.length > 0) {
          deckImage = buildWarDecksTextFallbackImage(warDecks);
        }

        const fields = [];
        if (!Array.isArray(warDecks) || warDecks.length === 0) {
          fields.push({
            name: "Aucune donnée GDC :",
            value:
              "⚠️ Matchup calculé sur des combats hors GDC car aucune donnée de match GDC trouvée dans le battlelog (25 derniers combats).",
            inline: false,
          });
        } else if (!warDecksField) {
          fields.push({
            name: "Aucune donnée de deck :",
            value: "Aucune synthèse de deck n'a pu être construite.",
            inline: false,
          });
        }

        const displayedAverageMatchupValue =
          computeAverageMatchupFromWarDecks(warDecks);
        const averageMatchupValue = Number.isFinite(
          displayedAverageMatchupValue,
        )
          ? displayedAverageMatchupValue
          : Number.isFinite(analysis.matchup?.average)
            ? analysis.matchup.average
            : null;
        const averageMatchup = Number.isFinite(averageMatchupValue)
          ? `${Math.round(averageMatchupValue * 100)}%`
          : null;
        const title = averageMatchup
          ? `⚡ Matchup GDC · ${analysis.overview.name} : ${averageMatchup}`
          : `⚡ Matchup GDC · ${analysis.overview.name}`;
        const matchupLinkField = {
          name: "Le ⚡% correspond à la difficulté de l'affrontement. Calcul :",
          value: "https://trustroyale.vercel.app/bot/#matchup",
          inline: false,
        };

        const dataEmbed = {
          title,
          url: trustPlayerUrl(tag),
          color: 0xe67e22,
          description: warDecksField || undefined,
          fields: [...fields, matchupLinkField],
        };

        let imageResponse = null;
        if (deckImage?.buffer) {
          const embedWithImage = {
            ...dataEmbed,
            image: {
              url: `attachment://${deckImage.filename || "matchup-decks.png"}`,
            },
          };

          console.log(
            "Sending deck image with embed description:",
            deckImage.filename,
            deckImage.mimeType,
            "bufferType=",
            deckImage.buffer?.constructor?.name,
            "size=",
            deckImage.buffer?.length,
          );
          imageResponse = await sendDiscordWebhookFile(webhookUrl, deckImage, {
            embed: embedWithImage,
          });
          console.log(
            "Discord webhook response ok=",
            imageResponse.ok,
            "status=",
            imageResponse.status,
          );
          if (!imageResponse.ok) {
            const responseText = await imageResponse
              .text()
              .catch(() => "<no body>");
            console.error(
              "Discord file webhook failed:",
              imageResponse.status,
              imageResponse.statusText,
              responseText,
            );
            await fetch(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({
                content:
                  "Échec de l'envoi de l'image. Veuillez vérifier les logs du serveur.",
                flags: 64,
              }),
            });
          }
        } else {
          console.log(
            "No deckImage generated for /matchup, sending embed only",
          );
          const textResponse = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ embeds: [dataEmbed] }),
          });
          if (!textResponse.ok) {
            const responseText = await textResponse
              .text()
              .catch(() => "<no body>");
            console.error(
              "Discord text webhook failed:",
              textResponse.status,
              textResponse.statusText,
              responseText,
            );
            const fallbackText = warDecksField
              ? `Matchup moyen : ${averageMatchup ?? "N/A"}\n\n${warDecksField}`
              : `Matchup moyen : ${averageMatchup ?? "N/A"}`;
            const safeFallback =
              fallbackText.length > 1900
                ? `${fallbackText.slice(0, 1897)}...`
                : fallbackText;
            await fetch(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: safeFallback }),
            });
          }
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
        const members = analysis.members || [];

        const filtered = members
          .filter(
            (m) => m.verdict === "High risk" || m.verdict === "Extreme risk",
          )
          .sort((a, b) => {
            // Risque le plus élevé en premier (score le plus bas = plus risqué)
            const scoreA = Number(a.reliability ?? 0);
            const scoreB = Number(b.reliability ?? 0);
            if (scoreA !== scoreB) return scoreA - scoreB;
            // En cas d'égalité, trier par verdict (extrême avant high)
            const severity = { "Extreme risk": 0, "High risk": 1 };
            return (severity[a.verdict] || 0) - (severity[b.verdict] || 0);
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
          "High reliability": RELIABILITY_ICON.green,
          "Low risk": RELIABILITY_ICON.yellow,
          "High risk": RELIABILITY_ICON.orange,
          "Extreme risk": RELIABILITY_ICON.red,
        };
        const VERDICT_LABELFr = {
          "Extreme risk": "Extrême",
          "High risk": "Élevé",
        };
        const clanUrl = trustClanUrl(resolved.tag);
        const allRows = filtered.map((m) => {
          const newTag = m.isNew ? " 🆕" : "";
          const emoji = VERDICT_EMOJI[m.verdict] ?? RELIABILITY_ICON.red;
          const pct = Math.round(Number(m.reliability ?? 0));
          const verdictLabel =
            VERDICT_LABELFr[m.verdict] ||
            (m.verdict || "").replace(/\s*risk$/i, "");
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
          await import("../../backend/services/clashApi.js");

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
        } = await import("../../backend/services/dateUtils.js");

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

          title = `🏆 <:topplayers:1493708397407899648> Meilleurs joueurs`;
          footer = `😎 Meilleurs joueurs de la saison précédente (S${selectedSeason})`;

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
                if (!tag) continue;
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
          title = `<:topplayers:1493708397407899648> Meilleurs joueurs`;
          const weekRef = (function () {
            for (const clan of CLANS) {
              const raceLog = clanRaceLogs[clan.tag];
              const prevWeekId = computePrevWeekId(raceLog);
              if (prevWeekId) return prevWeekId;
            }
            return null;
          })();

          footer = `😎 Meilleurs joueurs de la semaine précédente (${weekRef ?? "S?-W?"})`;

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
          await import("../../backend/services/clashApi.js");
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
          await import("../../backend/services/dateUtils.js");
        const weekIdFromLog = computePrevWeekId(raceLog);
        const earlyWinByDay3 = await hasProvenEarlyWinByDay3(
          resolved.tag,
          weekIdFromLog,
        );
        const uncompleteAll = analysis.uncomplete?.players || [];
        const uncomplete = uncompleteAll.filter((p) => p.inClan);

        if (uncomplete.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `✅ Aucun joueur en fail 16/16 dans ${resolved.name}.`,
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

        const demoteHeader = earlyWinByDay3
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
          footer: { text: `Combats non joués · Semaine : ${weekId}` },
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
          await import("../../backend/services/clashApi.js");
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
          await import("../../backend/services/dateUtils.js");

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

        const fullSets = weeks.map((w) => {
          const standing = (w.standings || []).find(
            (s) => s.clan?.tag?.toUpperCase() === `#${resolved.tag}`,
          );
          const participants = standing?.clan?.participants ?? [];
          return new Set(
            participants
              .filter((p) => (p.decksUsed ?? 0) >= 16)
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

        // 16 decks/semaine × nombre de semaines de la saison = decks attendus par joueur
        const decksPerPlayer = weeks.length * 16;

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

  // Commande /discord-link
  if (body.type === 2 && body.data?.name === "discord-link") {
    const opts = body.data.options ?? [];
    const rawTags = ["tag", "tag2", "tag3"]
      .map((n) => opts.find((o) => o.name === n)?.value?.trim())
      .filter(Boolean);
    if (rawTags.length === 0) {
      return res.status(200).json({
        type: 4,
        data: {
          content:
            "Veuillez fournir au moins un tag de joueur (ex: `#ABC123`).",
          flags: 64,
        },
      });
    }

    // Réponse éphémère différée (visible uniquement par l'utilisateur)
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;
    const discordUserId = body.member?.user?.id ?? body.user?.id;
    const tags = rawTags.map((t) =>
      t.startsWith("#") ? t.toUpperCase() : `#${t.toUpperCase()}`,
    );

    runBackground(async () => {
      try {
        const { fetchPlayer } =
          await import("../../backend/services/clashApi.js");
        // Valider tous les tags en parallèle
        const results = await Promise.all(
          tags.map(async (tag) => {
            try {
              const player = await fetchPlayer(tag);
              return { tag, player, ok: true };
            } catch {
              return { tag, ok: false };
            }
          }),
        );

        const failed = results.filter((r) => !r.ok);
        const success = results.filter((r) => r.ok);

        if (failed.length > 0 && success.length === 0) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: failed
                .map(
                  (r) => `❌ Tag \`${r.tag}\` introuvable dans Clash Royale.`,
                )
                .join("\n"),
              flags: 64,
            }),
          });
          return;
        }

        const { links, sha } = await readDiscordLinks();
        // Ajouter les nouveaux liens (sans supprimer les liens existants de cet utilisateur)
        for (const { tag } of success) {
          links[tag] = discordUserId;
        }

        const tagList = success.map((r) => r.tag).join(", ");
        const ok = await writeDiscordLinks(
          links,
          sha,
          `discord: lien Discord ${discordUserId} → Clash ${tagList}`,
        );

        const lines = [];
        for (const { tag, player } of success) {
          lines.push(`✅ Lié à **${player.name}** (\`${tag}\`).`);
        }
        for (const { tag } of failed) {
          lines.push(`❌ Tag \`${tag}\` introuvable — ignoré.`);
        }
        if (!ok)
          lines.push("⚠️ Sauvegarde GitHub échouée — contacte un admin.");

        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: lines.join("\n"), flags: 64 }),
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

  // Commande /discord-check
  if (body.type === 2 && body.data?.name === "discord-check") {
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
      try {
        const { fetchClanMembers } =
          await import("../../backend/services/clashApi.js");
        const [clanMembers, { links }] = await Promise.all([
          fetchClanMembers(`#${resolved.tag}`),
          readDiscordLinks(),
        ]);

        // Récupère tous les membres du serveur Discord (max 1 000)
        const guildId = process.env.DISCORD_GUILD_ID;
        const botToken = process.env.DISCORD_TOKEN;
        const guildRes = await fetch(
          `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`,
          { headers: { Authorization: `Bot ${botToken}` } },
        );
        if (!guildRes.ok) {
          const errBody = await guildRes.text();
          throw new Error(
            `Discord Guild Members API: ${guildRes.status} — ${errBody}`,
          );
        }
        const guildMembers = await guildRes.json();
        const guildMemberIds = new Set(
          guildMembers.map((m) => m.user?.id).filter(Boolean),
        );

        const memberById = new Map(guildMembers.map((m) => [m.user?.id, m]));

        const presentByDiscord = new Map();
        const absentByDiscord = new Map();
        const unlinked = [];

        for (const m of clanMembers) {
          const normTag = m.tag.startsWith("#") ? m.tag : `#${m.tag}`;
          const discordId = links[normTag];
          if (!discordId) {
            unlinked.push({ clash: m.name, tag: normTag });
            continue;
          }

          const guildMember = memberById.get(discordId);
          const entry = { clash: m.name, tag: normTag };

          if (!guildMember) {
            const list = absentByDiscord.get(discordId) || [];
            list.push(entry);
            absentByDiscord.set(discordId, list);
            continue;
          }

          const user = guildMember.user;
          const displayName =
            guildMember.nick || user.global_name || user.username || "unknown";
          const key = `${displayName.startsWith("☆") ? "0" : "1"}:${displayName.toLowerCase()}`;

          const existing = presentByDiscord.get(discordId);
          if (existing) {
            existing.entries.push(entry);
          } else {
            presentByDiscord.set(discordId, {
              discord: displayName,
              discordId,
              key,
              entries: [entry],
            });
          }
        }

        const present = Array.from(presentByDiscord.values());
        present.sort((a, b) =>
          a.key.localeCompare(b.key, "fr", {
            numeric: true,
            sensitivity: "base",
          }),
        );

        const absent = Array.from(absentByDiscord.values())
          .flat()
          .sort((a, b) =>
            a.clash.localeCompare(b.clash, "fr", {
              numeric: true,
              sensitivity: "base",
            }),
          );

        unlinked.sort((a, b) =>
          a.clash.localeCompare(b.clash, "fr", {
            numeric: true,
            sensitivity: "base",
          }),
        );

        const lines = [];
        if (present.length) {
          const list = present
            .map((p) => {
              const clashes = p.entries
                .map((e) => `${e.clash} ${e.tag}`)
                .join(" + ");
              const mention = `<@${p.discordId}>`;
              return `• ${mention} ⤑ ${clashes}`;
            })
            .join("\n");

          lines.push("✅ Liés (présents sur le serveur) :");
          lines.push(list);
        }
        if (absent.length)
          lines.push(
            `❌ **Liés mais absents du serveur** (${absent.length}) : ${absent.map((e) => `${e.clash} ${e.tag}`).join(", ")}`,
          );
        if (unlinked.length)
          lines.push(
            `❓ **Non liés** (${unlinked.length}) : ${unlinked.map((e) => e.clash).join(", ")}`,
          );

        const embed = {
          title: `📋 Présence Discord — ${resolved.name}`,
          color: 0x5865f2,
          description: lines.join("\n\n") || "Aucun membre trouvé.",
          footer: {
            text: `${clanMembers.length} membres · ${present.length + absent.length} comptes Discord liés`,
          },
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
        const { fetchCurrentRace, fetchRaceLog } =
          await import("../../backend/services/clashApi.js");
        const { getSnapshotsForWeeks, getCurrentWarDayIndex } =
          await import("../../backend/services/snapshot.js");
        const { computeCurrentWeekId, computePrevWeekId, warResetOffsetMs } =
          await import("../../backend/services/dateUtils.js");

        const [race, raceLog] = await Promise.all([
          fetchCurrentRace(`#${resolved.tag}`),
          fetchRaceLog(`#${resolved.tag}`),
        ]);

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

        const decksByTag = new Map(
          Object.entries(prevDaySnap.decks).map(([tag, value]) => [
            normalizeTag(tag),
            Number.isFinite(value) ? Math.max(0, Math.min(4, value)) : 0,
          ]),
        );

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
          }))
          .filter((p) => {
            const isNewArrival = isJoinedThisWar(p.arrivalStreak);
            return p.decks < 4 && !isNewArrival;
          })
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

        const DETAILABLE_FAIL_LIMIT = 12;
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
              const weeks = Array.isArray(analysis.warHistory?.weeks)
                ? analysis.warHistory.weeks.filter(
                    (w) => !w.isCurrent && Number(w.decksUsed) > 0,
                  )
                : [];
              const recent = weeks.slice(0, 8);
              const decksLine = recent
                .map((w) => {
                  const deckCount = Number(w.decksUsed || 0);
                  const badge = deckUsageBadge(deckCount, Boolean(w.ignored));
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
              const status = formatStatus(player.role);
              const isNew =
                Number.isFinite(player.arrivalWeeks) &&
                player.arrivalWeeks <= 1;
              const newTag = isNew ? " 🆕" : "";
              return `- [${player.name}](${trustPlayerUrl(tag)})${newTag} (${status}) manque ${4 - player.decks} :\n  Decks : ${decksLine}\n  Moyenne : ${avgPerDeck}`;
            } catch (err) {
              const status = formatStatus(player.role);
              return `- [${player.name}](${trustPlayerUrl(tag)}) (${status}) manque ${4 - player.decks} : données historiques indisponibles`;
            }
          }),
        );

        const failCount = failedPlayers.length;
        const failLabel =
          failCount === 1 ? "Joueur en échec" : "Joueurs en échec";
        const embed = {
          title: `<:boohoo:1493849412387209357> ${resolved.name} — ${failCount} ${failLabel} hier (${warDayLabel})`,
          url: trustClanUrl(resolved.tag),
          color: 0xe74c3c,
          description: `Historique des dernières GDC :\n${fetchLines.join("\n")}`,
          footer: { text: `Données pour ${warDayLabel} — ${currentWeekId}` },
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
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      // Helper : race une promise contre un timeout
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

      try {
        console.log("[/late] start, clan:", resolved.tag);
        const { fetchCurrentRace, fetchClanMembers } =
          await import("../../backend/services/clashApi.js");
        console.log("[/late] import OK");

        const [race, currentMembers, { links }] = await withTimeout(
          Promise.all([
            fetchCurrentRace(`#${resolved.tag}`),
            fetchClanMembers(`#${resolved.tag}`),
            readDiscordLinks(),
          ]),
          20000,
          "fetch initial",
        );

        const participants = race?.clan?.participants ?? [];

        const { warResetOffsetMs } =
          await import("../../backend/services/dateUtils.js");
        const resetUtcMs = warResetOffsetMs(resolved.tag);
        // Garde calendaire : hors jeu–dim (après reset lundi), jamais en mode GDC
        // même si l'API retourne encore periodType='warDay' transitoirement.
        // periodIndex n'est PAS utilisé : il est 0–3 aussi bien en entraînement
        // qu'en GDC et provoquerait de faux positifs.
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
          await sendToWebhook({
            content: `<:cards:1493711279121104926> **${resolved.name}** — Aucune journée de GDC en cours (période d'entraînement).`,
          });
          return;
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
            (a, b) =>
              b.missing - a.missing || a.name.localeCompare(b.name, "fr"),
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
            const { readFile: _rf } = await import("fs/promises");
            const { fileURLToPath: _ftu } = await import("url");
            const { default: _path } = await import("path");
            const __fileDir = _path.dirname(_ftu(import.meta.url));
            const snapPath = _path.resolve(
              __fileDir,
              "../../data/snapshots",
              `${resolved.tag}.json`,
            );
            const snapData = JSON.parse(await _rf(snapPath, "utf-8"));
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
              const timingLabels =
                lateTimingTagsByTag.get(tag.toUpperCase()) || [];
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
          "[/late] envoi embed, late:",
          late.length,
          "descLen:",
          description.length,
        );
        await sendToWebhook({
          embeds: [embed],
          allowed_mentions: { parse: [] },
        });
      } catch (err) {
        console.error("[/late] erreur:", err.message);
        await sendToWebhook({ content: `Erreur : ${err.message}`, flags: 64 });
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
          await import("../../backend/services/clashApi.js");
        console.log("[/late-ping] import OK");

        const [race, currentMembers, { links }] = await withTimeout(
          Promise.all([
            fetchCurrentRace(`#${resolved.tag}`),
            fetchClanMembers(`#${resolved.tag}`),
            readDiscordLinks(),
          ]),
          20000,
          "fetch initial",
        );

        const participants = race?.clan?.participants ?? [];

        const { warResetOffsetMs } =
          await import("../../backend/services/dateUtils.js");
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
            const { readFile: _rf } = await import("fs/promises");
            const { fileURLToPath: _ftu } = await import("url");
            const { default: _path } = await import("path");
            const __fileDir = _path.dirname(_ftu(import.meta.url));
            const snapPath = _path.resolve(
              __fileDir,
              "../../data/snapshots",
              `${resolved.tag}.json`,
            );
            const snapData = JSON.parse(await _rf(snapPath, "utf-8"));
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
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const apiUrl = `https://trustroyale.vercel.app/api/clan/${resolved.tag}/analysis?includeRaceGroup=true&includeTopPlayers=false&includeUncomplete=false&fast=true&force=true`;
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

        const ownTag = `#${resolved.tag}`.toUpperCase();
        const FAMILY_TAGS = new Set(["#Y8JUPC9C", "#LRQP20V9", "#QU9UQJRL"]);
        const isColosseum = data.isColosseum === true;

        // Garde calendaire locale : ne pas se fier à data.isWarPeriod qui peut venir
        // d'un cache statique généré pendant la GDC (lun–mer : false, jeu–dim : true).
        const { warResetOffsetMs: _compareResetMs } =
          await import("../../backend/services/dateUtils.js");
        const _cmpDow = new Date(
          Date.now() - _compareResetMs(resolved.tag),
        ).getUTCDay();
        const isWarPeriod =
          (_cmpDow === 0 || _cmpDow >= 4) && data.isWarPeriod === true;

        // Trier par projection si GDC active, sinon par lastWarFame décroissant
        const sorted = [...raceGroup].sort((a, b) => {
          if (isWarPeriod) {
            const aClinched = a.isClinchedWin ? 1 : 0;
            const bClinched = b.isClinchedWin ? 1 : 0;
            if (aClinched !== bClinched) return bClinched - aClinched;
            return (b.projectedFame ?? 0) - (a.projectedFame ?? 0);
          }
          return (b.lastWarFame ?? 0) - (a.lastWarFame ?? 0);
        });

        const fmt = (n) =>
          typeof n === "number" ? n.toLocaleString("fr-FR") : "—";

        const rows = sorted.map((clan, idx) => {
          const clanTag = (clan.tag ?? "").toUpperCase();
          const isOwn = clanTag === ownTag;
          const cleanTag = clanTag.replace("#", "");
          const isFamilyMember = FAMILY_TAGS.has(clanTag);
          const url = trustClanUrl(clanTag);
          const rank = `**#${idx + 1}**`;
          const nameStr = `**[${clan.name ?? clanTag}](${url})**`;
          const bold = isOwn ? "__" : "";

          const trophies =
            !isWarPeriod && clan.clanWarTrophies != null
              ? `<:trophy2:1493677804733337621> ${fmt(clan.clanWarTrophies)}`
              : "";

          let prevWarStr =
            clan.prevWarFame != null
              ? `<:battle:1493710671244689449> ${fmt(clan.prevWarFame)} (n-2)`
              : "";

          let trend = "";
          if (clan.lastWarFame != null && clan.prevWarFame != null) {
            if (clan.lastWarFame > clan.prevWarFame) trend = " ⬆";
            else if (clan.lastWarFame < clan.prevWarFame) trend = " ⬇";
          }
          let lastWarStr =
            clan.lastWarFame != null
              ? `<:battle:1493710671244689449> **${fmt(clan.lastWarFame)}** (Last)${trend}`
              : "";

          let line1 = `${rank} ${bold}${nameStr}${bold} ${trophies}`.trim();
          let line2;

          if (isWarPeriod) {
            const decks = `<:cards:1493711279121104926> ${clan.decksToday != null ? clan.decksToday : "?"} decks`;
            const eff = `<:cible:1493711597682557019> ${clan.ptsPerDeck != null ? clan.ptsPerDeck.toFixed(2) : "?"} pts/d`;
            const proj = clan.isClinchedWin
              ? "<:projection:1499275709078700073> ✅ Victoire"
              : `<:projection:1499275709078700073> Projection: **${clan.projectedFame != null ? fmt(Math.round(clan.projectedFame / 100) * 100) : "?"}**`;
            const clinched = "";
            const currentPts =
              isColosseum && clan.currentFame != null
                ? `<:trophy2:1493677804733337621> Points actuels : **${fmt(clan.currentFame)}**`
                : "";
            const line2a = [decks, eff].filter(Boolean).join(" · ");
            const line2b = [currentPts, proj].filter(Boolean).join(" · ");
            line2 = line2b ? `${line2a}\n${line2b}` : line2a;
            line2 += clinched;
          } else {
            line2 = [prevWarStr, lastWarStr].filter(Boolean).join(" · ");
          }

          const row = `${line1}\n${line2}`;
          return row;
        });

        const anyClinched = isWarPeriod && sorted.some((c) => c.isClinchedWin);
        const footerText = isWarPeriod
          ? anyClinched
            ? `Trié par Projection · ✅ = victoire mathématiquement assurée`
            : `Trié par Projection en fin de journée`
          : `Trié par Total Dernière GDC`;

        const embed = {
          title: `<:trophy2:1493677804733337621> ${isColosseum ? "Groupe de Colisée" : "Groupe de GDC"} — ${resolved.name}`,
          color: 0x9b59b6,
          description: rows.join("\n\n"),
          image: {
            url: `${TRUST_ROYALE_URL}/images/banner2.webp`,
          },
          footer: { text: footerText },
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
          await import("../../backend/services/clashApi.js");

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

  // Commande /collection
  if (body.type === 2 && body.data?.name === "collection") {
    const tagOption = body.data.options?.find((o) => o.name === "tag");
    const rawTag = tagOption?.value?.trim();
    if (!rawTag) {
      return res.status(200).json({
        type: 4,
        data: {
          content: "Veuillez fournir un tag de joueur (ex: `#ABC123`).",
          flags: 64,
        },
      });
    }

    res.status(200).json({ type: 5 });

    const tag = rawTag.startsWith("#") ? rawTag : `#${rawTag}`;
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
      try {
        const apiResp = await fetch(
          `https://trustroyale.vercel.app/api/player/${encodeURIComponent(tag)}/analysis?fast=true`,
          { headers: { Accept: "application/json" } },
        );

        if (!apiResp.ok) {
          const msg =
            apiResp.status === 404
              ? `Joueur \`${tag}\` introuvable.`
              : `Erreur API (${apiResp.status}).`;
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: msg, flags: 64 }),
          });
          return;
        }

        const analysis = await apiResp.json();
        const col = analysis.collection;

        if (!col) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: "Données de collection non disponibles.",
              flags: 64,
            }),
          });
          return;
        }

        const tourLevel = col.tourLevel;
        const collectionLevel = col.collectionLevel;

        // Distribution des niveaux normalisés
        const distEntries = Object.entries(col.distribution ?? {})
          .map(([k, v]) => [Number(k), v])
          .sort((a, b) => b[0] - a[0]);
        const sortedLevels = distEntries.map(([k]) => k);

        // Texte footer : prochain niveau de tour
        let tourFooter;
        if (!col.tourNextInfo) {
          tourFooter = "Tour du Roi maximale !";
        } else {
          const { missing, level } = col.tourNextInfo;
          const plural = missing > 1 ? "s" : "";
          tourFooter = `Prochain niveau de tour : manque ${missing} carte${plural} niveau ${level}+`;
        }

        // Formatage de la distribution (4 niveaux par ligne)
        const distLines = [];
        for (let i = 0; i < sortedLevels.length; i += 4) {
          const row = sortedLevels.slice(i, i + 4).map((lvl) => {
            const count = col.distribution[lvl];
            return `Niv${lvl}: ${count}`;
          });
          distLines.push(row.join("   "));
        }

        // Prochaines récompenses (5 prochains paliers depuis le niveau de collection actuel)
        const REWARD_LABELS = {
          gems: "Gemmes",
          common_wc: "Joker Commun",
          rare_wc: "Joker Rare",
          epic_wc: "Joker Épique",
          legendary_wc: "Joker Légendaire",
          champion_wc: "Joker Champion",
          lucky_chest_4star: "Coffre 4★",
          lucky_chest_5star: "Coffre 5★",
          evo_box: "Boîte EVO",
          banner: "Bannière",
        };
        const remainingRewards = COLLECTION_REWARDS.filter(
          (r) => r.cl > collectionLevel,
        );
        const nextRewards = remainingRewards.slice(0, 5);
        const rewardsText =
          nextRewards.length > 0
            ? nextRewards
                .map((r) => {
                  const label = REWARD_LABELS[r.type] ?? r.type;
                  const suffix =
                    r.arenaLevel != null
                      ? ` (Arène ${r.arenaLevel})`
                      : r.arenaLabel
                        ? ` (Arène ${r.arenaLabel})`
                        : r.label
                          ? ` "${r.label}"`
                          : ` ×${r.qty}`;
                  return `• CL ${r.cl} — ${label}${suffix}`;
                })
                .join("\n")
            : "Niveau maximum atteint !";

        const fields = [
          // Ligne 1 : cartes | évolutions | héros
          {
            name: "Cartes :",
            value: `${col.cardCount} / ${col.totals.cards}`,
            inline: true,
          },
          {
            name: "Évolutions :",
            value: `${col.evolvedCount} / ${col.totals.evolutions}`,
            inline: true,
          },
          {
            name: "Héros :",
            value: `${col.heroCount} / ${col.totals.heroes}`,
            inline: true,
          },
          // Ligne 2 : tour du roi | niveau de collection
          {
            name: "Tour du Roi :",
            value: `Niveau ${tourLevel}`,
            inline: true,
          },
          {
            name: "Niveau de Collection :",
            value: String(collectionLevel),
            inline: true,
          },
          // Distribution
          {
            name: "Distribution des niveaux :",
            value: "```\n" + distLines.join("\n") + "\n```",
            inline: false,
          },
          // Prochaines récompenses
          {
            name: "Prochaines récompenses :",
            value: rewardsText,
            inline: false,
          },
        ];

        const embed = {
          title: `📦 Collection : ${analysis.overview.name}`,
          url: trustPlayerUrl(tag),
          color: 0xf1c40f,
          fields,
          footer: { text: tourFooter },
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
            content: `Erreur lors de l'analyse : ${err.message}`,
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
    const isFamilyClan = ALLOWED_CLAN_TAGS.has(resolved.tag.toUpperCase());

    res.status(200).json({ type: 5 });
    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}`;

    runBackground(async () => {
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
              await fetch(webhookUrl, {
                method: "POST",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({ content: msg, flags: 64 }),
              });
              return;
            }
          } else {
            const msg =
              fetchErr.name === "AbortError"
                ? `⏱️ L'analyse du clan a pris trop longtemps. Réessayez dans 30 secondes.`
                : `Erreur réseau : ${fetchErr.message}`;
            await fetch(webhookUrl, {
              method: "POST",
              headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ content: msg, flags: 64 }),
            });
            return;
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
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Erreur API clan (${apiResp?.status ?? "inconnu"}). Réessayez dans quelques instants.`,
              flags: 64,
            }),
          });
          return;
        }

        const analysis = await apiResp.json();
        const clan = analysis.clan || {};
        const members = analysis.members || [];
        const liteMembers = analysis.isLite ? members : [];
        const summary = analysis.summary || {};
        const lastWarSummary = analysis.lastWarSummary || null;
        const hasReliabilityDetails =
          isFamilyClan && !analysis.isLite && !usedLiteFallback;

        const TYPE_FR = {
          open: "Ouvert",
          inviteOnly: "Sur invitation",
          closed: "Fermé",
        };

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
        function warLeagueLabel(trophies) {
          const label = getLeagueName(trophies ?? 0, "fr") ?? "Bronze 1";
          const icon = isFamilyClan
            ? (LEAGUE_ICON_SPECIFIC[label] ?? LEAGUE_ICON_GENERIC[label])
            : LEAGUE_ICON_GENERIC[label];
          return icon ? `${icon} ${label}` : label;
        }

        const fmt = (n) =>
          typeof n === "number" ? n.toLocaleString("fr-FR") : "—";
        const fmtInt = (n) =>
          Number.isFinite(n) ? Math.round(n).toLocaleString("fr-FR") : "—";
        const avgScore = summary.avgScore ?? 0;
        const embedColor = hasReliabilityDetails
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
                (a, b) =>
                  Number(b.reliability ?? 0) - Number(a.reliability ?? 0),
              )
              .slice(0, MEMBER_LIMIT)
          : [];
        const topRisky = hasReliabilityDetails
          ? members
              .filter(
                (m) =>
                  m.verdict === "High risk" || m.verdict === "Extreme risk",
              )
              .sort(
                (a, b) =>
                  Number(a.reliability ?? 0) - Number(b.reliability ?? 0),
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

        function memberLine(m) {
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

        // Champ 6 : Fiabilité (clan famille) ou Chef (clan externe)
        const sixthField = hasReliabilityDetails
          ? {
              name: "Fiabilité",
              value: `<:warn:1506174837519945800> **${avgScore}%**`,
              inline: true,
            }
          : (() => {
              const leader = liteMembers.find((m) => m.role === "leader");
              const leaderValue = leader
                ? `[${leader.name}](${trustPlayerUrl(leader.tag)})`
                : "—";
              return { name: "Chef", value: leaderValue, inline: true };
            })();

        const clanUrl = trustClanUrl(resolved.tag);
        const fields = [
          // Rangée 1 : Membres | Trophées GDC | Ligue
          {
            name: "Membres",
            value: `<:members:1506175789731811399> ${clan.members ?? "?"} / 50`,
            inline: true,
          },
          {
            name: "Trophées GDC",
            value: `<:trophy2:1493677804733337621> ${fmt(clan.clanWarTrophies)}`,
            inline: true,
          },
          {
            name: "Ligue",
            value: warLeagueLabel(clan.clanWarTrophies ?? 0),
            inline: true,
          },
          // Rangée 2 : Statut | Requis | Fiabilité/Chef
          {
            name: "Statut",
            value: (() => {
              const STATUS_ICON = {
                open: "<:success:1499002702208958577>",
                inviteOnly: "<:warning:1499002725965500577>",
                closed: "<:error:1499002755841265826>",
              };
              const icon = STATUS_ICON[clan.type] ?? "";
              const label = TYPE_FR[clan.type] ?? clan.type ?? "—";
              return icon ? `${icon} ${label}` : label;
            })(),
            inline: true,
          },
          {
            name: "Requis",
            value: `<:trophy:1498645869224792105> ${fmt(clan.requiredTrophies)}`,
            inline: true,
          },
          sixthField,
          {
            name: "Moyenne/joueur",
            value: `${fmtInt(lastWarSummary?.averagePerPlayer)} pts`,
            inline: true,
          },
          {
            name: "Points/deck",
            value: `${fmtInt(lastWarSummary?.pointsPerDeck)} pts`,
            inline: true,
          },
          {
            name: "\u200b",
            value: "\u200b",
            inline: true,
          },
        ];

        // Rangée 3 : listes membres (uniquement pour les clans famille)
        if (hasReliabilityDetails) {
          fields.push({ name: "\u200b", value: "\u200b", inline: false });
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
          fields.push({
            name: `Nouveaux (${newMembers.length})`,
            value: formatMemberListValue(newMembers, "Aucun"),
            inline: true,
          });
        }

        // Lien cliquable en bas
        fields.push({
          name: "\u200b",
          value: `[Plus d'infos sur TrustRoyale ↗](${clanUrl})`,
          inline: false,
        });

        const clanTag = (clan.tag ?? `#${resolved.tag}`).replace(/^#/, "");
        const embed = {
          title: `${clan.name ?? resolved.name} | #${clanTag}`,
          url: clanUrl,
          description: `${clan.description ?? ""}${usedLiteFallback ? "\n\n⚠️ Données de fiabilité temporairement indisponibles, affichage allégé." : ""}`,
          color: embedColor,
          fields,
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
            return {
              name: clan.name || name,
              tag,
              description: clan.description || "",
              members: clan.members ?? clan.memberCount ?? "—",
              clanWarTrophies: clan.clanWarTrophies ?? 0,
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
              {
                name: "Membres",
                value: `<:members:1506175789731811399> ${clanResult.members}`,
                inline: true,
              },
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
        setCachedStatsClanAnalysis(resolved.tag, data);
        const members = Array.isArray(data.members) ? data.members : [];
        const clanInfo = data.clan || {};
        const clanName = clanInfo.name || resolved.name;
        const scenario = getStatsClanScenario(data);

        const normalizedMembers = members.map((member) => {
          const metrics = getStatsClanMetrics(member, scenario.key);
          return {
            ...member,
            period: metrics.period,
            avgFame: metrics.avgFame,
            pointsPerDeck: metrics.pointsPerDeck,
          };
        });

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

        // Tri des membres selon le mode choisi (décroissant)
        const sorted = sortStatsClanMembers(normalizedMembers, sortMode);

        const fmt = (n) =>
          Number.isFinite(n) ? n.toLocaleString("fr-FR") : "—";

        // Construit les lignes d'affichage (format compact une ligne par membre)
        const rows = sorted.map((m, idx) => {
          const rank = idx + 1;
          const newIcon = m.isNew ? "🆕" : "";

          let reliabilityStr = "";
          if (Number.isFinite(m.reliability)) {
            const icon = RELIABILITY_ICON[m.color] ?? "⚪";
            reliabilityStr = icon + Math.round(m.reliability) + "%";
          }

          const avgStr = fmt(m.avgFame);
          const ppdStr = fmt(m.pointsPerDeck);
          const decksUsed = Number(m.period?.decksUsed);
          const decksStr = Number.isFinite(decksUsed)
            ? ` (${Math.round(decksUsed)})`
            : "";

          const parts = [newIcon, reliabilityStr].filter(Boolean);
          const prefix = parts.length ? " " + parts.join(" ") : "";
          const body = ` 🏆${avgStr} ⚡${ppdStr}${decksStr}`;
          return rank + ". " + m.name + prefix + body;
        });

        // Pagination au cas où (sécurité, normalement tout tient sur une page)
        const DESC_MAX = 4096;
        const pages = [];
        let currentPage = [];
        let currentLen = 0;
        for (const row of rows) {
          const rowLen = row.length + 1;
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
        const pageCount = pages.length;

        const sendPage = (pageRows, pageIndex) => {
          let description = "";
          for (let ri = 0; ri < pageRows.length; ri++) {
            if (ri > 0) description += String.fromCharCode(10);
            description += pageRows[ri];
          }
          const embed = {
            title: `<:stats:1499284927894650950> Stats GDC : ${clanName}`,
            url: trustClanUrl(resolved.tag),
            color: 0x5865f2,
            description,
            footer: {
              text: buildStatsClanFooter({
                sortMode,
                scenarioLabel: scenario.label,
                pageIndex,
                pageCount,
              }),
            },
          };
          return { embeds: [embed] };
        };

        const firstPayload = sendPage(pages[0], 0);

        // Ajoute les boutons de tri (uniquement sur la première page)
        firstPayload.components = buildStatsClanComponents(clanVal, sortMode);

        const firstResp = await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(firstPayload),
        });

        if (!firstResp.ok) {
          const text = await firstResp.text().catch(() => "");
          console.error(
            "stats-clan first page webhook failed:",
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

        // Pages suivantes (sans boutons)
        for (let p = 1; p < pageCount; p++) {
          const payload = sendPage(pages[p], p);
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload),
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

  // ── Pronostics GDC ──
  if (body.type === 2) {
    const cmd = body.data?.name;

    if (cmd === "champion-start") {
      const clanOpt = body.data.options?.find((o) => o.name === "clan");
      const clanVal = clanOpt?.value || "1";
      res.status(200).json({ type: 5 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      runBackground(() => handleChampionStart(webhookUrl, clanVal));
      return;
    }

    if (cmd === "champion-end") {
      const clanOpt = body.data.options?.find((o) => o.name === "clan");
      const clanVal = clanOpt?.value || "1";
      res.status(200).json({ type: 5 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      runBackground(() => handleChampionEnd(webhookUrl, clanVal));
      return;
    }

    if (cmd === "champion-count") {
      const clanOpt = body.data.options?.find((o) => o.name === "clan");
      const clanVal = clanOpt?.value || "1";
      res.status(200).json({ type: 5 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      runBackground(() => handleChampionCount(webhookUrl, clanVal));
      return;
    }

    if (cmd === "champion-history") {
      const clanOpt = body.data.options?.find((o) => o.name === "clan");
      const clanVal = clanOpt?.value || "1";
      res.status(200).json({ type: 5 });
      const webhookUrl = buildDiscordWebhookUrl(body);
      runBackground(() => handleChampionHistory(webhookUrl, clanVal));
      return;
    }

    if (cmd === "champion") {
      const selectOpt = body.data.options?.find((o) => o.name === "select");
      const clanOpt = body.data.options?.find((o) => o.name === "clan");
      const clanVal = clanOpt?.value || "1";
      let rawTag = selectOpt?.value?.trim();
      res.status(200).json({ type: 5, data: { flags: 64 } });
      const webhookUrl = buildDiscordWebhookUrl(body);
      runBackground(async () => {
        try {
          const { resolveClan, getActiveSessionByClan, castVote } =
            await import("../../backend/services/championPredictions.js");

          const resolved = resolveClan(clanVal);
          const active = await getActiveSessionByClan(resolved.tag);
          if (!active) throw new Error("Aucune session de vote ouverte.");
          const { weekId, session } = active;

          // Vérifier que le tag correspond à un challenger valide
          const matchedChallenger = session.challengers.find(
            (c) =>
              c.tag === rawTag ||
              c.tag.toUpperCase() === (rawTag || "").toUpperCase() ||
              c.name.toLowerCase() === (rawTag || "").toLowerCase(),
          );
          if (!matchedChallenger) {
            throw new Error(`Challenger invalide. Utilisez le menu déroulant.`);
          }
          rawTag = matchedChallenger.tag;

          const discordId = body.member?.user?.id;
          const discordName = body.member?.user?.username || "Inconnu";
          await castVote(resolved.tag, weekId, discordId, discordName, rawTag);

          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `Votre vote est enregistré ! ✓`,
              flags: 64,
            }),
          });
        } catch (err) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: `⚠️ ${err.message}`, flags: 64 }),
          });
        }
      });
      return;
    }
  }

  // ── MessageComponent : select menu pronostics GDC ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("champion_vote:")
  ) {
    res.status(200).json({ type: 5, data: { flags: 64 } });
    const webhookUrl = buildDiscordWebhookUrl(body);
    runBackground(() => handleChampionSelect(webhookUrl, body));
    return;
  }

  // ── MessageComponent : boutons de tri stats-clan ──
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("stats_clan_sort:")
  ) {
    const parts = body.data.custom_id.split(":");
    if (parts.length < 3) {
      return res
        .status(200)
        .json({ type: 4, data: { content: "Erreur interne.", flags: 64 } });
    }
    const sortMode = parts[1];
    const clanVal = parts[2];

    const CLAN_MAP = {
      1: { name: "La Resistance", tag: "Y8JUPC9C" },
      2: { name: "Les Resistants", tag: "LRQP20V9" },
      3: { name: "Les Revoltes", tag: "QU9UQJRL" },
    };
    const resolved = CLAN_MAP[clanVal] ?? CLAN_MAP["1"];
    const clanTag = resolved.tag;

    res.status(200).json({ type: 6 });

    const webhookUrl = `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${body.token}/messages/@original`;

    runBackground(async () => {
      try {
        const abortCtrl = new AbortController();
        const abortTimer = setTimeout(() => abortCtrl.abort(), 12000);
        let data = getCachedStatsClanAnalysis(clanTag);
        try {
          if (!data) {
            const apiResp = await fetch(
              `https://trustroyale.vercel.app/api/clan/${encodeURIComponent(clanTag)}/analysis?fast=true`,
              {
                headers: { Accept: "application/json" },
                signal: abortCtrl.signal,
              },
            );

            if (!apiResp.ok) {
              await fetch(webhookUrl, {
                method: "PATCH",
                headers: { "Content-Type": "application/json" },
                body: JSON.stringify({
                  content: "Erreur lors du rechargement. Relancez la commande.",
                }),
              });
              return;
            }

            data = await apiResp.json();
            setCachedStatsClanAnalysis(clanTag, data);
          }
        } finally {
          clearTimeout(abortTimer);
        }
        if (!data) {
          await fetch(webhookUrl, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: "Erreur lors du rechargement. Relancez la commande.",
            }),
          });
          return;
        }
        const members = Array.isArray(data.members) ? data.members : [];
        const clanInfo = data.clan || {};
        const clanName = clanInfo.name || resolved.name;
        const scenario = getStatsClanScenario(data);

        const normalizedMembers = members.map((member) => {
          const metrics = getStatsClanMetrics(member, scenario.key);
          return {
            ...member,
            period: metrics.period,
            avgFame: metrics.avgFame,
            pointsPerDeck: metrics.pointsPerDeck,
          };
        });

        const sorted = sortStatsClanMembers(normalizedMembers, sortMode);

        const fmt = (n) =>
          Number.isFinite(n) ? n.toLocaleString("fr-FR") : "—";

        const rows = sorted.map((m, idx) => {
          const rank = idx + 1;
          const newIcon = m.isNew ? "🆕" : "";

          let reliabilityStr = "";
          if (Number.isFinite(m.reliability)) {
            const icon = RELIABILITY_ICON[m.color] ?? "⚪";
            reliabilityStr = icon + Math.round(m.reliability) + "%";
          }

          const avgStr = fmt(m.avgFame);
          const ppdStr = fmt(m.pointsPerDeck);
          const decksUsed = Number(m.period?.decksUsed);
          const decksStr = Number.isFinite(decksUsed)
            ? ` (${Math.round(decksUsed)})`
            : "";

          const parts = [newIcon, reliabilityStr].filter(Boolean);
          const prefix = parts.length ? " " + parts.join(" ") : "";
          const body = ` 🏆${avgStr} ⚡${ppdStr}${decksStr}`;
          return rank + ". " + m.name + prefix + body;
        });

        const DESC_MAX = 4096;
        let currentLen = 0;
        const firstPage = [];
        for (const row of rows) {
          const rowLen = row.length + 1;
          if (currentLen + rowLen > DESC_MAX && firstPage.length > 0) break;
          firstPage.push(row);
          currentLen += rowLen;
        }
        const pageCount = Math.ceil(rows.length / firstPage.length);

        const embed = {
          title: `<:stats:1499284927894650950> Stats GDC : ${clanName}`,
          url: trustClanUrl(clanTag),
          color: 0x5865f2,
          description: firstPage.join(String.fromCharCode(10)),
          footer: {
            text: buildStatsClanFooter({
              sortMode,
              scenarioLabel: scenario.label,
              pageIndex: 0,
              pageCount,
            }),
          },
        };

        const payload = {
          embeds: [embed],
          components: buildStatsClanComponents(clanVal, sortMode),
        };

        await fetch(webhookUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(payload),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
          }),
        });
      }
    });
    return;
  }

  return res.status(400).json({ error: "Unsupported interaction type" });
}
