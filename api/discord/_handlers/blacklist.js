// ============================================================
// blacklist.js — Handler Discord pour `/blacklist` (réservé au staff) :
// sous-commandes `ajoute tag:`, `retire tag:` et `consulte`.
// Réponses éphémères (visibles uniquement par l'auteur de la commande).
// Stockage : backend/services/blacklist.js (Redis, hash `blacklist`).
// ============================================================

import {
  normalizeBlacklistTag,
  pushClanHistory,
  getBlacklist,
  isBlacklisted,
  setBlacklistEntries,
  removeFromBlacklist,
} from "../../../backend/services/blacklist.js";
import { memberHasRolePrefix } from "../../../backend/services/discordRoles.js";
import { fetchPlayer, fetchBattleLog } from "../../../backend/services/clashApi.js";

const STAFF_ROLE_PREFIX = "STAFF";
const BLACKLIST_COLOR = 0x2b2d31;
const EMBED_DESCRIPTION_MAX = 4000;
const TRUST_ROYALE_URL = "https://trustroyale.vercel.app";

const playerUrl = (tag) =>
  `${TRUST_ROYALE_URL}/player/${String(tag).replace(/^#/, "")}`;

async function post(webhookUrl, payload) {
  if (!webhookUrl) return;
  try {
    const r = await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        flags: 64,
        allowed_mentions: { parse: [] },
        ...payload,
      }),
    });
    if (!r.ok) {
      const txt = await r.text().catch(() => "");
      console.error(`[/blacklist] webhook HTTP ${r.status}:`, txt.slice(0, 300));
    }
  } catch (err) {
    console.error("[/blacklist] webhook erreur:", err.message);
  }
}

// Historique des clans déduit du journal de combats (25 derniers), puis du
// clan actuel — permet de connaître le clan précédent dès l'ajout.
async function buildInitialClanHistory(tag, player) {
  let clans = [];
  const battles = await fetchBattleLog(tag).catch(() => []);
  for (const battle of [...battles].reverse()) {
    const me = (battle.team ?? []).find((p) => p.tag === tag);
    clans = pushClanHistory(clans, me?.clan);
  }
  return pushClanHistory(clans, player?.clan);
}

// Dernier clan connu = clan le plus récent de l'historique différent du clan
// actuel (sinon on répéterait le clan actuel).
function lastKnownClan(clans, currentClanTag) {
  return (clans ?? []).find((c) => c.tag !== currentClanTag) ?? null;
}

async function handleAdd(webhookUrl, rawTag, discordUserId) {
  const tag = normalizeBlacklistTag(rawTag);
  if (!tag) {
    await post(webhookUrl, { content: `❌ Tag \`${rawTag}\` invalide.` });
    return;
  }
  if (await isBlacklisted(tag)) {
    await post(webhookUrl, {
      content: `ℹ️ \`${tag}\` est déjà dans la Liste Noire.`,
    });
    return;
  }

  let player;
  try {
    player = await fetchPlayer(tag);
  } catch {
    await post(webhookUrl, {
      content: `❌ Tag \`${tag}\` introuvable dans Clash Royale.`,
    });
    return;
  }

  const clans = await buildInitialClanHistory(tag, player);
  await setBlacklistEntries({
    [tag]: {
      name: player.name,
      clans,
      addedBy: discordUserId ?? null,
      addedAt: new Date().toISOString(),
    },
  });

  const previous = lastKnownClan(clans, player.clan?.tag);
  await post(webhookUrl, {
    content:
      `✅ **${player.name}** (\`${tag}\`) ajouté à la Liste Noire.\n` +
      `Clan actuel : ${player.clan?.name ?? "Aucun"} (dernier clan connu : ${previous?.name ?? "❓"})`,
  });
}

async function handleRemove(webhookUrl, rawTag) {
  const tag = normalizeBlacklistTag(rawTag);
  if (!tag) {
    await post(webhookUrl, { content: `❌ Tag \`${rawTag}\` invalide.` });
    return;
  }
  const list = await getBlacklist();
  const entry = list[tag];
  if (!entry) {
    await post(webhookUrl, {
      content: `ℹ️ \`${tag}\` n'est pas dans la Liste Noire.`,
    });
    return;
  }
  await removeFromBlacklist(tag);
  await post(webhookUrl, {
    content: `✅ **${entry.name ?? "?"}** (\`${tag}\`) retiré de la Liste Noire.`,
  });
}

async function handleList(webhookUrl) {
  const list = await getBlacklist();
  const tags = Object.keys(list).sort((a, b) =>
    String(list[a].addedAt ?? "").localeCompare(String(list[b].addedAt ?? "")),
  );

  if (tags.length === 0) {
    await post(webhookUrl, { content: "La Liste Noire est vide." });
    return;
  }

  // Profils à jour en parallèle : pseudo et clan actuels, et mise à jour de
  // l'historique des clans en Redis quand le joueur a changé de clan.
  const players = await Promise.all(
    tags.map((tag) => fetchPlayer(tag).catch(() => null)),
  );

  const updates = {};
  const lines = tags.map((tag, i) => {
    const entry = list[tag];
    const player = players[i];
    let clans = entry.clans ?? [];
    if (player) {
      const nextClans = pushClanHistory(clans, player.clan);
      if (
        player.name !== entry.name ||
        JSON.stringify(nextClans) !== JSON.stringify(clans)
      ) {
        updates[tag] = { ...entry, name: player.name, clans: nextClans };
      }
      clans = nextClans;
    }

    const name = player?.name ?? entry.name ?? "?";
    const current = player
      ? (player.clan?.name ?? "Aucun")
      : "Indisponible";
    const previous = lastKnownClan(clans, player?.clan?.tag);
    return (
      `${i + 1}. [${name}](${playerUrl(tag)}) \`${tag}\`\n` +
      `Clan actuel : **${current}** · Dernier clan connu : ${previous?.name ?? "❓"}`
    );
  });

  if (Object.keys(updates).length > 0) {
    await setBlacklistEntries(updates).catch((err) =>
      console.error("[/blacklist] mise à jour historique:", err.message),
    );
  }

  // Découpage en plusieurs embeds si la description dépasse la limite
  const chunks = [];
  let current = "";
  for (const line of lines) {
    const next = current ? `${current}\n\n${line}` : line;
    if (next.length > EMBED_DESCRIPTION_MAX && current) {
      chunks.push(current);
      current = line;
    } else {
      current = next;
    }
  }
  if (current) chunks.push(current);

  const embeds = chunks.slice(0, 10).map((description, i) => ({
    ...(i === 0 ? { title: `🏴 Liste Noire (${tags.length})` } : {}),
    color: BLACKLIST_COLOR,
    description,
  }));
  await post(webhookUrl, { embeds });
}

/**
 * Point d'entrée, appelé depuis runBackground() après la réponse type:5
 * éphémère. `body` = interaction Discord brute.
 */
export async function handleBlacklistCommand(webhookUrl, body) {
  try {
    if (!(await memberHasRolePrefix(body.member, STAFF_ROLE_PREFIX))) {
      await post(webhookUrl, {
        content: "🚫 Commande réservée au staff.",
      });
      return;
    }

    const sub = body.data?.options?.[0];
    const tagOpt = sub?.options?.find((o) => o.name === "tag")?.value;
    const discordUserId = body.member?.user?.id ?? body.user?.id;

    if (sub?.name === "ajoute") return await handleAdd(webhookUrl, tagOpt, discordUserId);
    if (sub?.name === "retire") return await handleRemove(webhookUrl, tagOpt);
    if (sub?.name === "consulte") return await handleList(webhookUrl);

    await post(webhookUrl, { content: "Sous-commande inconnue." });
  } catch (err) {
    console.error("[/blacklist] erreur:", err);
    await post(webhookUrl, { content: `Erreur : ${err.message}` });
  }
}
