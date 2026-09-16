#!/usr/bin/env node
// uploadGobeletEmojis.js
// Upload UNE SEULE FOIS les 6 faces de dé (data/gobelet/images/dice-1.png à
// dice-6.png) comme emojis d'application Discord, pour qu'elles s'affichent
// sur les boutons de sélection de dés du Jeu du Gobelet à la place des
// emoji génériques 🔒/🎲.
//
// À relancer uniquement si une image est remplacée — dans ce cas, supprime
// d'abord l'ancien emoji correspondant depuis le portail développeur Discord
// (Application > Emojis), sinon l'upload échoue sur un nom déjà pris.
//
// Usage : node scripts/uploadGobeletEmojis.js
//
// Après exécution, copie les IDs affichés dans data/gobelet/gobelet.json
// (clé "diceEmojis") puis redéploie — la config est statique, jamais lue
// depuis Discord au runtime.

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import fs from "fs/promises";
import path from "path";

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_TOKEN;

if (!appId || !token) {
  console.error("DISCORD_APP_ID et DISCORD_TOKEN doivent être définis (voir .env).");
  process.exit(1);
}

const IMAGES_DIR = path.resolve("data/gobelet/images");

(async () => {
  const diceEmojis = {};

  for (let value = 1; value <= 6; value++) {
    const filePath = path.join(IMAGES_DIR, `dice-${value}.png`);
    const buffer = await fs.readFile(filePath);
    const image = `data:image/png;base64,${buffer.toString("base64")}`;
    const name = `gobelet_dice_${value}`;

    const res = await fetch(`https://discord.com/api/v10/applications/${appId}/emojis`, {
      method: "POST",
      headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name, image }),
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => "");
      console.error(`Échec upload dice-${value}.png (${res.status}): ${errText}`);
      process.exit(1);
    }

    const emoji = await res.json();
    diceEmojis[value] = emoji.id;
    console.log(`✓ dice-${value}.png -> emoji ${emoji.name} (id ${emoji.id})`);
  }

  console.log('\nColle ceci dans data/gobelet/gobelet.json (clé "diceEmojis") :\n');
  console.log(JSON.stringify(diceEmojis, null, 2));
})();
