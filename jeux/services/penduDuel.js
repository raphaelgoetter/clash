// ============================================================
// penduDuel.js — Pendu (`/pendu`), 1v1 seulement : message public + vue
// éphémère par joueur, une seule partie à la fois (`penduduel:pvp`).
// Règles pures dans penduRules.js.
//
// Chaque écriture relance l'expiration : sans action pendant
// `INACTIVITE_SECONDES`, la partie disparaît. Seules les séries de
// victoires (et leur record) sont conservées.
//
// ⚠️ Toute modification de règle doit suivre jeux/CONTRIBUTING.md (section
// Pendu), source de vérité.
//
// ⚠️ automaticDeserialization désactivée volontairement (IDs Discord
// corrompus sinon, voir bossraid.js) : JSON sérialisé/désérialisé nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { appliquerDelais, creerDuel } from "./penduRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "data", "pendu", "duel.json");

export const INACTIVITE_SECONDES = 3600;

const cleVerrou = (nom) => `penduduel:lock:${nom}`;

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

// Verrou (double clic, clics rapprochés des deux joueurs).
async function withLock(nom, fn) {
  for (let essai = 0; essai < 40; essai++) {
    if (await getRedis().set(cleVerrou(nom), "1", { nx: true, px: 10_000 })) {
      try {
        return await fn();
      } finally {
        await getRedis().del(cleVerrou(nom));
      }
    }
    await new Promise((r) => setTimeout(r, 150));
  }
  throw new Error("Verrou du Pendu indisponible");
}

// ── Séries de victoires ───────────────────────────────────────────────────
// Une série par joueur : +1 par victoire, remise à 0 par une défaite,
// intacte sur un match nul. Record : plus longue série, JAMAIS effacé.

const CLE_SERIES = "penduduel:series";
const CLE_RECORD = "penduduel:record";

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

async function lireSerie(discordId) {
  return fromJson(await getRedis().hget(CLE_SERIES, discordId)) ?? { serie: 0 };
}

export async function lireRecord() {
  return fromJson(await getRedis().get(CLE_RECORD));
}

// Renvoie le record à jour (nouveau ou inchangé), null sans record.
async function majRecord(discordId, username, serie, now) {
  return withLock("record", async () => {
    const actuel = await lireRecord();
    if (!isNewRecord(actuel, serie)) return actuel;
    const record = { discordId, username: username || null, serie, at: now.toISOString() };
    await getRedis().set(CLE_RECORD, JSON.stringify(record));
    return record;
  });
}

// Fin de partie : { joueur: { avant, serie }, bot: { … }, record } (sièges
// du moteur).
async function finSeries(partie, now) {
  const series = {};
  for (const [siege, id] of Object.entries(partie.sieges)) {
    const { serie: avant } = await lireSerie(id);
    const serie = serieApres(avant, issueDe(partie.duel.gagnant, siege));
    await getRedis().hset(CLE_SERIES, { [id]: JSON.stringify({ serie }) });
    series[siege] = { avant, serie };
  }
  const g = partie.duel.gagnant;
  series.record = g === "nul" ? await lireRecord() : await majRecord(partie.sieges[g], partie.noms[partie.sieges[g]], series[g].serie, now);
  return series;
}

// ── Partie ────────────────────────────────────────────────────────────────
// Partie : { statut: "lobby" | "enCours" | "fini", channelId, messageId,
// lanceur, noms: { discordId: pseudo }, sieges: { joueur, bot } (siège du
// moteur → discordId), duel, webhooks: { discordId: { url, at } } (vue
// éphémère de chaque joueur, rééditée à la fin de la partie), dernierCoupAt,
// raisonFin: "jeu" | "abandon", series (en fin de partie, voir finSeries()) }.

const CLE_PVP = "penduduel:pvp";
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

// Partie sans action depuis INACTIVITE_PVP_MS : abandonnée, remplacée par
// le prochain `/pendu` (séries inchangées). Filet de sécurité : le délai par
// action (1 min) finit normalement la partie bien avant.
export const INACTIVITE_PVP_MS = 5 * 60_000;
export const pvpAbandonnee = (partie, now = Date.now()) => partie.statut === "enCours" && now - partie.dernierCoupAt > INACTIVITE_PVP_MS;

// Ouvre une partie (lobby) ; refusée si une autre est en cours. Un lobby
// sans adversaire depuis 1 minute (ou relancé par son lanceur) et une
// partie abandonnée sont remplacés : `ancienne` est renvoyée pour supprimer
// son message public.
export async function ouvrirPvp({ channelId, lanceur, nom }) {
  return withLock(VERROU_PVP, async () => {
    const enCours = await readPvp();
    const lobbyLibre = enCours?.statut === "lobby" && (enCours.lanceur === lanceur || Date.now() - enCours.dernierCoupAt > 60_000);
    if (enCours && enCours.statut !== "fini" && !lobbyLibre && !pvpAbandonnee(enCours)) return { dejaEnCours: enCours };
    const ancienne = enCours && enCours.statut !== "fini" ? enCours : null;
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
// résultat. Avant elle, les délais dépassés sont appliqués (joueur sans
// action depuis `delai_action_secondes` : pendu ; `resultat.delais` : sièges
// concernés). Une action (`resultat.coup`) note l'heure (`dernierCoupAt`).
// Renvoie { partie, config, resultat } ou { partie: null }.
export async function agirPvp(fn, { now = Date.now() } = {}) {
  const config = await loadDuelConfig();
  return withLock(VERROU_PVP, async () => {
    const partie = await readPvp();
    if (!partie) return { partie: null, config };
    const finiAvant = partie.statut === "fini";
    const delais = partie.statut === "enCours" ? appliquerDelais(partie.duel, config.delai_action_secondes * 1000, now) : [];
    const resultat = (await fn(partie, config)) || {};
    resultat.delais = delais;
    if (resultat.coup) partie.dernierCoupAt = now;
    if (partie.statut === "enCours" && partie.duel?.termine) {
      partie.statut = "fini";
      partie.raisonFin ??= partie.duel.abandon ? "abandon" : "jeu";
    }
    resultat.vientDeFinir = !finiAvant && partie.statut === "fini";
    if (resultat.vientDeFinir) partie.series = await finSeries(partie, new Date(now));
    await writePvp(partie);
    return { partie, config, resultat };
  });
}

// Le second joueur prend place, la partie commence (même mot pour les
// deux, chrono de chacun lancé).
export function rejoindrePvp(partie, discordId, nom, { now = Date.now(), rng = Math.random } = {}) {
  partie.noms[discordId] = nom;
  const [premier, second] = rng() < 0.5 ? [partie.lanceur, discordId] : [discordId, partie.lanceur];
  partie.sieges = { joueur: premier, bot: second };
  partie.duel = creerDuel({ now, rng });
  partie.statut = "enCours";
  partie.dernierCoupAt = now;
}
