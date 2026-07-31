// ============================================================
// aventure.js — Aventure interactive "Livre dont vous êtes le héros"
// Couche métier : lecture de l'histoire, état du chapitre courant,
// votes, détermination du vainqueur, historique paginé.
//
// Stockage : Upstash Redis (comme le jeu Frame, voir backend/services/
// frames.js lignes 1-22 pour le raisonnement complet) — les votes sont
// bien plus fréquents que le quota gratuit de Vercel Blob (2 000
// "Advanced Operations"/mois) ne le permettrait.
//
// ⚠️ automaticDeserialization désactivée volontairement : le SDK convertit
// par défaut toute valeur "numérique" en Number JS, y compris les IDs
// Discord (17-19 chiffres) qui dépassent Number.MAX_SAFE_INTEGER — ça les
// corrompt silencieusement. On sérialise/désérialise le JSON nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const HISTOIRE_JSON_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "data",
  "aventure",
  "histoire.json",
);

// Construction paresseuse (pas au chargement du module) : avec les imports
// ES hoistés, "import ... from aventure.js" s'exécute avant le
// dotenv.config() du script appelant — construire le client ici en top-level
// figerait des variables d'env pas encore chargées.
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

// Avec automaticDeserialization désactivée, HGETALL renvoie un tableau
// plat [champ1, valeur1, champ2, valeur2, ...] et non un objet.
function pairsToObject(flat) {
  const obj = {};
  for (let i = 0; i < flat.length; i += 2) {
    obj[flat[i]] = flat[i + 1];
  }
  return obj;
}

async function hgetallRaw(key) {
  return pairsToObject((await getRedis().hgetall(key)) || []);
}

async function hgetallJson(key) {
  const raw = await hgetallRaw(key);
  const result = {};
  for (const [field, value] of Object.entries(raw)) {
    result[field] = fromJson(value);
  }
  return result;
}

async function scanKeys(pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await getRedis().scan(cursor, { match: pattern, count: 200 });
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

async function scanDelete(pattern) {
  const keys = await scanKeys(pattern);
  if (keys.length) await getRedis().del(...keys);
}

const STATE_KEY = "aventure:state";
const JOUR_SEQ_KEY = "aventure:jour_seq";
const JOURS_KEY = "aventure:jours";
const HISTORIQUE_KEY = "aventure:historique";

function votesKey(chapitreId) {
  return `aventure:votes:${chapitreId}`;
}

// ── Lecture de l'histoire (statique, jamais mutée) ────────────────

let histoireCache = null;

export async function loadHistoire() {
  if (histoireCache) return histoireCache;
  const txt = await fs.readFile(HISTOIRE_JSON_PATH, "utf-8");
  histoireCache = JSON.parse(txt);
  return histoireCache;
}

// ── État du chapitre courant ──────────────────────────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// ── Votes ──────────────────────────────────────────────────────────
// Un membre ne peut avoir qu'une entrée par chapitre : revoter écrase
// simplement l'ancienne valeur via HSET, pas besoin de logique de
// changement de vote dédiée.

export async function recordVote(chapitreId, discordId, choixId) {
  await getRedis().hset(votesKey(chapitreId), { [discordId]: choixId });
}

export async function tallyVotes(chapitreId) {
  const raw = await hgetallRaw(votesKey(chapitreId));
  const counts = {};
  for (const choixId of Object.values(raw)) {
    counts[choixId] = (counts[choixId] || 0) + 1;
  }
  return counts;
}

async function clearVotes(chapitreId) {
  await getRedis().del(votesKey(chapitreId));
}

// ── Détermination du vainqueur ──────────────────────────────────────
// Fonction PURE (aucun I/O) : le choix avec le plus de votes gagne,
// égalité (y compris zéro vote partout) départagée par l'ordre
// d'apparition dans le tableau choix — couvre nativement les deux
// règles validées par l'utilisateur (égalité ET zéro vote) sans branche
// spéciale, ce sont la même règle.

export function determineWinningChoix(choix, voteCounts) {
  if (!Array.isArray(choix) || choix.length === 0) return null;
  let winner = choix[0];
  let winnerCount = voteCounts[choix[0].id] || 0;
  for (const c of choix.slice(1)) {
    const count = voteCounts[c.id] || 0;
    if (count > winnerCount) {
      winner = c;
      winnerCount = count;
    }
  }
  return winner;
}

// ── Numérotation des jours ──────────────────────────────────────────
// Idempotent (HSETNX + relecture) : un chapitre déjà numéroté renvoie
// toujours le même numéro, même appelé plusieurs fois — copie du
// pattern assignSeasonMancheNumber() de frames.js.

export async function assignJourNumber(chapitreId) {
  const existing = await getRedis().hget(JOURS_KEY, chapitreId);
  if (existing != null) return Number(existing);

  const jour = Number(await getRedis().incr(JOUR_SEQ_KEY));
  const wasSet = Number(await getRedis().hsetnx(JOURS_KEY, chapitreId, String(jour)));
  if (!wasSet) {
    return Number(await getRedis().hget(JOURS_KEY, chapitreId));
  }
  return jour;
}

// Aperçu en lecture seule du prochain numéro de jour à attribuer, sans muter
// l'état (INCR) — utilisé par la branche --dry-run de postChapter(), qui ne
// doit jamais faire avancer l'histoire. Voir previewSeasonManche() dans
// frames.js pour le même principe.
export async function previewJourNumber() {
  const seq = Number(await getRedis().get(JOUR_SEQ_KEY)) || 0;
  return seq + 1;
}

// ── Historique (chapitres résolus) ───────────────────────────────────

export async function writeHistoriqueEntry(chapitreId, record) {
  await getRedis().hset(HISTORIQUE_KEY, { [chapitreId]: toJson(record) });
}

export async function getHistoriqueEntry(chapitreId) {
  const raw = await getRedis().hget(HISTORIQUE_KEY, chapitreId);
  return fromJson(raw);
}

// Trié du jour le plus récent au plus ancien — même convention que la
// pagination "Précédents/Suivants" des pronostics GDC.
export async function listHistorique({ limit = 25, offset = 0 } = {}) {
  const all = await hgetallJson(HISTORIQUE_KEY);
  const entries = Object.entries(all)
    .map(([chapitreId, record]) => ({ chapitreId, ...record }))
    .sort((a, b) => b.jour - a.jour);
  const hasMore = entries.length > offset + limit;
  return { entries: entries.slice(offset, offset + limit), hasMore };
}

// ── Résolution du chapitre courant et avancée de l'histoire ─────────
// Appelée uniquement par postChapter() (api/discord/handlers/aventure.js)
// au moment du cron quotidien. Toute la logique métier vit ici, jamais
// dans le handler ni dans interactions.js.

async function computeResolution(state) {
  const histoire = await loadHistoire();
  const chapitreEntry = histoire.chapitres[state.chapitreId];
  const voteCounts = await tallyVotes(state.chapitreId);
  const gagnant = determineWinningChoix(chapitreEntry.choix, voteCounts);
  return { gagnant, nextChapitreId: gagnant?.prochain_chapitre ?? null };
}

// Lecture seule (aucune écriture Redis) — utilisée par la branche --dry-run
// de postChapter(), qui ne doit jamais faire avancer l'histoire ni
// consommer les votes du chapitre actif.
export async function previewNextChapitreId(state) {
  const { nextChapitreId } = await computeResolution(state);
  return nextChapitreId;
}

export async function resolveAndAdvance(state) {
  const { gagnant, nextChapitreId } = await computeResolution(state);
  const jour = await assignJourNumber(state.chapitreId);

  await writeHistoriqueEntry(state.chapitreId, {
    jour,
    choixGagnantId: gagnant?.id ?? null,
    resolvedAt: new Date().toISOString(),
  });
  await clearVotes(state.chapitreId);

  return { nextChapitreId };
}

// ── Remise à zéro ────────────────────────────────────────────────────

export async function resetAventure() {
  await getRedis().del(STATE_KEY, JOUR_SEQ_KEY, JOURS_KEY, HISTORIQUE_KEY);
  await scanDelete("aventure:votes:*");
}
