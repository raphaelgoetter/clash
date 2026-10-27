#!/usr/bin/env node
// uploadPionEmojis.js
// Rend le pion de Quatre à la suite (jeux/data/pions/pion.svg) en PNG
// 128×128, en mémoire, pour chaque couleur de jeux/data/pions/pions.json, et
// l'uploade comme emoji d'application Discord (`pion_<couleur>`).
// Les IDs obtenus sont écrits directement dans pions.json (à committer : la
// config est statique, jamais lue depuis Discord au runtime).
//
// Usage :
//   node jeux/scripts/uploadPionEmojis.js [--couleur bleu] [--remplacer]
//   node jeux/scripts/uploadPionEmojis.js --dry-run [--out <dossier>]
//
// --couleur   : une seule couleur (défaut : toutes celles de pions.json)
// --remplacer : supprime d'abord les emojis d'application du même nom (sinon
//               l'upload échoue sur un nom déjà pris)
// --dry-run   : aucun appel Discord, écrit les PNG dans --out (défaut temp/pions)

import "../env.js";

import fs from "fs/promises";
import path from "path";
import { Resvg } from "@resvg/resvg-js";
import { PIONS_CONFIG_PATH, loadPionsConfig, emojiName, buildColoredPionSvg } from "../services/pions.js";

const EMOJI_SIZE = 128;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const remplacer = args.includes("--remplacer");
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

const config = loadPionsConfig();
const couleurs = argValue("--couleur") ? [argValue("--couleur")] : Object.keys(config.couleurs);
for (const couleur of couleurs) {
  if (!config.couleurs[couleur]) {
    console.error(`Couleur inconnue : ${couleur} (voir ${PIONS_CONFIG_PATH})`);
    process.exit(1);
  }
}

async function renderPng(couleur) {
  const svg = await buildColoredPionSvg(couleur);
  return new Resvg(svg, { fitTo: { mode: "width", value: EMOJI_SIZE } }).render().asPng();
}

if (dryRun) {
  const outDir = path.resolve(argValue("--out") ?? "temp/pions");
  await fs.mkdir(outDir, { recursive: true });
  for (const couleur of couleurs) {
    const file = path.join(outDir, `${emojiName(couleur)}.png`);
    await fs.writeFile(file, await renderPng(couleur));
    console.log(`✓ ${file}`);
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
  const name = emojiName(couleur);
  for (const old of existing.filter((e) => e.name === name)) {
    await discord(`${API}/${old.id}`, { method: "DELETE" });
    console.log(`✗ ${name} supprimé (id ${old.id})`);
  }
  const image = `data:image/png;base64,${(await renderPng(couleur)).toString("base64")}`;
  const emoji = await discord(API, { method: "POST", body: JSON.stringify({ name, image }) });
  config.emojis[couleur] = emoji.id;
  console.log(`✓ ${name} (id ${emoji.id})`);
}

await fs.writeFile(PIONS_CONFIG_PATH, `${JSON.stringify(config, null, 2)}\n`);
console.log(`\nIDs écrits dans ${PIONS_CONFIG_PATH} : à committer pour le déploiement.`);
