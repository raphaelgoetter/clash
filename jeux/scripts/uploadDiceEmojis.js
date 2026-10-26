#!/usr/bin/env node
// uploadDiceEmojis.js
// Rend les 6 faces de dé (jeux/data/dices/dice-1.svg à dice-6.svg) en PNG
// 128×128, en mémoire, pour chaque couleur de jeux/data/dices/dices.json, et
// les uploade comme emojis d'application Discord (`de_<couleur>_<valeur>`).
// Les IDs obtenus sont écrits directement dans dices.json (à committer : la
// config est statique, jamais lue depuis Discord au runtime).
//
// Usage :
//   node jeux/scripts/uploadDiceEmojis.js [--couleur bleu] [--remplacer]
//   node jeux/scripts/uploadDiceEmojis.js --dry-run [--out <dossier>]
//
// --couleur   : une seule couleur (défaut : toutes celles de dices.json)
// --remplacer : supprime d'abord les emojis d'application du même nom (sinon
//               l'upload échoue sur un nom déjà pris)
// --dry-run   : aucun appel Discord, écrit les PNG dans --out (défaut temp/dices)

import "../env.js";

import fs from "fs/promises";
import path from "path";
import { Resvg } from "@resvg/resvg-js";
import {
  DICES_CONFIG_PATH,
  DICE_VALUES,
  loadDicesConfig,
  emojiName,
  buildColoredDieSvg,
} from "../services/dices.js";

const EMOJI_SIZE = 128;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const remplacer = args.includes("--remplacer");
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const config = loadDicesConfig();
const couleurs = argValue("--couleur") ? [argValue("--couleur")] : Object.keys(config.couleurs);
for (const couleur of couleurs) {
  if (!config.couleurs[couleur]) {
    console.error(`Couleur inconnue : ${couleur} (voir ${DICES_CONFIG_PATH})`);
    process.exit(1);
  }
}

async function renderPng(value, couleur) {
  const svg = await buildColoredDieSvg(value, couleur);
  return new Resvg(svg, { fitTo: { mode: "width", value: EMOJI_SIZE } }).render().asPng();
}

if (dryRun) {
  const outDir = path.resolve(argValue("--out") ?? "temp/dices");
  await fs.mkdir(outDir, { recursive: true });
  for (const couleur of couleurs) {
    for (const value of DICE_VALUES) {
      const file = path.join(outDir, `${emojiName(couleur, value)}.png`);
      await fs.writeFile(file, await renderPng(value, couleur));
      console.log(`✓ ${file}`);
    }
  }
  process.exit(0);
}

const appId = process.env.DISCORD_APP_ID;
const token = process.env.DISCORD_TOKEN;
if (!appId || !token) {
  console.error("DISCORD_APP_ID et DISCORD_TOKEN doivent être définis (voir .env).");
  process.exit(1);
}

const API = `https://discord.com/api/v10/applications/${appId}/emojis`;
const headers = { Authorization: `Bot ${token}`, "Content-Type": "application/json" };

async function discord(url, init) {
  const res = await fetch(url, { headers, ...init });
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    throw new Error(`${init?.method ?? "GET"} ${url} → ${res.status} ${errText}`);
  }
  return res.status === 204 ? null : res.json();
}

const existing = remplacer ? (await discord(API)).items ?? [] : [];

for (const couleur of couleurs) {
  config.emojis[couleur] ??= {};
  for (const value of DICE_VALUES) {
    const name = emojiName(couleur, value);
    for (const old of existing.filter((e) => e.name === name)) {
      await discord(`${API}/${old.id}`, { method: "DELETE" });
      console.log(`✗ ${name} supprimé (id ${old.id})`);
    }
    const image = `data:image/png;base64,${(await renderPng(value, couleur)).toString("base64")}`;
    const emoji = await discord(API, { method: "POST", body: JSON.stringify({ name, image }) });
    config.emojis[couleur][String(value)] = emoji.id;
    console.log(`✓ ${name} (id ${emoji.id})`);
  }
}

await fs.writeFile(DICES_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
console.log(`\nIDs écrits dans ${DICES_CONFIG_PATH} : à committer pour le déploiement.`);
