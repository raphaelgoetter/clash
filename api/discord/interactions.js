// Fonction Vercel dédiée pour les interactions Discord.
// Utilise waitUntil de @vercel/functions pour maintenir la fonction active
// après avoir répondu type:5 à Discord (deferred).

import { getDiscordLinks } from "../../backend/services/discordLinks.js";
import { fetchPlayer } from "@clash/clash-royale/clashApi.js";
import { normalizeClashTag } from "./_lib/commun.js";
import {
  isAuthorizedGuild,
  readRawBody,
  verifyDiscordSignature,
} from "@clash/commun/discordInteractions.js";
import { routeAdmin } from "./_routes/admin.js";
import { routeJoueur } from "./_routes/joueur.js";
import { routeClan } from "./_routes/clan.js";
import { routeSuiviGdc } from "./_routes/suiviGdc.js";
import { routeMiniJeux } from "../../jeux/discord/routes/miniJeux.js";
import { routeJeuxSpeciaux } from "../../jeux/discord/routes/jeuxSpeciaux.js";
import { routeDuels } from "../../jeux/discord/routes/duels.js";

const ROUTES = [
  routeAdmin,
  routeJoueur,
  routeClan,
  routeSuiviGdc,
  routeMiniJeux,
  routeJeuxSpeciaux,
  routeDuels,
];

const TAG_AUTOCOMPLETE_COMMANDS = new Set([
  "stats",
  "matchup",
  "matchup-gdc",
  "collection",
  "combats",
]);

const TAG_NAME_CACHE_TTL = 6 * 60 * 60 * 1000;

const tagNameCache = new Map();

function getLinkedTagsForDiscordUser(links, discordUserId) {
  const userId = String(discordUserId ?? "").trim();
  if (!userId) return [];

  const tags = [];
  for (const [tag, linkedUserId] of Object.entries(links ?? {})) {
    if (String(linkedUserId) !== userId) continue;
    const normalizedTag = normalizeClashTag(tag);
    if (normalizedTag) tags.push(normalizedTag);
  }

  return [...new Set(tags)].sort((a, b) => a.localeCompare(b));
}

function getCachedTagName(tag) {
  const entry = tagNameCache.get(tag);
  if (!entry) return null;
  if (Date.now() - entry.updatedAt > TAG_NAME_CACHE_TTL) {
    tagNameCache.delete(tag);
    return null;
  }
  return entry.name;
}

async function getClashTagName(tag) {
  const normalizedTag = normalizeClashTag(tag);
  if (!normalizedTag) return null;

  const cachedName = getCachedTagName(normalizedTag);
  if (cachedName) return cachedName;

  try {
    const player = await fetchPlayer(normalizedTag);
    const name = String(player?.name ?? "").trim();
    if (name) {
      tagNameCache.set(normalizedTag, { name, updatedAt: Date.now() });
      return name;
    }
  } catch {
    // Si le profil n'est pas disponible, on conserve juste le tag.
  }

  return null;
}

async function buildTagAutocompleteChoices(body, links) {
  const focusedOption = body.data?.options?.find((option) => option.focused);
  const currentValue = String(focusedOption?.value ?? "")
    .trim()
    .toUpperCase();
  const prefix = currentValue.replace(/^#/, "");
  const discordUserId = body.member?.user?.id ?? body.user?.id ?? "";

  const linkedTags = getLinkedTagsForDiscordUser(links, discordUserId);
  const filteredTags = prefix
    ? linkedTags.filter((tag) => tag.slice(1).startsWith(prefix))
    : linkedTags;

  const limitedTags = filteredTags.slice(0, 25);
  const resolvedNames = await Promise.all(
    limitedTags.map(async (tag) => ({ tag, name: await getClashTagName(tag) })),
  );

  return resolvedNames.map(({ tag, name }) => ({
    name: name ? `${name} (${tag})` : tag,
    value: tag,
  }));
}

export default async function handler(req, res) {
  if (req.method !== "POST") return res.status(405).end();

  const signature = req.headers["x-signature-ed25519"];

  const timestamp = req.headers["x-signature-timestamp"];

  const rawBody = await readRawBody(req);

  // Vérification de signature obligatoire *avant tout*, y compris pour les PINGs.
  // Discord teste explicitement que le endpoint rejette les requêtes sans signature valide.
  if (
    !verifyDiscordSignature(
      signature,
      timestamp,
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

  // Discord PING — répond après vérification de signature (requis par Discord pour valider l'endpoint)
  if (body.type === 1) {
    return res.status(200).json({ type: 1 });
  }

  // Vérification de la liste blanche des serveurs autorisés.
  // Effectuée en premier, avant tout traitement métier, pour minimiser le temps d'exécution.
  const authorizedPingIds = new Set(
    (process.env.AUTHORIZED_PING_IDS || "")
      .split(",")
      .map((id) => id.trim())
      .filter(Boolean),
  );

  if (body.type === 4 && TAG_AUTOCOMPLETE_COMMANDS.has(body.data?.name)) {
    if (!isAuthorizedGuild(body.guild_id)) {
      return res.status(200).json({ type: 8, data: { choices: [] } });
    }

    const links = await getDiscordLinks();
    const choices = await buildTagAutocompleteChoices(body, links);
    return res.status(200).json({ type: 8, data: { choices } });
  }

  if (!isAuthorizedGuild(body.guild_id)) {
    return res.status(200).json({
      type: 4,
      data: {
        content:
          "🚫 Ce serveur n'est pas autorisé à utiliser l'instance officielle de TrustRoyale. Contactez l'administrateur pour enregistrer votre guilde.",
        flags: 64,
      },
    });
  }

  // Chaque module répond à Discord s'il reconnaît l'interaction ; sinon il
  // rend la main sans rien envoyer et on essaie le suivant.
  for (const route of ROUTES) {
    await route(body, res, { authorizedPingIds });
    if (res.headersSent) return;
  }

  return res.status(400).json({ error: "Unsupported interaction type" });
}
