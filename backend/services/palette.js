// ============================================================
// palette.js — Jeu "Palette" (devine la couleur dominante d'une carte parmi
// 4 propositions A/B/C/D), en alternance une saison Clash Royale sur deux
// avec Zoom carte sous le nom collectif "Jeux visuels" (voir
// backend/services/jeuxvisuels.js) — validé après une phase de test.
// Couche métier : état Redis, tirage, scoring, classements. Miroir
// structurel de zoom.js (client Redis paresseux, mêmes pièges —
// automaticDeserialization/HGETALL — voir les commentaires détaillés dans
// frames.js) — mais SANS Modal ni indice, remplacés par un QCM à essai
// unique dont le mécanisme d'interaction (bouton → ACK éphémère immédiat,
// jamais de formulaire) suit plutôt quiz.js. Contrairement à Zoom, aucune
// logique de récap de saison interne (voir postSeasonRecap dans
// _handlers/palette.js, appelée uniquement par l'orchestrateur
// scripts/postJeuxVisuels.js) — même position que Pêle-mêle avant son
// unification avec Anagram (5473d39a).
//
// Deux écarts par rapport à Zoom, documentés ici :
//
// 1. data/palette/palette.json N'EST PAS mélangé (contrairement à
//    zoom.json, mélangé une fois pour toutes par generateZoomCatalog.js) —
//    il est trié dans l'ordre quasi alphabétique de data/cardNames.json.
//    Plutôt que de toucher à generatePaletteCatalog.js, l'ordre de tirage
//    est maintenu ici, côté Redis : palette:play_order (liste des ids
//    playable, mélangée une fois puis persistante). Un ordre alphabétique
//    aurait rendu le jeu totalement prévisible — même piège déjà documenté
//    pour zoom.json.
//
// 2. L'ordre A/B/C/D des 4 couleurs proposées est mélangé une seule fois
//    PAR MANCHE (Fisher-Yates), à startNewGame(), et persisté dans
//    palette:order:<gameId> — jamais recalculé, sinon une image réaffichée
//    par Discord (re-fetch d'URL) ou un ancien message encore visible
//    changerait d'ordre en cours de manche. Cette clé sert aussi de
//    registre anti-spoiler (isGamePosted), à la place du SET posted_games
//    de Zoom (un seul JSON par gameId suffit, pas besoin d'un SET séparé).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { fetchRaceLog, fetchCurrentRace } from "./clashApi.js";
import { computeCurrentSeasonId, countRemainingWeekdayOccurrences } from "./dateUtils.js";
import { FAMILY_CLAN_TAGS } from "./warHistory.js";
import { getOrSet } from "./cache.js";

const FRIDAY = 5; // même jour de référence que Zoom carte (destiné à alterner avec lui)

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const PALETTE_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "jeux-visuels", "palette", "palette.json");

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

const STATE_KEY = "palette:state";
const PLAY_ORDER_KEY = "palette:play_order";

function orderKey(gameId) {
  return `palette:order:${gameId}`;
}
function participantsKey(gameId) {
  return `palette:participants:${gameId}`;
}
function seasonMancheSeqKey(seasonId) {
  return `palette:season:${seasonId}:manche_seq`;
}
function seasonMancheNumbersKey(seasonId) {
  return `palette:season:${seasonId}:manche_numbers`;
}
function seasonKey(seasonId) {
  return `palette:season:${seasonId}`;
}
function seasonPseudosKey(seasonId) {
  return `palette:season:${seasonId}:pseudos`;
}
function archivedKey(seasonId) {
  return `palette:archived:${seasonId}`;
}

// ── Lecture du catalogue (statique, jamais muté) ──────────────────

let paletteCatalogCache = null;

export async function loadPaletteCatalog() {
  if (paletteCatalogCache) return paletteCatalogCache;
  const txt = await fs.readFile(PALETTE_JSON_PATH, "utf-8");
  paletteCatalogCache = JSON.parse(txt);
  return paletteCatalogCache;
}

export function resolvePaletteEntry(catalog, gameId) {
  return catalog.find((e) => e.id === gameId) ?? null;
}

// ── État de la partie en cours (métadonnées uniquement) ──────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

// Remet le jeu à zéro : plus de manche active, participants, numérotation de
// saison et archives effacés (comme resetGame() de Zoom). palette:order:*/
// palette:play_order NE SONT PAS touchés — une nouvelle manche repart
// simplement au tirage suivant de l'ordre courant, comme Zoom ne remet
// jamais à zéro zoom:posted_games ni l'ordre du fichier zoom.json.
export async function resetGame() {
  await getRedis().del(STATE_KEY);
  await scanDelete("palette:participants:*");
  await scanDelete("palette:season:*");
  await scanDelete("palette:archived:*");
}

// ── Saison Clash Royale en cours ────────────────────────────────
// Dupliquée à l'identique depuis zoom.js/frames.js (seule la clé de cache
// change) — convention du repo, pas de valeur à extraire tant que ça reste
// quelques copies quasi identiques.
export async function getCurrentSeasonId() {
  const { value } = await getOrSet(
    "palette:seasonId",
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

// ── Ordre de tirage des cartes jouables (mélangé une fois, persistant) ──

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

async function getOrInitPlayOrder(playableIds) {
  const existing = fromJson(await getRedis().get(PLAY_ORDER_KEY)) ?? [];
  const stillPlayable = new Set(playableIds);
  // Retire les ids qui ne sont plus jouables (override manuel, carte
  // retirée du catalogue) sans perturber l'ordre des ids restants.
  const order = existing.filter((id) => stillPlayable.has(id));

  const known = new Set(order);
  const newIds = playableIds.filter((id) => !known.has(id));
  // Insertion une par une à une position aléatoire — jamais en bloc en fin
  // de liste, sinon les cartes ajoutées lors d'une régénération future
  // seraient groupées et donc prévisibles après quelques semaines (même
  // piège documenté pour zoom.json).
  for (const id of shuffle(newIds)) {
    order.splice(Math.floor(Math.random() * (order.length + 1)), 0, id);
  }

  if (order.length !== existing.length || newIds.length > 0) {
    await getRedis().set(PLAY_ORDER_KEY, toJson(order));
  }
  return order;
}

// Même pattern que pickNextZoomIndex : avance d'une position dans l'ordre
// de tirage et boucle une fois épuisé.
export function pickNextPaletteIndex(state, order) {
  const prevIndex = state?.gameId ? order.findIndex((id) => id === state.gameId) : -1;
  return (prevIndex + 1) % order.length;
}

// ── Garde-fou anti-double-post ────────────────────────────────────
// Comparaison calendaire identique à Zoom (même créneau vendredi, même
// orchestrateur potentiel scripts/postJeuxVisuels.js) : GitHub Actions peut
// retarder significativement un cron planifié — si on relance postPalette()
// à la main pour rattraper un créneau manqué, il faut éviter qu'un run
// planifié arrivant en retard le même jour ne fasse avancer la manche une
// seconde fois.
function todayUtcDateString(date) {
  return date.toISOString().slice(0, 10);
}

export async function alreadyPostedThisWeek(now = new Date()) {
  const state = await readState();
  if (!state?.startedAt) return false;
  return todayUtcDateString(new Date(state.startedAt)) === todayUtcDateString(now);
}

// ── Numérotation de manche, scopée à la saison CR ──────────────────
// Même mécanique que Zoom (assignSeasonMancheNumber/computeSeasonMancheTotal)
// pour un affichage "Saison X · Manche X/Y" identique aux autres jeux —
// dupliquée plutôt qu'importée de zoom.js (convention du repo). Le total Y
// se projette sur les vendredis restants de la saison — même créneau que
// Zoom, avec lequel Palette alterne une saison sur deux (voir
// backend/services/jeuxvisuels.js).

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

function countRemainingFridays(now = new Date()) {
  return countRemainingWeekdayOccurrences(now, FRIDAY);
}
export function computeSeasonMancheTotal(seasonManche, now = new Date()) {
  return seasonManche + countRemainingFridays(now);
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

// Nom français de la carte d'une manche donnée — pour le récap de fin de
// saison (liste des manches jouées), comme getZoomRoundLabel dans zoom.js.
export async function getPaletteRoundLabel(gameId) {
  const catalog = await loadPaletteCatalog();
  const entry = resolvePaletteEntry(catalog, gameId);
  return entry?.fr ?? null;
}

// ── Sélection + démarrage d'une manche ────────────────────────────

export async function startNewGame(channelId) {
  const catalog = await loadPaletteCatalog();
  const playable = catalog.filter((e) => e.playable);
  const order = await getOrInitPlayOrder(playable.map((e) => e.id));

  const previousState = await readState();
  const nextIndex = pickNextPaletteIndex(previousState, order);
  const gameId = order[nextIndex];
  const entry = resolvePaletteEntry(catalog, gameId);

  const seasonId = await getCurrentSeasonId();
  const now = new Date();
  const seasonManche = await assignSeasonMancheNumber(seasonId, gameId);
  const seasonMancheTotal = computeSeasonMancheTotal(seasonManche, now);
  const letterOrder = shuffle([0, 1, 2, 3]);

  const newState = {
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
  await getRedis().set(orderKey(gameId), toJson(letterOrder));

  return { state: newState, entry, order: letterOrder };
}

// Garde-fou anti-spoiler pour backend/services/paletteImage.js — un gameId
// n'a de masque de couleurs que s'il a réellement été posté un jour.
export async function isGamePosted(gameId) {
  return (await getRedis().exists(orderKey(gameId))) === 1;
}

export async function readRoundOrder(gameId) {
  return fromJson(await getRedis().get(orderKey(gameId)));
}

// ── Vérification de réponse + scoring ─────────────────────────────
// order[i] = index dans entry.colors affiché à la lettre LETTERS[i].
// entry.colors est trié par share décroissant (generatePaletteCatalog.js),
// donc colors[0] = la couleur dominante = la bonne réponse.

export function checkAnswer(order, letter) {
  const idx = LETTERS.indexOf(letter);
  return idx !== -1 && order[idx] === 0;
}

export function getCorrectLetter(order) {
  return LETTERS[order.indexOf(0)];
}

// Barème volontairement plat (pas de bonus de rapidité ni de pénalité de
// tentative comme Zoom) : un seul clic verrouille tout, correct ou non — il
// n'y a jamais de "tentative incorrecte suivie d'une autre" à pénaliser, et
// Raphael a préféré la simplicité à un calcul de rapidité après le 1er test.
export function computeScore(correct) {
  return correct ? 1 : 0;
}

// ── Réponse à essai unique ─────────────────────────────────────────
// Verrou atomique (HSETNX), pas une lecture-puis-écriture comme markSolved()
// de Zoom : chaque clic est définitif ici, correct ou non, un double-clic
// quasi simultané (double-tap mobile, lag réseau) doit rester sûr.

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
// Miroir de archiveSolve() dans zoom.js. Contrairement à Zoom (qui n'archive
// que les réponses CORRECTES, "solved"), Palette archive TOUS les
// participants d'une manche — un essai unique, correct ou non, reste une
// participation valide à comptabiliser. Un score de 0 (mauvaise réponse)
// n'affecte pas le classement (ZINCRBY 0) mais laisse une trace de
// participation pour le récap de fin de saison.

export async function archiveAnswer(state, entry, discordId, username, score, answeredAt) {
  const archKey = archivedKey(state.seasonId);
  const field = `${state.gameId}:${discordId}`;

  const result = {
    gameId: state.gameId,
    seasonId: state.seasonId,
    cardKey: entry.cardKey,
    answer: entry.fr,
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
// /palette (scores personnels), comme getPlayerSeasonResults dans zoom.js.
export async function getPlayerSeasonResults(seasonId, discordId) {
  const all = await hgetallJson(archivedKey(seasonId));
  return Object.entries(all)
    .filter(([field]) => field.endsWith(`:${discordId}`))
    .map(([, result]) => result);
}

// Tous les participants d'une manche (correct ou non) — contrairement à
// computeGameRanking de Zoom (qui ne renvoie que les "solved"), Palette n'a
// pas cette distinction : chaque participant a répondu une fois, point final.
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
// miniJeuxHistory.js (entrée fusionnée "visuels" avec Zoom).
export async function getAllArchivedResults() {
  const keys = await scanKeys("palette:archived:*");
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
