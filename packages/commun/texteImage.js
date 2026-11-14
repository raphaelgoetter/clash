// ============================================================
// texteImage.js — Préparation des textes (pseudos surtout) avant rendu
// SVG → PNG par resvg dans les images de jeux.
//
// Les polices chargées (voir readGameFontPaths dans blobAssets.js) couvrent
// les lettres mathématiques stylées (𝕄, 𝐋, 𝑨…), symboles et emojis, mais
// aucune ne contient la plupart des petites capitales (ᴄ, ᴅ, ᴇ…) : on les
// remplace par la capitale latine correspondante. Les sélecteurs de variante
// (U+FE00-FE0F, ex. le U+FE0F de ❤️) sont retirés : resvg ne trouve aucune
// police qui les contienne et le repli échoue alors sur tout le texte.
//
// texteAffichable() s'applique au SVG entier juste avant `new Resvg` :
// sans effet sur le balisage, il couvre ainsi tous les textes de l'image.
// ============================================================

const PETITES_CAPITALES = {
  "ᴀ": "A", "ʙ": "B", "ᴄ": "C", "ᴅ": "D", "ᴇ": "E", "ꜰ": "F", "ɢ": "G",
  "ʜ": "H", "ɪ": "I", "ᴊ": "J", "ᴋ": "K", "ʟ": "L", "ᴍ": "M", "ɴ": "N",
  "ᴏ": "O", "ᴘ": "P", "ǫ": "Q", "ʀ": "R", "ꜱ": "S", "ᴛ": "T", "ᴜ": "U",
  "ᴠ": "V", "ᴡ": "W", "ʏ": "Y", "ᴢ": "Z",
};
const RE_PETITES_CAPITALES = new RegExp(`[${Object.keys(PETITES_CAPITALES).join("")}]`, "gu");

const segmenteur = new Intl.Segmenter("fr", { granularity: "grapheme" });

// Texte affichable par les polices chargées.
export function texteAffichable(texte) {
  return String(texte ?? "")
    .replace(/[︀-️]/g, "")
    .replace(RE_PETITES_CAPITALES, (c) => PETITES_CAPITALES[c]);
}

// Tronque à `max` graphèmes (jamais au milieu d'une lettre hors BMP, d'un
// accent combinant ou d'un emoji composé), avec « … » si coupé.
export function tronquer(texte, max) {
  const graphemes = Array.from(segmenteur.segment(texteAffichable(texte)), (s) => s.segment);
  if (graphemes.length <= max) return graphemes.join("");
  return `${graphemes.slice(0, Math.max(1, max - 1)).join("").trimEnd()}…`;
}
