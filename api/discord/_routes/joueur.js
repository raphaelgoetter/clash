// Commandes centrées sur un joueur : /stats, /combats, /matchup-gdc,
// /matchup (+ boutons et menu de détail), /collection.
//
// Routage extrait de api/discord/interactions.js : chaque bloc répond à
// Discord via `res` s'il reconnaît l'interaction, sinon la fonction rend
// la main sans rien envoyer et le routeur essaie le module suivant.

import { createRequire } from "node:module";
import { Resvg } from "@resvg/resvg-js";
import {
  getBestRankedLeagueLabel,
  isSupremeChampionLeague,
} from "../../../backend/services/rankedLeagues.js";
import { getDiscordLinks } from "../../../backend/services/discordLinks.js";
import {
  getWarMatchupPerformanceSamples,
} from "../../../backend/services/matchupPerformance.js";
import {
  toPublicWeekId,
  formatResetTimeParis,
  parseClashDate,
} from "@clash/clash-royale/dateUtils.js";
import { fetchPlayer } from "@clash/clash-royale/clashApi.js";
import { getOrSet } from "@clash/commun/cache.js";
import { buildWarDecksImage } from "../../../backend/services/warDecksImage.js";
import {
  summarizeWarDecks,
  summarizeWarDecksForMatchup,
  summarizeRecentBattlesForMatchup,
  computeMatchupPerformance,
  aggregateMatchupPerformance,
  categorizeBattleType,
  getWarMatchPoints,
  computeCombatsByDay,
} from "../../../backend/services/analysisService.js";
import { summarizePointsPerDeckWeeks } from "../../../backend/services/warScoring.js";
import {
  CROWN_SELF,
  CROWN_OPPONENT,
} from "../../../backend/services/matchupEngine.js";
import {
  runBackground,
  TRUST_ROYALE_URL,
  trustPlayerUrl,
  trustClanUrl,
  FAMILY_CLAN_TAGS,
  buildDiscordWebhookUrl,
  COLOR_MAP,
  RELIABILITY_ICON,
  parseBattleTimestamp,
  deckUsageBadge,
  getWarDayLabel,
  getCombatsDayBadge,
  SCORE_BADGES,
  normalizeClanTag,
  normalizeClashTag,
} from "../_lib/commun.js";

const _require = createRequire(import.meta.url);

const COLLECTION_LEVELS = _require("../../../data/collection_levels.json");

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

const FR_VERDICTS = {
  green: "Très fiable",
  yellow: "Risque faible",
  orange: "Risque élevé",
  red: "Risque extrême",
};

function formatDeckHistory(weeks) {
  return weeks
    .map((w) => {
      const badge = deckUsageBadge(w.decksUsed, w.ignored, w.maxDecks);
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

function escapeText(value) {
  return String(value || "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
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
    if (options?.components) {
      payload.components = options.components;
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

// Les journées GDC en élixir x3 restent des combats "riverRacePvP" : seul le
// mode de jeu les distingue.
function getWarMatchTypeLabel(type, gameMode = null) {
  const normalized = String(type || "").toLowerCase();
  if (normalized === "riverracepvp") {
    return String(gameMode ?? "").startsWith("TripleElixir") ? "(ElixirX3)" : "(PvP)";
  }
  if (normalized === "riverraceboat") return "(Bateau)";
  if (normalized === "riverraceduel" || normalized === "riverraceduelcolosseum")
    return "(Duel)";
  return "";
}

const BATTLE_CATEGORY_LABELS = {
  gdc: "GDC",
  ladder: "Ladder",
  challenge: "Challenge",
  friendly: "Amical",
  other: "Autre",
};

// Libellé de type utilisé sur /matchup (tous types) : sous-type GDC précis
// (PvP/Bateau/Duel) si le combat est un combat de guerre, sinon la
// catégorie générale (Ladder/Amical/Challenge/Autre).
function getBattleTypeLabel(type, gameMode = null) {
  // Combat de Ladder joué sous un type d'événement (ex. "trail") : le mode
  // de jeu fait foi, sinon il tomberait dans "Autre".
  if (gameMode === "Ladder" && categorizeBattleType(type) === "other") {
    return `(${BATTLE_CATEGORY_LABELS.ladder})`;
  }
  const category = categorizeBattleType(type);
  if (category === "gdc") {
    const warLabel = getWarMatchTypeLabel(type, gameMode);
    return warLabel ? `(${BATTLE_CATEGORY_LABELS.gdc} ${warLabel.slice(1, -1)})` : "(GDC)";
  }
  return `(${BATTLE_CATEGORY_LABELS[category] ?? BATTLE_CATEGORY_LABELS.other})`;
}

// Date courte (JJ/MM) pour une ligne de /matchup (tous types), là où
// getWarDayLabel() n'a de sens que pour un jour de GDC (J1..J4).
function formatRecentMatchDate(battleTime) {
  if (!battleTime) return "?";
  const date = parseClashDate(battleTime);
  if (Number.isNaN(date.getTime())) return "?";
  const day = String(date.getUTCDate()).padStart(2, "0");
  const month = String(date.getUTCMonth() + 1).padStart(2, "0");
  return `${day}/${month}`;
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

  const groupBlocks = sortedDays.map((group, groupIndex) => {
    const isOldestDay = groupIndex === sortedDays.length - 1;
    const deckLabels = [...group.decks.keys()].slice(0, maxDecks);
    const displayedMatches = [];
    const deckLines = [];
    const groupLines = groupIndex > 0 ? [""] : [];

    let deckCount = 0;
    for (const deckLabel of deckLabels) {
      const deckGroup = group.decks.get(deckLabel);
      if (!deckGroup) continue;
      deckCount += 1;
      if (deckCount > maxDecks) break;

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
          // Ligne épurée : résultat en tête, puis type (PvP/Duel/Bateau),
          // adversaire, score et difficulté séparés par "·" (même ordre que
          // /matchup ; le numéro de deck reste dans le menu "ℹ️ Détails").
          const typeLabel = getWarMatchTypeLabel(match.type, match.gameMode).replace(
            /^\(|\)$/g,
            "",
          );
          deckLines.push(
            `• ${resultEmoji} ${[typeLabel, opponentName, score, `⚡${matchup}`]
              .filter(Boolean)
              .join(" · ")}`,
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
        deckLines.push(`• <:error:1499002755841265826> Manquant · ⚡?`);
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
    const daySuffix = showStats ? ` · ${points} pts · ${winRate}% WR` : "";

    groupLines.push(`**${group.dayLabel}${daySuffix}**`);
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

// Pendant de formatWarDecksField() pour /matchup : liste des derniers combats
// bruts (sortie de summarizeRecentBattlesForMatchup) groupés par date (titre
// **JJ/MM**, comme /matchup-gdc regroupe par jour de GDC **J1**..**J4**) —
// contrairement à /matchup-gdc, chaque ligne précise aussi son propre type
// de combat (GDC/Ladder/Amical/...) puisqu'ils sont mélangés au sein d'une
// même date.
function formatRecentBattlesField(recentBattles) {
  if (!Array.isArray(recentBattles) || recentBattles.length === 0) {
    return null;
  }

  const dateGroups = new Map();
  recentBattles.forEach((deck, deckIndex) => {
    const match = deck.matches?.[0] ?? {};
    const dateLabel = formatRecentMatchDate(match.battleTime);
    const group = dateGroups.get(dateLabel) ?? [];
    group.push({ deck, deckIndex, match });
    dateGroups.set(dateLabel, group);
  });

  const blocks = [...dateGroups.entries()].map(([dateLabel, entries], groupIndex) => {
    const lines = entries.map(({ match }) => {
      // GDC : "PvP"/"Duel" suffit (seuls les combats de GDC portent ces
      // types), sans le préfixe "GDC" de getBattleTypeLabel().
      const typeLabel =
        categorizeBattleType(match.type) === "gdc"
          ? getWarMatchTypeLabel(match.type, match.gameMode) || "(GDC)"
          : getBattleTypeLabel(match.type, match.gameMode);
      const opponentName = escapeText(match.opponentName || "?");
      const resultEmoji =
        match.result === "win"
          ? "<:success:1499002702208958577>"
          : "<:error:1499002755841265826>";
      const score = escapeText(match.score || "?");
      const matchup = Number.isFinite(match.matchup)
        ? `${Math.round(match.matchup * 100)}%`
        : "?";
      // Même format épuré que /matchup-gdc, avec le type de combat juste
      // après le résultat (modes mélangés ici : GDC, Ladder, Amical...).
      return `• ${resultEmoji} ${typeLabel.replace(/^\(|\)$/g, "")} · ${opponentName} · ${score} · ⚡${matchup}`;
    });
    const groupLines = groupIndex > 0 ? [""] : [];
    groupLines.push(`**${dateLabel}**`, ...lines);
    return groupLines.join("\n");
  });

  return blocks.join("\n");
}

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
    return `${badge} ${item.label} (${item.score}/${item.max})`;
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

async function fetchWarDecksForTagUncached(tag) {
  const apiResp = await fetch(
    `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(tag)}/analysis?fast=true`,
    { headers: { Accept: "application/json" } },
  );
  if (!apiResp.ok) {
    throw new Error(
      apiResp.status === 404
        ? `Joueur \`${tag}\` introuvable.`
        : `Erreur API (${apiResp.status}).`,
    );
  }
  const analysis = await apiResp.json();
  // Battle log brut de préférence (plus complet), sinon celui de l'analyse
  let battleLog = analysis.battleLog ?? [];
  try {
    const battleLogResp = await fetch(
      `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(tag)}/battlelog`,
      { headers: { Accept: "application/json" } },
    );
    if (battleLogResp.ok) battleLog = (await battleLogResp.json()) ?? [];
  } catch {
    // repli silencieux sur analysis.battleLog
  }
  const warDecks = await summarizeWarDecksForMatchup(
    battleLog,
    64,
    null,
    analysis.overview.clan?.tag,
  );
  // Victoires réelles vs attendues sur 3 semaines glissantes : cumul Redis
  // (cron horaire) complété par le battle log courant, cf. matchupPerformance.js.
  const performance = aggregateMatchupPerformance(
    await getWarMatchupPerformanceSamples(tag, battleLog),
  );
  return { analysis, warDecks, performance };
}

// Récupère l'analyse + les decks de guerre (avec breakdown matchup) pour un tag joueur.
// Partagé entre /matchup-gdc et les interactions du bouton "ℹ️ Détails" (kind="gdc").
// Mis en cache le temps de la fenêtre d'interaction (getOrSet, TTL 15 min) : sans ça,
// un re-fetch à chaque clic peut retourner un battlelog légèrement différent (nouveau
// combat entre-temps) et désynchroniser les indices affichés dans le menu "Détails" de
// ceux du message d'origine — cf. bug identique et bien plus visible sur /matchup
// (fetchRecentBattlesForTag), où le battlelog Ladder change bien plus vite qu'un
// battlelog GDC.
async function fetchWarDecksForTag(tag) {
  const cleanTag = String(tag || "")
    .replace(/^#/, "")
    .toUpperCase();
  const { value } = await getOrSet(`matchup_gdc:${cleanTag}`, () =>
    fetchWarDecksForTagUncached(tag),
  );
  return value;
}

async function fetchRecentBattlesForTagUncached(tag) {
  const apiResp = await fetch(
    `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(tag)}/analysis?fast=true`,
    { headers: { Accept: "application/json" } },
  );
  if (!apiResp.ok) {
    throw new Error(
      apiResp.status === 404
        ? `Joueur \`${tag}\` introuvable.`
        : `Erreur API (${apiResp.status}).`,
    );
  }
  const analysis = await apiResp.json();
  // Battle log brut de préférence (plus complet), sinon celui de l'analyse
  let battleLog = analysis.battleLog ?? [];
  try {
    const battleLogResp = await fetch(
      `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(tag)}/battlelog`,
      { headers: { Accept: "application/json" } },
    );
    if (battleLogResp.ok) battleLog = (await battleLogResp.json()) ?? [];
  } catch {
    // repli silencieux sur analysis.battleLog
  }
  const warDecks = await summarizeRecentBattlesForMatchup(
    battleLog,
    6,
    analysis.overview.clan?.tag,
  );
  // Victoires réelles vs attendues sur tout le battle log exploitable (pas
  // seulement les combats affichés), cf. computeMatchupPerformance.
  const performance = await computeMatchupPerformance(battleLog, {
    warOnly: false,
  });
  return { analysis, warDecks, performance };
}

// Récupère l'analyse + les 6 derniers combats bruts (tous types) pour un tag
// joueur. Partagé entre /matchup et les interactions du bouton "ℹ️ Détails"
// (kind="recent"). Pendant de fetchWarDecksForTag() ci-dessus, mais sans
// filtre GDC ni regroupement par deck (cf. summarizeRecentBattlesForMatchup).
// Mis en cache (getOrSet, TTL 15 min, clé par tag) : le "Détails" doit montrer
// EXACTEMENT les 6 combats affichés dans le message d'origine, or un joueur
// actif en Ladder peut jouer un nouveau combat entre la commande et le clic
// sur le bouton — sans cache, un re-fetch décale la fenêtre des "6 derniers
// combats" et désynchronise les indices (Deck 1 du message ≠ Deck 1 du détail).
async function fetchRecentBattlesForTag(tag) {
  const cleanTag = String(tag || "")
    .replace(/^#/, "")
    .toUpperCase();
  const { value } = await getOrSet(`matchup_recent:${cleanTag}`, () =>
    fetchRecentBattlesForTagUncached(tag),
  );
  return value;
}

// kind distingue les deux commandes qui partagent ce flux "ℹ️ Détails" :
// "gdc" pour /matchup-gdc (fetchWarDecksForTag), "recent" pour /matchup
// (fetchRecentBattlesForTag) — encodé dans le custom_id pour que les
// handlers d'interaction sachent quelle source re-fetcher.
function buildMatchupDetailButtonRow(tag, kind = "gdc") {
  const cleanTag = String(tag || "")
    .replace(/^#/, "")
    .toUpperCase();
  return [
    {
      type: 1,
      components: [
        {
          type: 2,
          style: 2,
          emoji: { name: "ℹ️" },
          label: "Détails",
          custom_id: `matchup_detail:${kind}:${cleanTag}`,
        },
      ],
    },
  ];
}

function buildMatchupDetailSelectRow(tag, warDecks, kind = "gdc") {
  const cleanTag = String(tag || "")
    .replace(/^#/, "")
    .toUpperCase();
  const options = (Array.isArray(warDecks) ? warDecks : [])
    .slice(0, 25)
    .map((deck, index) => {
      const match = deck.matches?.[0] ?? {};
      const dayLabel =
        kind === "recent"
          ? formatRecentMatchDate(match.battleTime)
          : getWarDayLabel(match.dayKey);
      const typeLabel =
        kind === "recent"
          ? getBattleTypeLabel(match.type, match.gameMode)
          : getWarMatchTypeLabel(match.type, match.gameMode);
      const deckLabel = [deck.label, typeLabel].filter(Boolean).join(" ");
      const matchupPct = Number.isFinite(match.matchup)
        ? `${Math.round(match.matchup * 100)}%`
        : "?";
      return {
        label:
          `${dayLabel} · ${deckLabel} vs ${match.opponentName || "?"}`.slice(
            0,
            100,
          ),
        description:
          `${match.score || "?"} · ${matchupPct} de difficulté`.slice(0, 100),
        value: String(index),
      };
    });
  if (options.length === 0) return null;
  return [
    {
      type: 1,
      components: [
        {
          type: 3,
          custom_id: `matchup_detail_select:${kind}:${cleanTag}`,
          placeholder: "Choisis un match pour voir le détail",
          options,
        },
      ],
    },
  ];
}

// Ligne "🎯 Performance" de /matchup, /matchup-gdc et /stats : victoires
// réelles vs attendues d'après le %matchup (cf. computeMatchupPerformance).
// L'écart n'est en gras qu'au-delà de 2 écarts types : en deçà, il peut venir
// du seul hasard. Emoji succès/erreur selon le signe de l'écart arrondi.
// Moins de 4 combats (une journée de GDC) : pas de ligne.
function formatMatchupPerformanceField(
  performance,
  name = "🎯 Performance :",
) {
  if (!performance || performance.battles < 4) return null;
  const fmt = (value) => value.toFixed(1).replace(".", ",");
  const { battles, wins, expected, diff, sd } = performance;
  const rounded = Math.round(diff * 10) / 10;
  const signed = `${rounded >= 0 ? "+" : "-"}${fmt(Math.abs(rounded))}`;
  const gap = Math.abs(diff) >= 2 * sd ? `**${signed}**` : signed;
  const emoji =
    rounded > 0
      ? " <:success:1499002702208958577>"
      : rounded < 0
        ? " <:error:1499002755841265826>"
        : "";
  return {
    name,
    value: `${wins} win sur ${battles} combats (${fmt(expected)} attendues) : ${gap}${emoji}`,
    inline: false,
  };
}

function buildMatchupDetailEmbed(warDecks, index, kind = "gdc") {
  const deck = Array.isArray(warDecks) ? warDecks[index] : null;
  const match = deck?.matches?.[0];
  const detail = match?.matchupDetail;
  if (!deck || !match || !detail) return null;

  const dayLabel =
    kind === "recent"
      ? formatRecentMatchDate(match.battleTime)
      : getWarDayLabel(match.dayKey);
  const typeLabel =
    kind === "recent"
      ? getBattleTypeLabel(match.type, match.gameMode)
      : getWarMatchTypeLabel(match.type, match.gameMode);
  const deckLabel = [deck.label, typeLabel].filter(Boolean).join(" ");
  const matchupPct = Number.isFinite(match.matchup)
    ? Math.round(match.matchup * 100)
    : "?";
  const resultEmoji = match.result === "win" ? "✅" : "❌";
  const wcA = detail.winConditionsA?.length
    ? detail.winConditionsA.join(", ")
    : "Inconnue";
  const wcB = detail.winConditionsB?.length
    ? detail.winConditionsB.join(", ")
    : "Inconnue";
  // Affichage dans le SENS DE LA DIFFICULTÉ (comme le %final) : positif =
  // défavorable au joueur, négatif = favorable. C'est l'inverse du signe
  // interne du moteur (scoreA = avantage du joueur) — cf. matchupEngine.js.
  const fmtLayer = (value) => {
    const displayed = Math.round(-(Number.isFinite(value) ? value : 0));
    return `${displayed > 0 ? "+" : ""}${displayed}`;
  };

  // Barre de 18 cases proportionnelle au %matchup (arrondi au plus proche).
  // 18 plutôt que 20 : 20 emoji ne tiennent pas sur une largeur d'écran mobile.
  // Le rouge (difficulté/adversaire) est proportionnel au %, le bleu (confort/
  // toi) est le complément — à 71% de difficulté, la barre doit être
  // majoritairement rouge, pas bleue.
  const difficultyBar = (() => {
    if (typeof matchupPct !== "number") return null;
    const total = 18;
    const redFilled = Math.max(
      0,
      Math.min(total, Math.round((total * matchupPct) / 100)),
    );
    return "🟦".repeat(total - redFilled) + "🟥".repeat(redFilled);
  })();

  // Chaque layer séparé par une ligne vide, du plus au moins déterminant
  // (cf. calibrage dans matchupEngine.js). Les bornes ne sont pas rappelées
  // ici : elles sont documentées dans la doc de la commande. Partagé par
  // /matchup et /matchup-gdc (même moteur, seul `kind` change le titre).
  const calcDetail = [
    `**📊 Écart de niveau** : **${fmtLayer(detail.breakdown?.level)}%**\n${detail.reasons?.level ?? "?"}`,
    `**✨ Évolutions et héros** : **${fmtLayer(detail.breakdown?.evolutions)}%**\n${detail.reasons?.evolutions ?? "?"}`,
    `**⚔️ Counters directs** : **${fmtLayer(detail.breakdown?.counters)}%**\n${detail.reasons?.counters ?? "?"}`,
    `**🏗️ Structure du deck** : **${fmtLayer(detail.breakdown?.structure)}%**\n${detail.reasons?.structure ?? "?"}`,
  ].join("\n\n");

  return {
    title: `⚡ Détail — ${dayLabel} · ${deckLabel} vs ${match.opponentName || "?"}`,
    description: `${resultEmoji} ${match.score || "?"} · **${matchupPct}%** de difficulté${difficultyBar ? `\n${difficultyBar}` : ""}\n\n${calcDetail}`,
    color: 0xe67e22,
    fields: [
      {
        name: "Ton deck :",
        value: `- ${(deck.cardNames || []).join(", ") || "?"}`,
        inline: false,
      },
      {
        name: "Deck adverse :",
        value: `- ${(detail.opponentCardNames || []).join(", ") || "?"}`,
        inline: false,
      },
      {
        name: "Win conditions :",
        value: [
          `- ${CROWN_SELF} **${wcA}**`,
          `- ${CROWN_OPPONENT} **${wcB}**`,
        ].join("\n"),
        inline: false,
      },
    ],
  };
}

export async function routeJoueur(body, res) {
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

        if (analysis.warHistoryDegraded) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `⚠️ Données partielles pour \`${tag}\` : l'API Clash Royale n'a pas répondu pour l'historique de guerre, la fiabilité affichée serait incorrecte. Réessaie la commande dans quelques instants.`,
              flags: 64,
            }),
          });
          return;
        }

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
        let warDecks = await summarizeWarDecks(analysis.battleLog ?? []);
        if (!warDecks.length) {
          try {
            const battleLogResp = await fetch(
              `${TRUST_ROYALE_URL}/api/player/${encodeURIComponent(tag)}/battlelog`,
              { headers: { Accept: "application/json" } },
            );
            if (battleLogResp.ok) {
              const battleLog = await battleLogResp.json();
              warDecks = await summarizeWarDecks(battleLog ?? []);
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
        // Même fenêtre que le score "Points / deck" (3 dernières semaines
        // GDC terminées) pour éviter d'afficher deux moyennes incohérentes.
        const completedNonIgnoredWeeks = Array.isArray(warHistory?.weeks)
          ? warHistory.weeks.filter((w) => !w.isCurrent && !w.ignored)
          : [];
        const efficiencyHistory = summarizePointsPerDeckWeeks(
          completedNonIgnoredWeeks,
          3,
        );
        const pointsPerDeck = efficiencyHistory.totalDecks
          ? Number(efficiencyHistory.pointsPerDeck.toFixed(2))
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
          detailLines.push(
            `- **Points par deck :** ${pointsPerDeck} (3 dernières semaines terminées)`,
          );
        }
        // Performance GDC sur 3 semaines glissantes (cf. matchupPerformance.js),
        // même format que la ligne 🎯 de /matchup-gdc. Facultative : un échec
        // (Redis, catalogue) ne doit pas bloquer /stats.
        try {
          const performanceField = formatMatchupPerformanceField(
            aggregateMatchupPerformance(
              await getWarMatchupPerformanceSamples(
                tag,
                analysis.battleLog ?? [],
              ),
            ),
          );
          if (performanceField) {
            detailLines.push(
              `- **Performance (3 semaines) :** ${performanceField.value}`,
            );
          }
        } catch (err) {
          console.warn("[stats] performance indisponible:", err.message);
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

        const bestRankedLeagueLabel = getBestRankedLeagueLabel(
          analysis.overview.bestPathOfLegendLeagueNumber,
          analysis.overview.bestPathOfLegendTrophies,
        );

        const fields = [
          {
            name: "Fiabilité :",
            value: `${icon} ${Math.round(pct)}% (${verdictFr})`,
            inline: false,
          },
          ...(bestRankedLeagueLabel
            ? [
                {
                  name: "Meilleur Rang :",
                  value: `${
                    bestRankedLeagueLabel === "Champion Suprême"
                      ? "<:CS:1549458633396588544>"
                      : "<:CR:1549458634675724348>"
                  } ${bestRankedLeagueLabel}`,
                  inline: false,
                },
              ]
            : []),
          ...(isSupremeChampionLeague(
            analysis.overview.bestPathOfLegendLeagueNumber,
            analysis.overview.bestPathOfLegendTrophies,
          )
            ? [
                {
                  name: "Trophées ranked :",
                  value: `<:CS:1549458633396588544> ${analysis.overview.bestPathOfLegendTrophies}`,
                  inline: false,
                },
              ]
            : []),
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
          // /stats ne doit plus afficher les decks GDC, ce bloc est réservé à /matchup-gdc.
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

  // Commande /combats — suivi jour par jour des combats de GDC d'un joueur
  // (semaine en cours + semaine précédente).
  if (body.type === 2 && body.data?.name === "combats") {
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
      console.error("Discord webhook URL non construite pour /combats");
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
        let analysis;
        let warDecks;
        try {
          ({ analysis, warDecks } = await fetchWarDecksForTag(tag));
        } catch (err) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: err.message, flags: 64 }),
          });
          return;
        }

        if (analysis.warHistoryDegraded) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: `⚠️ Données partielles pour \`${tag}\` : l'API Clash Royale n'a pas répondu pour l'historique de guerre. Réessaie la commande dans quelques instants.`,
              flags: 64,
            }),
          });
          return;
        }

        // currentWarDays est null hors période GDC (calendrier lun-mer),
        // cf. buildCurrentWarDays() — source de vérité, pas besoin de
        // recalculer un état de période séparé pour un joueur.
        const isWarPeriod = analysis.currentWarDays != null;
        const combatsByDay = computeCombatsByDay(warDecks);
        const combatsByDayKey = new Map(combatsByDay.map((d) => [d.dayKey, d]));

        const warHistory = analysis.warHistory;
        const currentWeek = warHistory?.weeks?.find((w) => w.isCurrent);
        const lastWeekEntry = warHistory?.weeks?.find((w) => !w.isCurrent);

        const currentClanName =
          analysis.overview.clan?.name ||
          analysis.overview.clan?.tag ||
          "Aucun";
        const currentClanTag = analysis.overview.clan?.tag || null;
        const currentClanLink = currentClanTag
          ? `[${currentClanName}](${trustClanUrl(currentClanTag)})`
          : currentClanName;

        let currentWeekLines = ["Pas de GDC en cours."];
        if (isWarPeriod) {
          const dayEntries = analysis.currentWarDays.days.map((day, idx) => {
            const label = getWarDayLabel(day.key);
            if (day.isFuture) return { label, isFuture: true };
            const stats = combatsByDayKey.get(day.key);
            const battleLogDecks = stats?.decks ?? 0;
            // Le battle log (source de `stats`) est capé aux ~25-30 derniers
            // combats côté API Clash Royale : un jour ancien peut en sortir
            // complètement au fil de la semaine si beaucoup de combats plus
            // récents s'accumulent. Le snapshot horaire (warSnapshotDays),
            // lui, est persisté et ne s'efface jamais : on lui fait
            // confiance dès qu'il indique plus de decks que le battle log.
            const snapshotDecks = Array.isArray(analysis.warSnapshotDays)
              ? analysis.warSnapshotDays[idx]
              : null;
            const decks =
              snapshotDecks != null
                ? Math.max(snapshotDecks, battleLogDecks)
                : battleLogDecks;
            const battleLogIncomplete = decks > battleLogDecks;
            return {
              label,
              isFuture: false,
              isToday: Boolean(day.isToday),
              decks,
              battleLogIncomplete,
              wins: battleLogIncomplete ? null : (stats?.wins ?? 0),
              points: battleLogIncomplete ? null : (stats?.points ?? 0),
              boatAttacks: stats?.boatAttacks ?? 0,
              hasDuel: stats?.hasDuel,
            };
          });

          // Un jour dont le détail est indisponible (battle log tronqué,
          // cf. ci-dessus) peut parfois voir ses points déduits exactement
          // par différence avec le total hebdomadaire exact
          // (currentWeek.fame) : si un seul jour est concerné, son total de
          // points est forcément le reste des points déjà connus sur les
          // autres jours. Pas de déduction des victoires en revanche (le
          // détail combat par combat de ce jour reste, lui, indisponible).
          if (Number.isFinite(currentWeek?.fame)) {
            const incompleteDays = dayEntries.filter(
              (d) => !d.isFuture && d.battleLogIncomplete && d.decks > 0,
            );
            if (incompleteDays.length === 1) {
              const knownPointsSum = dayEntries.reduce(
                (sum, d) => sum + (Number.isFinite(d.points) ? d.points : 0),
                0,
              );
              const remainder = currentWeek.fame - knownPointsSum;
              if (remainder >= 0) incompleteDays[0].points = remainder;
            }
          }

          currentWeekLines = dayEntries.map((d) => {
            if (d.isFuture) {
              const badge = getCombatsDayBadge(null, { isFuture: true });
              return `${badge} ${d.label} : à venir`;
            }
            const badge = getCombatsDayBadge(d.decks, { isToday: d.isToday });
            if (d.decks === 0 && d.isToday)
              return `${badge} ${d.label} : pas encore joué`;
            if (d.decks === 0) return `${badge} ${d.label} : 0 deck`;
            if (d.battleLogIncomplete) {
              const pointsSuffix = Number.isFinite(d.points)
                ? ` · ${d.points} pts`
                : "";
              return `${badge} ${d.label} : ${d.decks} deck${d.decks === 1 ? "" : "s"}${pointsSuffix} (détail indisponible)`;
            }
            let line = `${badge} ${d.label} : ${d.decks} deck${d.decks === 1 ? "" : "s"} (${d.wins} victoire${d.wins === 1 ? "" : "s"}) · ${d.points} pts`;
            // Warnings uniquement sur un jour clos (jamais "aujourd'hui",
            // jamais "à venir", déjà retournés plus haut) avec au moins un
            // deck joué (déjà garanti à ce stade).
            if (!d.isToday) {
              const warnings = [];
              if (d.boatAttacks > 0) {
                warnings.push(
                  `⚠️ ${d.boatAttacks} attaque${d.boatAttacks === 1 ? "" : "s"} bateau`,
                );
              }
              if (!d.hasDuel) {
                warnings.push("⚠️ 0 duel");
              }
              if (warnings.length) line += ` · ${warnings.join(" · ")}`;
            }
            return line;
          });
        }
        // ⚠️ Limite connue : le regroupement par jour ci-dessus repose sur
        // warDayKey(battleTime), et battleTime d'un Duel correspond à
        // l'heure de FIN du combat (un Duel dure plusieurs minutes, jusqu'à
        // 3 rounds). Un Duel commencé juste avant le reset du clan et
        // terminé juste après peut donc s'afficher sur le mauvais jour.
        // Vérifié en conditions réelles (tag #U2UYYCQVG, saison Colisée) :
        // le compteur decksUsedToday de l'API Clash Royale ne permet PAS de
        // trancher ce cas de façon fiable (résultats contradictoires selon
        // les joueurs testés, semaine Colisée aux mécaniques de deck/jour
        // potentiellement différentes). Aucune correction fiable identifiée
        // à ce jour — le total hebdomadaire affiché plus bas reste exact
        // dans tous les cas (source : currentWeek.fame/decksUsed, pas une
        // somme des jours), seul ce détail par jour peut occasionnellement
        // afficher un combat sur le mauvais jour.
        const currentTotalDecks = currentWeek?.decksUsed ?? 0;
        const currentTotalPoints = currentWeek?.fame ?? 0;
        const currentPointsPerDeck = currentTotalDecks
          ? Math.round(currentTotalPoints / currentTotalDecks)
          : null;
        currentWeekLines.push(
          `**Total semaine actuelle : ${currentTotalPoints} pts**${
            currentPointsPerDeck !== null
              ? ` (${currentPointsPerDeck} pts/deck)`
              : ""
          }`,
        );

        const lastWeekDays = Array.isArray(analysis.warLastWeekDays)
          ? analysis.warLastWeekDays
          : [];
        const lastWeekLines = lastWeekDays.length
          ? lastWeekDays.map((day) => {
              const label = getWarDayLabel(day.date);
              const badge = getCombatsDayBadge(day.decks, {});
              if (day.decks === null || day.decks === undefined) {
                return `${badge} ${label} : pas de données`;
              }
              if (day.decks === 0) return `${badge} ${label} : 0 deck`;
              return `${badge} ${label} : ${day.decks} deck${day.decks === 1 ? "" : "s"}${
                Number.isFinite(day.points) ? ` · ${day.points} pts` : ""
              }`;
            })
          : ["Aucune donnée disponible pour la semaine précédente."];
        const lastTotalDecks = lastWeekEntry?.decksUsed ?? 0;
        const lastTotalPoints = lastWeekEntry?.fame ?? 0;
        const lastPointsPerDeck = lastTotalDecks
          ? Math.round(lastTotalPoints / lastTotalDecks)
          : null;
        const lastWeekLabel = toPublicWeekId(analysis.warLastWeekId) || "";
        if (lastWeekEntry) {
          lastWeekLines.push(
            `**Total semaine dernière${lastWeekLabel ? ` (${lastWeekLabel})` : ""} : ${lastTotalPoints} pts**${
              lastPointsPerDeck !== null
                ? ` (${lastPointsPerDeck} pts/deck)`
                : ""
            }`,
          );
        }

        const fields = [
          {
            name: "Combats semaine actuelle :",
            value: currentWeekLines.join("\n"),
            inline: false,
          },
          {
            name: "Combats semaine dernière :",
            value: lastWeekLines.join("\n"),
            inline: false,
          },
        ];

        const matchupAverage = Number.isFinite(analysis.matchup?.average)
          ? `${Math.round(analysis.matchup.average * 100)}%`
          : null;
        if (matchupAverage) {
          fields.push({
            name: "Matchup moyen de la semaine :",
            value: `⚡ ${matchupAverage}`,
            inline: false,
          });
        }

        const resetTime = currentClanTag
          ? formatResetTimeParis(currentClanTag)
          : null;

        const currentDayLabel = isWarPeriod
          ? ` J${(analysis.currentWarDays.daysFromThu ?? 0) + 1}`
          : "";

        const embed = {
          title: `<:cards:1499284927894650950> Combats GDC${currentDayLabel} : ${analysis.overview.name}${analysis.isNew ? " 🆕" : ""}`,
          url: trustPlayerUrl(tag),
          color: 0x3498db,
          description: `${tag} · ${currentClanLink}${resetTime ? ` · Reset : ${resetTime}` : ""}`,
          fields,
          footer: {
            text: "Voir le détail combat par combat avec /matchup-gdc",
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
            content: `Erreur lors de l'analyse : ${err.message}`,
            flags: 64,
          }),
        });
      }
    });
    return;
  }

  // Commande /matchup-gdc
  if (body.type === 2 && body.data?.name === "matchup-gdc") {
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
      console.error("Discord webhook URL non construite pour /matchup-gdc");
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
        let analysis;
        let warDecks;
        let performance;
        try {
          ({ analysis, warDecks, performance } = await fetchWarDecksForTag(tag));
        } catch (err) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: err.message, flags: 64 }),
          });
          return;
        }

        const detailComponents = buildMatchupDetailButtonRow(tag, "gdc");
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
          value: "https://trustroyale.vercel.app/bot/#matchup-gdc",
          inline: false,
        };

        const dataEmbed = {
          title,
          url: trustPlayerUrl(tag),
          color: 0xe67e22,
          description: warDecksField || undefined,
          fields: [
            ...fields,
            formatMatchupPerformanceField(
              performance,
              "🎯 Performance (3 semaines) :",
            ),
            matchupLinkField,
          ].filter(Boolean),
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
            components: detailComponents,
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
            "No deckImage generated for /matchup-gdc, sending embed only",
          );
          const textResponse = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              embeds: [dataEmbed],
              components: detailComponents,
            }),
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

  // Commande /matchup — 6 derniers combats bruts du joueur, tous types
  // confondus (GDC/Ladder/Amical/Challenge...), pendant de /matchup-gdc.
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
        let analysis;
        let warDecks;
        let performance;
        try {
          ({ analysis, warDecks, performance } = await fetchRecentBattlesForTag(tag));
        } catch (err) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ content: err.message, flags: 64 }),
          });
          return;
        }

        const detailComponents = buildMatchupDetailButtonRow(tag, "recent");
        let deckImage = null;
        const recentBattlesField = formatRecentBattlesField(warDecks);
        try {
          deckImage = await buildWarDecksImage(warDecks, {
            maxRows: 6,
            kind: "recent",
          });
        } catch {
          deckImage = null;
        }
        if (!deckImage && Array.isArray(warDecks) && warDecks.length > 0) {
          deckImage = buildWarDecksTextFallbackImage(warDecks);
        }

        const fields = [];
        if (!Array.isArray(warDecks) || warDecks.length === 0) {
          fields.push({
            name: "Aucun combat :",
            value:
              "⚠️ Aucun combat en mode standard (Ladder, Classé, GDC, Amical) dans le battlelog.",
            inline: false,
          });
        }

        const displayedAverageMatchupValue =
          computeAverageMatchupFromWarDecks(warDecks);
        const averageMatchup = Number.isFinite(displayedAverageMatchupValue)
          ? `${Math.round(displayedAverageMatchupValue * 100)}%`
          : null;
        const title = averageMatchup
          ? `⚡ Derniers combats · ${analysis.overview.name} : ${averageMatchup}`
          : `⚡ Derniers combats · ${analysis.overview.name}`;
        const matchupLinkField = {
          name: "Le ⚡% correspond à la difficulté de l'affrontement. Calcul :",
          value: "https://trustroyale.vercel.app/bot/#matchup-gdc",
          inline: false,
        };

        const dataEmbed = {
          title,
          url: trustPlayerUrl(tag),
          color: 0xe67e22,
          description: recentBattlesField || undefined,
          fields: [
            ...fields,
            formatMatchupPerformanceField(performance),
            matchupLinkField,
          ].filter(Boolean),
        };

        let imageResponse = null;
        if (deckImage?.buffer) {
          const embedWithImage = {
            ...dataEmbed,
            image: {
              url: `attachment://${deckImage.filename || "matchup-decks.png"}`,
            },
          };

          imageResponse = await sendDiscordWebhookFile(webhookUrl, deckImage, {
            embed: embedWithImage,
            components: detailComponents,
          });
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
          const textResponse = await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              embeds: [dataEmbed],
              components: detailComponents,
            }),
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
            const fallbackText = recentBattlesField
              ? `Matchup moyen : ${averageMatchup ?? "N/A"}\n\n${recentBattlesField}`
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

  // Bouton "ℹ️ Détails" sur /matchup-gdc et /matchup : ouvre un menu
  // déroulant (message éphémère) pour choisir un match et en voir le détail
  // (layers, win conditions, decks complets). custom_id : matchup_detail:<kind>:<tag>
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("matchup_detail:")
  ) {
    const [, kind, tagHex] = body.data.custom_id.split(":");
    const tag = `#${tagHex || ""}`;
    const webhookUrl = buildDiscordWebhookUrl(body);
    if (!webhookUrl) {
      return res
        .status(200)
        .json({ type: 4, data: { content: "Erreur interne.", flags: 64 } });
    }

    res.status(200).json({ type: 5, data: { flags: 64 } });

    runBackground(async () => {
      try {
        const { warDecks } =
          kind === "recent"
            ? await fetchRecentBattlesForTag(tag)
            : await fetchWarDecksForTag(tag);
        const components = buildMatchupDetailSelectRow(tag, warDecks, kind);
        if (!components) {
          await fetch(webhookUrl, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
              content: "Aucun match à détailler pour le moment.",
            }),
          });
          return;
        }
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: "Choisis un match pour voir le détail du calcul :",
            components,
          }),
        });
      } catch (err) {
        await fetch(webhookUrl, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ content: `Erreur : ${err.message}` }),
        });
      }
    });
    return;
  }

  // Sélection d'un match dans le menu déroulant "ℹ️ Détails" : met à jour le
  // message éphémère avec le breakdown complet, en gardant le menu actif
  // pour pouvoir enchaîner sur un autre match.
  if (
    body.type === 3 &&
    typeof body.data?.custom_id === "string" &&
    body.data.custom_id.startsWith("matchup_detail_select:")
  ) {
    const [, kind, tagHex] = body.data.custom_id.split(":");
    const tag = `#${tagHex || ""}`;
    const selectedIndex = Number(body.data.values?.[0]);
    const webhookUrl = buildDiscordWebhookUrl(body);
    const originalWebhookUrl = webhookUrl
      ? `${webhookUrl}/messages/@original`
      : null;
    if (!originalWebhookUrl) {
      return res
        .status(200)
        .json({ type: 4, data: { content: "Erreur interne.", flags: 64 } });
    }

    res.status(200).json({ type: 6 });

    runBackground(async () => {
      try {
        const { warDecks } =
          kind === "recent"
            ? await fetchRecentBattlesForTag(tag)
            : await fetchWarDecksForTag(tag);
        const embed = buildMatchupDetailEmbed(warDecks, selectedIndex, kind);
        const components =
          buildMatchupDetailSelectRow(tag, warDecks, kind) || [];
        const patchBody = embed
          ? { content: "", embeds: [embed], components }
          : {
              content:
                "Ce match n'est plus disponible (données mises à jour depuis).",
              embeds: [],
              components,
            };
        const r = await fetch(originalWebhookUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(patchBody),
        });
        if (!r.ok) {
          const txt = await r.text().catch(() => "");
          console.error(
            `[matchup_detail_select] PATCH Discord HTTP ${r.status}:`,
            txt.slice(0, 300),
          );
        }
      } catch (err) {
        await fetch(originalWebhookUrl, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            content: `Erreur : ${err.message}`,
            embeds: [],
            components: [],
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
        tourFooter += " • Les troupes de tour comptent dans les cartes";

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
            value: String(col.cardCount),
            inline: true,
          },
          {
            name: "Évolutions :",
            value: String(col.evolvedCount),
            inline: true,
          },
          {
            name: "Héros :",
            value: String(col.heroCount),
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
}
