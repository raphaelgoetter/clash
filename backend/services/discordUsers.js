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
const MAX_ATTEMPTS = 3; // uniquement pour les 429 (rate limit) — jamais retenté sur 404/erreur réseau

// ⚠️ Résoudre TOUS les joueurs d'un classement en parallèle (Promise.all,
// pattern utilisé dans tous les appelants) déclenche facilement plus de 5-10
// requêtes GET /guilds/{id}/members/{id} simultanées, ce qui dépasse le
// rate-limit de cette route côté Discord — vérifié empiriquement (7 échecs
// sur 12 requêtes en parallèle, toutes en HTTP 429). Sans retry, chaque
// requête rate-limitée retombait silencieusement sur le pseudo stocké,
// produisant un résultat incohérent d'une exécution à l'autre. Discord
// renvoie le délai exact à attendre (`retry_after`, en secondes) : on le
// respecte et on retente, jusqu'à MAX_ATTEMPTS.
export async function resolveDiscordUsername(discordId) {
  if (!discordId) return null;
  if (memberCache.has(discordId)) return memberCache.get(discordId);

  const guildId = process.env.DISCORD_GUILD_ID;
  const token = process.env.DISCORD_TOKEN;
  if (!guildId || !token) return null;

  let username = null;
  for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt++) {
    try {
      const res = await fetch(`https://discord.com/api/v10/guilds/${guildId}/members/${discordId}`, {
        headers: { Authorization: `Bot ${token}` },
      });
      if (res.ok) {
        const member = await res.json();
        username = member.nick || member.user?.global_name || member.user?.username || null;
        break;
      }
      if (res.status === 429 && attempt < MAX_ATTEMPTS) {
        const body = await res.json().catch(() => null);
        const retryAfterMs = Math.ceil((body?.retry_after ?? 1) * 1000);
        await new Promise((resolve) => setTimeout(resolve, retryAfterMs));
        continue;
      }
      break; // autre erreur (404, etc.) — pas la peine de retenter
    } catch {
      break;
    }
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
