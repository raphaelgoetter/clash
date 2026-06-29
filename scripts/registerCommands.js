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
        autocomplete: true,
      },
    ],
  },
  {
    name: "stats",
    description:
      "Affiche les statistiques GDC détaillées d'un membre de la famille à partir de son tag.",
    options: [
      {
        type: 3, // STRING
        name: "tag",
        description: "Tag du joueur (ex : #ABC123)",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "matchup",
    description:
      "Calcule le matchup GDC d'un joueur selon ses decks et ses adversaires.",
    options: [
      {
        type: 3, // STRING
        name: "tag",
        description: "Tag du joueur (ex : #ABC123)",
        required: true,
        autocomplete: true,
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
    name: "quota",
    description:
      "Affiche la moyenne GDC et les joueurs sous quota pour un clan.",
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
      {
        type: 4, // INTEGER
        name: "quota",
        description: "Seuil de points GDC (par défaut : 2000)",
        required: false,
        choices: [
          { name: "1600", value: 1600 },
          { name: "1800", value: 1800 },
          { name: "2000", value: 2000 },
          { name: "2200", value: 2200 },
          { name: "2400", value: 2400 },
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
    name: "fail",
    description:
      "Affiche les joueurs qui ont manqué une journée de GDC la veille pour un clan.",
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
    name: "late-ping",
    description:
      "Liste les joueurs en retard dans leurs combats GDC avant le reset, avec ping des membres lies.",
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
      "Liste les meilleurs joueurs de la famille pour la semaine, la saison précédente ou tous les temps.",
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
        description: "Période : week (par défaut), season ou all-time.",
        required: false,
        choices: [
          { name: "week", value: "week" },
          { name: "season", value: "season" },
          { name: "all-time", value: "all-time" },
        ],
      },
    ],
  },
  {
    name: "stats-clan",
    description:
      "Statistiques GDC détaillées de tous les membres d'un clan.",
    options: [
      {
        type: 3, // STRING
        name: "clan",
        description:
          "Clan de la famille (1=La Resistance, 2=Les Resistants, 3=Les Revoltes).",
        required: false,
        choices: [
          { name: "La Resistance", value: "1" },
          { name: "Les Resistants", value: "2" },
          { name: "Les Revoltes", value: "3" },
        ],
      },
      {
        type: 3, // STRING
        name: "tag",
        description:
          "Tag d'un clan hors-famille (ex: #ABC123). Prioritaire sur le choix clan.",
        required: false,
      },
      {
        type: 3, // STRING
        name: "sort",
        description:
          "Mode de tri (défaut : points par semaine).",
        required: false,
        choices: [
          { name: "Points par semaine", value: "avgFame" },
          { name: "Points par deck", value: "pointsPerDeck" },
        ],
      },
    ],
  },
  {
    name: "top-clans",
    description:
      "Affiche une tranche de 50 clans du classement France GDC par trophées de guerre.",
    options: [
      {
        type: 4, // INTEGER
        name: "start",
        description:
          "Rang de départ (défaut : 1). Affiche 50 clans à partir de ce rang.",
        required: false,
        min_value: 1,
        max_value: 950,
      },
    ],
  },
  {
    name: "collection",
    description:
      "Statistiques de collection d'un joueur (cartes, niveaux, évolutions, héros).",
    options: [
      {
        type: 3, // STRING
        name: "tag",
        description: "Tag du joueur (ex : #ABC123)",
        required: true,
        autocomplete: true,
      },
    ],
  },
  {
    name: "help",
    description: "Affiche l’aide détaillée de toutes les commandes du bot.",
    options: [],
  },
  {
    name: "clan",
    description: "Affiche la fiche récapitulative d'un clan.",
    options: [
      {
        type: 3, // STRING
        name: "clan",
        description: "Clan de la famille (données de fiabilité incluses).",
        required: false,
        choices: [
          { name: "La Resistance", value: "1" },
          { name: "Les Resistants", value: "2" },
          { name: "Les Revoltes", value: "3" },
        ],
      },
      {
        type: 3, // STRING
        name: "tag",
        description:
          "Tag d'un clan quelconque (ex: #ABC123). Prioritaire sur le choix clan.",
        required: false,
      },
    ],
  },
  {
    name: "family",
    description: "Affiche un résumé des clans de la famille.",
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
    await registerAtUrl(globalUrl);
    console.log(
      "Global command registration done (may take up to 1 hour to propagate).",
    );
  } catch (err) {
    console.error("Request failed", err);
    process.exit(1);
  }
})();
