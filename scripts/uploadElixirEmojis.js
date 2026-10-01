#!/usr/bin/env node
// uploadElixirEmojis.js
// Génère (SVG → PNG, même goutte que l'image des cartes, voir
// backend/services/elixirImage.js) puis upload UNE SEULE FOIS l'emoji
// d'application Discord `elixir` utilisé par le jeu Élixir (/elixir).
//
// À relancer uniquement si la goutte change : supprime d'abord l'ancien
// emoji depuis le portail développeur Discord (Application > Emojis), sinon
// l'upload échoue sur un nom déjà pris.
//
// Usage :
//   node scripts/uploadElixirEmojis.js            # génère et upload
//   node scripts/uploadElixirEmojis.js --dry-run  # génère seulement
//                                                  (data/elixir/images/elixir.png)
//
// Après exécution, reporte l'ID affiché dans ELIXIR_EMOJI
// (api/discord/_handlers/elixirDuel.js).

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import fs from "fs/promises";
import path from "path";
import { Resvg } from "@resvg/resvg-js";
import { elixirDropSvg } from "../backend/services/elixirImage.js";

const DRY_RUN = process.argv.includes("--dry-run");
const OUTPUT = path.resolve("data/elixir/images/elixir.png");
const SIZE = 128;

(async () => {
  // Repère 100×116 de la goutte, centré dans un carré transparent
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${SIZE}" height="${SIZE}" viewBox="-10 -4 120 120">${elixirDropSvg(0, 0, 100)}</svg>`;
  const png = Buffer.from(new Resvg(svg, { fitTo: { mode: "width", value: SIZE } }).render().asPng());
  await fs.mkdir(path.dirname(OUTPUT), { recursive: true });
  await fs.writeFile(OUTPUT, png);
  console.log(`✓ ${OUTPUT} généré`);
  if (DRY_RUN) return;

  const appId = process.env.DISCORD_APP_ID;
  const token = process.env.DISCORD_TOKEN;
  if (!appId || !token) {
    console.error("DISCORD_APP_ID et DISCORD_TOKEN doivent être définis (voir .env).");
    process.exit(1);
  }
  const res = await fetch(`https://discord.com/api/v10/applications/${appId}/emojis`, {
    method: "POST",
    headers: { Authorization: `Bot ${token}`, "Content-Type": "application/json" },
    body: JSON.stringify({ name: "elixir", image: `data:image/png;base64,${png.toString("base64")}` }),
  });
  if (!res.ok) {
    console.error(`Échec upload (${res.status}): ${await res.text().catch(() => "")}`);
    process.exit(1);
  }
  const emoji = await res.json();
  console.log(`✓ emoji :${emoji.name}: (id ${emoji.id}) → <:elixir:${emoji.id}>`);
})();
