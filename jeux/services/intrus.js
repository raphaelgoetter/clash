// ============================================================
// intrus.js — Jeu "Intrus de l'inventaire" (4 objets de jeux vidéo : 3 du
// même jeu, 1 intrus venu d'un autre jeu), groupe "Culture geek" du lundi
// en alternance avec Trivia Geek (voir refonte.js). Instance du moteur
// commun triviaEngine.js : préfixe Redis `intrus:`, publication le lundi,
// un seul essai, 1 pt si l'intrus est trouvé.
//
// Catalogue en deux fichiers (jeux/data/jeux-visuels/intrus/) :
// - objets.json : catalogue d'objets vérifiés (`id`, `nom`, `nomVO`, `jeu`,
//   `image`, `source`), réutilisable d'une manche à l'autre, plus les champs
//   de relecture (`accentuation` 0..3 appliquée au rendu, `style`,
//   `etiquettes`, `exclu`) posés via jeux/outils/intrus/demoValidation.js ;
// - intrus.json : manches validées à la main (`numero`, `difficulte`, `jeu`,
//   `jeuIntrus`, `theme`, `objets` = 3 ids du même jeu, `intrus` = 1 id,
//   `explication`). Parcourues dans l'ordre du fichier, en boucle ; gameId =
//   `i` + numéro sur 3 chiffres. Ne jamais réordonner, ajouter en fin.
//
// L'intrus est toujours options[0] (convention du moteur) ; l'ordre affiché
// A/B/C/D est mélangé par manche (`intrus:order:<gameId>`), et l'image 2×2
// est composée dans cet ordre par intrusImage.js.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { createTriviaService } from "./triviaEngine.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const DATA_DIR = path.resolve(__dirname, "..", "data", "jeux-visuels", "intrus");
const OBJETS_PATH = path.join(DATA_DIR, "objets.json");
const MANCHES_PATH = path.join(DATA_DIR, "intrus.json");

export const DIFFICULTES = {
  facile: "Facile",
  intermediaire: "Intermédiaire",
  difficile: "Difficile",
  expert: "Expert",
};

export const QUESTION = "Quel objet ne vient pas du même jeu que les trois autres ?";

// Nom montré à la révélation : les noms provisoires d'objets importés en
// masse (planches de sprites, fichiers de wiki) sont nettoyés (« Bonbon
// Candy #010 » → « Bonbon Candy », « GatyaitemD 160 f » → « Objet »).
export function nomAffiche(objet) {
  if (/^gatyaitem/i.test(objet.nom)) return "Objet";
  return objet.nom.replace(/\s*#\s*\d+\s*$/, "").trim() || "Objet";
}

export function gameIdFor(numero) {
  return `i${String(numero).padStart(3, "0")}`;
}

// Fonction pure : manche brute + index des objets → entrée du moteur.
export function parseIntrusEntry(manche, objetsById) {
  const ids = [manche.intrus, ...manche.objets];
  const objets = ids.map((id) => {
    const objet = objetsById.get(id);
    if (!objet) throw new Error(`Intrus : objet inconnu « ${id} » (manche ${manche.numero})`);
    return objet;
  });
  return {
    id: gameIdFor(manche.numero),
    numero: manche.numero,
    titre: `Difficulté : ${DIFFICULTES[manche.difficulte] ?? manche.difficulte}`,
    question: QUESTION,
    options: objets.map(nomAffiche),
    optionNotes: objets.map((o) => o.jeu),
    images: objets.map((o) => o.image),
    accentuations: objets.map((o) => o.accentuation ?? 0),
    explication: manche.explication,
    label: `${manche.jeu} (intrus : ${nomAffiche(objets[0])}, ${manche.jeuIntrus})`,
    source: null,
    erratum: manche.erratum ?? null,
  };
}

export async function loadObjets() {
  return JSON.parse(await fs.readFile(OBJETS_PATH, "utf-8"));
}

export async function loadManches() {
  return JSON.parse(await fs.readFile(MANCHES_PATH, "utf-8"));
}

async function loadIntrusCatalog() {
  const [objets, manches] = await Promise.all([loadObjets(), loadManches()]);
  const objetsById = new Map(objets.map((o) => [o.id, o]));
  return manches.map((m) => parseIntrusEntry(m, objetsById));
}

const svc = createTriviaService({
  prefix: "intrus",
  weekday: 1, // lundi, créneau du groupe jeuxaveugle
  loadCatalog: loadIntrusCatalog,
});

export const {
  LETTERS,
  loadTriviaCatalog,
  resolveTriviaEntry,
  readState,
  writeState,
  resetGame,
  getCurrentSeasonId,
  pickNextTriviaIndex,
  alreadyPostedThisWeek,
  computeSeasonMancheTotal,
  previewSeasonManche,
  getSeasonManches,
  getSeasonMancheNumber,
  getTriviaRoundLabel,
  startNewGame,
  isGamePosted,
  readRoundOrder,
  checkAnswer,
  getCorrectLetter,
  computeScore,
  readParticipant,
  recordAnswer,
  archiveAnswer,
  getGameParticipants,
  computeSeasonRanking,
  getAllArchivedResults,
  grantErratumPoint,
  claimErratumAnnouncement,
  releaseErratumAnnouncement,
  findRank,
  findTiedRank,
} = svc;
