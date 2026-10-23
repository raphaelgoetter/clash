// Fonction Vercel des interactions Discord du bot des jeux (application
// distincte de TrustRoyale). Ne sert que les routes des jeux ; architecture
// et règles identiques à api/discord/interactions.js (réponse type 5 avant
// tout await, runBackground).

import { BOT_JEUX_CONFIGURE } from "../../jeux/env.js";
import {
  isAuthorizedGuild,
  readRawBody,
  verifyDiscordSignature,
} from "@clash/commun/discordInteractions.js";
import { routeMiniJeux } from "../../jeux/discord/routes/miniJeux.js";
import { routeJeuxSpeciaux } from "../../jeux/discord/routes/jeuxSpeciaux.js";
import { routeDuels } from "../../jeux/discord/routes/duels.js";

const ROUTES = [routeMiniJeux, routeJeuxSpeciaux, routeDuels];

export default async function handler(req, res) {
  // Tant que le bot des jeux n'est pas configuré, l'endpoint n'existe pas.
  if (!BOT_JEUX_CONFIGURE) return res.status(404).end();
  if (req.method !== "POST") return res.status(405).end();

  const rawBody = await readRawBody(req);

  // Signature vérifiée avant tout, y compris pour les PINGs (testé par Discord).
  if (
    !verifyDiscordSignature(
      req.headers["x-signature-ed25519"],
      req.headers["x-signature-timestamp"],
      rawBody,
      process.env.DISCORD_PUBLIC_KEY,
    )
  ) {
    return res.status(401).end("invalid request signature");
  }

  let body;
  try {
    body = JSON.parse(rawBody);
  } catch {
    return res.status(400).end("invalid json");
  }

  if (body.type === 1) return res.status(200).json({ type: 1 });

  if (!isAuthorizedGuild(body.guild_id)) {
    return res.status(200).json({
      type: 4,
      data: { content: "🚫 Ce serveur n'est pas autorisé à utiliser ce bot.", flags: 64 },
    });
  }

  for (const route of ROUTES) {
    await route(body, res);
    if (res.headersSent) return;
  }

  return res.status(400).json({ error: "Unsupported interaction type" });
}
