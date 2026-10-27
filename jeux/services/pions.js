// ============================================================
// pions.js — Pions de Quatre à la suite, dans le style des faces de dé de
// La Grille (dices.js) : disque coloré (toujours rond, même sur une grille
// de cases carrées), anneau blanc. Source vectorielle unique :
// jeux/data/pions/pion.svg. Discord n'affiche pas le SVG :
// jeux/scripts/uploadPionEmojis.js le rend en PNG en mémoire, une couleur à
// la fois, et l'uploade comme emoji d'application, dont l'ID est rangé dans
// jeux/data/pions/pions.json (config statique).
//
// Couleurs : bleu (ses pions), rouge (pions adverses), vert (alignement
// gagnant, quel que soit le joueur).
// ============================================================

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PIONS_DIR = path.resolve(__dirname, "..", "data", "pions");
export const PIONS_CONFIG_PATH = path.join(PIONS_DIR, "pions.json");

// Repli tant que l'emoji d'une couleur n'est pas uploadé
const REPLI = { bleu: "🔵", rouge: "🔴", vert: "🟢" };

let configCache = null;

// Config statique, jamais mutée au runtime (seul le script d'upload la
// réécrit, en local).
export function loadPionsConfig() {
  if (!configCache) {
    configCache = JSON.parse(fs.readFileSync(PIONS_CONFIG_PATH, "utf-8"));
  }
  return configCache;
}

export function emojiName(couleur) {
  return `pion_${couleur}`;
}

// Pion dans un texte (titre, description) : emoji d'application si
// uploadé, sinon rond de couleur.
export function formatPion(couleur) {
  const id = loadPionsConfig().emojis?.[couleur] ?? null;
  return id ? `<:${emojiName(couleur)}:${id}>` : REPLI[couleur];
}

// SVG coloré prêt à rendre (script d'upload, aperçus). Même contour clair
// que les dés, l'anneau blanc vient du disque blanc placé sous le corps.
export async function buildColoredPionSvg(couleur) {
  const hex = loadPionsConfig().couleurs?.[couleur];
  if (!hex) throw new Error(`Couleur de pion inconnue : ${couleur}`);
  const source = await fsp.readFile(path.join(PIONS_DIR, "pion.svg"), "utf-8");
  return source
    .replace(/<path /g, `<path fill="${hex}" stroke="#FFFFFF" stroke-opacity="0.85" stroke-width="0.6" stroke-linejoin="round" `)
    .replace(/(<svg[^>]*>)/, `$1<circle cx="7.5" cy="7.5" r="5" fill="#FFFFFF"/>`);
}
