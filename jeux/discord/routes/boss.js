// ============================================================
// boss.js (route) — Boutons du Boss de fin de saison (boss_*), cliqués en
// MP (sans serveur : seule interaction admise hors serveur, voir
// api/discord/jeux.js) ou depuis « 🛂 Mon passeport ».
// ============================================================

import { buildDiscordWebhookUrl, runBackground } from "@clash/commun/discordInteractions.js";
import { handleBossBouton } from "../handlers/boss.js";

export const estBoutonBoss = (body) =>
  body.type === 3 && typeof body.data?.custom_id === "string" && body.data.custom_id.startsWith("boss_");

export async function routeBoss(body, res) {
  if (!estBoutonBoss(body)) return;
  if (body.data.custom_id.startsWith("boss_lancer:")) {
    // Nouveau message (privé sur le serveur) : l'invitation et le passeport restent
    res.status(200).json({ type: 5, data: body.guild_id ? { flags: 64 } : {} });
  } else {
    // Coups : le message de la partie est édité en place
    res.status(200).json({ type: 6 });
  }
  const webhookUrl = buildDiscordWebhookUrl(body);
  runBackground(() => handleBossBouton(webhookUrl, body));
}
