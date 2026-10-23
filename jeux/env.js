// Environnement des jeux : à importer EN PREMIER par tout point d'entrée des
// jeux (endpoint Discord, scripts), avant les autres modules.
//
// Charge `./.env` (scripts lancés depuis la racine ; sans effet sur Vercel)
// puis, si le bot des jeux est configuré (DISCORD_JEUX_*), lui substitue les
// identifiants Discord standards : tout le code des jeux lit DISCORD_TOKEN,
// DISCORD_APP_ID et DISCORD_PUBLIC_KEY, et agit ainsi au nom du bot des jeux
// sans connaître son existence. Sans DISCORD_JEUX_*, rien ne change (bot
// TrustRoyale). Quand les jeux auront leur propre projet Vercel, ces
// variables y porteront directement les noms standards.

import dotenv from "dotenv";

dotenv.config({ path: "./.env" });

const SUBSTITUTIONS = {
  DISCORD_JEUX_TOKEN: "DISCORD_TOKEN",
  DISCORD_JEUX_APP_ID: "DISCORD_APP_ID",
  DISCORD_JEUX_PUBLIC_KEY: "DISCORD_PUBLIC_KEY",
};

export const BOT_JEUX_CONFIGURE = Boolean(
  process.env.DISCORD_JEUX_TOKEN && process.env.DISCORD_JEUX_APP_ID,
);

if (BOT_JEUX_CONFIGURE) {
  for (const [source, cible] of Object.entries(SUBSTITUTIONS)) {
    if (process.env[source]) process.env[cible] = process.env[source];
  }
}
