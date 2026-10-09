// ============================================================
// bangDuel.js — Bang! Duel (`/bang`) : un joueur contre le Bot, partie
// privée (message éphémère). Règles pures dans bangDuelRules.js.
//
// Stockage : Upstash Redis, une clé par joueur (`bangduel:<discordId>`),
// plusieurs parties en même temps possibles. Chaque écriture relance
// l'expiration : sans action pendant `INACTIVITE_SECONDES`, la partie
// disparaît (abandon, aucun score conservé : jeu libre).
//
// ⚠️ Toute modification de règle doit suivre CONTRIBUTING.md (section
// Bang! Duel), source de vérité.
//
// ⚠️ automaticDeserialization désactivée volontairement (IDs Discord
// corrompus sinon, voir bossraid.js) : JSON sérialisé/désérialisé nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { creerDuel } from "./bangDuelRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "bang", "duel.json");

export const INACTIVITE_SECONDES = 2 * 3600;

const cleDuel = (discordId) => `bangduel:${discordId}`;
const cleVerrou = (discordId) => `bangduel:lock:${discordId}`;

let _redis = null;
function getRedis() {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
      automaticDeserialization: false,
    });
  }
  return _redis;
}

function fromJson(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

let _configCache = null;

export async function loadDuelConfig() {
  if (_configCache) return _configCache;
  _configCache = JSON.parse(await fs.readFile(CONFIG_JSON_PATH, "utf8"));
  return _configCache;
}

export async function readDuel(discordId) {
  return fromJson(await getRedis().get(cleDuel(discordId)));
}

async function writeDuel(discordId, duel) {
  await getRedis().set(cleDuel(discordId), JSON.stringify(duel), { ex: INACTIVITE_SECONDES });
}

export async function supprimerDuel(discordId) {
  await getRedis().del(cleDuel(discordId));
}

// Verrou par joueur (double clic, clics rapprochés).
async function withLock(discordId, fn) {
  for (let essai = 0; essai < 40; essai++) {
    if (await getRedis().set(cleVerrou(discordId), "1", { nx: true, px: 10_000 })) {
      try {
        return await fn();
      } finally {
        await getRedis().del(cleVerrou(discordId));
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Verrou de Bang! Duel indisponible");
}

// Nouvelle partie (remplace une éventuelle partie en cours).
export async function nouveauDuel(discordId) {
  const config = await loadDuelConfig();
  return withLock(discordId, async () => {
    const duel = creerDuel(config);
    await writeDuel(discordId, duel);
    return { duel, config };
  });
}

// Action du joueur sous verrou : `fn(duel, config)` modifie le duel
// (fonctions de bangDuelRules.js) et renvoie un résultat.
// Renvoie { duel, config, resultat } ou { duel: null } sans partie en cours.
export async function agirDuel(discordId, fn) {
  const config = await loadDuelConfig();
  return withLock(discordId, async () => {
    const duel = await readDuel(discordId);
    if (!duel) return { duel: null, config };
    const resultat = await fn(duel, config);
    await writeDuel(discordId, duel);
    return { duel, config, resultat };
  });
}
