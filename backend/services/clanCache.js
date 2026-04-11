// ============================================================
// clanCache.js — cache de données clan statiques pour le frontend
//
// ⚠️  VERCEL SERVERLESS : le système de fichiers est en LECTURE SEULE
// partout sauf dans /tmp. Toute écriture en dehors de /tmp échoue
// silencieusement. Règle générale : écrire dans /tmp/<sous-dossier>/,
// lire d'abord /tmp puis le bundle statique en fallback.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
// Répertoire statique bundlé (lecture uniquement sur Vercel, pré-généré par npm run cache)
const BUNDLE_DIR = path.resolve(
  __dirname,
  "..",
  "..",
  "frontend",
  "public",
  "clan-cache",
);
// Répertoire d'écriture : /tmp est le seul dossier writable sur Vercel Serverless
const WRITE_DIR = path.join("/tmp", "clan-cache");

async function ensureDir() {
  try {
    await fs.mkdir(WRITE_DIR, { recursive: true });
  } catch (_) {}
}

function writeFilename(clanTag) {
  const clean = clanTag.replace(/[^A-Za-z0-9]/g, "");
  return path.join(WRITE_DIR, `${clean}.json`);
}

function bundleFilename(clanTag) {
  const clean = clanTag.replace(/[^A-Za-z0-9]/g, "");
  return path.join(BUNDLE_DIR, `${clean}.json`);
}

function stripClanCachePayload(payload) {
  if (!payload || typeof payload !== "object") return payload;

  const {
    lastWarSummary,
    warSnapshotDays,
    currentWarDays,
    decksYesterdayAtThisHour,
    // these are war/day specific and must be kept in snapshots or live API only
    ...rest
  } = payload;

  // warDays/warDecks sont conservés dans le cache pour que le fallback statique
  // affiche la colonne "This War" même quand l'API live échoue (données max 1h stale).
  // Ils seront rechargés à chaque regénération de cache (cron horaire).

  return rest;
}

export async function loadClanCache(clanTag) {
  await ensureDir();
  // Priorité au fichier écrit par la fonction live (/tmp) — plus récent.
  // Fallback sur le fichier bundlé (pré-généré par npm run cache).
  for (const file of [writeFilename(clanTag), bundleFilename(clanTag)]) {
    try {
      const txt = await fs.readFile(file, "utf-8");
      return JSON.parse(txt);
    } catch (_) {
      // fichier absent ou illisible, essayer le suivant
    }
  }
  return null;
}

export async function saveClanCache(clanTag, payload) {
  await ensureDir();
  const file = writeFilename(clanTag);
  const data = stripClanCachePayload(payload);
  try {
    await fs.writeFile(file, JSON.stringify(data, null, 2));
  } catch (_) {}
}

// Écrit dans le bundle statique (frontend/public/clan-cache/).
// Réservé aux scripts CI (refreshClanCache.js) — jamais appelé depuis une fonction Vercel.
export async function saveClanCacheToBundle(clanTag, payload) {
  const clean = clanTag.replace(/[^A-Za-z0-9]/g, "");
  const file = path.join(BUNDLE_DIR, `${clean}.json`);
  const data = stripClanCachePayload(payload);
  await fs.mkdir(BUNDLE_DIR, { recursive: true });
  await fs.writeFile(file, JSON.stringify(data, null, 2));
}
