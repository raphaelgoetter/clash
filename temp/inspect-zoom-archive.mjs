// Lecture seule : vérifie ce qui reste dans l'archive de saison pour la
// manche Zoom carte en cours, avant restauration de zoom:participants.
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { Redis } from "@upstash/redis";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  automaticDeserialization: false,
});

const state = JSON.parse(await redis.get("zoom:state"));
console.log("État actuel :", state);

const archKey = `zoom:archived:${state.seasonId}`;
const archive = await redis.hgetall(archKey);
const entries = Object.entries(archive || {})
  .filter(([field]) => field.startsWith(`${state.gameId}:`))
  .map(([field, raw]) => [field, JSON.parse(raw)]);

console.log(`\nEntrées archivées pour ${state.gameId} (${entries.length}) :`);
for (const [field, r] of entries) {
  console.log(`  ${field} -> ${r.pseudo} | score ${r.score} | solvedAt ${r.solvedAt}`);
}

console.log("\nContenu actuel de zoom:participants:" + state.gameId + " :");
const participants = await redis.hgetall(`zoom:participants:${state.gameId}`);
console.log(participants);

console.log("\nContenu actuel de zoom:usernames:" + state.gameId + " :");
const usernames = await redis.hgetall(`zoom:usernames:${state.gameId}`);
console.log(usernames);
