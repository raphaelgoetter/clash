#!/usr/bin/env node
// discordLinks.js — Administration manuelle des liens Clash tag → Discord
// user ID (Upstash Redis, hash "discordlinks" — voir
// backend/services/discordLinks.js). Remplace l'ancienne édition manuelle
// de data/discord-links.json + push sur main : ce fichier n'existe plus,
// tout se fait maintenant via ce script (ou la commande /discord-link,
// qui ne lie que le compte de la personne qui l'exécute).
//
// Usage :
//   node scripts/discordLinks.js list
//   node scripts/discordLinks.js set "#TAG" discordUserId ["#TAG2" discordUserId2 ...]
//   node scripts/discordLinks.js remove "#TAG" ["#TAG2" ...]

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import {
  getDiscordLinks,
  setDiscordLinks,
  deleteDiscordLinks,
} from "../backend/services/discordLinks.js";

function normalizeTag(tag) {
  const raw = String(tag ?? "").trim().toUpperCase();
  return raw.startsWith("#") ? raw : `#${raw}`;
}

async function main() {
  const [command, ...args] = process.argv.slice(2);

  if (command === "list") {
    const links = await getDiscordLinks();
    const entries = Object.entries(links);
    if (entries.length === 0) {
      console.log("Aucun lien enregistré.");
      return;
    }
    for (const [tag, userId] of entries.sort(([a], [b]) => a.localeCompare(b))) {
      console.log(`${tag} → ${userId}`);
    }
    console.log(`\n${entries.length} lien(s).`);
    return;
  }

  if (command === "set") {
    if (args.length === 0 || args.length % 2 !== 0) {
      console.error(
        'Usage : node scripts/discordLinks.js set "#TAG" discordUserId [...]',
      );
      process.exit(1);
    }
    const map = {};
    for (let i = 0; i < args.length; i += 2) {
      map[normalizeTag(args[i])] = args[i + 1];
    }
    const ok = await setDiscordLinks(map);
    if (!ok) {
      console.error("Échec de l'écriture Redis.");
      process.exit(1);
    }
    for (const [tag, userId] of Object.entries(map)) {
      console.log(`✅ ${tag} → ${userId}`);
    }
    return;
  }

  if (command === "remove") {
    if (args.length === 0) {
      console.error('Usage : node scripts/discordLinks.js remove "#TAG" [...]');
      process.exit(1);
    }
    const tags = args.map(normalizeTag);
    const ok = await deleteDiscordLinks(tags);
    if (!ok) {
      console.error("Échec de la suppression Redis.");
      process.exit(1);
    }
    for (const tag of tags) {
      console.log(`🗑️  ${tag} supprimé.`);
    }
    return;
  }

  console.error(
    "Usage :\n" +
      "  node scripts/discordLinks.js list\n" +
      '  node scripts/discordLinks.js set "#TAG" discordUserId [...]\n' +
      '  node scripts/discordLinks.js remove "#TAG" [...]',
  );
  process.exit(1);
}

main().catch((err) => {
  console.error("[discordLinks] Erreur:", err.message);
  process.exit(1);
});
