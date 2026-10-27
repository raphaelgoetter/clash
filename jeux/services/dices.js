// ============================================================
// dices.js — Faces de dé communes aux jeux de dés (La Pile ; le Gobelet
// garde ses keycaps et ses boutons 🔒/🎲, plus lisibles pour la sélection).
// Sources vectorielles uniques : jeux/data/dices/dice-1.svg à dice-6.svg
// (dé plein 15×15, corps de 1 à 14, points évidés). Discord n'affiche pas
// le SVG : jeux/scripts/uploadDiceEmojis.js les rend en PNG en
// mémoire, une couleur à la fois, et les uploade comme emojis d'application,
// dont les IDs sont rangés dans jeux/data/dices/dices.json (config statique).
//
// Lisibilité en thème clair comme sombre : points blancs opaques (carré
// blanc sous le corps, visible seulement à travers les points évidés) et
// fin contour clair qui détache le dé d'un fond sombre.
// ============================================================

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const DICES_DIR = path.resolve(__dirname, "..", "data", "dices");
export const DICES_CONFIG_PATH = path.join(DICES_DIR, "dices.json");

export const DICE_VALUES = [1, 2, 3, 4, 5, 6];

// Repli tant que les emojis d'une couleur ne sont pas uploadés : keycaps
// (vrais emoji couleur, agrandis sous un titre H1, contrairement aux glyphes
// ⚀-⚅ qui restent minuscules).
const KEYCAPS = ["1️⃣", "2️⃣", "3️⃣", "4️⃣", "5️⃣", "6️⃣"];

let configCache = null;

// Config statique, jamais mutée au runtime (seul le script d'upload la
// réécrit, en local).
export function loadDicesConfig() {
  if (!configCache) {
    configCache = JSON.parse(fs.readFileSync(DICES_CONFIG_PATH, "utf-8"));
  }
  return configCache;
}

export function emojiName(couleur, value) {
  return `de_${couleur}_${value}`;
}

function emojiId(couleur, value) {
  return loadDicesConfig().emojis?.[couleur]?.[String(value)] ?? null;
}

// Face de dé dans un texte (titre, description) : emoji d'application si
// uploadé, sinon keycap.
export function formatDie(value, couleur) {
  const id = emojiId(couleur, value);
  return id ? `<:${emojiName(couleur, value)}:${id}>` : KEYCAPS[value - 1];
}

export function formatDice(dice, couleur) {
  return dice.map((value) => formatDie(value, couleur)).join(" ");
}

// Objet `emoji` d'un bouton Discord, ou null si la face n'est pas uploadée
// (à l'appelant de choisir son repli).
export function dieButtonEmoji(value, couleur) {
  const id = emojiId(couleur, value);
  return id ? { id, name: emojiName(couleur, value) } : null;
}

// SVG coloré prêt à rendre (script d'upload, aperçus).
export async function buildColoredDieSvg(value, couleur) {
  const hex = loadDicesConfig().couleurs?.[couleur];
  if (!hex) throw new Error(`Couleur de dé inconnue : ${couleur}`);
  const source = await fsp.readFile(path.join(DICES_DIR, `dice-${value}.svg`), "utf-8");
  return source
    .replace(/<path /g, `<path fill="${hex}" stroke="#FFFFFF" stroke-opacity="0.85" stroke-width="0.6" stroke-linejoin="round" `)
    .replace(/(<svg[^>]*>)/, `$1<rect x="2" y="2" width="11" height="11" fill="#FFFFFF"/>`);
}
