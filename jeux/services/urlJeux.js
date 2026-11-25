// ============================================================
// urlJeux.js — Adresse publique qui sert les images des jeux (routes
// /api/<jeu>/… de jeux/server/imageRoutes.js et images statiques), utilisée
// dans les embeds Discord. JEUX_URL_PUBLIQUE permet de la changer (projet
// Vercel dédié aux jeux) ; à défaut, le site TrustRoyale qui les sert
// aujourd'hui.
// ============================================================

export const URL_JEUX = (process.env.JEUX_URL_PUBLIQUE || "https://trustroyale.vercel.app").replace(/\/+$/, "");
