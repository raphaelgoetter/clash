// Commande /multi : liste les multi-comptes connus, d'après les liens
// tag Clash → compte Discord (hash Redis `discordlinks`). Un multi = un
// compte Discord lié à au moins deux tags. Le compte principal est celui
// qui a le plus de trophées. Les comptes inactifs (plus de 30 jours sans
// connexion, ou dernière connexion inconnue) sont écartés, ainsi que les
// comptes Discord qui ne sont plus sur le serveur. Les multis sans aucun
// compte dans un clan de la famille sont listés à part.

import { getDiscordLinks } from "../../../backend/services/discordLinks.js";
import { FAMILY_CLAN_TAGS, mapWithConcurrency, trustPlayerUrl } from "../_lib/commun.js";

const MS_PER_DAY = 24 * 60 * 60 * 1000;
const DESCRIPTION_MAX = 4096;
const MAX_DAYS_OFFLINE = 30;

function normalizeTag(tag) {
  const t = String(tag ?? "").trim().toUpperCase();
  if (!t) return null;
  return t.startsWith("#") ? t : `#${t}`;
}

// Regroupe les tags par compte Discord et ne garde que les comptes à 2 tags
// ou plus. `memberIds` (optionnel) : comptes Discord présents sur le serveur.
export function groupMultiAccounts(links, memberIds = null) {
  const byUser = new Map();
  for (const [rawTag, userId] of Object.entries(links ?? {})) {
    const tag = normalizeTag(rawTag);
    const id = String(userId ?? "").trim();
    if (!tag || !id) continue;
    if (memberIds && !memberIds.has(id)) continue;
    if (!byUser.has(id)) byUser.set(id, new Set());
    byUser.get(id).add(tag);
  }
  return [...byUser.values()]
    .map((tags) => [...tags])
    .filter((tags) => tags.length >= 2);
}

// Nombre de jours entiers sans connexion, ou null si inconnu.
export function daysOffline(lastSeenDate, now = new Date()) {
  if (!lastSeenDate || Number.isNaN(lastSeenDate.getTime())) return null;
  return Math.max(0, Math.floor((now.getTime() - lastSeenDate.getTime()) / MS_PER_DAY));
}

// « (Les Revoltes) », « (Les Revoltes, 📵 40 jours) », « (aucun clan, 📵 2 jours) »
function formatDetails(account) {
  const parts = [account.clanName ?? "aucun clan"];
  if (account.days != null && account.days >= 1) {
    parts.push(`📵 ${account.days} jour${account.days > 1 ? "s" : ""}`);
  }
  return `(${parts.join(", ")})`;
}

function formatAccount(account, { link = false } = {}) {
  if (!account.found) return `${account.tag} (introuvable)`;
  const name = link ? `[${account.name}](${trustPlayerUrl(account.tag)})` : account.name;
  return `${name} ${account.tag} ${formatDetails(account)}`;
}

// Trie les comptes d'un multi (principal = plus de trophées en premier) et
// les groupes par nombre de comptes décroissant, puis par nom du principal.
export function buildMultiLines(groups) {
  const sorted = groups
    .map((accounts) => [...accounts].sort((a, b) => (b.trophies ?? -1) - (a.trophies ?? -1)))
    .sort(
      (a, b) =>
        b.length - a.length ||
        String(a[0].name ?? a[0].tag).localeCompare(String(b[0].name ?? b[0].tag), "fr", {
          sensitivity: "base",
          numeric: true,
        }),
    );
  return sorted.map(([main, ...alts], i) => {
    const altsText = alts.map((a) => formatAccount(a)).join(", ");
    return `${i + 1}. ${formatAccount(main, { link: true })} ⇢ ${altsText}`;
  });
}

// Vrai si au moins un compte du multi est dans un clan de la famille.
export function isInFamily(accounts) {
  return accounts.some((a) => a.clanTag && FAMILY_CLAN_TAGS.has(a.clanTag.replace(/^#/, "").toUpperCase()));
}

// Ne garde que les comptes actifs, puis les multis qui en ont encore deux.
export function keepActiveGroups(groups, maxDays = MAX_DAYS_OFFLINE) {
  return groups
    .map((accounts) => accounts.filter((a) => a?.found && a.days != null && a.days <= maxDays))
    .filter((accounts) => accounts.length >= 2);
}

// Découpe les lignes en descriptions d'embed de 4096 caractères au plus.
export function chunkLines(lines, max = DESCRIPTION_MAX) {
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n${line}` : line;
    if (next.length > max && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);
  return chunks;
}

// Identifiants des membres du serveur Discord (pagination par 1 000).
async function fetchGuildMemberIds() {
  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_TOKEN;
  const ids = new Set();
  let after = "0";
  for (;;) {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000&after=${after}`,
      { headers: { Authorization: `Bot ${botToken}` } },
    );
    if (!res.ok) throw new Error(`Discord Guild Members API: ${res.status}`);
    const page = await res.json();
    for (const m of page) if (m.user?.id) ids.add(m.user.id);
    if (page.length < 1000) return ids;
    after = page[page.length - 1].user.id;
  }
}

async function loadAccounts(tags, now) {
  const { fetchPlayer, fetchClanMembers, fetchBattleLog } =
    await import("@clash/clash-royale/clashApi.js");
  const { parseClashDate } = await import("@clash/clash-royale/dateUtils.js");

  const players = await mapWithConcurrency(tags, 8, async (tag) => {
    try {
      return { tag, player: await fetchPlayer(tag) };
    } catch {
      return { tag, player: null };
    }
  });

  // lastSeen n'existe que dans le roster du clan : un appel par clan distinct.
  const clanTags = [...new Set(players.map((p) => p.player?.clan?.tag).filter(Boolean))];
  const rosters = new Map();
  await mapWithConcurrency(clanTags, 5, async (clanTag) => {
    try {
      rosters.set(clanTag, await fetchClanMembers(clanTag));
    } catch {
      rosters.set(clanTag, []);
    }
  });

  return mapWithConcurrency(players, 8, async ({ tag, player }) => {
    if (!player) return { tag, found: false, trophies: -1 };
    const clanTag = player.clan?.tag ?? null;
    let lastSeen = null;
    if (clanTag) {
      const entry = (rosters.get(clanTag) ?? []).find((m) => normalizeTag(m.tag) === tag);
      if (entry?.lastSeen) lastSeen = parseClashDate(entry.lastSeen);
    } else {
      // Hors clan : le dernier combat sert d'approximation de la dernière connexion.
      try {
        const battles = await fetchBattleLog(tag);
        if (battles[0]?.battleTime) lastSeen = parseClashDate(battles[0].battleTime);
      } catch {
        // dernière connexion inconnue
      }
    }
    return {
      tag,
      found: true,
      name: player.name,
      trophies: player.trophies ?? 0,
      clanName: player.clan?.name ?? null,
      clanTag,
      days: daysOffline(lastSeen, now),
    };
  });
}

async function postWebhook(webhookUrl, payload) {
  await fetch(webhookUrl, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ allowed_mentions: { parse: [] }, ...payload }),
  });
}

export async function handleMultiCommand(webhookUrl, now = new Date()) {
  try {
    const [links, memberIds] = await Promise.all([getDiscordLinks(), fetchGuildMemberIds()]);
    const tagGroups = groupMultiAccounts(links, memberIds);
    const accounts = await loadAccounts(tagGroups.flat(), now);
    const byTag = new Map(accounts.map((a) => [a.tag, a]));
    const groups = keepActiveGroups(tagGroups.map((tags) => tags.map((t) => byTag.get(t))));
    if (groups.length === 0) {
      await postWebhook(webhookUrl, { content: "Aucun multi-compte connu." });
      return;
    }

    const family = groups.filter(isInFamily);
    const others = groups.filter((g) => !isInFamily(g));
    const sections = [
      { title: `👥 Multi-comptes dans nos clans (${family.length})`, groups: family },
      { title: `🌍 Multi-comptes hors de nos clans (${others.length})`, groups: others },
    ];
    const embeds = [];
    for (const section of sections) {
      if (section.groups.length === 0) continue;
      const chunks = chunkLines(buildMultiLines(section.groups));
      for (const [i, description] of chunks.entries()) {
        const embed = { color: 0x5865f2, description };
        if (i === 0) embed.title = section.title;
        embeds.push(embed);
      }
    }
    embeds.at(-1).footer = {
      text: `Non listés : comptes non connectés depuis plus de ${MAX_DAYS_OFFLINE} jours (ou date inconnue) et membres absents du serveur Discord.`,
    };
    for (const embed of embeds) {
      await postWebhook(webhookUrl, { embeds: [embed] });
    }
  } catch (err) {
    await postWebhook(webhookUrl, { content: `Erreur : ${err.message}`, flags: 64 });
  }
}
