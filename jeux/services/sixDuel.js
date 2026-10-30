// ============================================================
// sixDuel.js — Six (`/six`) : un joueur contre Kévina
// (plateau public + vue éphémère du joueur) ou contre un autre joueur
// (`/six adversaire:1v1`, message public + vue éphémère par joueur). Règles pures
// dans sixRules.js.
//
// Stockage : Upstash Redis. Contre Kévina : une clé par joueur
// (`sixduel:<discordId>`), plusieurs parties en même temps possibles.
// 1v1 : une seule partie à la fois (`sixduel:pvp`).
// Chaque écriture relance l'expiration : sans action pendant
// `INACTIVITE_SECONDES`, la partie disparaît. Seules les séries de
// victoires (et leurs records) sont conservées, une par mode.
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Six), source de vérité.
//
// ⚠️ automaticDeserialization désactivée volontairement (IDs Discord
// corrompus sinon, voir bossraid.js) : JSON sérialisé/désérialisé nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { adversaire, creerDuel } from "./sixRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "data", "six", "duel.json");

export const INACTIVITE_SECONDES = 3600;

const cleDuel = (discordId) => `sixduel:${discordId}`;
const cleVerrou = (discordId) => `sixduel:lock:${discordId}`;

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

function fromJson(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

let _configCache = null;

export async function loadDuelConfig() {
  if (_configCache) return _configCache;
  _configCache = JSON.parse(await fs.readFile(CONFIG_JSON_PATH, "utf8"));
  return _configCache;
}

export async function readDuel(discordId) {
  return fromJson(await getRedis().get(cleDuel(discordId)));
}

async function writeDuel(discordId, duel) {
  await getRedis().set(cleDuel(discordId), JSON.stringify(duel), { ex: INACTIVITE_SECONDES });
}

export async function supprimerDuel(discordId) {
  await getRedis().del(cleDuel(discordId));
}

// Verrou par joueur (double clic, clics rapprochés).
async function withLock(discordId, fn) {
  for (let essai = 0; essai < 40; essai++) {
    if (await getRedis().set(cleVerrou(discordId), "1", { nx: true, px: 10_000 })) {
      try {
        return await fn();
      } finally {
        await getRedis().del(cleVerrou(discordId));
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Verrou de Six indisponible");
}

// Nouvelle partie contre Kévina (remplace une éventuelle partie en cours) :
// le joueur commence toujours. `ancien` : partie remplacée (ou null), pour
// retirer son plateau public du salon.
export async function nouveauDuel(discordId) {
  return withLock(discordId, async () => {
    const ancien = await readDuel(discordId);
    const s = await lireSerie("bot", discordId);
    // Partie précédente abandonnée ou remplacée : comptée comme une défaite
    await ecrireSerie("bot", discordId, { serie: s.enCours ? 0 : s.serie, enCours: true });
    const duel = creerDuel({ commence: "joueur" });
    await writeDuel(discordId, duel);
    return { duel, ancien };
  });
}

// Action du joueur sous verrou : `fn(duel)` modifie le duel (fonctions de
// sixRules.js) et renvoie un résultat. En fin de partie, la série est
// mise à jour et jointe au duel (`duel.series`). `nom` : pseudo du record.
// Renvoie { duel, resultat } ou { duel: null } sans partie en cours.
export async function agirDuel(discordId, fn, { nom = null, now = new Date() } = {}) {
  return withLock(discordId, async () => {
    const duel = await readDuel(discordId);
    if (!duel) return { duel: null };
    const finiAvant = duel.termine;
    const resultat = await fn(duel);
    if (!finiAvant && duel.termine) duel.series = await finSerieSolo(discordId, nom, duel.gagnant, now);
    await writeDuel(discordId, duel);
    return { duel, resultat };
  });
}

// ── Séries de victoires ───────────────────────────────────────────────────
// Une série par joueur et par mode (contre Kévina, 1v1) : +1 par victoire,
// remise à 0 par une défaite, intacte sur un match nul. Contre Kévina, une
// partie abandonnée ou remplacée compte comme une défaite (`enCours` encore
// vrai au lancement suivant). Record de chaque mode : plus longue série,
// JAMAIS effacé.

const CLE_SERIES = { bot: "sixduel:series:bot", pvp: "sixduel:series:pvp" };
const CLE_RECORDS = "sixduel:records";

// Pure : série après une partie (issue "victoire" | "defaite" | "nul").
export function serieApres(serie, issue) {
  if (issue === "victoire") return serie + 1;
  return issue === "defaite" ? 0 : serie;
}

// Pure : strictement plus longue que le record (une égalité ne détrône pas
// le détenteur), jamais une série nulle.
export function isNewRecord(actuel, serie) {
  return serie > 0 && (!actuel || serie > actuel.serie);
}

const issueDe = (gagnant, siege) => (gagnant === "nul" ? "nul" : gagnant === siege ? "victoire" : "defaite");

async function lireSerie(mode, discordId) {
  return fromJson(await getRedis().hget(CLE_SERIES[mode], discordId)) ?? { serie: 0 };
}

async function ecrireSerie(mode, discordId, serie) {
  await getRedis().hset(CLE_SERIES[mode], { [discordId]: JSON.stringify(serie) });
}

export async function lireRecord(mode) {
  return fromJson(await getRedis().hget(CLE_RECORDS, mode));
}

// Renvoie le record du mode à jour (nouveau ou inchangé), null sans record.
async function majRecord(mode, discordId, username, serie, now) {
  return withLock(`record:${mode}`, async () => {
    const actuel = await lireRecord(mode);
    if (!isNewRecord(actuel, serie)) return actuel;
    const record = { discordId, username: username || null, serie, at: now.toISOString() };
    await getRedis().hset(CLE_RECORDS, { [mode]: JSON.stringify(record) });
    return record;
  });
}

// Fin d'une partie contre Kévina : { avant, serie, record }.
async function finSerieSolo(discordId, nom, gagnant, now) {
  const { serie: avant } = await lireSerie("bot", discordId);
  const serie = serieApres(avant, issueDe(gagnant, "joueur"));
  await ecrireSerie("bot", discordId, { serie, enCours: false });
  return { avant, serie, record: await majRecord("bot", discordId, nom, serie, now) };
}

// Fin d'une partie 1v1 : { joueur: { avant, serie }, bot: { … }, record }
// (sièges du moteur).
async function finSeriesPvp(partie, now) {
  const series = {};
  for (const [siege, id] of Object.entries(partie.sieges)) {
    const { serie: avant } = await lireSerie("pvp", id);
    const serie = serieApres(avant, issueDe(partie.duel.gagnant, siege));
    await ecrireSerie("pvp", id, { serie });
    series[siege] = { avant, serie };
  }
  const g = partie.duel.gagnant;
  series.record =
    g === "nul"
      ? await lireRecord("pvp")
      : await majRecord("pvp", partie.sieges[g], partie.noms[partie.sieges[g]], series[g].serie, now);
  return series;
}

// ── 1v1 (`/six adversaire:1v1`) ─────────────────────────────────────────
// Partie : { statut: "lobby" | "enCours" | "fini", channelId, messageId,
// lanceur, noms: { discordId: pseudo }, sieges: { joueur, bot } (siège du
// moteur → discordId ; "joueur" commence), duel, webhooks: { discordId:
// { url, at } } (vue éphémère de chaque joueur, rééditée après chaque coup
// adverse), dernierCoupAt, raisonFin: "jeu" (pioche vide) | "delai" | "abandon",
// series (en fin de partie, voir finSeriesPvp()) }.

const CLE_PVP = "sixduel:pvp";
const VERROU_PVP = "pvp";

export async function readPvp() {
  return fromJson(await getRedis().get(CLE_PVP));
}

async function writePvp(partie) {
  await getRedis().set(CLE_PVP, JSON.stringify(partie), { ex: INACTIVITE_SECONDES });
}

// Siège d'un joueur dans la partie (null s'il n'y joue pas).
export function siegeDe(partie, discordId) {
  if (!partie?.sieges) return null;
  return Object.keys(partie.sieges).find((s) => partie.sieges[s] === discordId) ?? null;
}

// Délai dépassé par le joueur actif : il perd. Vérifié paresseusement à
// chaque interaction (pas de cron).
export function verifierDelai(partie, config, now = Date.now()) {
  if (partie.statut !== "enCours" || partie.duel.termine) return false;
  if (now - partie.dernierCoupAt <= config.delai_tour_minutes * 60_000) return false;
  partie.duel.termine = true;
  partie.duel.gagnant = adversaire(partie.duel.actif);
  partie.raisonFin = "delai";
  return true;
}

// Ouvre une partie (lobby) ; refusée si une autre est en cours. Un lobby
// sans adversaire depuis `delai_tour_minutes` (ou relancé par son lanceur)
// et une partie au délai dépassé sont remplacés : `ancienne` est renvoyée
// pour supprimer son message public.
export async function ouvrirPvp({ channelId, lanceur, nom }) {
  const config = await loadDuelConfig();
  return withLock(VERROU_PVP, async () => {
    const enCours = await readPvp();
    const lobbyLibre =
      enCours?.statut === "lobby" &&
      (enCours.lanceur === lanceur || Date.now() - enCours.dernierCoupAt > config.delai_tour_minutes * 60_000);
    if (enCours && enCours.statut !== "fini" && !lobbyLibre && !verifierDelai(enCours, config)) {
      return { dejaEnCours: enCours };
    }
    const ancienne = enCours && enCours.statut !== "fini" ? enCours : null;
    // Partie remplacée au délai dépassé : séries mises à jour (sans message)
    if (ancienne?.statut === "enCours" && ancienne.duel?.termine) await finSeriesPvp(ancienne, new Date());
    const partie = {
      statut: "lobby",
      channelId,
      messageId: null,
      lanceur,
      noms: { [lanceur]: nom },
      sieges: null,
      duel: null,
      webhooks: {},
      dernierCoupAt: Date.now(),
      raisonFin: null,
    };
    await writePvp(partie);
    return { partie, ancienne };
  });
}

export async function enregistrerMessagePvp(messageId) {
  return withLock(VERROU_PVP, async () => {
    const partie = await readPvp();
    if (!partie) return;
    partie.messageId = messageId;
    await writePvp(partie);
  });
}

// Action sous verrou : `fn(partie, config)` modifie la partie et renvoie un
// résultat. Le délai du tour est vérifié avant (`resultat` vaut alors
// { delai: true } sans appeler fn). Un coup joué (`resultat.coup`) remet le
// chrono à zéro.
// Renvoie { partie, config, resultat } ou { partie: null }.
export async function agirPvp(fn) {
  const config = await loadDuelConfig();
  return withLock(VERROU_PVP, async () => {
    const partie = await readPvp();
    if (!partie) return { partie: null, config };
    const finiAvant = partie.statut === "fini";
    let resultat;
    if (verifierDelai(partie, config)) resultat = { delai: true };
    else {
      resultat = (await fn(partie, config)) || {};
      if (resultat.coup) partie.dernierCoupAt = Date.now();
    }
    if (partie.statut === "enCours" && partie.duel?.termine) {
      partie.statut = "fini";
      partie.raisonFin ??= "jeu";
    }
    resultat.vientDeFinir = !finiAvant && partie.statut === "fini";
    if (resultat.vientDeFinir) partie.series = await finSeriesPvp(partie, new Date());
    await writePvp(partie);
    return { partie, config, resultat };
  });
}

// Le second joueur prend place : sièges tirés au sort, la partie commence.
export function rejoindrePvp(partie, discordId, nom, { rng = Math.random } = {}) {
  partie.noms[discordId] = nom;
  const [premier, second] = rng() < 0.5 ? [partie.lanceur, discordId] : [discordId, partie.lanceur];
  partie.sieges = { joueur: premier, bot: second };
  partie.duel = creerDuel({ commence: "joueur" });
  partie.statut = "enCours";
  partie.dernierCoupAt = Date.now();
}
