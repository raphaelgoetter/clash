#!/usr/bin/env node

// ============================================================
// notifyGdcLaunch.js — Annonce de lancement de la GDC
//
// Envoie un message dans le channel Discord de chaque clan de
// la famille le jeudi matin pour annoncer le début de la
// Guerre de Clans (GDC).
//
// Clans ciblés :
//   Y8JUPC9C — La Resistance
//   LRQP20V9 — Les Resistants
//   QU9UQJRL — Les Revoltes
//
// Fonctionnement :
//   1. Vérifie le log de déduplication (data/gdc-launch-log.json)
//      pour ne pas poster deux fois la même semaine.
//   2. Appelle l'API Clash Royale (currentriverrace) pour
//      détecter si la semaine est un Colisée.
//   3. Récupère le rôle Discord du clan via l'API Discord pour
//      mentionner les membres (@LES RESISTANTS ★ / @LES REVOLTES ★).
//   4. Construit le message text + embed Colisée si nécessaire.
//   5. Poste sur le channel du clan.
//
// Usage :
//   node scripts/notifyGdcLaunch.js              # poste réellement
//   node scripts/notifyGdcLaunch.js --dry-run     # simule sans poster
//   node scripts/notifyGdcLaunch.js --force       # ignore le dedup
//
// Cron attendu : jeudi 10h30 UTC (~46 min après le reset GDC de 09:42-09:44 UTC)
// Workflow : .github/workflows/gdc-launch.yml
//
// Dépendances env :
//   DISCORD_TOKEN, DISCORD_GUILD_ID
//   DISCORD_CHANNEL_MEMBERS_Y8JUPC9C, DISCORD_CHANNEL_MEMBERS_LRQP20V9, DISCORD_CHANNEL_MEMBERS_QU9UQJRL
//   CLASH_API_KEY
//
// Log de déduplication : data/gdc-launch-log.json
//   Clé : tag du clan, Valeur : date du jeudi de la semaine (YYYY-MM-DD)
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

import { fetchCurrentRace } from "../backend/services/clashApi.js";
import {
  parisOffsetMs,
  CLAN_RESET_TIMES,
} from "../backend/services/dateUtils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// ── Constants ──────────────────────────────────────────────────

const DISCORD_API = "https://discord.com/api/v10";
const CLAN_TAGS = ["Y8JUPC9C", "LRQP20V9", "QU9UQJRL"];
const LOG_FILE = path.resolve(__dirname, "..", "data", "gdc-launch-log.json");

const CLAN_ROLE_NAMES = {
  Y8JUPC9C: "LA RESISTANCE ★",
  LRQP20V9: "LES RESISTANTS ★",
  QU9UQJRL: "LES REVOLTES ★",
};

// ── Message templates ──────────────────────────────────────────

const COLOSSEUM_SECTION =
  "Cette semaine, c'est une semaine de Colisée ! **C'est la semaine la plus importante du mois car les points remportés (ou perdus) par le clan sont multipliés par 5 !**";

const RESISTANTS_BODY = `La Guerre de Clans commence ! 🔥
{colosseum}
### OBLIGATIONS :

🔹 4 combats/jour du jeudi au lundi matin.
🔹 Si absence prévue → Prévenir dans <#881862784059592704> + quitter le clan uniquement durant l'absence (réintégration au retour).
-# Lors de votre retour vous conserverez le rôle que vous aviez avant de partir.

### OUBLIS :

🔸 En fin de semaine GDC, si moins de 12 combats joués → rétrogradation ou exclusion (selon le rôle).
-# Excuses/explications possibles sur discord ou dans le chat du clan.

### PROMOTION :

<:crown:1518889526460682280> Plus de 2600 points dans la semaine → promotion au rang "Aîné".

🎯 L'objectif n'est pas de gagner tous ses combats, "juste" de faire ses 4 combats chaque jour, car **tous les combats comptent pour le clan**. Un combat même perdu rapporte des points !

📊 On peut suivre la progression de notre clan au quotidien sur ⤑ <https://trustroyale.vercel.app/>

Détails pratiques :

- Début de la GDC : jeudi à {resetTime}
- Fin de la GDC : lundi à {resetTime}
- Durée de la GDC : 4 jours

🤜 Bonne chance à tous !`;

const RESISTANCE_BODY = `**La Guerre de Clans commence !** 🔥

⚔️ La GDC commence aujourd'hui ! Les combats dans notre clan sont **OBLIGATOIRES** chaque jour. Une absence de combat sera sanctionnée par une rétrogradation ou une orientation vers nos clans chill.
{colosseum}
😴 **Indisponibilité ?** ⤑ Prévenez sur <#881862784059592704>

🎯 L'objectif n'est pas de gagner tous ses combats, "juste" de faire ses 4 combats chaque jour, car **tous les combats comptent pour le clan**. Un combat même perdu rapporte des points !

📊 On peut suivre la progression de notre clan au quotidien sur ⤑ <https://trustroyale.vercel.app>

Détails pratiques :

- Début de la GDC : jeudi à {resetTime}
- Fin de la GDC : lundi à {resetTime}
- Durée de la GDC : 4 jours
- Nombre de combats : 4 combats par jour (soit 16 combats sur la durée de la GDC)
- Promotion si tous les combats faits sur une saison entière

🤜 **Bonne chance à tous !**`;

const REVOLTES_BODY = `**La Guerre de Clans commence !** 🔥

⚔️ La GDC commence aujourd'hui ! Les combats dans notre clan sont vivement conseillés, surtout si on souhaite intégrer les clans au-dessus un jour.
{colosseum}
🎯 L'objectif n'est pas de gagner à tout prix, mais de participer activement, car **tous les combats comptent pour le clan**. Un combat même perdu rapporte des points !

📊 On peut suivre la progression de notre clan au quotidien sur ⤑ <https://trustroyale.vercel.app>

Détails pratiques :

- Début de la GDC : jeudi à {resetTime}
- Fin de la GDC : lundi à {resetTime}
- Durée de la GDC : 4 jours
- Nombre de combats : 4 combats par jour (soit 16 combats sur la durée de la GDC)

🤜 **Merci de jouer le jeu et bonne chance à tous !**`;

// ── CLI flags ──────────────────────────────────────────────────

const DRY_RUN = process.argv.includes("--dry-run");
const FORCE = process.argv.includes("--force");

// ── Dedup log ──────────────────────────────────────────────────

async function loadLog() {
  try {
    return JSON.parse(await fs.readFile(LOG_FILE, "utf-8"));
  } catch {
    return {};
  }
}

async function saveLog(log) {
  if (DRY_RUN) return;
  await fs.mkdir(path.dirname(LOG_FILE), { recursive: true });
  await fs.writeFile(LOG_FILE, JSON.stringify(log, null, 2) + "\n");
}

// ── Role mention ───────────────────────────────────────────────

const ROLE_CACHE = new Map();

function normalizeRoleName(value) {
  return String(value ?? "")
    .trim()
    .replace(/\s+/g, " ")
    .toLowerCase();
}

async function getClanRoleId(clanTag) {
  const roleName = CLAN_ROLE_NAMES[clanTag];
  if (!roleName) return null;

  const guildId = process.env.DISCORD_GUILD_ID;
  if (!guildId) return null;

  const cacheKey = `roles:${guildId}`;
  if (!ROLE_CACHE.has(cacheKey)) {
    try {
      const res = await fetch(`${DISCORD_API}/guilds/${guildId}/roles`, {
        headers: {
          Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
        },
      });
      if (!res.ok) {
        console.warn(
          `[notifyGdcLaunch] Impossible de récupérer les rôles (${res.status})`,
        );
        ROLE_CACHE.set(cacheKey, []);
      } else {
        const roles = await res.json();
        ROLE_CACHE.set(cacheKey, Array.isArray(roles) ? roles : []);
      }
    } catch (err) {
      console.warn(`[notifyGdcLaunch] Erreur rôles:`, err.message);
      ROLE_CACHE.set(cacheKey, []);
    }
  }

  const roles = ROLE_CACHE.get(cacheKey);
  const role = roles.find(
    (r) => normalizeRoleName(r?.name) === normalizeRoleName(roleName),
  );
  return role?.id ?? null;
}

// ── Reset time in Paris ────────────────────────────────────────

function formatResetTimeParis(clanTag) {
  const cfg = CLAN_RESET_TIMES[clanTag];
  if (!cfg) return "09:40";
  const now = new Date();
  const resetUtc = Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate(),
    cfg.h,
    cfg.m,
  );
  const resetParis = new Date(resetUtc + parisOffsetMs(new Date(resetUtc)));
  const h = resetParis.getUTCHours();
  const m = resetParis.getUTCMinutes();
  return `${h}h${String(m).padStart(2, "0")}`;
}

// ── Week dedup key ─────────────────────────────────────────────

function getWeekKey() {
  const now = new Date();
  const paris = new Date(
    now.toLocaleString("en-US", { timeZone: "Europe/Paris" }),
  );
  const dow = paris.getDay();
  const diffToThu = dow >= 4 ? dow - 4 : dow + 3;
  const thu = new Date(paris);
  thu.setDate(paris.getDate() - diffToThu);
  return thu.toISOString().slice(0, 10);
}

// ── Build message ──────────────────────────────────────────────

const CLAN_TEMPLATES = {
  Y8JUPC9C: RESISTANCE_BODY,
  LRQP20V9: RESISTANTS_BODY,
  QU9UQJRL: REVOLTES_BODY,
};

function buildMessageBody(clanTag, isColosseum, resetTime) {
  const template = CLAN_TEMPLATES[clanTag] ?? REVOLTES_BODY;
  const colosseumBlock = isColosseum ? COLOSSEUM_SECTION + "\n" : "";
  return template
    .replace("{colosseum}", colosseumBlock)
    .replace(/\{resetTime\}/g, resetTime);
}

// ── Main ───────────────────────────────────────────────────────

async function main() {
  if (!process.env.DISCORD_TOKEN) {
    console.error("[notifyGdcLaunch] Variable manquante: DISCORD_TOKEN");
    process.exit(1);
  }

  const log = await loadLog();
  const weekKey = getWeekKey();
  let postedAny = false;

  for (const tag of CLAN_TAGS) {
    if (!FORCE && log[tag] === weekKey) {
      console.log(`[SKIP] ${tag} déjà posté (semaine ${weekKey})`);
      continue;
    }

    const channelId = process.env[`DISCORD_CHANNEL_MEMBERS_${tag}`];
    if (!channelId) {
      console.warn(`[SKIP] ${tag}: DISCORD_CHANNEL_MEMBERS_${tag} non défini`);
      continue;
    }

    // Détection Colisée
    let isColosseum = false;
    try {
      const race = await fetchCurrentRace(tag);
      isColosseum = race?.periodType === "colosseum";
    } catch (err) {
      console.warn(`[WARN] ${tag}: fetchCurrentRace échoué:`, err.message);
    }

    // Rôle et message
    const roleId = await getClanRoleId(tag);
    const resetTime = formatResetTimeParis(tag);
    const body = buildMessageBody(tag, isColosseum, resetTime);
    const content = roleId
      ? `<@&${roleId}>\n\n${body}`
      : `@${CLAN_ROLE_NAMES[tag]}\n\n${body}`;

    const payload = { content, allowed_mentions: { parse: [] } };
    if (roleId) payload.allowed_mentions.roles = [roleId];
    if (isColosseum) {
      payload.embeds = [
        {
          image: {
            url: "https://trustroyale.vercel.app/images/colosseum.webp",
          },
        },
      ];
    }

    // Post
    try {
      if (DRY_RUN) {
        console.log(`[DRY RUN] ${tag} → ${channelId}`);
        console.log(JSON.stringify(payload, null, 2));
      } else {
        const res = await fetch(
          `${DISCORD_API}/channels/${channelId}/messages`,
          {
            method: "POST",
            headers: {
              "Content-Type": "application/json",
              Authorization: `Bot ${process.env.DISCORD_TOKEN}`,
            },
            body: JSON.stringify(payload),
          },
        );
        if (!res.ok) {
          const txt = await res.text();
          throw new Error(`HTTP ${res.status}: ${txt}`);
        }
        console.log(`[OK] ${tag} posté dans channel ${channelId}`);
      }
    } catch (err) {
      console.error(`[ERR] ${tag}:`, err.message);
      continue;
    }

    log[tag] = weekKey;
    postedAny = true;
  }

  if (postedAny) await saveLog(log);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error(err);
    process.exit(1);
  });
}
