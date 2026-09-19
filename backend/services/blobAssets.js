// ============================================================
// blobAssets.js — Accès aux assets binaires de rendu (images composées par
// resvg, police embarquée) depuis Vercel Blob plutôt que depuis data/ sur
// disque.
//
// Pourquoi : une Vercel Function n'a aucun accès au dépôt Git au runtime,
// seulement aux fichiers tracés dans son bundle au build (@vercel/nft). Les
// lectures dynamiques (fs.readFile avec un nom de fichier venu d'un
// catalogue JSON, comme dans paletteImage.js/zoomImage.js) forcent le
// traceur à embarquer le RÉPERTOIRE ENTIER — data/jeux-visuels/ pèse à lui
// seul 38 Mo, réembarqués à CHAQUE déploiement retenu (30j vivant + 30j de
// récupération après suppression). Cause principale du dépassement de
// Functions Storage (voir mémoire projet, sept. 2026). Uploadés via
// scripts/uploadImageAssetsToBlob.js — les fichiers restent versionnés dans
// data/ (source de vérité), Blob n'en est qu'une copie servie au runtime.
//
// Access "private" (même convention que championPredictions.js) : pas
// juste un choix, une NÉCESSITÉ pour Palette/Zoom — ces images sont
// anti-spoiler, une URL publique devinable exposerait la réponse avant
// résolution de la manche.
//
// Compromis assumé : ceci réintroduit une requête réseau (absente avant
// cette migration, voir l'en-tête historique de zoomImage.js) au premier
// appel par instance de fonction — atténué par le cache mémoire ci-dessous,
// qui survit tant que l'instance Fluid Compute reste chaude.
// ============================================================

import fs from "fs/promises";

const memCache = new Map(); // relativePath -> Buffer

function blobStoreId() {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  if (!token) return null;
  return token.split("_")[3] || null;
}

function blobUrlFor(relativePath) {
  const storeId = blobStoreId();
  if (!storeId) return null;
  return `https://${storeId}.private.blob.vercel-storage.com/${relativePath}`;
}

async function fetchWithRetry(url) {
  const token = process.env.BLOB_READ_WRITE_TOKEN;
  let lastErr;
  for (const delay of [0, 1000, 2000, 4000, 8000]) {
    if (delay) await new Promise((r) => setTimeout(r, delay));
    try {
      const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
      if (res.ok) return Buffer.from(await res.arrayBuffer());
      lastErr = new Error(`HTTP ${res.status}`);
    } catch (err) {
      lastErr = err;
    }
  }
  throw new Error(`[blobAssets] Échec de lecture ${url}: ${lastErr?.message}`);
}

// Lit un asset binaire depuis Blob, avec cache mémoire par instance de
// fonction (évite de re-télécharger à chaque requête tant que l'instance
// reste chaude).
export async function readBlobAsset(relativePath) {
  if (memCache.has(relativePath)) return memCache.get(relativePath);
  const url = blobUrlFor(relativePath);
  if (!url) throw new Error("[blobAssets] BLOB_READ_WRITE_TOKEN manquant");
  const buffer = await fetchWithRetry(url);
  memCache.set(relativePath, buffer);
  return buffer;
}

// Cas particulier de la police embarquée : resvg-js n'accepte qu'un CHEMIN
// de fichier local (option `font.fontFiles`), jamais un Buffer — on écrit
// donc l'octet une seule fois dans /tmp (seul répertoire inscriptible d'une
// Vercel Function) puis on réutilise ce chemin pour toute la durée de vie
// de l'instance.
const fontPathCache = new Map(); // relativePath -> "/tmp/..."

export async function readBlobFontPath(relativePath) {
  if (fontPathCache.has(relativePath)) return fontPathCache.get(relativePath);
  const buffer = await readBlobAsset(relativePath);
  const tmpFile = `/tmp/${relativePath.split("/").pop()}`;
  await fs.writeFile(tmpFile, buffer);
  fontPathCache.set(relativePath, tmpFile);
  return tmpFile;
}
