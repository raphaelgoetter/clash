#!/usr/bin/env node
// uploadVehiculeEmojis.js
// Uploade les images des véhicules de Mario Clash
// (jeux/data/marioclash/vehicules/<id>.png, 512×512 transparent) comme emojis
// d'application Discord (`vehicule_<id>`), puis écrit leurs IDs dans
// `config.vehicules.<id>.emoji_id` (jeux/data/marioclash/marioclash.json, à
// committer : la config est statique, jamais lue depuis Discord au runtime).
// Tant qu'un `emoji_id` manque, le jeu affiche l'emoji Unicode `emoji`.
//
// Usage :
//   node jeux/scripts/uploadVehiculeEmojis.js [--vehicule velo] [--remplacer]
//   node jeux/scripts/uploadVehiculeEmojis.js --dry-run
//
// --vehicule  : un seul véhicule (défaut : tous)
// --remplacer : supprime d'abord les emojis d'application du même nom (sinon
//               l'upload échoue sur un nom déjà pris)
// --dry-run   : aucun appel Discord, vérifie seulement les images

import "../env.js";

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data", "marioclash");
const CONFIG_PATH = path.join(DATA_DIR, "marioclash.json");
// Limite Discord d'un emoji : 256 Ko
const TAILLE_MAX = 256 * 1024;

const args = process.argv.slice(2);
const dryRun = args.includes("--dry-run");
const remplacer = args.includes("--remplacer");
const argValue = (flag) => {
  const i = args.indexOf(flag);
  return i >= 0 ? args[i + 1] : null;
};

let texte = await fs.readFile(CONFIG_PATH, "utf-8");
const config = JSON.parse(texte);

// Écrit `"emoji_id"` juste après le `"emoji"` du véhicule, sans reformater
// le reste du fichier (entrées compactes sur une ligne).
function ecrireEmojiId(id, emojiId) {
  const debut = texte.indexOf(`"${id}": {`, texte.indexOf('"vehicules"'));
  const re = /("emoji": "[^"]*")(, "emoji_id": "\d*")?/y;
  re.lastIndex = texte.indexOf('"emoji": "', debut);
  const m = re.exec(texte);
  if (debut < 0 || !m) throw new Error(`"emoji" introuvable pour ${id}`);
  texte = texte.slice(0, m.index) + `${m[1]}, "emoji_id": "${emojiId}"` + texte.slice(m.index + m[0].length);
}
const tous = Object.keys(config.vehicules || {});
const ids = argValue("--vehicule") ? [argValue("--vehicule")] : tous;
for (const id of ids) {
  if (!tous.includes(id)) {
    console.error(`Véhicule inconnu : ${id} (${tous.join(", ")})`);
    process.exit(1);
  }
}

const images = {};
for (const id of ids) {
  const file = path.join(DATA_DIR, "vehicules", `${id}.png`);
  const buffer = await fs.readFile(file);
  if (buffer.length > TAILLE_MAX) {
    console.error(`${file} : ${buffer.length} octets, au-delà de la limite Discord (256 Ko)`);
    process.exit(1);
  }
  images[id] = buffer;
  console.log(`${dryRun ? "✓" : "…"} ${file} (${Math.round(buffer.length / 1024)} Ko)`);
}
if (dryRun) process.exit(0);

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

for (const id of ids) {
  const name = `vehicule_${id}`;
  for (const old of existing.filter((e) => e.name === name)) {
    await discord(`${API}/${old.id}`, { method: "DELETE" });
    console.log(`✗ ${name} supprimé (id ${old.id})`);
  }
  const image = `data:image/png;base64,${images[id].toString("base64")}`;
  const emoji = await discord(API, { method: "POST", body: JSON.stringify({ name, image }) });
  ecrireEmojiId(id, emoji.id);
  console.log(`✓ ${name} (id ${emoji.id})`);
}

JSON.parse(texte); // garde-fou : fichier toujours valide
await fs.writeFile(CONFIG_PATH, texte);
console.log(`\nIDs écrits dans ${CONFIG_PATH} : à committer pour le déploiement.`);
