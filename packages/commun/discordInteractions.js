// Utilitaires communs aux endpoints d'interactions Discord (TrustRoyale et jeux).

import { createPublicKey, verify } from "node:crypto";
import { waitUntil } from "@vercel/functions";

// Vérifie la signature Ed25519 envoyée par Discord avec la clé publique de
// l'application qui reçoit l'interaction.
export function verifyDiscordSignature(signature, timestamp, rawBody, publicKeyHex) {
  if (!publicKeyHex || !signature || !timestamp) return false;
  try {
    // Encapsule la clé publique brute dans le format SPKI DER attendu par Node.js
    const spkiPrefix = Buffer.from("302a300506032b6570032100", "hex");
    const publicKey = createPublicKey({
      key: Buffer.concat([spkiPrefix, Buffer.from(publicKeyHex, "hex")]),
      format: "der",
      type: "spki",
    });
    return verify(
      null,
      Buffer.from(timestamp + rawBody),
      publicKey,
      Buffer.from(signature, "hex"),
    );
  } catch {
    return false;
  }
}

// Corps brut de la requête (nécessaire pour vérifier la signature).
export async function readRawBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf8");
}

// Serveurs autorisés (AUTHORIZED_GUILD_IDS, séparés par des virgules) ;
// liste vide = tous autorisés.
export function isAuthorizedGuild(guildId) {
  const authorized = (process.env.AUTHORIZED_GUILD_IDS || "")
    .split(",")
    .map((id) => id.trim())
    .filter(Boolean);
  return authorized.length === 0 || authorized.includes(guildId);
}

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
