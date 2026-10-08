// ============================================================
// cardArt.js — Illustrations de base que l'API Clash Royale sert encore
// avec un ancien design (vérifié en jeu et sur RoyaleAPI, cf.
// temp/compare_card_art.mjs) : remplacées PARTOUT par la version à jour de
// data/card-art/ (copie servie par Blob, cf. scripts/uploadImageAssetsToBlob.js).
//
// Trois points d'entrée, pour que tout le projet en profite :
//   - fetchCards() (clashApi.js) réécrit `iconUrls.medium` vers la route
//     publique /api/card-art/<fichier> (site, embeds Discord, scripts) et
//     garde l'URL d'origine dans `iconUrls.apiMedium` ;
//   - battleCardIconUrl() (battleLogUtils.js) fait de même pour les cartes
//     des battle logs (version de base uniquement) ;
//   - les rendus SVG côté serveur (cardImage.js, images de decks) lisent
//     directement le fichier sur Blob (readCardArt), sans requête HTTP.
// Les icônes évolution/héros ne sont pas concernées.
//
// Nouvelle carte périmée : ajouter le PNG (285×420) dans data/card-art/,
// l'entrée ci-dessous, puis `npm run assets:upload-blob -- card-art`.
// ============================================================

import { readBlobAsset } from "./blobAssets.js";

const PUBLIC_BASE_URL = "https://trustroyale.vercel.app";

// Nom anglais de la carte (API) → fichier de data/card-art/
export const CARD_ART_OVERRIDES = new Map([
  ["Bandit", "bandit.png"],
  ["Musketeer", "musketeer.png"],
  ["Mega Minion", "mega-minion.png"],
]);

const FICHIERS = new Set(CARD_ART_OVERRIDES.values());

export function isCardArtFile(fichier) {
  return FICHIERS.has(fichier);
}

// URL publique de l'illustration à jour, null si l'API est à jour.
export function cardArtUrl(name) {
  const fichier = CARD_ART_OVERRIDES.get(name);
  return fichier ? `${PUBLIC_BASE_URL}/api/card-art/${fichier}` : null;
}

// Catalogue de l'API avec les illustrations de base remplacées.
export function withCardArtOverrides(cards) {
  return cards.map((c) => {
    const url = cardArtUrl(c?.name);
    if (!url || !c.iconUrls?.medium) return c;
    return { ...c, iconUrls: { ...c.iconUrls, medium: url, apiMedium: c.iconUrls.medium } };
  });
}

// Contenu PNG de l'illustration à jour (Blob), pour les rendus serveur.
export async function readCardArt(name) {
  const fichier = CARD_ART_OVERRIDES.get(name);
  return fichier ? readBlobAsset(`card-art/${fichier}`) : null;
}

export async function readCardArtFile(fichier) {
  return isCardArtFile(fichier) ? readBlobAsset(`card-art/${fichier}`) : null;
}
