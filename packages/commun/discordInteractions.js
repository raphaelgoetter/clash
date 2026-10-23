// Utilitaires communs aux endpoints d'interactions Discord (TrustRoyale et jeux).

import { waitUntil } from "@vercel/functions";

// Maintient la fonction Vercel active le temps de l'exécution asynchrone.
export function runBackground(fn) {
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

export function buildDiscordWebhookUrl(body) {
  const token = body.token || body.interaction?.token;
  if (!process.env.DISCORD_APP_ID || !token) return null;
  return `https://discord.com/api/v10/webhooks/${process.env.DISCORD_APP_ID}/${token}`;
}
