// ============================================================
// trivia.js — Jeu "Trivia" (QCM de culture Clash Royale, 4 propositions
// A/B/C/D), en alternance une saison Clash Royale sur deux avec Frame
// ("Devine le film") sous le nom collectif "Mini-jeux de Culture" (voir
// backend/services/jeuxculture.js). Couche métier : état Redis, tirage,
// scoring, classements. Miroir structurel de palette.js (client Redis
// paresseux, QCM à essai unique verrouillé par HSETNX, barème plat 1pt/0pt)
// — mêmes pièges détaillés dans les commentaires de frames.js
// (automaticDeserialization/HGETALL).
//
// data/triviaclash/trivia-clash.json est déjà prêt (pas de script de
// génération de catalogue séparé, contrairement à palette.json/zoom.json) :
// chaque question a 4 `choices`, la bonne réponse marquée par un suffixe
// " √". loadTriviaCatalog() normalise chaque entrée en { id, question,
// options, source }, où options[0] est TOUJOURS la bonne réponse (même
// convention que entry.colors[0] = couleur dominante dans palette.js) —
// l'ordre affiché aux joueurs est ensuite mélangé PAR MANCHE, jamais ici.
//
// Écart volontaire par rapport à Palette pour le TIRAGE des questions (pas
// pour les réponses) : Palette mélange une fois pour toutes l'ordre de son
// catalogue (getOrInitPlayOrder) ; Trivia parcourt trivia-clash.json dans
// son ORDRE D'ORIGINE, en boucle, comme frames.js (pickNextFrameIndex) —
// demande explicite, l'ordre du fichier est déjà volontaire.
//
// id = index dans le tableau JSON, zero-paddé (q000, q001...) — stable tant
// que le fichier n'est pas réordonné/élagué, même limite assumée que les
// autres catalogues statiques (frames.json, cardNames.json...).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { fetchRaceLog, fetchCurrentRace } from "./clashApi.js";
import { computeCurrentSeasonId, countRemainingWeekdayOccurrences } from "./dateUtils.js";
import { FAMILY_CLAN_TAGS } from "./warHistory.js";
import { getOrSet } from "./cache.js";

const WEDNESDAY = 3; // même jour de référence que Frame (destiné à alterner avec lui)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TRIVIA_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "triviaclash", "trivia-clash.json");

export const LETTERS = ["A", "B", "C", "D"];

// Construction paresseuse (pas au chargement du module) — voir frames.js
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
// [champ1, valeur1, ...] et non un objet — voir frames.js.
function pairsToObject(flat) {
  const obj = {};
  for (let i = 0; i < flat.length; i += 2) {
    obj[flat[i]] = flat[i + 1];
  }
  return obj;
}

async function hgetallJson(key) {
  const flat = (await getRedis().hgetall(key)) || [];
  const raw = pairsToObject(flat);
  const result = {};
  for (const [field, value] of Object.entries(raw)) {
    result[field] = fromJson(value);
  }
  return result;
}

async function hgetallRaw(key) {
  return pairsToObject((await getRedis().hgetall(key)) || []);
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

const STATE_KEY = "trivia:state";

function orderKey(gameId) {
  return `trivia:order:${gameId}`;
}
function participantsKey(gameId) {
  return `trivia:participants:${gameId}`;
}
function seasonMancheSeqKey(seasonId) {
  return `trivia:season:${seasonId}:manche_seq`;
}
function seasonMancheNumbersKey(seasonId) {
  return `trivia:season:${seasonId}:manche_numbers`;
}
function seasonKey(seasonId) {
  return `trivia:season:${seasonId}`;
}
function seasonPseudosKey(seasonId) {
  return `trivia:season:${seasonId}:pseudos`;
}
function archivedKey(seasonId) {
  return `trivia:archived:${seasonId}`;
}

// ── Lecture du catalogue (statique, jamais muté) ──────────────────

function parseTriviaEntry(raw, index) {
  const id = `q${String(index).padStart(3, "0")}`;
  const correctIdx = raw.choices.findIndex((c) => /√\s*$/.test(c));
  const clean = raw.choices.map((c) => c.replace(/\s*√\s*$/, "").trim());
  const options = [clean[correctIdx], ...clean.filter((_, i) => i !== correctIdx)];
  return { id, question: raw.question, options, source: raw.source ?? null };
}

let triviaCatalogCache = null;

export async function loadTriviaCatalog() {
  if (triviaCatalogCache) return triviaCatalogCache;
  const txt = await fs.readFile(TRIVIA_JSON_PATH, "utf-8");
  const all = JSON.parse(txt);
  triviaCatalogCache = all.map(parseTriviaEntry);
  return triviaCatalogCache;
}

export function resolveTriviaEntry(catalog, gameId) {
  return catalog.find((e) => e.id === gameId) ?? null;
}

// ── État de la partie en cours (métadonnées uniquement) ──────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// Remet le jeu à zéro : plus de manche active (la prochaine repart à
// l'index 0 de trivia-clash.json, comme resetGame() de Frame), participants,
// numérotation de saison et archives effacés.
export async function resetGame() {
  await getRedis().del(STATE_KEY);
  await scanDelete("trivia:participants:*");
  await scanDelete("trivia:season:*");
  await scanDelete("trivia:archived:*");
}

// ── Saison Clash Royale en cours ────────────────────────────────
// Dupliquée à l'identique depuis palette.js/frames.js (seule la clé de cache
// change) — convention du repo, pas de valeur à extraire tant que ça reste
// quelques copies quasi identiques.
export async function getCurrentSeasonId() {
  const { value } = await getOrSet(
    "trivia:seasonId",
    async () => {
      const clanTag = FAMILY_CLAN_TAGS[0];
      for (const delay of [0, 1000, 3000]) {
        if (delay) await new Promise((r) => setTimeout(r, delay));
        const raceLog = await fetchRaceLog(clanTag).catch(() => null);
        const currentRace = await fetchCurrentRace(clanTag).catch(() => null);
        const seasonId = computeCurrentSeasonId(currentRace, raceLog);
        if (seasonId != null) return seasonId;
      }
      return null;
    },
    15 * 60 * 1000,
  );
  return value;
}

// ── Ordre de tirage des questions ──────────────────────────────────
// Contrairement à Palette/Zoom (ordre mélangé une fois puis persistant),
// Trivia parcourt le fichier data/triviaclash/trivia-clash.json dans son
// ORDRE D'ORIGINE, en boucle — même principe que pickNextFrameIndex
// (frames.js) : demande explicite (l'ordre du fichier est déjà volontaire,
// pas à randomiser). Seul l'ordre des 4 PROPOSITIONS affichées est mélangé,
// voir plus bas (option shuffle par manche).

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Même pattern que pickNextFrameIndex : avance d'une position dans le
// catalogue et boucle une fois épuisé.
export function pickNextTriviaIndex(state, catalog) {
  const prevIndex = state?.currentIndex ?? -1;
  return (prevIndex + 1) % catalog.length;
}

// ── Garde-fou anti-double-post ────────────────────────────────────
// Comparaison calendaire identique à Palette (même créneau mercredi, même
// orchestrateur potentiel scripts/postJeuxCulture.js).
function todayUtcDateString(date) {
  return date.toISOString().slice(0, 10);
}

export async function alreadyPostedThisWeek(now = new Date()) {
  const state = await readState();
  if (!state?.startedAt) return false;
  return todayUtcDateString(new Date(state.startedAt)) === todayUtcDateString(now);
}

// ── Numérotation de manche, scopée à la saison CR ──────────────────
// Même mécanique que Palette/Zoom (assignSeasonMancheNumber/
// computeSeasonMancheTotal) pour un affichage "Saison X · Manche X/Y"
// identique aux autres jeux — dupliquée plutôt qu'importée (convention du
// repo). Le total Y se projette sur les mercredis restants de la saison —
// même créneau que Frame, avec lequel Trivia alterne une saison sur deux
// (voir backend/services/jeuxculture.js).

async function assignSeasonMancheNumber(seasonId, gameId) {
  const numbersKey = seasonMancheNumbersKey(seasonId);
  const existing = await getRedis().hget(numbersKey, gameId);
  if (existing != null) return Number(existing);

  const seasonManche = Number(await getRedis().incr(seasonMancheSeqKey(seasonId)));
  const wasSet = Number(await getRedis().hsetnx(numbersKey, gameId, String(seasonManche)));
  if (!wasSet) {
    return Number(await getRedis().hget(numbersKey, gameId));
  }
  return seasonManche;
}

function countRemainingWednesdays(now = new Date()) {
  return countRemainingWeekdayOccurrences(now, WEDNESDAY);
}
export function computeSeasonMancheTotal(seasonManche, now = new Date()) {
  return seasonManche + countRemainingWednesdays(now);
}

export async function previewSeasonManche(seasonId) {
  const seq = Number(await getRedis().get(seasonMancheSeqKey(seasonId))) || 0;
  return seq + 1;
}

export async function getSeasonManches(seasonId) {
  const ids = await getRedis().hkeys(seasonMancheNumbersKey(seasonId));
  return ids || [];
}

export async function getSeasonMancheNumber(seasonId, gameId) {
  const raw = await getRedis().hget(seasonMancheNumbersKey(seasonId), gameId);
  return raw == null ? null : Number(raw);
}

// Intitulé (question tronquée) d'une manche donnée — pour le récap de fin de
// saison (liste des manches jouées), comme getPaletteRoundLabel.
const ROUND_LABEL_MAX_LENGTH = 80;

export async function getTriviaRoundLabel(gameId) {
  const catalog = await loadTriviaCatalog();
  const entry = resolveTriviaEntry(catalog, gameId);
  if (!entry) return null;
  return entry.question.length > ROUND_LABEL_MAX_LENGTH
    ? `${entry.question.slice(0, ROUND_LABEL_MAX_LENGTH - 1)}…`
    : entry.question;
}

// ── Sélection + démarrage d'une manche ────────────────────────────

export async function startNewGame(channelId) {
  const catalog = await loadTriviaCatalog();
  const previousState = await readState();
  const currentIndex = pickNextTriviaIndex(previousState, catalog);
  const entry = catalog[currentIndex];
  const gameId = entry.id;

  const seasonId = await getCurrentSeasonId();
  const now = new Date();
  const seasonManche = await assignSeasonMancheNumber(seasonId, gameId);
  const seasonMancheTotal = computeSeasonMancheTotal(seasonManche, now);
  const optionOrder = shuffle([0, 1, 2, 3]);

  const newState = {
    currentIndex,
    gameId,
    seasonId,
    seasonManche,
    seasonMancheTotal,
    startedAt: now.toISOString(),
    channelId,
    messageId: null,
  };

  await writeState(newState);
  // Permanent : jamais réécrit ensuite, sert aussi de registre anti-spoiler
  // (voir isGamePosted ci-dessous).
  await getRedis().set(orderKey(gameId), toJson(optionOrder));

  return { state: newState, entry, order: optionOrder };
}

// Garde-fou anti-spoiler symétrique à isGamePosted de palette.js — un gameId
// n'a d'ordre d'options que s'il a réellement été posté un jour.
export async function isGamePosted(gameId) {
  return (await getRedis().exists(orderKey(gameId))) === 1;
}

export async function readRoundOrder(gameId) {
  return fromJson(await getRedis().get(orderKey(gameId)));
}

// ── Vérification de réponse + scoring ─────────────────────────────
// order[i] = index dans entry.options affiché à la lettre LETTERS[i].
// options[0] est toujours la bonne réponse (voir parseTriviaEntry), donc
// checkAnswer(order, letter) suit exactement la même logique que Palette.

export function checkAnswer(order, letter) {
  const idx = LETTERS.indexOf(letter);
  return idx !== -1 && order[idx] === 0;
}

export function getCorrectLetter(order) {
  return LETTERS[order.indexOf(0)];
}

// Barème volontairement plat (demandé explicitement : 1pt par bonne
// réponse, 0 sinon) — un seul clic verrouille tout, correct ou non.
export function computeScore(correct) {
  return correct ? 1 : 0;
}

// ── Réponse à essai unique ─────────────────────────────────────────
// Verrou atomique (HSETNX) : chaque clic est définitif, correct ou non — la
// garantie "impossible de changer sa réponse" demandée.

export async function readParticipant(gameId, discordId) {
  const raw = await getRedis().hget(participantsKey(gameId), discordId);
  return fromJson(raw);
}

export async function recordAnswer(gameId, discordId, username, letter, correct, score) {
  const participant = {
    discordId,
    username,
    letter,
    correct,
    score,
    answeredAt: new Date().toISOString(),
  };
  const wasSet = Number(
    await getRedis().hsetnx(participantsKey(gameId), discordId, toJson(participant)),
  );
  if (!wasSet) {
    return { participant: await readParticipant(gameId, discordId), alreadyAnswered: true };
  }
  return { participant, alreadyAnswered: false };
}

// ── Résultats archivés (classement de la saison) ─────────────────
// Miroir de archiveAnswer() dans palette.js : archive TOUS les participants
// d'une manche (correct ou non), un essai unique reste une participation
// valide à comptabiliser pour le récap de fin de saison.

export async function archiveAnswer(state, entry, discordId, username, score, answeredAt) {
  const archKey = archivedKey(state.seasonId);
  const field = `${state.gameId}:${discordId}`;

  const result = {
    gameId: state.gameId,
    seasonId: state.seasonId,
    question: entry.question,
    answer: entry.options[0],
    postedAt: state.startedAt,
    discordId,
    pseudo: username,
    score,
    solvedAt: answeredAt,
  };

  const wasSet = Number(await getRedis().hsetnx(archKey, field, toJson(result)));
  if (!wasSet) {
    return fromJson(await getRedis().hget(archKey, field)) ?? result; // déjà archivé par un appel concurrent
  }

  await getRedis().zincrby(seasonKey(state.seasonId), score, discordId);
  await getRedis().hset(seasonPseudosKey(state.seasonId), { [discordId]: username });
  return result;
}

// Résultats archivés d'un joueur pour une saison donnée — pour la commande
// /trivia (scores personnels), comme getPlayerSeasonResults dans palette.js.
export async function getPlayerSeasonResults(seasonId, discordId) {
  const all = await hgetallJson(archivedKey(seasonId));
  return Object.entries(all)
    .filter(([field]) => field.endsWith(`:${discordId}`))
    .map(([, result]) => result);
}

// Tous les participants d'une manche (correct ou non).
export async function getGameParticipants(gameId) {
  const all = await hgetallJson(participantsKey(gameId));
  return Object.values(all);
}

export async function computeSeasonRanking(seasonId) {
  const [flat, pseudos] = await Promise.all([
    getRedis().zrange(seasonKey(seasonId), 0, -1, { rev: true, withScores: true }),
    hgetallRaw(seasonPseudosKey(seasonId)),
  ]);
  const ranking = [];
  for (let i = 0; i < flat.length; i += 2) {
    const discordId = String(flat[i]);
    const totalScore = Number(flat[i + 1]);
    ranking.push({ discordId, pseudo: pseudos?.[discordId] || discordId, totalScore });
  }
  return ranking.sort((a, b) => b.totalScore - a.totalScore || a.pseudo.localeCompare(b.pseudo));
}

// Tous les résultats archivés, toutes saisons CR confondues — utilisé par
// miniJeuxHistory.js (entrée fusionnée "culture" avec Frame).
export async function getAllArchivedResults() {
  const keys = await scanKeys("trivia:archived:*");
  if (keys.length === 0) return [];
  const hashes = await Promise.all(keys.map((key) => hgetallJson(key)));
  return hashes.flatMap((hash) => Object.values(hash));
}

export function findRank(sortedList, discordId) {
  const idx = sortedList.findIndex((e) => e.discordId === discordId);
  return idx === -1 ? null : idx + 1;
}

export function findTiedRank(sortedList, discordId, scoreKey) {
  const entry = sortedList.find((e) => e.discordId === discordId);
  if (!entry) return null;
  const score = entry[scoreKey];
  return sortedList.filter((e) => e[scoreKey] > score).length + 1;
}
