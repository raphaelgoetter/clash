// ============================================================
// bangDuel.js — Bang! Duel (`/bang`) : un joueur contre le Bot (partie
// privée, message éphémère) ou contre un autre joueur (`/bang joueurs:2`,
// message public + vue éphémère par joueur). Règles pures dans
// bangDuelRules.js.
//
// Stockage : Upstash Redis. Contre le Bot : une clé par joueur
// (`bangduel:<discordId>`), plusieurs parties en même temps possibles.
// 1v1 : une seule partie à la fois (`bangduel:pvp`), comme Blackjack et
// Gobelet Duel. Chaque écriture relance l'expiration : sans action pendant
// `INACTIVITE_SECONDES`, la partie disparaît (aucun score conservé : jeu
// libre).
//
// ⚠️ Toute modification de règle doit suivre CONTRIBUTING.md (section
// Bang! Duel), source de vérité.
//
// ⚠️ automaticDeserialization désactivée volontairement (IDs Discord
// corrompus sinon, voir bossraid.js) : JSON sérialisé/désérialisé nous-mêmes.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { adversaire, creerDuel } from "./bangDuelRules.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CONFIG_JSON_PATH = path.resolve(__dirname, "..", "..", "data", "bang", "duel.json");

export const INACTIVITE_SECONDES = 2 * 3600;

const cleDuel = (discordId) => `bangduel:${discordId}`;
const cleVerrou = (discordId) => `bangduel:lock:${discordId}`;

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
  throw new Error("Verrou de Bang! Duel indisponible");
}

// Nouvelle partie (remplace une éventuelle partie en cours).
export async function nouveauDuel(discordId) {
  const config = await loadDuelConfig();
  return withLock(discordId, async () => {
    const duel = creerDuel(config);
    await writeDuel(discordId, duel);
    return { duel, config };
  });
}

// Action du joueur sous verrou : `fn(duel, config)` modifie le duel
// (fonctions de bangDuelRules.js) et renvoie un résultat.
// Renvoie { duel, config, resultat } ou { duel: null } sans partie en cours.
export async function agirDuel(discordId, fn) {
  const config = await loadDuelConfig();
  return withLock(discordId, async () => {
    const duel = await readDuel(discordId);
    if (!duel) return { duel: null, config };
    const resultat = await fn(duel, config);
    await writeDuel(discordId, duel);
    return { duel, config, resultat };
  });
}

// ── 1v1 (`/bang joueurs:2`) ──────────────────────────────────────────
// Partie : { statut: "lobby" | "enCours" | "fini", channelId, messageId,
// lanceur, noms: { discordId: pseudo }, sieges: { joueur, bot } (siège du
// moteur → discordId ; "joueur" commence), duel, webhooks: { discordId:
// { url, at } } (vue éphémère de chaque joueur, rééditée après chaque
// action adverse), dernierCoupAt, raisonFin: "bang" | "nul" | "delai" |
// "abandon" }.

const CLE_PVP = "bangduel:pvp";
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
function verifierDelai(partie, config, now = Date.now()) {
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
      partie.raisonFin ??= partie.duel.gagnant ? "bang" : "nul";
    }
    resultat.vientDeFinir = !finiAvant && partie.statut === "fini";
    await writePvp(partie);
    return { partie, config, resultat };
  });
}

// Le second joueur prend place : sièges tirés au sort, la partie commence.
export function rejoindrePvp(partie, config, discordId, nom, { rng = Math.random } = {}) {
  partie.noms[discordId] = nom;
  const [premier, second] = rng() < 0.5 ? [partie.lanceur, discordId] : [discordId, partie.lanceur];
  partie.sieges = { joueur: premier, bot: second };
  partie.duel = creerDuel(config, { rng });
  partie.duel.debutTour = 0;
  partie.statut = "enCours";
  partie.dernierCoupAt = Date.now();
}
