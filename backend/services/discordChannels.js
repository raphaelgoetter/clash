// ============================================================
// services/discordChannels.js — Résolution du salon/thread cible Discord
// Pour chaque clan, une variable DISCORD_THREAD_MEMBERS_<TAG> optionnelle
// permet de rediriger les notifications automatiques vers un thread dédié.
// Si elle n'est pas définie, on retombe sur DISCORD_CHANNEL_MEMBERS_<TAG>
// (comportement actuel, inchangé).
// ============================================================

/**
 * Résout l'ID du salon (ou thread) Discord cible pour les notifications
 * automatiques d'un clan donné.
 *
 * @param {string} clanTag - tag du clan sans '#', ex "LRQP20V9"
 * @returns {string|undefined} l'ID du channel/thread, ou undefined si aucune
 *   variable d'env n'est définie pour ce clan.
 */
export function resolveMembersChannelId(clanTag) {
  return (
    process.env[`DISCORD_THREAD_MEMBERS_${clanTag}`] ||
    process.env[`DISCORD_CHANNEL_MEMBERS_${clanTag}`]
  );
}
