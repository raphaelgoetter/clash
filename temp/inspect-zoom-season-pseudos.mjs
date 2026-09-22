// Lecture seule : liste discordId -> pseudo stocké pour la saison Zoom en
// cours, pour retrouver les IDs des 12 joueurs à restaurer à partir de leurs
// pseudos (capture d'écran).
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  automaticDeserialization: false,
});

const seasonId = 136;
const pseudos = await redis.hgetall(`zoom:season:${seasonId}:pseudos`);
console.log(`zoom:season:${seasonId}:pseudos :`);
for (let i = 0; i < pseudos.length; i += 2) {
  console.log(`  ${pseudos[i]} -> ${pseudos[i + 1]}`);
}

const flat = await redis.zrange(`zoom:season:${seasonId}`, 0, -1, { rev: true, withScores: true });
console.log("\nClassement saison (discordId, score) :");
for (let i = 0; i < flat.length; i += 2) {
  console.log(`  ${flat[i]} -> ${flat[i + 1]}`);
}
