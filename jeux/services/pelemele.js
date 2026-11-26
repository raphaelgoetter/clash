// ============================================================
// pelemele.js — Jeu "Pêle-mêle" (DRAW_SIZE lettres tirées au
// sort, il faut retrouver les noms du thème de la manche, Pokémon ou
// capitales, qu'on peut former avec). Couche métier : pool éligible, tirage, validation des
// propositions, scoring, classements. Même stockage Upstash Redis et mêmes
// pièges que les autres mini-jeux (automaticDeserialization/HGETALL, client
// paresseux — voir les commentaires détaillés dans frames.js), avec des
// différences structurelles importantes :
//
// 1. Pas de nom secret à deviner : chaque manche est un TIRAGE DE
//    DRAW_SIZE LETTRES ouvert. N'importe quel nom du pool qui "rentre"
//    dans ces lettres est une réponse valide — il n'y a donc pas de notion
//    de résolution collective ("quelqu'un a trouvé, la manche est finie").
// 2. Un joueur peut reproposer autant de fois qu'il veut ; TOUS ses mots
//    DISTINCTS trouvés comptent pour son score de manche (dédoublonnage par
//    forme canonique) — barème : LONGEST_WORD_BONUS pour le(s) mot(s) le(s)
//    plus long(s) possible(s) du tirage, EXTRA_WORD_POINTS pour chaque autre
//    (voir computeScore/submitWord ci-dessous ; pas juste le meilleur mot,
//    contrairement à une version antérieure de ce fichier).
// 3. La manche reste OUVERTE jusqu'à la manche suivante : elle n'est
//    jamais "résolue" à proprement parler, elle est simplement remplacée.
//    Le classement de saison est incrémenté EN CONTINU (à chaque mot
//    NOUVEAU trouvé, voir submitWord ci-dessous).
//
// Production : Pêle-mêle alterne avec Concept, une saison sur deux, dans le
// groupe "Jeux de mots" — voir jeux/services/jeuxdelettres.js pour
// l'alternance et jeux/scripts/postJeuxDeLettres.js pour l'orchestration
// (seul point d'entrée en production ; jeux/scripts/postPeleMele.js reste
// utilisable pour forcer un post direct de CE jeu précis, test comme
// rattrapage manuel).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { noterManche } from "./passeport.js";
import { Redis } from "@upstash/redis";
import { countRemainingWeekdayOccurrences, getCurrentSeasonId } from "./saison.js";
import { normalizeAnswer } from "@clash/commun/textNormalize.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Thèmes, en alternance d'une manche à l'autre (ordre de THEME_ORDER),
// un fichier de noms par thème dans jeux/data/pelemele/ :
// - pokemon : les 151 Pokémon de 1re génération, noms français officiels
//   (Poképédia) ; Nidoran♀ et Nidoran♂, mêmes lettres, ne font qu'une entrée ;
// - capitales : capitales des 193 États de l'ONU, du Vatican et de la
//   Palestine (Wikipédia, « Liste des capitales du monde »), toutes les
//   capitales d'un pays qui en a plusieurs.
export const THEME_ORDER = ["pokemon", "capitales"];
const THEME_FILES = { pokemon: "pokemon.json", capitales: "capitales.json" };

// Thème d'une manche ; les manches antérieures aux thèmes sont des Pokémon.
export function themeOf(state) {
  return state?.theme ?? THEME_ORDER[0];
}

// Thème de la manche qui suit `previousState` (le premier si elle n'en a pas).
export function nextTheme(previousState) {
  const index = THEME_ORDER.indexOf(previousState?.theme);
  return THEME_ORDER[(index + 1) % THEME_ORDER.length];
}

export const DRAW_SIZE = 14;

// Samedi (comme Anagram, avec qui ce jeu alterne — même jour, même
// mécanique de créneau matin/soir, voir jeuxdelettres.js) — décision
// produit actée le 2026-09-19.
const SATURDAY = 6;

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

const STATE_KEY = "pelemele:state";
const ROUND_SEQ_KEY = "pelemele:round_seq";

function orderKey(theme) {
  return `pelemele:order:${theme}`;
}
function drawsKey(theme) {
  return `pelemele:draws:${theme}`;
}

function participantsKey(gameId) {
  return `pelemele:participants:${gameId}`;
}
function usernamesKey(gameId) {
  return `pelemele:usernames:${gameId}`;
}
function attemptsKey(gameId, discordId) {
  return `pelemele:attempts:${gameId}:${discordId}`;
}
function seasonKey(seasonId) {
  return `pelemele:season:${seasonId}`;
}
function seasonPseudosKey(seasonId) {
  return `pelemele:season:${seasonId}:pseudos`;
}
function seasonMancheSeqKey(seasonId) {
  return `pelemele:season:${seasonId}:manche_seq`;
}
function seasonMancheNumbersKey(seasonId) {
  return `pelemele:season:${seasonId}:manche_numbers`;
}
function archivedKey(seasonId) {
  return `pelemele:archived:${seasonId}`;
}

// SCAN par motif — uniquement utilisé pour le nettoyage, jamais sur le
// chemin critique d'une interaction joueur (voir frames.js).
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

// ── Pool éligible (sous-ensemble du fichier du thème) ──────────────
// Un nom est éligible s'il est renseigné et si son nombre de lettres
// (espaces, accents et ponctuation ignorés) est ≤ DRAW_SIZE — sans quoi il
// ne pourrait jamais rentrer dans un tirage.

// Lettres "brutes" d'un nom : accents et espaces retirés, casse
// ignorée — c'est l'alphabet utilisé pour le tirage ET la validation, les
// tuiles de lettres n'ayant pas d'accent (comme au Scrabble). Réutilise
// normalizeAnswer (déjà utilisé par tous les autres mini-jeux) plutôt que de
// réinventer la normalisation d'accents.
function bareLetters(str) {
  return normalizeAnswer(str).replace(/\s+/g, "");
}

export function wordLetterCount(str) {
  return bareLetters(str).length;
}

// Forme canonique affichée/archivée d'un mot trouvé : uniquement les lettres
// (accents, espaces, points retirés), cohérent avec le principe du jeu : il
// n'existe ni tuile espace ni tuile ponctuation parmi les lettres tirées,
// donc "M. Mime" s'écrit "MMIME", jamais avec sa ponctuation d'origine.
export function canonicalWordForm(str) {
  return bareLetters(str).toUpperCase();
}

const fullListCache = new Map();
const poolCache = new Map();

export async function loadFullList(theme = THEME_ORDER[0]) {
  if (!THEME_FILES[theme]) throw new Error(`Thème Pêle-mêle inconnu : ${theme}`);
  if (!fullListCache.has(theme)) {
    const txt = await fs.readFile(path.resolve(__dirname, "..", "data", "pelemele", THEME_FILES[theme]), "utf-8");
    fullListCache.set(theme, JSON.parse(txt));
  }
  return fullListCache.get(theme);
}

// Fonction pure exportée séparément (testable sans I/O) — le filtre lui-même
// ne dépend d'aucun état, seulement de la liste en entrée.
export function filterEligiblePool(fullList) {
  return fullList.filter((c) => c.fr && wordLetterCount(c.fr) <= DRAW_SIZE);
}

export async function loadEligiblePool(theme = THEME_ORDER[0]) {
  if (!poolCache.has(theme)) poolCache.set(theme, filterEligiblePool(await loadFullList(theme)));
  return poolCache.get(theme);
}

// ── Multi-ensembles de lettres (cœur de la validation) ─────────────

function multisetFromLetters(letters) {
  const counts = new Map();
  for (const raw of letters) {
    const ch = String(raw).toLowerCase();
    counts.set(ch, (counts.get(ch) || 0) + 1);
  }
  return counts;
}

// word peut être n'importe quelle chaîne (typiquement un nom du pool) ;
// bagLetters est un tableau de lettres (le tirage de la manche, casse
// indifférente). Vrai si toutes les lettres de word peuvent être formées à
// partir du multi-ensemble du tirage (sans dépasser le nombre de doublons
// disponibles).
export function canFormFromBag(word, bagLetters) {
  const need = multisetFromLetters(bareLetters(word));
  const have = multisetFromLetters(bagLetters);
  for (const [ch, n] of need) {
    if ((have.get(ch) || 0) < n) return false;
  }
  return true;
}

// Tous les noms du pool qui rentrent dans CE tirage précis, triées par
// longueur décroissante — calculé UNE FOIS à la génération de la manche
// (startNewGame) et stocké dans l'état (totalValidWords/maxWordLength),
// jamais recalculé à chaque proposition. Sert à la fois à afficher "X mots
// valides sur ce tirage" et à déterminer le bonus "mot le plus long" du
// barème (voir computeScore).
export function computeValidWordsForDraw(pool, bagLetters) {
  return pool
    .filter((c) => canFormFromBag(c.fr, bagLetters))
    .map((c) => ({ key: c.key, fr: c.fr, length: wordLetterCount(c.fr) }))
    .sort((a, b) => b.length - a.length);
}

// ── Tirage pondéré des lettres ──────────────────────────────────────
// Fréquences du Scrabble français (102 jetons standard, blancs exclus — 100
// lettres au total) : évite un tirage à 6 consonnes injouable. Table figée,
// pas de dépendance externe.
const FR_LETTER_WEIGHTS = {
  e: 15, a: 9, i: 8, n: 6, o: 6, r: 6, s: 6, t: 6, u: 6, l: 5,
  d: 3, m: 3,
  g: 2, b: 2, c: 2, p: 2, f: 2, h: 2, v: 2,
  j: 1, q: 1, k: 1, w: 1, x: 1, y: 1, z: 1,
};
const FR_LETTER_TOTAL = Object.values(FR_LETTER_WEIGHTS).reduce((a, b) => a + b, 0); // 100

// rng injectable (Math.random par défaut) pour des tests déterministes.
export function weightedRandomLetter(rng = Math.random) {
  let target = rng() * FR_LETTER_TOTAL;
  for (const [letter, weight] of Object.entries(FR_LETTER_WEIGHTS)) {
    target -= weight;
    if (target < 0) return letter;
  }
  return "e"; // filet de sécurité, ne devrait jamais être atteint (arrondi flottant)
}

function shuffle(array, rng = Math.random) {
  const result = [...array];
  for (let i = result.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    [result[i], result[j]] = [result[j], result[i]];
  }
  return result;
}

// Union (PAS somme) des lettres de plusieurs mots — le nombre de fois qu'une
// lettre doit apparaître dans le tirage pour que TOUS les mots tiennent
// simultanément est le MAX de ses occurrences dans chacun, pas leur total :
// deux mots qui partagent des lettres ne doivent pas gonfler artificiellement
// le nombre de lettres nécessaires. Sert à garantir plusieurs solutions à la
// fois dans un même tirage (voir pickCompatibleSecondarySeed ci-dessous).
function unionLetterCounts(words) {
  const union = new Map();
  for (const word of words) {
    const counts = multisetFromLetters(bareLetters(word));
    for (const [ch, n] of counts) {
      union.set(ch, Math.max(union.get(ch) || 0, n));
    }
  }
  return union;
}

function unionLetterTotal(words) {
  let total = 0;
  for (const n of unionLetterCounts(words).values()) total += n;
  return total;
}

// Construit un tirage de DRAW_SIZE lettres qui contient TOUJOURS les lettres
// de CHAQUE mot de seedFrs (garantit une solution par mot, simultanément),
// complété par du tirage pondéré puis mélangé — aucun des mots "seed" n'est
// donc devinable par sa position dans le tirage affiché. Un seul mot dans
// seedFrs revient au comportement d'origine (une seule solution garantie).
export function buildLetterBagFromSeeds(seedFrs, rng = Math.random, size = DRAW_SIZE) {
  const union = unionLetterCounts(seedFrs);
  const bag = [];
  for (const [ch, n] of union) {
    for (let i = 0; i < n; i++) bag.push(ch.toUpperCase());
  }
  while (bag.length < size) {
    bag.push(weightedRandomLetter(rng).toUpperCase());
  }
  return shuffle(bag, rng);
}

export function buildLetterBag(seedFr, rng = Math.random, size = DRAW_SIZE) {
  return buildLetterBagFromSeeds([seedFr], rng, size);
}

// Tire un second nom "seed" compatible avec le premier (leurs lettres
// combinées tiennent dans DRAW_SIZE) : garantit deux solutions par tirage.
// maxTries est un filet de sécurité — si aucune paire compatible n'est
// trouvée (pool très restreint), retombe sur une seule solution garantie,
// jamais d'échec bloquant la génération d'une manche.
export function pickCompatibleSecondarySeed(pool, primaryEntry, rng = Math.random, maxTries = 30) {
  const candidates = pool.filter((c) => c.key !== primaryEntry.key);
  if (candidates.length === 0) return null;
  for (let i = 0; i < maxTries; i++) {
    const candidate = candidates[Math.floor(rng() * candidates.length)];
    if (unionLetterTotal([primaryEntry.fr, candidate.fr]) <= DRAW_SIZE) {
      return candidate;
    }
  }
  return null;
}

// ── Fourchette du nombre de noms trouvables par tirage ─────────────
// Chaque tirage doit offrir entre MIN_VALID_WORDS et MAX_VALID_WORDS noms
// trouvables. Simulation sur les 150 noms (6 000 tirages) : 100 % des
// tirages dans la fourchette, 5,1 noms en moyenne.
export const MIN_VALID_WORDS = 4;
export const MAX_VALID_WORDS = 9;
const VALID_WORDS_RANGE = { min: MIN_VALID_WORDS, max: MAX_VALID_WORDS };

// Distance d'un nombre de mots à la fourchette (0 = dedans).
function distanceToRange(count, { min, max }) {
  if (count < min) return min - count;
  if (count > max) return count - max;
  return 0;
}

// Retire second nom + lettres de complément jusqu'à tomber dans la
// fourchette ; maxTries est un filet de sécurité : à défaut, garde le
// tirage le plus proche de la fourchette plutôt que de bloquer la
// génération d'une manche.
export function generateDraw(pool, primaryEntry, rng = Math.random, maxTries = 1000) {
  const range = VALID_WORDS_RANGE;
  let best = null;
  for (let i = 0; i < maxTries; i++) {
    const secondaryEntry = pickCompatibleSecondarySeed(pool, primaryEntry, rng);
    const seedFrs = secondaryEntry ? [primaryEntry.fr, secondaryEntry.fr] : [primaryEntry.fr];
    const letters = buildLetterBagFromSeeds(seedFrs, rng);
    const validWords = computeValidWordsForDraw(pool, letters);
    const distance = distanceToRange(validWords.length, range);
    if (!best || distance < best.distance) best = { letters, validWords, distance };
    if (distance === 0) break;
  }
  return { letters: best.letters, validWords: best.validWords };
}

// ── Résolution d'une proposition texte → nom du pool ───────────────
// Égalité stricte sur le nom normalisé (ou l'une de ses variantes
// acceptées, champ `accept`, ex. "Mr. Mime" pour "M. Mime"), avec repli
// "compact" (espaces retirés) pour tolérer un joueur qui tape sans les
// séparateurs. Les lettres comptées restent toujours celles de `fr`.
function namesOf(entry) {
  return [entry.fr, ...(entry.accept ?? [])].map(normalizeAnswer);
}

function matchByFrName(list, rawName) {
  const normalized = normalizeAnswer(rawName);
  if (!normalized) return null;
  const exact = list.find((c) => namesOf(c).includes(normalized));
  if (exact) return exact;
  const compact = normalized.replace(/\s+/g, "");
  return list.find((c) => namesOf(c).some((n) => n.replace(/\s+/g, "") === compact)) ?? null;
}

// Fonction pure : ne dépend d'aucun état Redis, testable indépendamment.
// Trois issues d'échec distinctes :
// - "invalid"      : aucun nom connu ne correspond (vraie faute de frappe)
// - "not-eligible" : nom connu mais hors pool (trop long)
// - "impossible"   : nom du pool, mais ne rentre pas dans CE tirage précis
// - "ok"           : proposition valide, `length` = score obtenu
export function validateSubmission(pool, fullList, bagLetters, rawText) {
  const entry = matchByFrName(pool, rawText);
  if (entry) {
    if (!canFormFromBag(entry.fr, bagLetters)) {
      return { status: "impossible", entry };
    }
    return { status: "ok", entry, length: wordLetterCount(entry.fr) };
  }
  const anyEntry = matchByFrName(fullList, rawText);
  if (anyEntry) {
    return { status: "not-eligible", entry: anyEntry };
  }
  return { status: "invalid" };
}

// ── État de la partie en cours (métadonnées uniquement) ──────────

export async function readState() {
  return fromJson(await getRedis().get(STATE_KEY));
}

export async function writeState(state) {
  await getRedis().set(STATE_KEY, toJson(state));
}

async function cleanupGameScratchData(gameId) {
  await getRedis().del(participantsKey(gameId), usernamesKey(gameId));
  await scanDelete(`pelemele:attempts:${gameId}:*`);
}

export async function resetGame() {
  await getRedis().del(STATE_KEY, ROUND_SEQ_KEY);
  await scanDelete("pelemele:order*");
  await scanDelete("pelemele:draws*");
  await scanDelete("pelemele:participants:*");
  await scanDelete("pelemele:usernames:*");
  await scanDelete("pelemele:attempts:*");
  await scanDelete("pelemele:season:*");
  await scanDelete("pelemele:archived:*");
}

// ── Saison en cours (mois calendaire, voir saison.js) ──────────
export { getCurrentSeasonId };

// ── Ordre de rotation des noms "seed" (garantissent une solution) ──────
// Une rotation par thème. Les fichiers sont triés (Pokédex, alphabet), donc
// on ne s'appuie pas sur leur ordre physique — mélangé une fois puis
// persisté dans Redis. Ne
// détermine QUE le nom utilisé pour garantir qu'une solution existe dans le
// tirage ; n'importe quel autre nom du pool qui rentre dans le tirage reste
// une réponse valide.
export async function loadSeedOrder(pool, theme = THEME_ORDER[0]) {
  const stored = fromJson(await getRedis().get(orderKey(theme))) || [];
  const poolKeySet = new Set(pool.map((c) => c.key));
  const kept = stored.filter((k) => poolKeySet.has(k));
  const missing = pool.map((c) => c.key).filter((k) => !kept.includes(k));
  const order = [...kept, ...shuffle(missing)];
  if (missing.length > 0 || kept.length !== stored.length) {
    await getRedis().set(orderKey(theme), toJson(order));
  }
  return order;
}

export function pickNextIndex(state, order) {
  const prevIndex = state?.currentIndex ?? -1;
  return (prevIndex + 1) % order.length;
}

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

export function computeSeasonMancheTotal(seasonManche, now = new Date()) {
  return seasonManche + countRemainingWeekdayOccurrences(now, SATURDAY);
}

// ── Tirages préparés à l'avance ──────────────────────────────────
// Décision produit (2026-10-11) : les tirages sont générés à l'avance et
// stockés dans une LIST Redis par thème (une entrée JSON {seedKey, letters}
// par manche, dans l'ordre de passage), complétée à PREPARED_DRAWS_TARGET après
// chaque manche. On stocke le nom principal plutôt que son index : un
// changement de pool (nom ajouté/retiré) peut décaler les index de la
// rotation, pas les clés. Le nombre de mots trouvables est recalculé à la
// consommation, pour tenir compte d'un nom ajouté au pool entre-temps.
export const PREPARED_DRAWS_TARGET = 50;

export async function listPreparedDraws(theme = THEME_ORDER[0]) {
  const raw = (await getRedis().lrange(drawsKey(theme), 0, -1)) || [];
  return raw.map(fromJson).filter(Boolean);
}

// Les tirages dont le nom principal a quitté le pool (changement de liste)
// sont d'abord retirés de la file. La rotation reprend après le dernier nom
// en file, sinon après celui de la dernière manche de ce thème.
export async function refillPreparedDraws(theme = THEME_ORDER[0], target = PREPARED_DRAWS_TARGET) {
  const pool = await loadEligiblePool(theme);
  const order = await loadSeedOrder(pool, theme);
  const stored = await listPreparedDraws(theme);
  const queued = stored.filter((draw) => order.includes(draw.seedKey));
  if (queued.length !== stored.length) {
    await getRedis().del(drawsKey(theme));
    if (queued.length) await getRedis().rpush(drawsKey(theme), ...queued.map(toJson));
  }
  if (queued.length >= target) return queued.length;

  const state = await readState();
  const lastSeedKey = queued.at(-1)?.seedKey ?? (themeOf(state) === theme ? state?.seedKey : undefined);
  let index = order.indexOf(lastSeedKey);
  const newDraws = [];
  for (let i = queued.length; i < target; i++) {
    index = pickNextIndex({ currentIndex: index }, order);
    const primaryEntry = pool.find((c) => c.key === order[index]);
    const { letters } = generateDraw(pool, primaryEntry);
    newDraws.push(toJson({ seedKey: primaryEntry.key, letters }));
  }
  await getRedis().rpush(drawsKey(theme), ...newDraws);
  return target;
}

// Retire le prochain tirage de la file (en la remplissant d'abord si elle
// est vide) ; un tirage dont le nom principal a quitté le pool est jeté.
async function takeNextDraw(pool, order, theme) {
  for (;;) {
    let draw = fromJson(await getRedis().lpop(drawsKey(theme)));
    if (!draw) {
      await refillPreparedDraws(theme);
      draw = fromJson(await getRedis().lpop(drawsKey(theme)));
    }
    const currentIndex = order.indexOf(draw.seedKey);
    if (currentIndex >= 0) return { currentIndex, seedKey: draw.seedKey, letters: draw.letters };
  }
}

// ── Cycle de vie d'une manche ────────────────────────────────────

export async function startNewGame(channelId) {
  const previousState = await readState();
  const theme = nextTheme(previousState);
  const pool = await loadEligiblePool(theme);
  const order = await loadSeedOrder(pool, theme);
  // Le nom PRINCIPAL de chaque tirage préparé suit la rotation équitable
  // persistée — seul le second, purement là pour garantir davantage de
  // solutions, est tirée au hasard sans notion de rotation/répétition.
  const { currentIndex, seedKey, letters } = await takeNextDraw(pool, order, theme);
  const validWords = computeValidWordsForDraw(pool, letters);
  const totalValidWords = validWords.length;
  const maxWordLength = validWords[0]?.length ?? 0;
  const seasonId = await getCurrentSeasonId();
  const gameId = String(await getRedis().incr(ROUND_SEQ_KEY));
  const now = new Date();

  const seasonManche = await assignSeasonMancheNumber(seasonId, gameId);
  const seasonMancheTotal = computeSeasonMancheTotal(seasonManche, now);

  const newState = {
    theme,
    currentIndex,
    seedKey,
    gameId,
    seasonId,
    seasonManche,
    seasonMancheTotal,
    letters,
    totalValidWords,
    maxWordLength,
    startedAt: now.toISOString(),
    channelId,
    messageId: null,
  };

  await writeState(newState);

  // Aucun événement de fin de manche : on fige les résultats de la
  // manche précédente au moment où elle est remplacée par la nouvelle.
  if (previousState?.gameId && previousState.gameId !== newState.gameId) {
    await finalizeRound(previousState);
    await cleanupGameScratchData(previousState.gameId);
  }

  await refillPreparedDraws(theme);

  return { state: newState };
}

// Anti-double-post — même garde-fou que les autres mini-jeux contre
// un cron GitHub Actions en retard qui ferait avancer la manche deux fois.
function todayUtcDateString(date) {
  return date.toISOString().slice(0, 10);
}

export async function alreadyPostedThisWeek(now = new Date()) {
  const state = await readState();
  if (!state?.startedAt) return false;
  return todayUtcDateString(new Date(state.startedAt)) === todayUtcDateString(now);
}

// ── Progression par joueur ────────────────────────────────────────

export async function readParticipant(gameId, discordId) {
  return fromJson(await getRedis().hget(participantsKey(gameId), discordId));
}

async function touchUsername(gameId, discordId, username) {
  await noterManche(discordId, "pelemele", gameId);
  await getRedis().hset(usernamesKey(gameId), { [discordId]: username });
}

export async function getGuessHistory(gameId, discordId) {
  return (await getRedis().lrange(attemptsKey(gameId, discordId), 0, -1)) || [];
}

// Barème (décision produit explicite, 2026-09) : le(s) mot(s) le(s) plus
// long(s) POSSIBLE(S) sur ce tirage (maxWordLength, calculé une fois par
// startNewGame — voir computeValidWordsForDraw) valent LONGEST_WORD_BONUS
// chacun s'ils sont trouvés (plusieurs mots à égalité de longueur max valent
// chacun ce bonus, pas de partage) ; tout autre mot valide trouvé vaut
// EXTRA_WORD_POINTS. Volontairement des constantes FIXES plutôt que
// proportionnelles à DRAW_SIZE/à la longueur du mot : un score qui ne
// dépend pas de la taille du tirage évite de tout recalibrer si DRAW_SIZE
// change encore (voir l'historique de ce fichier).
const LONGEST_WORD_BONUS = 5;
const EXTRA_WORD_POINTS = 1;

export function computeScore(length, maxWordLength) {
  return length === maxWordLength ? LONGEST_WORD_BONUS : EXTRA_WORD_POINTS;
}

// Enregistre une proposition VALIDE (status "ok" de validateSubmission).
// Contrairement à l'ancien barème (un seul "meilleur mot" par joueur), le
// score est désormais la somme des points de TOUS les mots DISTINCTS
// trouvés par le joueur sur cette manche — un mot déjà trouvé ne rapporte
// rien en re-proposition (dédoublonnage par forme canonique). Le classement
// de SAISON est incrémenté du nombre de points de CE mot uniquement (pas
// besoin de delta comme l'ancien barème basé sur un "meilleur score" — un
// mot ne rapporte ses points qu'une seule fois, jamais recompté).
export async function submitWord(gameId, discordId, username, entry, length, maxWordLength, seasonId) {
  await touchUsername(gameId, discordId, username);
  const canonical = canonicalWordForm(entry.fr);
  await getRedis().rpush(attemptsKey(gameId, discordId), canonical);

  const previous = await readParticipant(gameId, discordId);
  const foundWords = previous?.foundWords ?? [];
  if (foundWords.includes(canonical)) {
    return { isNew: false, participant: previous, points: 0, foundCount: foundWords.length };
  }

  const points = computeScore(length, maxWordLength);
  const participant = {
    discordId,
    username,
    foundWords: [...foundWords, canonical],
    score: (previous?.score ?? 0) + points,
    lastFoundAt: new Date().toISOString(),
  };
  await getRedis().hset(participantsKey(gameId), { [discordId]: toJson(participant) });

  if (seasonId != null) {
    await getRedis().zincrby(seasonKey(seasonId), points, discordId);
    await getRedis().hset(seasonPseudosKey(seasonId), { [discordId]: username });
  }

  return { isNew: true, participant, points, foundCount: participant.foundWords.length };
}

// ── Résultats archivés (classement de la saison) ─────────────────
// Pas d'archivage au moment d'un "solved" : ici on
// fige les résultats de TOUS les participants de la manche en une fois,
// au moment où elle est remplacée (voir startNewGame). Le total de saison
// (seasonKey, ZSET) est lui déjà à jour en continu via submitWord — ce
// n'est qu'un instantané pour l'historique détaillé (getAllArchivedResults).
async function finalizeRound(previousState) {
  const archKey = archivedKey(previousState.seasonId);
  for (const [field, result] of await roundResults(previousState)) {
    await getRedis().hsetnx(archKey, field, toJson(result));
  }
}

// Résultats d'une manche, au format archivé : [champ, résultat] par joueur
// ayant trouvé au moins un nom.
async function roundResults(state) {
  const participants = await hgetallJson(participantsKey(state.gameId));
  return Object.values(participants)
    .filter((participant) => participant?.foundWords?.length)
    .map((participant) => [
      `${state.gameId}:${participant.discordId}`,
      {
        gameId: state.gameId,
        seasonId: state.seasonId,
        theme: themeOf(state),
        reponse: participant.foundWords.join(", "),
        // Lettres du tirage de CETTE manche — redondant entre les enregistrements
        // de plusieurs joueurs d'une même manche (même gameId), mais c'est le
        // seul endroit où cette donnée survit après remplacement de la manche
        // (state.letters n'existe que tant que la manche est active) ; sert au
        // récap de fin de saison (voir getSeasonManchesPlayed, handler Discord).
        letters: state.letters.join(""),
        postedAt: state.startedAt,
        discordId: participant.discordId,
        pseudo: participant.username,
        score: participant.score,
        solvedAt: participant.lastFoundAt,
      },
    ]);
}

export async function getPlayerSeasonResults(seasonId, discordId) {
  const all = await hgetallJson(archivedKey(seasonId));
  return Object.entries(all)
    .filter(([field]) => field.endsWith(`:${discordId}`))
    .map(([, result]) => result);
}

// Inclut la manche en cours (ou la dernière, tant qu'aucune autre ne l'a
// remplacée) : elle n'est archivée qu'à son remplacement, qui n'arrive qu'à
// la prochaine saison de Pêle-mêle sous l'alternance.
export async function getAllArchivedResults() {
  const keys = await scanKeys("pelemele:archived:*");
  const hashes = await Promise.all(keys.map((key) => hgetallJson(key)));
  const archived = hashes.flatMap((hash) => Object.values(hash));

  const state = await readState();
  if (!state?.gameId || !state.letters) return archived;
  const archivedFields = new Set(
    archived
      .filter((r) => r.seasonId === state.seasonId)
      .map((r) => `${r.gameId}:${r.discordId}`),
  );
  const pending = (await roundResults(state))
    .filter(([field]) => !archivedFields.has(field))
    .map(([, result]) => result);
  return [...archived, ...pending];
}

export async function getSeasonManches(seasonId) {
  const ids = await getRedis().hkeys(seasonMancheNumbersKey(seasonId));
  return ids || [];
}

export async function getSeasonMancheNumber(seasonId, gameId) {
  const raw = await getRedis().hget(seasonMancheNumbersKey(seasonId), gameId);
  return raw == null ? null : Number(raw);
}

export async function previewSeasonManche(seasonId) {
  const seq = Number(await getRedis().get(seasonMancheSeqKey(seasonId))) || 0;
  return seq + 1;
}

export async function hasPlayerInteracted(gameId, discordId) {
  const username = await getRedis().hget(usernamesKey(gameId), discordId);
  return username != null;
}

// ── Classements ──────────────────────────────────────────────────

// Joueurs ayant trouvé au moins un mot valide, triés par score total
// décroissant puis par nombre de mots trouvés décroissant (à score égal —
// rare mais possible si l'un a trouvé le mot bonus et l'autre plusieurs
// petits mots — celui qui en a trouvé le plus est mis devant), puis par
// date du dernier mot trouvé croissante.
export async function computeGameRanking(gameId) {
  const all = await hgetallJson(participantsKey(gameId));
  return Object.values(all)
    .filter((p) => p?.foundWords?.length)
    .map((p) => ({
      discordId: p.discordId,
      username: p.username,
      score: p.score,
      foundWords: p.foundWords,
      lastFoundAt: p.lastFoundAt,
    }))
    .sort(
      (a, b) =>
        b.score - a.score ||
        b.foundWords.length - a.foundWords.length ||
        new Date(a.lastFoundAt) - new Date(b.lastFoundAt),
    );
}

export async function listGamePlayersInProgress(gameId) {
  const [participants, usernames] = await Promise.all([
    hgetallJson(participantsKey(gameId)),
    hgetallRaw(usernamesKey(gameId)),
  ]);
  const foundIds = new Set(
    Object.values(participants)
      .filter((p) => p?.foundWords?.length)
      .map((p) => p.discordId),
  );
  return Object.entries(usernames)
    .filter(([discordId]) => !foundIds.has(discordId))
    .map(([discordId, username]) => ({ discordId, username }))
    .sort((a, b) => a.username.localeCompare(b.username));
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

export function findTiedRank(sortedList, discordId, scoreKey) {
  const entry = sortedList.find((e) => e.discordId === discordId);
  if (!entry) return null;
  const score = entry[scoreKey];
  return sortedList.filter((e) => e[scoreKey] > score).length + 1;
}
