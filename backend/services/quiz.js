// ============================================================
// quiz.js — Quiz thématique (7 questions, 1 par jour, thème unique par
// manche). Couche métier : lecture du contenu statique, état de la manche
// active, votes, scoring, historique des vainqueurs.
//
// Stockage : Upstash Redis (même instance que tamagotchi.js/anagrams.js),
// espace de clés `quiz:*`.
//
// ⚠️ automaticDeserialization désactivée volontairement : le SDK convertit
// par défaut toute valeur "numérique" en Number JS, y compris les IDs
// Discord (17-19 chiffres) qui dépassent Number.MAX_SAFE_INTEGER — ça les
// corrompt silencieusement. On sérialise/désérialise le JSON nous-mêmes.
//
// Schéma de data/quiz/quiz.json : { manches: [{ id, theme, questions: [
//   { type: "qcm"|"vrai_faux", enonce, image, choix: [...], bonne_reponse } × 7
// ] }] } — `id` est un slug stable (dossier d'images + debug), `image` un
// chemin relatif sous frontend/public/images/ (ou null), `bonne_reponse`
// l'index 0-based dans `choix`.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const QUIZ_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "quiz", "quiz.json");

// Construction paresseuse (pas au chargement du module) — voir tamagotchi.js
// pour la raison exacte (ordre des imports ES vs dotenv.config()).
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

// Avec automaticDeserialization désactivée, HGETALL renvoie un tableau plat
// [champ1, valeur1, ...] et non un objet.
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

const STATE_KEY = "quiz:state";
const MANCHE_SEQ_KEY = "quiz:manche_seq";
const THEME_CURSOR_KEY = "quiz:theme_cursor";
const MANCHES_KEY = "quiz:manches";

function votesKey(manche, jour) {
  return `quiz:votes:${manche}:${jour}`;
}

function voteUsernamesKey(manche, jour) {
  return `quiz:vote_usernames:${manche}:${jour}`;
}

// ── Lecture du contenu (statique, jamais muté) ────────────────────

let quizConfigCache = null;

export async function loadQuizConfig() {
  if (quizConfigCache) return quizConfigCache;
  const txt = await fs.readFile(QUIZ_JSON_PATH, "utf-8");
  quizConfigCache = JSON.parse(txt);
  return quizConfigCache;
}

// ── État de la manche active ──────────────────────────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// ── Sélection de la thématique ─────────────────────────────────────
// Cycle séquentiel (jamais aléatoire), même logique que pickNextAnagramIndex
// dans anagrams.js — ne rejoue jamais deux fois la même manche de suite.

export function pickNextMancheIndex(previousIndex, totalManches) {
  return ((previousIndex ?? -1) + 1) % totalManches;
}

export async function getThemeCursor() {
  const raw = await getRedis().get(THEME_CURSOR_KEY);
  return raw == null ? null : Number(raw);
}

export async function setThemeCursor(index) {
  await getRedis().set(THEME_CURSOR_KEY, String(index));
}

// ── Numéro d'instance de manche ────────────────────────────────────
// Attribué une seule fois, au démarrage réel du Jour 1 (pas à la clôture) :
// Quiz a besoin d'un identifiant de manche stable dès le premier jour pour
// namespacer les votes des 7 jours suivants.

export async function nextMancheSeq() {
  return Number(await getRedis().incr(MANCHE_SEQ_KEY));
}

// Lecture seule (pour le dry-run) — ne consomme pas le compteur.
export async function previewNextMancheSeq() {
  const current = Number(await getRedis().get(MANCHE_SEQ_KEY)) || 0;
  return current + 1;
}

// ── Votes ──────────────────────────────────────────────────────────
// Comme Tamagotchi : le vote n'est PAS modifiable une fois posé. Revoter le
// MÊME choix est un no-op idempotent ("already_recorded"), voter un choix
// DIFFÉRENT est rejeté sans écriture ("rejected"). Le pseudo est stocké à
// part, uniquement pour l'affichage admin (quizStatus.js), jamais utilisé
// pour la logique de vote elle-même.

export async function recordVote(manche, jour, discordId, choiceIndex, username) {
  const key = votesKey(manche, jour);
  const existing = await getRedis().hget(key, discordId);
  const choice = String(choiceIndex);
  if (existing == null) {
    await getRedis().hset(key, { [discordId]: choice });
    if (username) {
      await getRedis().hset(voteUsernamesKey(manche, jour), { [discordId]: username });
    }
    return { status: "recorded" };
  }
  if (existing === choice) {
    return { status: "already_recorded" };
  }
  return { status: "rejected", existing };
}

// Détail brut des votants d'un jour — utilisé uniquement par
// scripts/quizStatus.js (qui ne doit afficher QUE la participation, jamais
// le contenu du vote lui-même avant la révélation).
export async function listVotes(manche, jour) {
  const [votes, usernames] = await Promise.all([
    hgetallRaw(votesKey(manche, jour)),
    hgetallRaw(voteUsernamesKey(manche, jour)),
  ]);
  return Object.entries(votes).map(([discordId, choiceIndex]) => ({
    discordId,
    choiceIndex: Number(choiceIndex),
    username: usernames[discordId] || null,
  }));
}

// ── Scoring ────────────────────────────────────────────────────────
// Calculable à tout moment, y compris en cours de manche (usage admin
// uniquement via `quiz:scores` — les joueurs ne voient jamais ce classement
// avant la révélation du Jour 7).

export async function computeMancheRanking(manche, mancheConfig) {
  const scores = new Map(); // discordId -> { discordId, username, score }

  for (let jour = 1; jour <= mancheConfig.questions.length; jour++) {
    const question = mancheConfig.questions[jour - 1];
    const votes = await listVotes(manche, jour);
    for (const vote of votes) {
      const entry = scores.get(vote.discordId) || {
        discordId: vote.discordId,
        username: vote.username,
        score: 0,
      };
      if (vote.choiceIndex === question.bonne_reponse) {
        entry.score += 1;
      }
      entry.username = vote.username || entry.username;
      scores.set(vote.discordId, entry);
    }
  }

  return Array.from(scores.values()).sort((a, b) => b.score - a.score);
}

// ── Historique permanent des manches conclues en public ────────────
// HASH permanent, jamais nettoyé par un reset normal — comparable à
// MANCHES_KEY de tamagotchi.js, à ceci près que le numéro de manche est
// attribué au Jour 1 (nextMancheSeq), pas ici : archiveManche() ne fait donc
// pas d'INCR, contrairement à son équivalent Tamagotchi.

export async function archiveManche(record) {
  await getRedis().hset(MANCHES_KEY, { [record.manche]: toJson(record) });
}

// Trié de la manche la plus récente à la plus ancienne.
export async function listManches({ limit = 10 } = {}) {
  const all = await hgetallJson(MANCHES_KEY);
  return Object.values(all)
    .sort((a, b) => b.manche - a.manche)
    .slice(0, limit);
}

// ── Remise à zéro ────────────────────────────────────────────────────
// `clearManches: false` par défaut — l'archive des manches passées survit à
// un reset normal ; seul --manches (voir scripts/resetQuiz.js) l'efface,
// utile en phase de test pour ne pas polluer l'archive avec des manches de
// test avant le vrai lancement public.

export async function resetQuiz({ clearManches = false } = {}) {
  await getRedis().del(STATE_KEY);
  await scanDelete("quiz:votes:*");
  await scanDelete("quiz:vote_usernames:*");
  if (clearManches) {
    await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY, THEME_CURSOR_KEY);
  }
}
