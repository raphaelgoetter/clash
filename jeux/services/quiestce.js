// ============================================================
// quiestce.js — Qui est-ce ?, jeu spécial de 7 jours : chaque joueur a une
// carte secrète d'une grille commune et chasse les cartes des autres, une
// question par jour. 100 % asynchrone : chaque action est résolue tout de
// suite (règles pures dans quiestceRules.js).
//
// Couche métier : config statique, état de la publication, partie
// (grille, joueurs, enquêtes, journal) sous verrou, clôture quotidienne,
// manches.
//
// Stockage : Upstash Redis (mêmes conventions que bang.js) — espace de clés
// `quiestce:*`. Toute la partie tient dans une seule clé, lue et réécrite
// sous verrou à chaque action.
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Qui est-ce ?), source de vérité.
//
// ⚠️ automaticDeserialization désactivée volontairement (IDs Discord
// corrompus sinon, voir bossraid.js) : JSON sérialisé/désérialisé nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { creerPartie, inscrire, desinscrire, demarrer, debutAction, cloturer, classement, completerCartes, nbInscrits } from "./quiestceRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "data", "quiestce", "quiestce.json");
const CARDS_JSON_PATH = path.resolve(__dirname, "..", "data", "cardNames.json");

// { phase, jour, channelId, messageId, publishedAt, termine, isPublic, noPing }
const STATE_KEY = "quiestce:state";
// voir creerPartie() dans quiestceRules.js
const PARTIE_KEY = "quiestce:partie";
const RESULTAT_KEY = "quiestce:resultat";
const MANCHES_KEY = "quiestce:manches";
const MANCHE_SEQ_KEY = "quiestce:manche_seq";
const LOCK_KEY = "quiestce:lock";

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
let _cartesCache = null;

export async function loadQuiEstCeConfig() {
  if (_configCache) return _configCache;
  _configCache = JSON.parse(await fs.readFile(CONFIG_JSON_PATH, "utf8"));
  return _configCache;
}

// Cartes de jeux/data/cardNames.json, complétées par la table `complements`.
export async function loadCartesData() {
  if (_cartesCache) return _cartesCache;
  const [config, cartes] = await Promise.all([loadQuiEstCeConfig(), fs.readFile(CARDS_JSON_PATH, "utf8")]);
  _cartesCache = completerCartes(JSON.parse(cartes), config.complements);
  return _cartesCache;
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
  throw new Error("Verrou de Qui est-ce ? indisponible");
}

// Jour 1 : grille, cartes secrètes et première cible des inscrits. `pnj` :
// pseudos de joueurs fictifs inscrits d'office (salon de test, pour avoir
// des cibles) ; ils ne jouent jamais.
export async function demarrerPartie({ pnj = [] } = {}) {
  return withLock(async () => {
    const [config, cartesData, partie] = await Promise.all([loadQuiEstCeConfig(), loadCartesData(), readPartie()]);
    // PNJ inscrits hors plafond d'effectif (salon de test seulement)
    pnj.forEach((nom, i) => inscrire(partie, `pnj-${i + 1}`, nom, { config: { ...config, effectif_max: Infinity } }));
    demarrer(partie, { config, cartesData });
    await writePartie(partie);
    return partie;
  });
}

// Action d'un joueur sous verrou : `fn(partie, config)` modifie la partie
// (fonctions de quiestceRules.js) et renvoie un résultat. `inscription` :
// le joueur s'inscrit s'il ne l'est pas encore (bouton S'inscrire, pendant
// la fenêtre d'inscription et dans la limite de `effectif_max`) ; sinon un
// non-inscrit est refusé. À la première action du jour, le joueur reçoit
// son objet gratuit (et une cible s'il n'en a pas), voir debutAction().
// Renvoie { partie, resultat, nouveau, debut } ou { erreur: "inscriptions" | "complet" | "pasInscrit" }.
export async function agir(discordId, username, fn = () => null, { inscription = false } = {}) {
  return withLock(async () => {
    const [config, partie] = await Promise.all([loadQuiEstCeConfig(), readPartie()]);
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
    const debut = debutAction(partie, discordId, { config });
    const resultat = await fn(partie, config);
    await writePartie(partie);
    return { partie, resultat, nouveau, debut };
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

// ── Clôture ─────────────────────────────────────────────────────────

// Lecture seule (aucune écriture Redis) — branche --dry-run du script.
export async function previewCloture(jour) {
  const [config, partie] = await Promise.all([loadQuiEstCeConfig(), readPartie()]);
  if (!partie.termine) cloturer(partie, { config });
  const termine = partie.termine || jour >= config.duree_jours;
  return { partie, termine, final: termine ? classement(partie) : null, jourSuivant: jour + 1 };
}

// Compteurs du jour remis à zéro ; classement final au dernier jour.
export async function closeDayAndAdvance(jour) {
  return withLock(async () => {
    const [config, partie] = await Promise.all([loadQuiEstCeConfig(), readPartie()]);
    if (!partie.termine) cloturer(partie, { config });
    const termine = partie.termine || jour >= config.duree_jours;
    if (termine) partie.termine = true;
    const final = termine ? classement(partie) : null;
    await writePartie(partie);
    if (final) await getRedis().set(RESULTAT_KEY, toJson(final));
    return { partie, termine, final, jourSuivant: jour + 1 };
  });
}

export async function readResultat() {
  return fromJson(await getRedis().get(RESULTAT_KEY));
}

export const MIN_HOURS_BETWEEN_CLOSURES = 8;

export function isTooSoonSinceLastClosure(publishedAt, now = Date.now()) {
  if (!publishedAt) return false;
  return (now - new Date(publishedAt).getTime()) / 3_600_000 < MIN_HOURS_BETWEEN_CLOSURES;
}

// ── Manches (comparaison entre parties, comme bang.js) ──────────────

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

export async function resetQuiEstCe({ clearManches = false } = {}) {
  await getRedis().del(STATE_KEY, PARTIE_KEY, RESULTAT_KEY, LOCK_KEY);
  if (clearManches) await getRedis().del(MANCHES_KEY, MANCHE_SEQ_KEY);
}
