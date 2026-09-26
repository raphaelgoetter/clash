// Suppression du post de la manche précédente d'un mini-jeu hebdomadaire,
// pour ne garder qu'une seule manche visible dans le salon. Best-effort :
// un échec (message déjà supprimé à la main, permissions…) est seulement
// loggé, jamais bloquant pour la publication de la nouvelle manche.
export async function deletePreviousRoundMessage(previousState, label) {
  const token = process.env.DISCORD_TOKEN;
  const { channelId, messageId } = previousState ?? {};
  if (!token || !channelId || !messageId) return;
  try {
    const res = await fetch(
      `https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`,
      { method: "DELETE", headers: { Authorization: `Bot ${token}` } },
    );
    if (!res.ok && res.status !== 404) {
      console.warn(
        `[${label}] Échec suppression du post de la manche précédente (${res.status}).`,
      );
    }
  } catch (err) {
    console.warn(
      `[${label}] Erreur réseau à la suppression du post de la manche précédente:`,
      err.message,
    );
  }
}
