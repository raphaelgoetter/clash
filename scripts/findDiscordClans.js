#!/usr/bin/env node
// findDiscordClans.js
// Script ponctuel : liste les clans français dont la description mentionne
// "discord" (hors clans de type "famille" ou explicitement exclus) et qui
// comptent entre MIN_ACTIVE et MAX_ACTIVE joueurs actifs (connectés récemment).
// Usage:
//   node scripts/findDiscordClans.js
//   node scripts/findDiscordClans.js --max-active=10 --min-active=1 --active-days=3

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { writeFile } from "fs/promises";
import { fileURLToPath } from "url";
import path from "path";
import {
  searchClans,
  fetchClan,
  fetchClanMembers,
} from "../backend/services/clashApi.js";
import { parseClashDate, MS_PER_DAY } from "../backend/services/dateUtils.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const OUTPUT_FILE = path.join(__dirname, "..", "data", "discord-clans-fr.json");

const FRANCE_LOCATION_ID = 57000087;
const CONCURRENCY = 10;

function parseIntArg(name, fallback) {
  const arg = process.argv.find((a) => a.startsWith(`--${name}=`));
  if (!arg) return fallback;
  const value = Number(arg.split("=")[1]);
  return Number.isFinite(value) ? value : fallback;
}

const MAX_ACTIVE = parseIntArg("max-active", 18);
const MIN_ACTIVE = parseIntArg("min-active", 3);
const ACTIVE_DAYS = parseIntArg("active-days", 2);

// Clans passés en revue manuellement et écartés d'office (non pertinents
// malgré la correspondance sur les critères automatiques).
const EXCLUDED_CLAN_TAGS = new Set([
  "#LCCCL0VV", // CHEZ ♥️MEL♥️
  "#R2V0P09J", // La Terre 2 Feu
  "#GJUQR2QP", // SX-Ladder
  "#LVV8PQ88", // FranceNova 2
  "#G0R9L9GQ", // 'QLF' BATTALION
]);

/** Run async tasks with limited concurrency to avoid rate-limiting. */
async function pooledAllSettled(tasks, concurrency = CONCURRENCY) {
  const results = new Array(tasks.length);
  let idx = 0;
  async function worker() {
    while (idx < tasks.length) {
      const i = idx++;
      try {
        results[i] = { status: "fulfilled", value: await tasks[i]() };
      } catch (err) {
        results[i] = { status: "rejected", reason: err };
      }
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, tasks.length) }, worker),
  );
  return results;
}

// L'API plafonne chaque requête de recherche à ~640 résultats, quel que soit
// le nombre réel de clans correspondants. En découpant par tranches de
// taille (minMembers/maxMembers), chaque tranche renvoie son propre lot de
// 640 clans avec un recouvrement partiel seulement — vérifié empiriquement :
// 10 tranches de 5 membres (2 à 51) donnent 5 728 clans uniques au lieu de
// 640 pour une requête sans filtre de taille.
const CLAN_SIZE_BAND_WIDTH = 2;
const MAX_CLAN_SIZE = 50;

/** Récupère tous les clans d'une location, en découpant par tranches de
 * taille pour contourner le plafond ~640 résultats par requête. */
async function fetchAllClansForLocation(locationId) {
  const clans = new Map();
  for (let min = 2; min <= MAX_CLAN_SIZE; min += CLAN_SIZE_BAND_WIDTH) {
    const max = Math.min(min + CLAN_SIZE_BAND_WIDTH, MAX_CLAN_SIZE);
    let after;
    let bandCount = 0;
    do {
      const { items, cursorAfter } = await searchClans({
        locationId,
        minMembers: min,
        maxMembers: max,
        limit: 1000,
        after,
      });
      for (const clan of items) {
        if (!clans.has(clan.tag)) clans.set(clan.tag, clan);
      }
      bandCount += items.length;
      after = cursorAfter;
    } while (after);
    console.log(
      `  tranche ${min}-${max} membres: ${bandCount} résultats (cumul unique: ${clans.size})`,
    );
  }
  return Array.from(clans.values());
}

function countActiveMembers(members, now = new Date()) {
  let active = 0;
  for (const member of members ?? []) {
    if (!member?.lastSeen) continue;
    const lastSeenDate = parseClashDate(member.lastSeen);
    const daysInactive = (now.getTime() - lastSeenDate.getTime()) / MS_PER_DAY;
    if (daysInactive < ACTIVE_DAYS) active += 1;
  }
  return active;
}

async function main() {
  console.log(
    `Recherche des clans FR (locationId=${FRANCE_LOCATION_ID})...`,
  );
  const clans = await fetchAllClansForLocation(FRANCE_LOCATION_ID);
  console.log(`${clans.length} clans FR trouvés. Récupération des descriptions...`);

  const detailResults = await pooledAllSettled(
    clans.map((c) => () => fetchClan(c.tag)),
  );

  const discordClans = [];
  detailResults.forEach((result, i) => {
    if (result.status !== "fulfilled") {
      console.warn(
        `  ⚠️ échec fetchClan(${clans[i].tag}): ${result.reason?.message}`,
      );
      return;
    }
    const clan = result.value;
    const description = clan.description?.toLowerCase() ?? "";
    if (EXCLUDED_CLAN_TAGS.has(clan.tag)) return;
    if (!description.includes("discord")) return;
    if (description.includes("famille")) return;
    discordClans.push(clan);
  });
  console.log(
    `${discordClans.length} clans FR mentionnent "discord" (hors "famille" et exclusions manuelles) dans leur description. Vérification de l'activité des membres...`,
  );

  const memberResults = await pooledAllSettled(
    discordClans.map((c) => () => fetchClanMembers(c.tag)),
  );

  const matches = [];
  memberResults.forEach((result, i) => {
    const clan = discordClans[i];
    if (result.status !== "fulfilled") {
      console.warn(
        `  ⚠️ échec fetchClanMembers(${clan.tag}): ${result.reason?.message}`,
      );
      return;
    }
    const members = result.value;
    const activeCount = countActiveMembers(members);
    if (activeCount >= MIN_ACTIVE && activeCount <= MAX_ACTIVE) {
      matches.push({
        tag: clan.tag,
        name: clan.name,
        members: members.length,
        activeMembers: activeCount,
        description: clan.description,
      });
    }
  });

  matches.sort((a, b) => a.activeMembers - b.activeMembers);

  await writeFile(OUTPUT_FILE, JSON.stringify(matches, null, 2));

  console.log(
    `\n${matches.length} clan(s) FR avec "discord" en description et entre ${MIN_ACTIVE} et ${MAX_ACTIVE} joueurs actifs (< ${ACTIVE_DAYS}j) :\n`,
  );
  for (const clan of matches) {
    console.log(
      `- ${clan.name} (${clan.tag}) — ${clan.activeMembers}/${clan.members} actifs`,
    );
  }
  console.log(`\nRésultat écrit dans ${OUTPUT_FILE}`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  main().catch((err) => {
    console.error("[findDiscordClans] Erreur:", err.message);
    process.exit(1);
  });
}
