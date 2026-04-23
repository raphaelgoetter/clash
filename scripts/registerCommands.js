#!/usr/bin/env node
// Small utility to register the `/trust` command with Discord. Run once
// after setting DISCORD_APP_ID and DISCORD_TOKEN in your environment.

import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config({ path: "./.env" });

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_TOKEN;

if (!appId || !token) {
  console.error("DISCORD_APP_ID and DISCORD_TOKEN must be set");
  process.exit(1);
}

const globalUrl = `https://discord.com/api/v10/applications/${appId}/commands`;
const guildId = process.env.DISCORD_GUILD_ID;
const guildUrl = guildId
  ? `https://discord.com/api/v10/applications/${appId}/guilds/${guildId}/commands`
  : null;

const commands = [
  {
    name: "trust",
    description: "Analyse la fiabilité d'un joueur Clash Royale",
    options: [
      {
        type: 3, // STRING
        name: "tag",
        description: "Tag du joueur (ex : #ABC123)",
        required: true,
      },
    ],
  },
  {
    name: "discord-link",
    description: "Lie un ou plusieurs tags Clash Royale à ton compte Discord.",
    options: [
      {
        type: 3, // STRING
        name: "tag",
        description: "Ton tag Clash Royale principal (ex : #ABC123)",
        required: true,
      },
      {
        type: 3, // STRING
        name: "tag2",
        description: "Deuxième tag Clash Royale (optionnel)",
        required: false,
      },
      {
        type: 3, // STRING
        name: "tag3",
        description: "Troisième tag Clash Royale (optionnel)",
        required: false,
      },
    ],
  },
  {
    name: "discord-check",
    description:
      "Vérifie quels membres d'un clan sont présents sur ce serveur Discord.",
    options: [
      {
        type: 3, // STRING
        name: "clan",
        description:
          "1=La Resistance, 2=Les Resistants, 3=Les Revoltes (défaut : 1)",
        required: false,
        choices: [
          { name: "La Resistance", value: "1" },
          { name: "Les Resistants", value: "2" },
          { name: "Les Revoltes", value: "3" },
        ],
      },
    ],
  },
  {
    name: "promote",
    description:
      "Liste les joueurs éligibles à la promotion (2600 pts minimum)",
    options: [
      {
        type: 3, // STRING
        name: "clan",
        description:
          "1/2/3 ou la/les (1=La Resistance, 2=Les Resistants, 3=Les Revoltes)",
        required: true,
        choices: [
          { name: "La Resistance", value: "1" },
          { name: "Les Resistants", value: "2" },
          { name: "Les Revoltes", value: "3" },
        ],
      },
    ],
  },
  {
    name: "demote",
    description:
      "Liste les joueurs n’ayant pas fait 16/16 decks lors de la dernière semaine GDC",
    options: [
      {
        type: 3, // STRING
        name: "clan",
        description: "1=La Resistance, 2=Les Resistants, 3=Les Revoltes",
        required: true,
        choices: [
          { name: "La Resistance", value: "1" },
          { name: "Les Resistants", value: "2" },
          { name: "Les Revoltes", value: "3" },
        ],
      },
    ],
  },
  {
    name: "trust-clan",
    description: "Liste les membres risqués d'un clan",
    options: [
      {
        type: 3, // STRING
        name: "clan",
        description: "1=La Resistance, 2=Les Resistants, 3=Les Revoltes",
        required: true,
        choices: [
          { name: "La Resistance", value: "1" },
          { name: "Les Resistants", value: "2" },
          { name: "Les Revoltes", value: "3" },
        ],
      },
    ],
  },
  {
    name: "late",
    description:
      "Liste les joueurs en retard dans leurs combats GDC avant le reset.",
    options: [
      {
        type: 3, // STRING
        name: "clan",
        description: "1=La Resistance, 2=Les Resistants, 3=Les Revoltes",
        required: true,
        choices: [
          { name: "La Resistance", value: "1" },
          { name: "Les Resistants", value: "2" },
          { name: "Les Revoltes", value: "3" },
        ],
      },
    ],
  },
  {
    name: "compare",
    description: "Affiche les clans du groupe GDC.",
    options: [
      {
        type: 3, // STRING
        name: "clan",
        description: "1=La Resistance, 2=Les Resistants, 3=Les Revoltes",
        required: true,
        choices: [
          { name: "La Resistance", value: "1" },
          { name: "Les Resistants", value: "2" },
          { name: "Les Revoltes", value: "3" },
        ],
      },
    ],
  },
  {
    name: "top-players",
    description:
      "Liste les meilleurs joueurs de la famille pour la semaine ou la saison précédente.",
    options: [
      {
        type: 4, // INTEGER
        name: "number",
        description:
          "Nombre de joueurs à afficher (3, 5 ou 10 ; par défaut 5).",
        required: false,
        choices: [
          { name: "3", value: 3 },
          { name: "5", value: 5 },
          { name: "10", value: 10 },
        ],
      },
      {
        type: 3, // STRING
        name: "period",
        description: "Période : week (par défaut) ou season.",
        required: false,
        choices: [
          { name: "week", value: "week" },
          { name: "season", value: "season" },
        ],
      },
    ],
  },
  {
    name: "help",
    description: "Affiche l’aide détaillée de toutes les commandes du bot.",
    options: [],
  },
  {
    name: "chelem",
    description:
      "Liste les joueurs ayant fait 16/16 decks chaque semaine d’une saison donnée.",

    options: [
      {
        type: 3, // STRING
        name: "clan",
        description: "1=La Resistance, 2=Les Resistants, 3=Les Revoltes",
        required: true,
        choices: [
          { name: "La Resistance", value: "1" },
          { name: "Les Resistants", value: "2" },
          { name: "Les Revoltes", value: "3" },
        ],
      },
      {
        type: 4, // INTEGER
        name: "season",
        description:
          "Numéro de saison (ex: 129). Par défaut, la dernière saison terminée.",
        required: false,
      },
    ],
  },
];

async function registerAtUrl(url) {
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${token}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(commands),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`Failed to register commands at ${url}`, data);
    process.exit(1);
  }
  console.log(`Commands registered at ${url}:`);
  console.dir(data, { depth: 2 });
}

(async () => {
  try {
    // Supprimer les commandes guild si DISCORD_GUILD_ID est défini (évite les doublons).
    if (guildUrl) {
      const res = await fetch(guildUrl, {
        method: "PUT",
        headers: {
          Authorization: `Bot ${token}`,
          "Content-Type": "application/json",
        },
        body: JSON.stringify([]),
      });
      if (!res.ok) {
        console.error("Failed to clear guild commands", await res.json());
        process.exit(1);
      }
      console.log("Guild commands cleared.");
    }
    // Enregistrement global uniquement.
    await registerAtUrl(globalUrl);
    console.log(
      "Global command registration done (may take up to 1 hour to propagate).",
    );
  } catch (err) {
    console.error("Request failed", err);
    process.exit(1);
  }
})();
