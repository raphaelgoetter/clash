// ============================================================
// urlJeux.js — Adresse publique qui sert les images des jeux (routes
// /api/<jeu>/… de jeux/server/imageRoutes.js et images fixes de
// jeux/public/), utilisée dans les embeds Discord : le projet Vercel
// « kevina », sauf si JEUX_URL_PUBLIQUE en désigne un autre.
// ============================================================

export const URL_JEUX = (process.env.JEUX_URL_PUBLIQUE || "https://kevina-jeux.vercel.app").replace(/\/+$/, "");
