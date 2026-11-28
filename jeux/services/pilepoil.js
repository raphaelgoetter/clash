// ============================================================
// pilepoil.js — Pile Poil (calcul du jour, jeu quotidien sans fin) :
// stockage Redis, essais, classement du mois, séries, PNJ du salon de test.
// Règles pures : pilepoilRules.js. Règles du jeu : jeux/CONTRIBUTING.md,
// section « Pile Poil ».
//
// Deux espaces de clés indépendants : `pilepoil:*` (salon public, le jeu ne
// s'arrête jamais) et `pilepoil:test:*` (salon de test), pour tester sans
// toucher à la partie publique.
// ⚠️ automaticDeserialization désactivée (IDs Discord > MAX_SAFE_INTEGER).
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { retour, gagne, pointsDuJour, compatibles, toutesLesEgalites, signeDe, serieApresVictoire } from "./pilepoilRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "data", "pilepoil", "pilepoil.json");

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

const toJson = (value) => JSON.stringify(value);
function fromJson(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// HGETALL sans désérialisation : tableau plat [champ1, valeur1, …]
function pairsToObject(flat) {
  const obj = {};
  for (let i = 0; i < flat.length; i += 2) obj[flat[i]] = flat[i + 1];
  return obj;
}
const hgetallRaw = async (key) => pairsToObject((await getRedis().hgetall(key)) || []);
async function hgetallJson(key) {
  const raw = await hgetallRaw(key);
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, fromJson(v)]));
}
async function hgetallNombres(key) {
  const raw = await hgetallRaw(key);
  return Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, Number(v) || 0]));
}

async function scanDelete(pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await getRedis().scan(cursor, { match: pattern, count: 200 });
    cursor = next;
    keys.push(...batch);
  } while (String(cursor) !== "0");
  if (keys.length) await getRedis().del(...keys);
}

// ── Espaces de clés ───────────────────────────────────────────────

// `espace` : "public" ou "test" (code court « p » / « t » dans les custom_id)
export const ESPACES = ["public", "test"];
export const codeEspace = (espace) => (espace === "test" ? "t" : "p");
export const espaceDuCode = (code) => (code === "t" ? "test" : "public");
const prefixe = (espace) => (espace === "test" ? "pilepoil:test" : "pilepoil");

const cle = {
  state: (e) => `${prefixe(e)}:state`,
  solutions: (e) => `${prefixe(e)}:solutions`,
  sorties: (e) => `${prefixe(e)}:sorties`,
  parties: (e, jour) => `${prefixe(e)}:parties:${jour}`,
  verrou: (e, jour, id) => `${prefixe(e)}:verrou:${jour}:${id}`,
  usernames: (e) => `${prefixe(e)}:usernames`,
  series: (e) => `${prefixe(e)}:series`,
  moisPoints: (e, sid) => `${prefixe(e)}:mois:${sid}`,
  moisJours: (e, sid) => `${prefixe(e)}:mois:${sid}:jours`,
  moisFinal: (e, sid) => `${prefixe(e)}:mois:${sid}:final`,
  historique: (e) => `${prefixe(e)}:historique`,
};

// Parties et verrous d'un jour : plus utiles après le récap
const TTL_PARTIES_SECONDES = 40 * 24 * 3600;

// ── Config (statique) ─────────────────────────────────────────────

let configCache = null;
export async function loadPilePoilConfig() {
  if (configCache) return configCache;
  configCache = JSON.parse(await fs.readFile(CONFIG_JSON_PATH, "utf-8"));
  return configCache;
}

// ── État (muté uniquement par la publication quotidienne) ─────────

export async function readState(espace) {
  return fromJson(await getRedis().get(cle.state(espace)));
}

export async function writeState(espace, state) {
  await getRedis().set(cle.state(espace), toJson(state));
}

// ── Égalité du jour (secrète jusqu'au récap) ──────────────────────

export async function writeSolution(espace, jour, egalite) {
  await getRedis().hset(cle.solutions(espace), { [jour]: egalite });
  await getRedis().sadd(cle.sorties(espace), egalite);
}

export async function readSolution(espace, jour) {
  return (await getRedis().hget(cle.solutions(espace), String(jour))) ?? null;
}

export const readSorties = (espace) => getRedis().smembers(cle.sorties(espace));

// ── Partie d'un joueur (un jour) ──────────────────────────────────

const PARTIE_VIDE = () => ({ essais: [], trouve: false, points: 0 });

// { essais: [{ chiffres, retour, at }], trouve, points }
export async function readPartie(espace, jour, discordId) {
  return fromJson(await getRedis().hget(cle.parties(espace, jour), discordId)) ?? PARTIE_VIDE();
}

export const listParties = (espace, jour) => hgetallJson(cle.parties(espace, jour));

// Joue un essai (6 chiffres déjà lus par `lireSaisie`). Renvoie
// { statut, partie, retour? } ; statut : "ok", "invalide", "termine"
// (trouvé ou essais épuisés), "occupe" (envoi déjà en cours). Verrou par
// joueur (SET NX, 10 s). `seasonId` : mois du jour de jeu (classement).
export async function jouerEssai(espace, jour, discordId, chiffres, { solution, essaisMax, seasonId, username }) {
  if (!/^\d{6}$/.test(String(chiffres ?? ""))) return { statut: "invalide", partie: await readPartie(espace, jour, discordId) };
  const verrou = await getRedis().set(cle.verrou(espace, jour, discordId), "1", { nx: true, ex: 10 });
  if (!verrou) return { statut: "occupe", partie: await readPartie(espace, jour, discordId) };
  try {
    const partie = await readPartie(espace, jour, discordId);
    if (partie.trouve || partie.essais.length >= essaisMax) return { statut: "termine", partie };
    const r = retour(chiffres, solution);
    partie.essais.push({ chiffres, retour: r, at: new Date().toISOString() });
    if (gagne(r)) {
      partie.trouve = true;
      partie.points = pointsDuJour(partie.essais.length, essaisMax);
    }
    await getRedis().hset(cle.parties(espace, jour), { [discordId]: toJson(partie) });
    await getRedis().expire(cle.parties(espace, jour), TTL_PARTIES_SECONDES);
    // Classement du mois : tout joueur y entre dès son premier essai
    if (partie.essais.length === 1) {
      await getRedis().hincrby(cle.moisJours(espace, seasonId), discordId, 1);
      await getRedis().hincrby(cle.moisPoints(espace, seasonId), discordId, 0);
    }
    if (partie.trouve) {
      await getRedis().hincrby(cle.moisPoints(espace, seasonId), discordId, partie.points);
      await writeSerie(espace, discordId, serieApresVictoire(await readSerie(espace, discordId), Number(jour)));
    }
    if (username) await getRedis().hset(cle.usernames(espace), { [discordId]: username });
    return { statut: "ok", partie, retour: r };
  } finally {
    await getRedis().del(cle.verrou(espace, jour, discordId));
  }
}

// ── Séries, pseudos, classement du mois ───────────────────────────

export async function readSerie(espace, discordId) {
  return fromJson(await getRedis().hget(cle.series(espace), discordId));
}
async function writeSerie(espace, discordId, serie) {
  await getRedis().hset(cle.series(espace), { [discordId]: toJson(serie) });
}

export const readUsernames = (espace) => hgetallRaw(cle.usernames(espace));
export const readPointsMois = (espace, seasonId) => hgetallNombres(cle.moisPoints(espace, seasonId));
export const readJoursMois = (espace, seasonId) => hgetallNombres(cle.moisJours(espace, seasonId));

// Marqueur du classement final d'un mois : true la première fois seulement
export async function marquerFinalMois(espace, seasonId) {
  return Boolean(await getRedis().set(cle.moisFinal(espace, seasonId), new Date().toISOString(), { nx: true }));
}

// ── Historique (récaps quotidiens) ────────────────────────────────

export async function writeHistoriqueEntry(espace, jour, record) {
  await getRedis().hset(cle.historique(espace), { [jour]: toJson(record) });
}

export async function getHistoriqueEntry(espace, jour) {
  return fromJson(await getRedis().hget(cle.historique(espace), String(jour)));
}

// ── PNJ (salon de test uniquement) ────────────────────────────────

export const PNJ = ["Josette", "Gérard", "Ginette", "Jean-Mi", "Bernadette"];
export const estPnj = (discordId) => String(discordId).startsWith("pnj-");

// Les PNJ jouent comme des joueurs méthodiques : une égalité au hasard parmi
// celles encore compatibles avec leurs retours (jamais sur le salon public)
export async function jouerPnj(espace, jour, { solution, essaisMax, seasonId }, rng = Math.random) {
  if (espace !== "test") return;
  const candidatsDepart = toutesLesEgalites(signeDe(solution));
  for (const [i, nom] of PNJ.entries()) {
    const id = `pnj-${i + 1}`;
    let historique = [];
    for (let e = 0; e < essaisMax; e++) {
      const possibles = compatibles(candidatsDepart, historique);
      const essai = possibles[Math.floor(rng() * possibles.length)].replace(/\D/g, "");
      const { partie } = await jouerEssai(espace, jour, id, essai, { solution, essaisMax, seasonId, username: nom });
      if (partie.trouve) break;
      historique = partie.essais;
    }
  }
}

// ── Remise à zéro ─────────────────────────────────────────────────

export async function resetPilePoil(espace) {
  const p = prefixe(espace);
  await getRedis().del(cle.state(espace), cle.solutions(espace), cle.sorties(espace), cle.usernames(espace), cle.series(espace), cle.historique(espace));
  await scanDelete(`${p}:parties:*`);
  await scanDelete(`${p}:verrou:*`);
  await scanDelete(`${p}:mois:*`);
}
