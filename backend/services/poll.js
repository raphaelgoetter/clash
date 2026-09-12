// ============================================================
// poll.js — Sondage public (série de questions, chacune postée comme un
// sondage natif Discord distinct : question + réponses à choix discret,
// décompte et clôture gérés par Discord lui-même, aucune logique de vote à
// coder ici).
//
// Stockage : Upstash Redis (même instance que quiz.js/tamagotchi.js),
// espace de clés `poll:*` — uniquement la liste des messages déjà postés
// (channelId, messageId, id de question), pas les votes eux-mêmes (Discord
// les garde).
//
// Schéma de data/poll/poll.json : { questions: [
//   { id, type: "choice"|"note"|"freetext", question, answers?: [...],
//     allowMultiselect?, durationHours? } × N
// ] } — pour "note", les réponses "1".."5" sont générées automatiquement
// (pas de champ `answers`). "freetext" n'est pas un sondage natif (Discord
// ne permet pas de champ libre dans un poll) : posté comme un message avec
// un bouton "Proposer une idée" ouvrant une Modal, réponses stockées dans
// `poll:ideas` (voir addIdea/listIdeas).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const POLL_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "poll", "poll.json");

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

const STATE_KEY = "poll:state";

// ── Lecture du contenu (statique, jamais muté) ────────────────────

let pollConfigCache = null;

export async function loadPollConfig() {
  if (pollConfigCache) return pollConfigCache;
  const txt = await fs.readFile(POLL_JSON_PATH, "utf-8");
  pollConfigCache = JSON.parse(txt);
  return pollConfigCache;
}

// ── État du sondage actif ─────────────────────────────────────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

export async function clearState() {
  await getRedis().del(STATE_KEY);
}

// ── Idées de jeu soumises (question "freetext") ────────────────────

const IDEAS_KEY = "poll:ideas";

export async function addIdea(idea) {
  await getRedis().rpush(IDEAS_KEY, toJson(idea));
}

export async function listIdeas() {
  const raw = (await getRedis().lrange(IDEAS_KEY, 0, -1)) || [];
  return raw.map(fromJson).filter(Boolean);
}

export async function clearIdeas() {
  await getRedis().del(IDEAS_KEY);
}

const NOTE_ANSWERS = ["1", "2", "3", "4", "5"];

// Construit l'objet `poll` attendu par l'API Discord v10
// (POST /channels/{id}/messages, champ `poll`) à partir d'une question de
// data/poll/poll.json.
export function buildPollObject(questionConfig) {
  const answers =
    questionConfig.type === "note"
      ? NOTE_ANSWERS
      : questionConfig.answers;

  return {
    question: { text: questionConfig.question },
    answers: answers.map((text) => ({ poll_media: { text } })),
    duration: questionConfig.durationHours ?? 168,
    allow_multiselect: !!questionConfig.allowMultiselect,
    layout_type: 1,
  };
}
