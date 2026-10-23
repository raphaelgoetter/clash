// ============================================================
// textNormalize.js — Normalisation de texte partagée entre les mini-jeux
// Discord (Frame, Anagram) pour la comparaison de réponses libres.
// ============================================================

export function normalizeAnswer(str) {
  return String(str ?? "")
    .toLowerCase()
    .normalize("NFD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[^a-z0-9\s]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}
