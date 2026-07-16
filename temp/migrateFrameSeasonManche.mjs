// migrateFrameSeasonManche.mjs
// One-off : migre frame:season:<seasonId>:manches (ancien SET non ordonné)
// vers le nouveau schéma manche_numbers (HASH gameId → numéro) +
// manche_seq (STRING, compteur), et patche frame:state avec
// seasonManche/seasonMancheTotal pour la partie active.
//
// Usage : node temp/migrateFrameSeasonManche.mjs   (depuis la racine du repo)

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { Redis } from "@upstash/redis";
import { readState, writeState } from "../backend/services/frames.js";
import { computeSeasonMancheTotal } from "../backend/services/dateUtils.js";

const redis = new Redis({
  url: process.env.KV_REST_API_URL,
  token: process.env.KV_REST_API_TOKEN,
  automaticDeserialization: false,
});

const oldSetKey = (seasonId) => `frame:season:${seasonId}:manches`;
const numbersKey = (seasonId) => `frame:season:${seasonId}:manche_numbers`;
const seqKey = (seasonId) => `frame:season:${seasonId}:manche_seq`;

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune partie Frame active — rien à migrer.");
    return;
  }
  const { seasonId, gameId } = state;

  const oldMembers = (await redis.smembers(oldSetKey(seasonId))) || [];
  console.log(`SET ${oldSetKey(seasonId)} :`, oldMembers);
  if (oldMembers.length > 1) {
    // ⚠️ Un SET est non ordonné : avec plusieurs membres, vérifier/décider
    // manuellement l'ordre chronologique réel avant de lancer ce script
    // (ex. via startedAt archivé ailleurs) plutôt que de faire confiance à
    // l'ordre renvoyé par SMEMBERS.
    console.warn("Plusieurs manches à numéroter : vérifier l'ordre chronologique avant de continuer.");
  }

  let seq = 0;
  for (const id of oldMembers) {
    seq += 1;
    await redis.hsetnx(numbersKey(seasonId), id, String(seq));
  }
  await redis.set(seqKey(seasonId), String(seq));

  const seasonManche = Number(await redis.hget(numbersKey(seasonId), gameId));
  const seasonMancheTotal = computeSeasonMancheTotal();
  await writeState({ ...state, seasonManche, seasonMancheTotal });

  console.log(
    `Migré : saison ${seasonId}, ${oldMembers.length} manche(s) numérotée(s), ` +
      `partie active → Manche ${seasonManche}/${seasonMancheTotal}.`,
  );

  await redis.del(oldSetKey(seasonId));
  console.log(`Ancien SET ${oldSetKey(seasonId)} supprimé.`);
})();
