#!/usr/bin/env node
// Small utility to register the `/trust` command with Discord. Run once
// after setting DISCORD_APP_ID and DISCORD_TOKEN in your environment.

import fetch from 'node-fetch';
import dotenv from 'dotenv';

dotenv.config({ path: './.env' });

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_TOKEN;

if (!appId || !token) {
  console.error('DISCORD_APP_ID and DISCORD_TOKEN must be set');
  process.exit(1);
}

const url = `https://discord.com/api/v10/applications/${appId}/commands`;

const commands = [
  {
    name: 'trust',
    description: "Analyse la fiabilité d'un joueur Clash Royale",
    options: [
      {
        type: 3, // STRING
        name: 'tag',
        description: 'Tag du joueur (ex : #ABC123)',
        required: true,
      },
    ],
  },
  {
    name: 'promote',
    description: "Liste les joueurs éligibles à la promotion (quota minimum)",
    options: [
      {
        type: 4, // INTEGER
        name: 'min',
        description: 'Quota minimale (ex: 2400 à 2800)',
        required: false,
        choices: [
          { name: '2400', value: 2400 },
          { name: '2600', value: 2600 },
          { name: '2800', value: 2800 },
        ],
      },
      {
        type: 3, // STRING
        name: 'clan',
        description: '1/2/3 ou la/les (1=La Resistance, 2=Les Resistants, 3=Les Revoltes)',
        required: false,
        choices: [
          { name: 'La Resistance', value: '1' },
          { name: 'Les Resistants', value: '2' },
          { name: 'Les Revoltes', value: '3' },
        ],
      },
    ],
  },
];

(async () => {
  try {
    const res = await fetch(url, {
      method: 'PUT',
      headers: {
        Authorization: `Bot ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(commands),
    });
    const data = await res.json();
    if (!res.ok) {
      console.error('Failed to register commands', data);
      process.exit(1);
    }
    console.log('Commands registered:');
    console.dir(data, { depth: 2 });
  } catch (err) {
    console.error('Request failed', err);
    process.exit(1);
  }
})();
