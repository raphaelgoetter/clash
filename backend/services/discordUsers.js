// ============================================================
// discordUsers.js — Résolution du pseudo Discord ACTUEL d'un membre
// (surnom serveur, repli global_name/username), pour ne plus dépendre des
// pseudos figés stockés en base au moment de l'interaction (Frame, Anagram,
// Aventure, Pronostics Champions capturent tous le pseudo une seule fois et
// ne le rafraîchissent jamais si le joueur change de surnom ensuite).
//
// Même principe que discordRoles.js (déjà dans ce repo) : cache mémoire par
// process, jamais d'exception — un pseudo non résolvable (joueur ayant
// quitté le serveur, erreur réseau) ne doit jamais empêcher un affichage,
// juste retomber sur le pseudo stocké fourni par l'appelant. Pas de TTL :
// chaque script/invocation est un process court-vécu, le cache repart vide
// à chaque exécution donc toujours à jour.
// ============================================================

const memberCache = new Map(); // discordId -> pseudo actuel | null

export async function resolveDiscordUsername(discordId) {
  if (!discordId) return null;
  if (memberCache.has(discordId)) return memberCache.get(discordId);

  const guildId = process.env.DISCORD_GUILD_ID;
  const token = process.env.DISCORD_TOKEN;
  if (!guildId || !token) return null;

  let username = null;
  try {
    const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`, {
      headers: { Authorization: `Bot ${token}` },
    });
    if (res.ok) {
      const member = await res.json();
      username = member.nick || member.user?.global_name || member.user?.username || null;
    }
  } catch {
    username = null;
  }
  memberCache.set(discordId, username);
  return username;
}

// Pseudo à afficher : résolution live si possible, sinon repli sur le
// pseudo stocké (joueur ayant quitté le serveur, erreur réseau/API Discord).
export async function resolveDisplayName(discordId, storedFallback) {
  const live = await resolveDiscordUsername(discordId);
  return live ?? storedFallback ?? "Inconnu";
}
