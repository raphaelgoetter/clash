// ============================================================
// puntoCartes.js — Cartes de Punto, dans le style des faces de dé de La
// Grille (dices.js) : carré arrondi plein coloré, valeur en élixir (1 à 9)
// en chiffre blanc tracé (pas de police : rendu identique partout), fin
// contour clair. Source vectorielle unique : jeux/data/punto/carte.svg ;
// chiffres définis ici (CHIFFRES). Discord n'affiche pas le SVG :
// jeux/scripts/uploadPuntoEmojis.js le rend en PNG en mémoire, une variante
// à la fois, et l'uploade comme emoji d'application, dont l'ID est rangé
// dans jeux/data/punto/cartes.json (config statique).
//
// Variantes : `<couleur>_<valeur>` (contour blanc), `<couleur>_<valeur>_gagnant`
// (contour jaune épais sur l'alignement gagnant, la carte garde sa couleur)
// et `vide` (case libre : carré gris sans chiffre, même taille).
// ============================================================

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PUNTO_DIR = path.resolve(__dirname, "..", "data", "punto");
export const CARTES_CONFIG_PATH = path.join(PUNTO_DIR, "cartes.json");

export const VALEURS = [1, 2, 3, 4, 5, 6, 7, 8, 9];

// Repli tant que l'emoji d'une variante n'est pas uploadé : keycap de la
// valeur (la couleur est perdue), carré noir pour la case vide
const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣", "7️⃣", "8️⃣", "9️⃣"];
const REPLI_VIDE = "⬛";

// Épaisseur du contour (unités du viewBox 15×15) : le jaune doit se voir
const EPAISSEUR = { normal: 0.6, gagnant: 1.8 };

// Chiffres en traits arrondis (style afficheur), dans le cadre x 5 → 10,
// y 3 → 12 du viewBox 15×15
const CHIFFRES = {
  1: "M5.9 4.6 L7.9 3 V12",
  2: "M5 3 H10 V7.5 H5 V12 H10",
  3: "M5 3 H10 V12 H5 M5.6 7.5 H10",
  4: "M5 3 V7.5 H10 M10 3 V12",
  5: "M10 3 H5 V7.5 H10 V12 H5",
  6: "M10 3 H5 V12 H10 V7.5 H5",
  7: "M5 3 H10 V12",
  8: "M5 3 H10 V12 H5 Z M5 7.5 H10",
  9: "M10 7.5 H5 V3 H10 V12 H5",
};

let configCache = null;

// Config statique, jamais mutée au runtime (seul le script d'upload la
// réécrit, en local).
export function loadCartesConfig() {
  if (!configCache) {
    configCache = JSON.parse(fs.readFileSync(CARTES_CONFIG_PATH, "utf-8"));
  }
  return configCache;
}

export const varianteDe = (couleur, valeur, { gagnant = false } = {}) =>
  `${couleur}_${valeur}${gagnant ? "_gagnant" : ""}`;

// Variantes à uploader : chaque couleur × valeur, normale et gagnante, puis vide
export function variantes() {
  const liste = [];
  for (const couleur of Object.keys(loadCartesConfig().couleurs)) {
    for (const v of VALEURS) liste.push(varianteDe(couleur, v), varianteDe(couleur, v, { gagnant: true }));
  }
  return [...liste, "vide"];
}

export function emojiName(variante) {
  return `punto_${variante}`;
}

const emojiId = (variante) => loadCartesConfig().emojis?.[variante] ?? null;

// Carte dans un texte (titre, description) : emoji d'application si
// uploadé, sinon keycap. `couleur` "vide" : case libre.
export function formatCarte(couleur, valeur, { gagnant = false } = {}) {
  const variante = couleur === "vide" ? "vide" : varianteDe(couleur, valeur, { gagnant });
  const id = emojiId(variante);
  if (id) return `<:${emojiName(variante)}:${id}>`;
  return couleur === "vide" ? REPLI_VIDE : KEYCAPS[valeur - 1];
}

// Objet `emoji` d'un bouton Discord, ou null si la variante n'est pas
// uploadée (à l'appelant de choisir son repli).
export function carteButtonEmoji(couleur, valeur) {
  const variante = couleur === "vide" ? "vide" : varianteDe(couleur, valeur);
  const id = emojiId(variante);
  return id ? { id, name: emojiName(variante) } : null;
}

// SVG coloré prêt à rendre (script d'upload, aperçus). Le contour est
// tracé à l'intérieur de la carte : même taille pour toutes les variantes.
export async function buildCarteSvg(variante) {
  const config = loadCartesConfig();
  const source = await fsp.readFile(path.join(PUNTO_DIR, "carte.svg"), "utf-8");
  const rect = /<rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)" rx="([\d.]+)"/;
  if (variante === "vide") return source.replace(rect, (m) => `${m} fill="${config.vide}"`);

  const [couleur, valeur, type = "normal"] = variante.split("_");
  const hex = config.couleurs?.[couleur];
  const chiffre = CHIFFRES[valeur];
  if (!hex || !chiffre || !EPAISSEUR[type]) throw new Error(`Variante de carte inconnue : ${variante}`);
  const e = EPAISSEUR[type];
  return source
    .replace(
      rect,
      (_, x, y, w, h, rx) =>
        `<rect x="${Number(x) + e / 2}" y="${Number(y) + e / 2}" width="${Number(w) - e}" height="${Number(h) - e}" rx="${Number(rx) - e / 2}" fill="${hex}" stroke="${config.contours[type]}" stroke-width="${e}"`,
    )
    .replace(
      "</svg>",
      `  <path d="${chiffre}" fill="none" stroke="#FFFFFF" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/>\n</svg>`,
    );
}
