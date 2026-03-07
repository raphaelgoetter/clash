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
