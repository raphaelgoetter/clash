// ============================================================
// triviaEngine.js — Moteur commun des QCM « Trivia » (4 propositions
// A/B/C/D, essai unique verrouillé par HSETNX, barème plat 1 pt/0 pt).
// Couche métier : état Redis, tirage, scoring, classements, erratum.
// Instancié par trivia.js (culture Clash Royale) et triviageek.js (Trivia
// Geek, refonte hors Clash Royale) : chaque instance a son préfixe Redis,
// son catalogue et son jour de publication, jamais de données partagées.
//
// Catalogue : tableau JSON où chaque question a 4 `choices`, la bonne
// réponse marquée par un suffixe " √". parseTriviaEntry() normalise chaque
// entrée en { id, titre, question, options, source, erratum }, où
// options[0] est TOUJOURS la bonne réponse — l'ordre affiché aux joueurs est
// mélangé PAR MANCHE, jamais ici. Le catalogue est parcouru dans son ORDRE
// D'ORIGINE, en boucle (l'ordre du fichier est volontaire).
//
// id = index dans le tableau JSON, zero-paddé (q000, q001...) — stable tant
// que le fichier n'est pas réordonné/élagué : on n'ajoute qu'en fin.
// ============================================================

import fs from "fs/promises";
import { Redis } from "@upstash/redis";
import { countRemainingWeekdayOccurrences, getCurrentSeasonId } from "./saison.js";

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

function shuffle(array) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// ── Fonctions pures (communes à toutes les instances) ──────────────

export function parseTriviaEntry(raw, index) {
  const id = `q${String(index).padStart(3, "0")}`;
  const correctIdx = raw.choices.findIndex((c) => /√\s*$/.test(c));
  const clean = raw.choices.map((c) => c.replace(/\s*√\s*$/, "").trim());
  const options = [clean[correctIdx], ...clean.filter((_, i) => i !== correctIdx)];
  return {
    id,
    titre: raw.titre ?? null,
    question: raw.question,
    options,
    source: raw.source ?? null,
    erratum: raw.erratum ?? null,
  };
}

export function resolveTriviaEntry(catalog, gameId) {
  return catalog.find((e) => e.id === gameId) ?? null;
}

// Avance d'une position dans le catalogue et boucle une fois épuisé (même
// pattern que pickNextFrameIndex).
export function pickNextTriviaIndex(state, catalog) {
  const prevIndex = state?.currentIndex ?? -1;
  return (prevIndex + 1) % catalog.length;
}

// order[i] = index dans entry.options affiché à la lettre LETTERS[i] ;
// options[0] est toujours la bonne réponse (voir parseTriviaEntry).
export function checkAnswer(order, letter) {
  const idx = LETTERS.indexOf(letter);
  return idx !== -1 && order[idx] === 0;
}

export function getCorrectLetter(order) {
  return LETTERS[order.indexOf(0)];
}

// Barème volontairement plat : 1 pt par bonne réponse, 0 sinon — un seul
// clic verrouille tout, correct ou non.
export function computeScore(correct) {
  return correct ? 1 : 0;
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

const ROUND_LABEL_MAX_LENGTH = 80;

// ── Instance ─────────────────────────────────────────────────────────
// prefix : préfixe des clés Redis (`<prefix>:state`, `<prefix>:archived:*`…)
// catalogPath : chemin absolu du catalogue JSON
// weekday : jour UTC de publication (0 = dimanche), pour le total de manches
export function createTriviaService({ prefix, catalogPath, weekday }) {
  const STATE_KEY = `${prefix}:state`;
  const orderKey = (gameId) => `${prefix}:order:${gameId}`;
  const participantsKey = (gameId) => `${prefix}:participants:${gameId}`;
  const seasonMancheSeqKey = (seasonId) => `${prefix}:season:${seasonId}:manche_seq`;
  const seasonMancheNumbersKey = (seasonId) => `${prefix}:season:${seasonId}:manche_numbers`;
  const seasonKey = (seasonId) => `${prefix}:season:${seasonId}`;
  const seasonPseudosKey = (seasonId) => `${prefix}:season:${seasonId}:pseudos`;
  const archivedKey = (seasonId) => `${prefix}:archived:${seasonId}`;
  const erratumPostedKey = (gameId) => `${prefix}:erratum_posted:${gameId}`;

  // ── Catalogue (statique, jamais muté) ──────────────────────────────
  let catalogCache = null;

  async function loadTriviaCatalog() {
    if (catalogCache) return catalogCache;
    const txt = await fs.readFile(catalogPath, "utf-8");
    catalogCache = JSON.parse(txt).map(parseTriviaEntry);
    return catalogCache;
  }

  // ── État de la partie en cours (métadonnées uniquement) ────────────
  async function readState() {
    return fromJson(await getRedis().get(STATE_KEY));
  }

  async function writeState(state) {
    await getRedis().set(STATE_KEY, toJson(state));
  }

  // Remet le jeu à zéro : plus de manche active (la prochaine repart à
  // l'index 0 du catalogue), participants, numérotation de saison et
  // archives effacés.
  async function resetGame() {
    await getRedis().del(STATE_KEY);
    await scanDelete(`${prefix}:participants:*`);
    await scanDelete(`${prefix}:season:*`);
    await scanDelete(`${prefix}:archived:*`);
    await scanDelete(`${prefix}:erratum_posted:*`);
  }

  // ── Garde-fou anti-double-post (même jour UTC que la manche en cours) ─
  async function alreadyPostedThisWeek(now = new Date()) {
    const state = await readState();
    if (!state?.startedAt) return false;
    return new Date(state.startedAt).toISOString().slice(0, 10) === now.toISOString().slice(0, 10);
  }

  // ── Numérotation de manche, scopée à la saison ─────────────────────
  // Même mécanique que Palette/Zoom, pour un affichage « Saison X ·
  // Manche X/Y » identique aux autres jeux. Le total Y se projette sur les
  // occurrences restantes du jour de publication dans la saison.
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

  function computeSeasonMancheTotal(seasonManche, now = new Date()) {
    return seasonManche + countRemainingWeekdayOccurrences(now, weekday);
  }

  async function previewSeasonManche(seasonId) {
    const seq = Number(await getRedis().get(seasonMancheSeqKey(seasonId))) || 0;
    return seq + 1;
  }

  async function getSeasonManches(seasonId) {
    const ids = await getRedis().hkeys(seasonMancheNumbersKey(seasonId));
    return ids || [];
  }

  async function getSeasonMancheNumber(seasonId, gameId) {
    const raw = await getRedis().hget(seasonMancheNumbersKey(seasonId), gameId);
    return raw == null ? null : Number(raw);
  }

  // Intitulé (question tronquée) d'une manche — pour le récap de fin de
  // saison (liste des manches jouées).
  async function getTriviaRoundLabel(gameId) {
    const entry = resolveTriviaEntry(await loadTriviaCatalog(), gameId);
    if (!entry) return null;
    return entry.question.length > ROUND_LABEL_MAX_LENGTH
      ? `${entry.question.slice(0, ROUND_LABEL_MAX_LENGTH - 1)}…`
      : entry.question;
  }

  // ── Sélection + démarrage d'une manche ─────────────────────────────
  async function startNewGame(channelId) {
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
    // Permanent : jamais réécrit ensuite, sert aussi de registre
    // anti-spoiler (voir isGamePosted).
    await getRedis().set(orderKey(gameId), toJson(optionOrder));

    return { state: newState, entry, order: optionOrder };
  }

  // Un gameId n'a d'ordre d'options que s'il a réellement été posté.
  async function isGamePosted(gameId) {
    return (await getRedis().exists(orderKey(gameId))) === 1;
  }

  async function readRoundOrder(gameId) {
    return fromJson(await getRedis().get(orderKey(gameId)));
  }

  // ── Réponse à essai unique (HSETNX : chaque clic est définitif) ─────
  async function readParticipant(gameId, discordId) {
    return fromJson(await getRedis().hget(participantsKey(gameId), discordId));
  }

  async function recordAnswer(gameId, discordId, username, letter, correct, score) {
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

  // ── Résultats archivés (classement de la saison) ───────────────────
  // Archive TOUS les participants d'une manche (correct ou non) : un essai
  // unique reste une participation valide pour le récap de fin de saison.
  async function archiveAnswer(state, entry, discordId, username, score, answeredAt) {
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

  async function getPlayerSeasonResults(seasonId, discordId) {
    const all = await hgetallJson(archivedKey(seasonId));
    return Object.entries(all)
      .filter(([field]) => field.endsWith(`:${discordId}`))
      .map(([, result]) => result);
  }

  async function getGameParticipants(gameId) {
    return Object.values(await hgetallJson(participantsKey(gameId)));
  }

  async function computeSeasonRanking(seasonId) {
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

  // Tous les résultats archivés, toutes saisons confondues — pour
  // miniJeuxHistory.js et miniJeuxStats.js.
  async function getAllArchivedResults() {
    const keys = await scanKeys(`${prefix}:archived:*`);
    if (keys.length === 0) return [];
    const hashes = await Promise.all(keys.map((key) => hgetallJson(key)));
    return hashes.flatMap((hash) => Object.values(hash));
  }

  // ── Erratum : point offert à tous les participants d'une manche ─────
  // Pour une question dont la « bonne » réponse s'avère fausse après coup
  // (champ `erratum` du catalogue) : chaque participant archivé de la
  // manche passe à 1 pt. Idempotent : un résultat déjà marqué `erratum`
  // n'est plus touché. Renvoie le nombre total de participants.
  async function grantErratumPoint(gameId, correctedAnswer) {
    const keys = await scanKeys(`${prefix}:archived:*`);
    let participantCount = 0;

    for (const key of keys) {
      const archived = await hgetallJson(key);
      for (const [field, result] of Object.entries(archived)) {
        if (!result || result.gameId !== gameId) continue;
        participantCount++;
        if (result.erratum) continue;

        const updated = { ...result, score: 1, answer: correctedAnswer, erratum: true };
        await getRedis().hset(key, { [field]: toJson(updated) });
        if (!(result.score > 0)) await getRedis().zincrby(seasonKey(result.seasonId), 1, result.discordId);

        const participant = await readParticipant(gameId, result.discordId);
        if (participant) {
          await getRedis().hset(participantsKey(gameId), {
            [result.discordId]: toJson({ ...participant, score: 1, erratum: true }),
          });
        }
      }
    }
    return participantCount;
  }

  // Verrou anti-double-post du message d'erratum (SET NX, permanent) —
  // libéré si l'envoi Discord échoue, pour retenter au passage suivant.
  async function claimErratumAnnouncement(gameId) {
    return (await getRedis().set(erratumPostedKey(gameId), "1", { nx: true })) === "OK";
  }

  async function releaseErratumAnnouncement(gameId) {
    await getRedis().del(erratumPostedKey(gameId));
  }

  return {
    LETTERS,
    loadTriviaCatalog,
    resolveTriviaEntry,
    readState,
    writeState,
    resetGame,
    getCurrentSeasonId,
    pickNextTriviaIndex,
    alreadyPostedThisWeek,
    computeSeasonMancheTotal,
    previewSeasonManche,
    getSeasonManches,
    getSeasonMancheNumber,
    getTriviaRoundLabel,
    startNewGame,
    isGamePosted,
    readRoundOrder,
    checkAnswer,
    getCorrectLetter,
    computeScore,
    readParticipant,
    recordAnswer,
    archiveAnswer,
    getPlayerSeasonResults,
    getGameParticipants,
    computeSeasonRanking,
    getAllArchivedResults,
    grantErratumPoint,
    claimErratumAnnouncement,
    releaseErratumAnnouncement,
    findRank,
    findTiedRank,
  };
}
