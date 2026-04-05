#!/usr/bin/env node
// notifyWarSummary.js
// Poste un embed résumé de la journée de GDC qui vient de se terminer dans
// chaque channel de clan. Doit être exécuté après 09:40 UTC.
//
// Usage :
//   node scripts/notifyWarSummary.js           — mode normal (poste sur Discord)
//   node scripts/notifyWarSummary.js --dry-run — affiche l'embed sans poster

import dotenv from 'dotenv';
dotenv.config({ path: './.env' });

import { readFile, writeFile } from 'fs/promises';
import { existsSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';
import fetch from 'node-fetch';
import { ALLOWED_CLANS } from '../backend/routes/clan.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SNAP_DIR = path.join(__dirname, '..', 'data', 'snapshots');
const CACHE_DIR = path.join(__dirname, '..', 'frontend', 'public', 'clan-cache');
const LOG_FILE = path.join(__dirname, '..', 'data', 'war-summary-log.json');

const DISCORD_API = 'https://discord.com/api/v10';
const DRY_RUN = process.argv.includes('--dry-run');

// ── Déduplication ────────────────────────────────────────────
// Format : { "LRQP20V9": "saturday:2026-04-04", ... }

async function loadLog() {
  if (!existsSync(LOG_FILE)) return {};
  try {
    return JSON.parse(await readFile(LOG_FILE, 'utf-8'));
  } catch {
    return {};
  }
}

async function markPosted(log, tag, warDay, realDay) {
  log[tag] = `${warDay}:${realDay}`;
  if (!DRY_RUN) await writeFile(LOG_FILE, JSON.stringify(log, null, 2));
}

function alreadyPosted(log, tag, warDay, realDay) {
  return log[tag] === `${warDay}:${realDay}`;
}

const WAR_DAYS = ['thursday', 'friday', 'saturday', 'sunday'];
const WAR_DAY_NUMBER = { thursday: 1, friday: 2, saturday: 3, sunday: 4 };
const WAR_DAY_FR = { thursday: 'jeudi', friday: 'vendredi', saturday: 'samedi', sunday: 'dimanche' };

/**
 * Retourne la journée GDC qui vient de se terminer (à appeler après 09:40 UTC).
 * On recule de 90 minutes pour se trouver avant le reset et identifier la journée écoulée.
 * Exemples :
 *   10:05 UTC vendredi → 08:35 UTC vendredi (avant reset) → jeudi GDC (J1)
 *   10:05 UTC lundi    → 08:35 UTC lundi    (avant reset) → dimanche GDC (J4)
 */
function getEndedWarDay(now = new Date()) {
  const refTime = new Date(now.getTime() - 90 * 60_000);
  const resetUtcMs = (9 * 60 + 40) * 60 * 1000;
  const msOfDayUtc =
    refTime.getUTCHours() * 3_600_000 +
    refTime.getUTCMinutes() * 60_000 +
    refTime.getUTCSeconds() * 1000;

  const refParis = new Date(refTime.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  // Avant 09:40 UTC, on est encore dans la journée précédente en terme GDC.
  if (msOfDayUtc < resetUtcMs) {
    refParis.setDate(refParis.getDate() - 1);
  }

  const names = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday'];
  const warDay = names[refParis.getDay()];
  if (!WAR_DAYS.includes(warDay)) return null;

  const y = refParis.getFullYear();
  const mo = String(refParis.getMonth() + 1).padStart(2, '0');
  const d = String(refParis.getDate()).padStart(2, '0');
  return { warDay, realDay: `${y}-${mo}-${d}` };
}

/**
 * Charge le fichier snapshot JSON pour un clan (lecture directe depuis le disque).
 */
async function loadSnapshots(tag) {
  const clean = tag.replace(/[^A-Za-z0-9]/g, '');
  const filePath = path.join(SNAP_DIR, `${clean}.json`);
  if (!existsSync(filePath)) return [];
  const raw = await readFile(filePath, 'utf-8');
  return JSON.parse(raw);
}

/**
 * Lit le nom du clan depuis le cache persisté.
 */
async function readClanName(tag) {
  const filePath = path.join(CACHE_DIR, `${tag}.json`);
  if (!existsSync(filePath)) return `#${tag}`;
  const raw = await readFile(filePath, 'utf-8');
  const data = JSON.parse(raw);
  return data.clan?.name ?? `#${tag}`;
}

/**
 * Calcule le total de fame d'une journée GDC depuis _cumulFame.
 * Colosseum : la fame s'accumule toute la semaine → on soustrait le cumul du jour précédent.
 * warDay    : le score est remis à 0 à chaque reset → _cumulFame = total du jour uniquement.
 */
function computeDailyFame(dayEntry, prevDayEntry) {
  const todayCumul = Object.values(dayEntry._cumulFame ?? {}).reduce((a, b) => a + b, 0);
  if (!prevDayEntry) return todayCumul;
  if (dayEntry.periodType === 'colosseum') {
    const prevCumul = Object.values(prevDayEntry._cumulFame ?? {}).reduce((a, b) => a + b, 0);
    return Math.max(0, todayCumul - prevCumul);
  }
  // warDay : total du jour directement
  return todayCumul;
}

/** Formate un entier avec séparateur de milliers français : 88400 → "88 400". */
function fmt(n) {
  return Math.round(n).toLocaleString('fr-FR');
}

/** Formate un delta signé avec émoji de tendance. */
function fmtDelta(delta) {
  if (delta > 0) return `(+${fmt(delta)} 📈)`;
  if (delta < 0) return `(${fmt(delta)} 📉)`;
  return '(stable)';
}

/**
 * Construit et envoie l'embed Discord du résumé GDC pour un clan.
 *
 * @param {string} tag
 * @param {string} clanName
 * @param {object} dayEntry       - snapshot de la journée terminée
 * @param {object|null} prevDayEntry      - snapshot de la veille (J-1)
 * @param {object|null} prevPrevDayEntry  - snapshot de l'avant-veille (J-2, pour calcul delta colosseum)
 */
async function postWarSummary(tag, clanName, dayEntry, prevDayEntry, prevPrevDayEntry) {
  const channelId = process.env[`DISCORD_CHANNEL_MEMBERS_${tag}`];
  const token = process.env.DISCORD_TOKEN;
  const { warDay } = dayEntry;

  // Totaux du jour
  const totalDecks = Object.values(dayEntry.decks ?? {}).reduce((a, b) => a + b, 0);
  const hasFameData = Object.keys(dayEntry._cumulFame ?? {}).length > 0;
  const totalFame = hasFameData ? computeDailyFame(dayEntry, prevDayEntry) : null;

  // Totaux du jour précédent (pour les deltas)
  const prevDecks =
    prevDayEntry && Object.keys(prevDayEntry.decks ?? {}).length > 0
      ? Object.values(prevDayEntry.decks).reduce((a, b) => a + b, 0)
      : null;
  const prevFame =
    prevDayEntry && Object.keys(prevDayEntry._cumulFame ?? {}).length > 0
      ? computeDailyFame(prevDayEntry, prevPrevDayEntry)
      : null;

  // Couleur selon la tendance (fame en priorité, decks en fallback)
  let color = 0x5865f2; // bleu neutre (J1 ou données insuffisantes)
  if (totalFame !== null && prevFame !== null) {
    color = totalFame >= prevFame ? 0x57f287 : 0xed4245;
  } else if (prevDecks !== null) {
    color = totalDecks >= prevDecks ? 0x57f287 : 0xed4245;
  }

  const fields = [];

  if (hasFameData) {
    let line = `${fmt(totalFame)} pts`;
    if (prevFame !== null) line += ` ${fmtDelta(totalFame - prevFame)}`;
    fields.push({ name: '⚔️ Points marqués', value: line, inline: false });
  }

  {
    let line = `${fmt(totalDecks)} decks`;
    if (prevDecks !== null) line += ` ${fmtDelta(totalDecks - prevDecks)}`;
    fields.push({ name: '🃏 Decks joués', value: line, inline: false });
  }

  const now = new Date();
  const paris = new Date(now.toLocaleString('en-US', { timeZone: 'Europe/Paris' }));
  const dateStr = paris.toLocaleDateString('fr-FR', { timeZone: 'Europe/Paris' });
  const timeStr = paris.toLocaleTimeString('fr-FR', {
    timeZone: 'Europe/Paris',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  });

  const embed = {
    title: clanName,
    description: `Résumé Journée ${WAR_DAY_NUMBER[warDay]} de GDC (${WAR_DAY_FR[warDay]})`,
    color,
    fields,
    footer: { text: `Résumé posté le : ${dateStr} à ${timeStr}` },
  };

  if (DRY_RUN) {
    console.log(`\n[${tag}] ── DRY-RUN ── embed pour le channel ${channelId ?? '(non configuré)'} :`);
    console.log(JSON.stringify({ embeds: [embed] }, null, 2));
    return;
  }

  if (!channelId) {
    console.log(`[${tag}] DISCORD_CHANNEL_MEMBERS_${tag} non configuré — résumé ignoré.`);
    return;
  }
  if (!token) {
    console.log(`[${tag}] DISCORD_TOKEN non configuré — résumé ignoré.`);
    return;
  }

  const res = await fetch(`${DISCORD_API}/channels/${channelId}/messages`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bot ${token}`,
    },
    body: JSON.stringify({ embeds: [embed] }),
  });

  if (!res.ok) {
    const err = await res.text();
    throw new Error(`Discord API ${res.status}: ${err}`);
  }

  const fameStr = totalFame !== null ? `${fmt(totalFame)} pts` : 'fame N/A';
  console.log(`[${tag}] Résumé GDC posté — J${WAR_DAY_NUMBER[warDay]} (${fameStr}, ${fmt(totalDecks)} decks).`);
}

async function main() {
  const endedDay = getEndedWarDay();
  if (!endedDay) {
    console.log('Pas de journée GDC terminée à cette heure — rien à poster.');
    process.exit(0);
  }

  const { warDay, realDay } = endedDay;
  console.log(`Journée GDC terminée : ${warDay} (${realDay})`);

  const log = await loadLog();

  for (const tag of ALLOWED_CLANS) {
    try {
      // Vérification anti-doublon
      if (alreadyPosted(log, tag, warDay, realDay)) {
        console.log(`[${tag}] Résumé déjà posté pour ${warDay} ${realDay} — ignoré.`);
        continue;
      }

      const [snapshots, clanName] = await Promise.all([loadSnapshots(tag), readClanName(tag)]);

      if (!snapshots.length) {
        console.log(`[${tag}] Pas de snapshots disponibles — résumé ignoré.`);
        continue;
      }

      // Chercher la semaine contenant ce realDay
      let dayEntry = null;
      let prevDayEntry = null;
      let prevPrevDayEntry = null;

      for (const week of snapshots) {
        const dayIdx = (week.days ?? []).findIndex((d) => d.realDay === realDay);
        if (dayIdx === -1) continue;
        dayEntry = week.days[dayIdx];
        prevDayEntry = dayIdx > 0 ? week.days[dayIdx - 1] : null;
        prevPrevDayEntry = dayIdx > 1 ? week.days[dayIdx - 2] : null;
        break;
      }

      if (!dayEntry?.snapshotTime) {
        console.log(`[${tag}] Pas de snapshot pour ${realDay} (${warDay}) — résumé ignoré.`);
        continue;
      }

      const hasData =
        Object.keys(dayEntry.decks ?? {}).length > 0 ||
        Object.keys(dayEntry._cumulFame ?? {}).length > 0;
      if (!hasData) {
        console.log(`[${tag}] Snapshot vide pour ${realDay} — résumé ignoré.`);
        continue;
      }

      await postWarSummary(tag, clanName, dayEntry, prevDayEntry, prevPrevDayEntry);
      await markPosted(log, tag, warDay, realDay);
    } catch (err) {
      console.error(`[${tag}] Erreur : ${err.message}`);
    }
  }

  process.exit(0);
}

main();
