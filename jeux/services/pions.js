// ============================================================
// pions.js — Pions de Quatre à la suite, dans le style des faces de dé de
// La Grille (dices.js) : disque plein coloré (toujours rond, même sur une
// grille de cases carrées), contour clair. Source vectorielle unique :
// jeux/data/pions/pion.svg. Discord n'affiche pas le SVG :
// jeux/scripts/uploadPionEmojis.js le rend en PNG en mémoire, une variante
// à la fois, et l'uploade comme emoji d'application, dont l'ID est rangé
// dans jeux/data/pions/pions.json (config statique).
//
// Variantes : bleu (ses pions) et rouge (pions adverses), chacune avec un
// contour blanc, ou jaune et plus épais sur l'alignement gagnant (le pion
// garde sa couleur) ; vide (case libre : disque gris sans contour, même
// taille, pour une grille régulière).
// ============================================================

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
export const PIONS_DIR = path.resolve(__dirname, "..", "data", "pions");
export const PIONS_CONFIG_PATH = path.join(PIONS_DIR, "pions.json");

// Repli tant que l'emoji d'une variante n'est pas uploadé
const REPLI = { bleu: "🔵", rouge: "🔴", bleu_gagnant: "🟦", rouge_gagnant: "🟥", vide: "⚫" };

// Épaisseur du contour (unités du viewBox 15×15) : le jaune doit se voir
const EPAISSEUR = { normal: 0.6, gagnant: 1.8 };

let configCache = null;

// Config statique, jamais mutée au runtime (seul le script d'upload la
// réécrit, en local).
export function loadPionsConfig() {
  if (!configCache) {
    configCache = JSON.parse(fs.readFileSync(PIONS_CONFIG_PATH, "utf-8"));
  }
  return configCache;
}

// Variantes à uploader : bleu, rouge, bleu_gagnant, rouge_gagnant, vide
export function variantes() {
  const couleurs = Object.keys(loadPionsConfig().couleurs);
  return [...couleurs, ...couleurs.map((c) => `${c}_gagnant`), "vide"];
}

export function emojiName(variante) {
  return `pion_${variante}`;
}

// Pion dans un texte (titre, description) : emoji d'application si
// uploadé, sinon rond (ou carré gagnant) de couleur.
// `couleur` "vide" : case libre.
export function formatPion(couleur, { gagnant = false } = {}) {
  const variante = gagnant && couleur !== "vide" ? `${couleur}_gagnant` : couleur;
  const id = loadPionsConfig().emojis?.[variante] ?? null;
  return id ? `<:${emojiName(variante)}:${id}>` : REPLI[variante];
}

// SVG coloré prêt à rendre (script d'upload, aperçus). Le contour est
// dessiné à l'intérieur du disque (rayon réduit de la demi-épaisseur) :
// même taille de pion pour toutes les variantes.
export async function buildColoredPionSvg(variante) {
  const config = loadPionsConfig();
  if (variante === "vide") {
    const source = await fsp.readFile(path.join(PIONS_DIR, "pion.svg"), "utf-8");
    return source.replace(/<circle cx="7.5" cy="7.5" r="([\d.]+)"/, (_, r) => `<circle cx="7.5" cy="7.5" r="${Number(r) + 0.3}" fill="${config.vide}"`);
  }
  const [couleur, type = "normal"] = variante.split("_");
  const hex = config.couleurs?.[couleur];
  const contour = config.contours?.[type === "gagnant" ? "gagnant" : "normal"];
  if (!hex || !contour) throw new Error(`Variante de pion inconnue : ${variante}`);
  const epaisseur = EPAISSEUR[type === "gagnant" ? "gagnant" : "normal"];
  const source = await fsp.readFile(path.join(PIONS_DIR, "pion.svg"), "utf-8");
  return source.replace(
    /<circle cx="7.5" cy="7.5" r="([\d.]+)"/,
    (_, r) =>
      `<circle cx="7.5" cy="7.5" r="${Number(r) + 0.3 - epaisseur / 2}" fill="${hex}" stroke="${contour}" stroke-width="${epaisseur}"`,
  );
}
