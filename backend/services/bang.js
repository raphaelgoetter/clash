// ============================================================
// bang.js — Bang!, jeu spécial de 7 jours inspiré d'Exploding Kittens :
// chaque joueur pioche dans une pioche commune truffée de Gobelins
// explosifs, joue ses cartes d'action pour piéger les autres, et tente
// d'être le dernier Roi en vie. 100 % asynchrone, sans ordre de passage :
// chaque action est résolue tout de suite (règles pures dans bangRules.js).
//
// Couche métier : config statique, état de la publication, partie
// (pioche, joueurs, journal) sous verrou, clôture quotidienne, manches.
//
// Stockage : Upstash Redis (mêmes conventions que marioclash.js) — espace
// de clés `bang:*`. Toute la partie tient dans une seule clé, lue et
// réécrite sous verrou à chaque action (les joueurs jouent en même temps
// sur la même pioche).
//
// ⚠️ Toute modification de règle doit suivre CONTRIBUTING.md (section
// Bang!), source de vérité.
//
// ⚠️ automaticDeserialization désactivée volontairement (IDs Discord
// corrompus sinon, voir bossraid.js) : JSON sérialisé/désérialisé nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { creerPartie, ajouterJoueur, cloturer, classement } from "./bangRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "bang", "bang.json");

// { phase, jour, channelId, messageId, publishedAt, termine, isPublic, noPing }
const STATE_KEY = "bang:state";
// { pioche, joueurs, journal, elimines, termine } (voir bangRules.js)
const PARTIE_KEY = "bang:partie";
const RESULTAT_KEY = "bang:resultat";
const MANCHES_KEY = "bang:manches";
const MANCHE_SEQ_KEY = "bang:manche_seq";
const LOCK_KEY = "bang:lock";

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

function toJson(value) {
  return JSON.stringify(value);
}

function fromJson(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

function pairsToObject(flat) {
  const obj = {};
  for (let i = 0; i < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
  return obj;
}

async function hgetallJson(key) {
  const raw = pairsToObject((await getRedis().hgetall(key)) || []);
  const result = {};
  for (const [field, value] of Object.entries(raw)) result[field] = fromJson(value);
  return result;
}

// ── Config statique ────────────────────────────────────────────────

let _configCache = null;

export async function loadBangConfig() {
  if (_configCache) return _configCache;
  _configCache = JSON.parse(await fs.readFile(CONFIG_JSON_PATH, "utf8"));
  return _configCache;
}

// ── État de la publication ─────────────────────────────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// ── Partie ──────────────────────────────────────────────────────────

export async function readPartie() {
  return fromJson(await getRedis().get(PARTIE_KEY)) || creerPartie();
}

async function writePartie(partie) {
  await getRedis().set(PARTIE_KEY, toJson(partie));
}

// Jour 1. `pnj` : pseudos de joueurs fictifs inscrits d'office (salon de
// test, pour voir le jeu avec du monde) ; ils ne jouent jamais, seule la
// clôture pioche pour eux.
export async function initPartie({ pnj = [] } = {}) {
  const config = await loadBangConfig();
  // Décalage des avatars du plateau (voir tableImageUrl), pour varier d'une
  // partie à l'autre
  const partie = { ...creerPartie(), decalageAvatars: Math.floor(Math.random() * 12) };
  pnj.forEach((nom, i) => ajouterJoueur(partie, `pnj-${i + 1}`, nom, { config }));
  await writePartie(partie);
  return partie;
}

async function withLock(fn) {
  for (let essai = 0; essai < 60; essai++) {
    if (await getRedis().set(LOCK_KEY, "1", { nx: true, px: 10_000 })) {
      try {
        return await fn();
      } finally {
        await getRedis().del(LOCK_KEY);
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Verrou de Bang! indisponible");
}

// Action d'un joueur sous verrou : `fn(partie, config)` modifie la partie
// (fonctions de bangRules.js) et renvoie un résultat. Le joueur rejoint la
// partie à sa première action tant que les inscriptions sont ouvertes.
// Renvoie { partie, resultat, nouveau } ou { erreur: "inscriptions" }.
export async function agir(jour, discordId, username, fn = () => null) {
  return withLock(async () => {
    const [config, partie] = await Promise.all([loadBangConfig(), readPartie()]);
    let nouveau = false;
    const joueur = partie.joueurs[discordId];
    if (!joueur) {
      if (jour > config.inscription_jours) return { erreur: "inscriptions", partie };
      ajouterJoueur(partie, discordId, username, { config });
      nouveau = true;
    } else if (username && joueur.username !== username) {
      joueur.username = username;
    }
    const resultat = await fn(partie, config);
    await writePartie(partie);
    return { partie, resultat, nouveau };
  });
}

// ── Clôture ─────────────────────────────────────────────────────────

// Lecture seule (aucune écriture Redis) — branche --dry-run du script.
export async function previewCloture(jour) {
  const [config, partie] = await Promise.all([loadBangConfig(), readPartie()]);
  if (!partie.termine) cloturer(partie, { config });
  const termine = partie.termine || jour >= config.duree_jours;
  return { partie, termine, final: termine ? classement(partie) : null, jourSuivant: jour + 1 };
}

// Pioches automatiques du jour ; classement final au dernier
// jour ou s'il ne reste qu'un Roi.
export async function closeDayAndAdvance(jour) {
  return withLock(async () => {
    const [config, partie] = await Promise.all([loadBangConfig(), readPartie()]);
    if (!partie.termine) cloturer(partie, { config });
    const termine = partie.termine || jour >= config.duree_jours;
    const final = termine ? classement(partie) : null;
    await writePartie(partie);
    if (final) await getRedis().set(RESULTAT_KEY, toJson(final));
    return { partie, termine, final, jourSuivant: jour + 1 };
  });
}

// Fin de partie en cours de journée (dernier Roi debout) : classement
// figé une seule fois, même si plusieurs actions se terminent ensemble.
export async function figerResultat(partie) {
  const final = classement(partie);
  const ok = await getRedis().set(RESULTAT_KEY, toJson(final), { nx: true });
  return ok ? final : null;
}

export async function readResultat() {
  return fromJson(await getRedis().get(RESULTAT_KEY));
}

export const MIN_HOURS_BETWEEN_CLOSURES = 8;

export function isTooSoonSinceLastClosure(publishedAt, now = Date.now()) {
  if (!publishedAt) return false;
  return (now - new Date(publishedAt).getTime()) / 3_600_000 < MIN_HOURS_BETWEEN_CLOSURES;
}

// ── Manches (comparaison entre parties, comme marioclash.js) ────────

export async function archiveManche(record) {
  const manche = Number(await getRedis().incr(MANCHE_SEQ_KEY));
  await getRedis().hset(MANCHES_KEY, { [manche]: toJson({ manche, ...record }) });
  return manche;
}

export async function listManches({ limit = 10 } = {}) {
  const all = await hgetallJson(MANCHES_KEY);
  return Object.values(all)
    .sort((a, b) => b.manche - a.manche)
    .slice(0, limit);
}

// ── Remise à zéro ────────────────────────────────────────────────────

export async function resetBang({ clearManches = false } = {}) {
  await getRedis().del(STATE_KEY, PARTIE_KEY, RESULTAT_KEY, LOCK_KEY);
  if (clearManches) await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
}
