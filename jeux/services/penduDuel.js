// ============================================================
// penduDuel.js — Pendu (`/pendu`) : message public + vue éphémère par
// joueur. Solo (`/pendu mode:solo`) : une partie par joueur
// (`penduduel:solo:<discordId>`), plusieurs en même temps. 1v1 : une seule
// partie à la fois (`penduduel:pvp`). Règles pures dans penduRules.js.
//
// Une partie est désignée par son identifiant `id` : "pvp", ou le
// discordId du joueur en solo.
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
// Une série par joueur et par mode (solo : mots trouvés d'affilée ; 1v1 :
// victoires d'affilée) : +1 par victoire, remise à 0 par une défaite,
// intacte sur un match nul. En solo, une partie abandonnée ou remplacée
// compte comme une défaite (`enCours` encore vrai au lancement suivant).
// Record de chaque mode : plus longue série, JAMAIS effacé.

const CLE_SERIES = { solo: "penduduel:series:solo", pvp: "penduduel:series:pvp" };
const CLE_RECORDS = "penduduel:records";

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

// Fin de partie : { joueur: { avant, serie }, bot: { … } (1v1), record }
// (sièges du moteur).
async function finSeries(partie, now) {
  const series = {};
  for (const [siege, id] of Object.entries(partie.sieges)) {
    const { serie: avant } = await lireSerie(partie.mode, id);
    const serie = serieApres(avant, issueDe(partie.duel.gagnant, siege));
    await ecrireSerie(partie.mode, id, { serie, enCours: false });
    series[siege] = { avant, serie };
  }
  const g = partie.duel.gagnant;
  series.record =
    g && g !== "nul"
      ? await majRecord(partie.mode, partie.sieges[g], partie.noms[partie.sieges[g]], series[g].serie, now)
      : await lireRecord(partie.mode);
  return series;
}

// ── Partie ────────────────────────────────────────────────────────────────
// Partie : { mode: "solo" | "pvp", statut: "lobby" | "enCours" | "fini",
// channelId, messageId, lanceur, noms: { discordId: pseudo }, sieges:
// { joueur, bot } (siège du moteur → discordId ; solo : { joueur }), duel,
// webhooks: { discordId: { url, at } } (vue éphémère de chaque joueur,
// rééditée à la fin de la partie), dernierCoupAt, raisonFin: "jeu" |
// "abandon", series (en fin de partie, voir finSeries()) }.

const ID_PVP = "pvp";
const clePartie = (id) => (id === ID_PVP ? "penduduel:pvp" : `penduduel:solo:${id}`);

export async function readPartie(id) {
  return fromJson(await getRedis().get(clePartie(id)));
}

export const readPvp = () => readPartie(ID_PVP);

async function writePartie(id, partie) {
  await getRedis().set(clePartie(id), JSON.stringify(partie), { ex: INACTIVITE_SECONDES });
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
  return withLock(ID_PVP, async () => {
    const enCours = await readPvp();
    const lobbyLibre = enCours?.statut === "lobby" && (enCours.lanceur === lanceur || Date.now() - enCours.dernierCoupAt > 60_000);
    if (enCours && enCours.statut !== "fini" && !lobbyLibre && !pvpAbandonnee(enCours)) return { dejaEnCours: enCours };
    const ancienne = enCours && enCours.statut !== "fini" ? enCours : null;
    const partie = {
      mode: "pvp",
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
    await writePartie(ID_PVP, partie);
    return { partie, ancienne };
  });
}

// Nouvelle partie solo (remplace une éventuelle partie en cours du joueur,
// renvoyée dans `ancienne` pour supprimer son message public).
export async function nouvelleSolo({ channelId, discordId, nom, now = Date.now(), rng = Math.random }) {
  return withLock(discordId, async () => {
    const ancienne = await readPartie(discordId);
    const s = await lireSerie("solo", discordId);
    // Partie précédente abandonnée ou remplacée : comptée comme une défaite
    await ecrireSerie("solo", discordId, { serie: s.enCours ? 0 : s.serie, enCours: true });
    const partie = {
      mode: "solo",
      statut: "enCours",
      channelId,
      messageId: null,
      lanceur: discordId,
      noms: { [discordId]: nom },
      sieges: { joueur: discordId },
      duel: creerDuel({ now, rng, sieges: ["joueur"] }),
      webhooks: {},
      dernierCoupAt: now,
      raisonFin: null,
    };
    await writePartie(discordId, partie);
    return { partie, ancienne: ancienne?.statut === "enCours" ? ancienne : null };
  });
}

export async function enregistrerMessage(id, messageId) {
  return withLock(id, async () => {
    const partie = await readPartie(id);
    if (!partie) return;
    partie.messageId = messageId;
    await writePartie(id, partie);
  });
}

// Action sous verrou : `fn(partie, config)` modifie la partie et renvoie un
// résultat. Avant elle, les délais dépassés sont appliqués (joueur sans
// action depuis `delai_action_secondes` : pendu ; `resultat.delais` : sièges
// concernés). Une action (`resultat.coup`) note l'heure (`dernierCoupAt`).
// Renvoie { partie, config, resultat } ou { partie: null }.
export async function agir(id, fn, { now = Date.now() } = {}) {
  const config = await loadDuelConfig();
  return withLock(id, async () => {
    const partie = await readPartie(id);
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
    await writePartie(id, partie);
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
