#!/usr/bin/env node
// Enregistre les commandes slash auprès de Discord (globales, propagation
// jusqu'à 1 h). Bot TrustRoyale : DISCORD_APP_ID/DISCORD_TOKEN. Si le bot des
// jeux est configuré (DISCORD_JEUX_APP_ID/DISCORD_JEUX_TOKEN), les commandes
// des jeux (JEUX_COMMANDS) lui sont enregistrées et retirées de TrustRoyale ;
// sinon tout reste sur TrustRoyale.

import fetch from "node-fetch";
import dotenv from "dotenv";

dotenv.config({ path: "./.env" });

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_TOKEN;

if (!appId || !token) {
  console.error("DISCORD_APP_ID and DISCORD_TOKEN must be set");
  process.exit(1);
}

const jeuxAppId = process.env.DISCORD_JEUX_APP_ID;
const jeuxToken = process.env.DISCORD_JEUX_TOKEN;
const botJeuxConfigure = Boolean(jeuxAppId && jeuxToken);

// Commandes servies par jeux/discord/routes/ (bot des jeux).
const JEUX_COMMANDS = new Set([
  "mini-jeux",
  "mini-jeux-history",
  "grille",
  "quatre",
  "punto",
  "blackjack",
  "gobelet",
]);

const commandsUrl = (id) => `https://discord.com/api/v10/applications/${id}/commands`;

const commands = [
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
    name: "matchup-gdc",
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
    name: "matchup",
    description:
      "Affiche les 6 derniers combats d'un joueur (tous types) avec le détail des decks.",
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
    name: "combats",
    description:
      "Affiche le suivi jour par jour des combats de GDC d'un joueur (semaine en cours + précédente).",
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
    name: "blacklist",
    description: "Gère la Liste Noire des joueurs (réservé au staff).",
    options: [
      {
        type: 1, // SUB_COMMAND
        name: "ajoute",
        description: "Ajoute un joueur à la Liste Noire.",
        options: [
          {
            type: 3, // STRING
            name: "tag",
            description: "Tag du joueur (ex : #2YLYUPCUG ou 2YLYUPCUG)",
            required: true,
          },
          {
            type: 3, // STRING
            name: "raison",
            description: "Raison de l'ajout (remplace la raison existante si le joueur est déjà listé)",
            required: false,
            max_length: 150,
          },
        ],
      },
      {
        type: 1, // SUB_COMMAND
        name: "retire",
        description: "Retire un joueur de la Liste Noire.",
        options: [
          {
            type: 3, // STRING
            name: "tag",
            description: "Tag du joueur (ex : #2YLYUPCUG ou 2YLYUPCUG)",
            required: true,
          },
        ],
      },
      {
        type: 1, // SUB_COMMAND
        name: "consulte",
        description: "Affiche la Liste Noire avec clan actuel et clan précédent (avant).",
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
    description: "Statistiques GDC détaillées de tous les membres d'un clan.",
    options: [
      {
        type: 3, // STRING
        name: "clan",
        description:
          "Clan de la famille (1=La Resistance, 2=Les Resistants, 3=Les Revoltes).",
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
    name: "combats-clan",
    description:
      "Liste les joueurs n'ayant pas joué leurs 4 decks/jour cette semaine de GDC.",
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
    name: "recap",
    description:
      "Récap GDC : 10 moins bons scoreurs La Resistance / 10 meilleurs Les Resistants.",
    options: [
      {
        type: 3, // STRING
        name: "saison",
        description:
          "Saison à récapituler (défaut : -1, la dernière terminée).",
        required: false,
        choices: [
          { name: "Saison -1 (dernière terminée)", value: "-1" },
          { name: "Saison -2", value: "-2" },
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
      "Liste les joueurs ayant fait 16/16 decks chaque semaine d'une saison donnée.",

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
  {
    name: "champion-history",
    description: "Affiche l'historique des Champions GDC passés.",
    options: [
      {
        type: 3, // STRING
        name: "clan",
        description: "Choisir le clan",
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
    name: "mini-jeux",
    description:
      "Affiche l'état des lieux et l'avancement des mini-jeux et du jeu spécial en cours.",
    options: [],
  },
  {
    name: "mini-jeux-history",
    description: "Affiche l'historique des vainqueurs des saisons mini-jeux.",
    options: [],
  },
  {
    name: "grille",
    description:
      "La Grille : pose tes dés et détruis ceux de Kévina ou d'un autre joueur — réservé au rôle MINI-JEUX.",
    options: [
      {
        type: 3, // STRING
        name: "adversaire",
        description: "Contre qui jouer ?",
        required: true,
        choices: [
          { name: "Kévina (bot)", value: "bot" },
          { name: "2 joueurs", value: "1v1" },
        ],
      },
    ],
  },
  {
    name: "quatre",
    description:
      "Quatre à la suite : aligne 4 pions avant Kévina ou un autre joueur — réservé au rôle MINI-JEUX.",
    options: [
      {
        type: 3, // STRING
        name: "adversaire",
        description: "Contre qui jouer ?",
        required: true,
        choices: [
          { name: "Kévina (bot)", value: "bot" },
          { name: "2 joueurs", value: "1v1" },
        ],
      },
    ],
  },
  {
    name: "punto",
    description:
      "Punto : aligne 4 cartes d'une couleur avant Kévina ou un autre joueur — réservé au rôle MINI-JEUX.",
    options: [
      {
        type: 3, // STRING
        name: "adversaire",
        description: "Contre qui jouer ?",
        required: true,
        choices: [
          { name: "Kévina (bot)", value: "bot" },
          { name: "2 joueurs", value: "1v1" },
        ],
      },
    ],
  },
  {
    name: "blackjack",
    description:
      "Lance un duel de Blackjack (1 ou 2 joueurs) dans ce salon — réservé au rôle MINI-JEUX.",
    options: [
      {
        type: 4, // INTEGER
        name: "joueurs",
        description: "Nombre de joueurs (1 ou 2).",
        required: true,
        choices: [
          { name: "1", value: 1 },
          { name: "2", value: 2 },
        ],
      },
      {
        type: 4, // INTEGER
        name: "manches",
        description: "Nombre de manches.",
        required: true,
        choices: [
          { name: "5", value: 5 },
          { name: "10", value: 10 },
        ],
      },
    ],
  },
  {
    name: "gobelet",
    description:
      "Lance un duel du Jeu du Gobelet (1 ou 2 joueurs) dans ce salon — réservé au rôle MINI-JEUX.",
    options: [
      {
        type: 4, // INTEGER
        name: "joueurs",
        description: "Nombre de joueurs (1 ou 2).",
        required: true,
        choices: [
          { name: "1", value: 1 },
          { name: "2", value: 2 },
        ],
      },
      {
        type: 4, // INTEGER
        name: "manches",
        description: "Nombre de manches.",
        required: true,
        choices: [
          { name: "5", value: 5 },
          { name: "10", value: 10 },
        ],
      },
    ],
  },
];

async function registerAtUrl(url, botToken, list) {
  const res = await fetch(url, {
    method: "PUT",
    headers: {
      Authorization: `Bot ${botToken}`,
      "Content-Type": "application/json",
    },
    body: JSON.stringify(list),
  });
  const data = await res.json();
  if (!res.ok) {
    console.error(`Failed to register commands at ${url}`, data);
    process.exit(1);
  }
  console.log(`${data.length} commandes enregistrées : ${data.map((c) => c.name).join(", ")}`);
}

(async () => {
  try {
    if (botJeuxConfigure) {
      const trust = commands.filter((c) => !JEUX_COMMANDS.has(c.name));
      const jeux = commands.filter((c) => JEUX_COMMANDS.has(c.name));
      console.log("Bot TrustRoyale :");
      await registerAtUrl(commandsUrl(appId), token, trust);
      console.log("Bot des jeux :");
      await registerAtUrl(commandsUrl(jeuxAppId), jeuxToken, jeux);
    } else {
      await registerAtUrl(commandsUrl(appId), token, commands);
    }
    console.log("Enregistrement global terminé (propagation jusqu'à 1 h).");
  } catch (err) {
    console.error("Request failed", err);
    process.exit(1);
  }
})();
