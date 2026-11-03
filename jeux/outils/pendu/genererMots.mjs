// Génère la liste de mots du Pendu (jeux/data/pendu/mots.json) à partir de
// sources publiques vérifiables (jamais de liste écrite de mémoire) :
// - les listes du Petit Bac dont les mots sont des noms communs (animaux,
//   métiers, inventions, fruits et légumes, outils, sports, transports),
//   gardées si d'usage courant (fréquence d'au moins SEUIL_BAC par million) ;
// - les noms communs de Lexique 3.83 (lexique.org) d'usage courant
//   (fréquence d'au moins SEUIL_LEXIQUE par million).
// Les deux : nom commun au singulier dans Lexique (forme = lemme, pas de
// pluriel ni de féminin fléchi), de LONGUEUR_MIN à LONGUEUR_MAX lettres,
// lettres seules (accents admis, ni œ ni æ, ni tiret ni espace), hors
// mots écartés (EXCLUS : grossiers, injurieux).
//
// Fréquence : films + livres (comme genererListes.mjs du Petit Bac).
// Usage : node jeux/outils/pendu/genererMots.mjs
// Lexique téléchargé une fois, en cache dans le dossier temporaire du système
// (même cache que le Petit Bac).
import fs from "fs";
import os from "os";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const RACINE = path.resolve(__dirname, "..", "..", "..");
const BAC = path.join(RACINE, "jeux", "data", "bac");
const SORTIE = path.join(RACINE, "jeux", "data", "pendu", "mots.json");
const CACHE = path.join(os.tmpdir(), "bac-sources");
fs.mkdirSync(CACHE, { recursive: true });

const THEMES_BAC = ["animaux", "metiers", "inventions", "fruits", "outils", "sports", "transports"];
const SEUIL_BAC = 1;
const SEUIL_LEXIQUE = 5;
const LONGUEUR_MIN = 4;
const LONGUEUR_MAX = 11;
const LETTRES = /^[a-zàâäçéèêëîïôöùûüÿ]+$/;
// Mots grossiers ou injurieux : jamais à faire deviner
const EXCLUS = new Set(fs.readFileSync(path.join(__dirname, "exclus.txt"), "utf8").split("\n").map((l) => l.trim()).filter((l) => l && !l.startsWith("#")));

async function lexique() {
  const f = path.join(CACHE, "Lexique383.tsv");
  if (!fs.existsSync(f)) {
    const r = await fetch("http://www.lexique.org/databases/Lexique383/Lexique383.tsv");
    if (!r.ok) throw new Error(`Lexique : ${r.status}`);
    fs.writeFileSync(f, Buffer.from(await r.arrayBuffer()));
  }
  const lignes = fs.readFileSync(f, "utf8").split("\n");
  const entete = lignes[0].split("\t");
  const [iOrtho, iLemme, iCgram, iFilms, iLivres] = ["ortho", "lemme", "cgram", "freqfilms2", "freqlivres"].map((c) => entete.indexOf(c));
  // Noms communs au singulier (forme = lemme) → fréquence
  const noms = new Map();
  for (const l of lignes.slice(1)) {
    const c = l.split("\t");
    if (c[iCgram] !== "NOM" || c[iOrtho] !== c[iLemme]) continue;
    const v = (Number(c[iFilms]) || 0) + (Number(c[iLivres]) || 0);
    noms.set(c[iOrtho], Math.max(noms.get(c[iOrtho]) ?? 0, v));
  }
  return noms;
}

const jouable = (m) => LETTRES.test(m) && m.length >= LONGUEUR_MIN && m.length <= LONGUEUR_MAX && !EXCLUS.has(m);

const noms = await lexique();
const mots = new Set();
const parSource = {};
for (const t of THEMES_BAC) {
  const { mots: liste } = JSON.parse(fs.readFileSync(path.join(BAC, `${t}.json`), "utf8"));
  const gardes = liste.map((m) => m.toLowerCase()).filter((m) => jouable(m) && (noms.get(m) ?? 0) >= SEUIL_BAC);
  parSource[t] = gardes.length;
  gardes.forEach((m) => mots.add(m));
}
const avantLexique = mots.size;
for (const [m, v] of noms) if (jouable(m) && v >= SEUIL_LEXIQUE) mots.add(m);
parSource.lexique = mots.size - avantLexique;

const tries = [...mots].sort((a, b) => a.localeCompare(b, "fr"));
fs.mkdirSync(path.dirname(SORTIE), { recursive: true });
fs.writeFileSync(SORTIE, `${JSON.stringify({ mots: tries })}\n`);
console.log(`${tries.length} mots écrits dans ${path.relative(RACINE, SORTIE)}`, parSource);
