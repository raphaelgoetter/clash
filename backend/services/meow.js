// ============================================================
// meow.js — Meow, jeu spécial de 7 jours : trois bandes de chats squattent
// les coins d'une maison (Risk simplifié en temps réel, règles pures dans
// meowRules.js).
//
// Couche métier : config statique, état de la publication, partie (carte,
// joueurs, combats, journal) sous verrou, rattrapage des événements
// horaires avant chaque action, manches.
//
// Stockage : Upstash Redis (mêmes conventions que quiestce.js) — espace de
// clés `meow:*`. Toute la partie tient dans une seule clé, lue et réécrite
// sous verrou à chaque action.
//
// ⚠️ Toute modification de règle doit suivre CONTRIBUTING.md (section
// Meow), source de vérité.
//
// ⚠️ automaticDeserialization désactivée volontairement (IDs Discord
// corrompus sinon, voir bossraid.js) : JSON sérialisé/désérialisé nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { creerPartie, inscrire, desinscrire, demarrer, rattraper, nbInscrits, classementBandes, classementCaid } from "./meowRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "meow", "meow.json");

// { phase, jour, channelId, messageId, publishedAt, termine, isPublic, noPing, closingAt?, prolongee? }
const STATE_KEY = "meow:state";
// voir creerPartie() dans meowRules.js
const PARTIE_KEY = "meow:partie";
const MANCHES_KEY = "meow:manches";
const MANCHE_SEQ_KEY = "meow:manche_seq";
const LOCK_KEY = "meow:lock";

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

export async function loadMeowConfig() {
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

// Ouverture de la fenêtre d'inscription : partie vide.
export async function initPartie() {
  const partie = creerPartie();
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
  throw new Error("Verrou de Meow indisponible");
}

// Lancement : bandes tirées au sort. `pnj` : pseudos de joueurs fictifs
// inscrits d'office (salon de test, pour remplir les bandes) ; ils jouent
// tout seuls à chaque distribution (jouerPnj() dans meowRules.js).
export async function demarrerPartie({ pnj = [] } = {}) {
  return withLock(async () => {
    const [config, partie] = await Promise.all([loadMeowConfig(), readPartie()]);
    pnj.forEach((nom, i) => inscrire(partie, `pnj-${i + 1}`, nom, { config: { ...config, effectif_max: Infinity } }));
    demarrer(partie, { config });
    partie.pnjActifs = pnj.length > 0;
    await writePartie(partie);
    return partie;
  });
}

// Action d'un joueur sous verrou : événements horaires rattrapés, puis
// `fn(partie, config)` modifie la partie (fonctions de meowRules.js) et
// renvoie un résultat. `inscription` : le joueur s'inscrit s'il ne l'est
// pas encore (bouton S'inscrire). Renvoie { partie, resultat, nouveau } ou
// { erreur: "inscriptions" | "complet" | "pasInscrit" }.
export async function agir(discordId, username, fn = () => null, { inscription = false } = {}) {
  return withLock(async () => {
    const [config, partie] = await Promise.all([loadMeowConfig(), readPartie()]);
    rattraper(partie, { config });
    let nouveau = false;
    const joueur = partie.joueurs[discordId];
    if (!joueur) {
      if (!inscription) return { erreur: partie.demarree ? "inscriptions" : "pasInscrit", partie };
      const r = inscrire(partie, discordId, username, { config });
      if (r.erreur) return { erreur: r.erreur, partie };
      nouveau = true;
    } else if (username && joueur.username !== username) {
      joueur.username = username;
    }
    const resultat = await fn(partie, config);
    await writePartie(partie);
    return { partie, resultat, nouveau };
  });
}

// Désinscription (bouton Se désinscrire), possible jusqu'au lancement.
export async function desinscrireJoueur(discordId) {
  return withLock(async () => {
    const partie = await readPartie();
    const r = desinscrire(partie, discordId);
    if (!r.erreur) await writePartie(partie);
    return { ...r, partie };
  });
}

export async function countInscrits() {
  return nbInscrits(await readPartie());
}

// Rattrapage sans action de joueur (publication quotidienne). `dryRun` :
// lecture seule, rien n'est réécrit.
export async function rattraperPartie({ dryRun = false } = {}) {
  if (dryRun) {
    const [config, partie] = await Promise.all([loadMeowConfig(), readPartie()]);
    return rattraper(partie, { config });
  }
  return withLock(async () => {
    const [config, partie] = await Promise.all([loadMeowConfig(), readPartie()]);
    rattraper(partie, { config });
    await writePartie(partie);
    return partie;
  });
}

export async function classementsFinaux(partie) {
  const config = await loadMeowConfig();
  return { bandes: classementBandes(partie), caid: classementCaid(partie, config) };
}

// ── Manches (comparaison entre parties, comme quiestce.js) ──────────

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

export async function resetMeow({ clearManches = false } = {}) {
  await getRedis().del(STATE_KEY, PARTIE_KEY, LOCK_KEY);
  if (clearManches) await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
}
