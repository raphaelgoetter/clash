// ============================================================
// discordRoles.js — Résolution d'un rôle Discord par son nom, avec cache
// mémoire (un seul appel par process). Même principe que getClanRoleId()
// dans scripts/notifyRules.js, généralisé à un nom de rôle quelconque —
// évite de dupliquer la logique de fetch/cache dans chaque handler de jeu.
// ============================================================

// Rôle pingé aux annonces de lancement/récap des mini-jeux (Frame, Anagram,
// Aventure) — nom unique, pas de variable d'env dédiée nécessaire.
export const MINI_JEUX_ROLE_NAME = "MINI JEUX";

let rolesCache = null; // Role[] | null

function normalizeRoleName(value) {
  return String(value ?? "").trim().replace(/\s+/g, " ").toLowerCase();
}

async function loadGuildRoles() {
  if (rolesCache) return rolesCache;

  const guildId = process.env.DISCORD_GUILD_ID;
  const token = process.env.DISCORD_TOKEN;
  if (!guildId || !token) {
    rolesCache = [];
    return rolesCache;
  }

  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/roles`, {
      headers: { Authorization: `Bot ${token}` },
    });
    rolesCache = res.ok ? await res.json() : [];
  } catch {
    rolesCache = [];
  }
  return rolesCache;
}

// Renvoie null si le rôle n'existe pas (ou en cas d'erreur réseau) — jamais
// d'exception, un ping manqué ne doit jamais empêcher la publication d'un
// message.
export async function getRoleIdByName(roleName) {
  const roles = await loadGuildRoles();
  const match = roles.find((r) => normalizeRoleName(r?.name) === normalizeRoleName(roleName));
  return match?.id ?? null;
}

// Fragments `content`/`allowed_mentions` à fusionner dans un payload de
// message Discord pour pinger un rôle. `allowed_mentions.parse: []` bloque
// toute mention implicite (ex: @everyone présent par erreur dans un texte) —
// seul le rôle explicitement listé est notifié. roleId null (rôle introuvable,
// --no-ping) → objet vide, le message part sans ping, jamais d'erreur.
export function buildRolePingFields(roleId) {
  if (!roleId) return {};
  return {
    content: `<@&${roleId}>`,
    allowed_mentions: { parse: [], roles: [roleId] },
  };
}
