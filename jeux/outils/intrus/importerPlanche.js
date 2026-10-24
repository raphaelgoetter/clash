#!/usr/bin/env node
// importerPlanche.js
// Découpe une planche de sprites (ex. téléchargée à la main depuis The
// Spriters Resource, qui refuse les scripts) en objets du jeu "Intrus de
// l'inventaire" : chaque sprite isolé devient un PNG dans
// jeux/data/jeux-visuels/intrus/sources-local/<prefixe>/ et un objet de
// objets.json (source `localFile`, nom provisoire « <Jeu> #NNN », jamais
// affiché dans le post).
//
// Détection : fond transparent (alpha) si la planche en a, sinon couleur de
// fond = couleur la plus fréquente du bord (rendue transparente). Les zones
// connexes voisines de moins de `--ecart` px sont fusionnées (sprite en
// plusieurs morceaux) ; on écarte les zones plus petites que `--min` px
// (texte, séparateurs) et les très grandes (`--max`, décors, bandeaux).
//
// Ensuite : npm run intrus:verifier (icônes normalisées dans images/), puis
// tri dans npm run intrus:demo (onglet Objets, filtre par jeu : exclure les
// découpes ratées), et npm run assets:upload-blob -- jeux-visuels/intrus.
//
// Mode dossier (`--dossier`) : sprites téléchargés un par un, une image =
// un objet, sans découpe ; nom repris du nom de fichier (« Peashooter.png »
// → « Peashooter »). Les fichiers déjà importés (même nom) sont ignorés.
//
// Usage :
//   node jeux/outils/intrus/importerPlanche.js --planche ~/Downloads/pvz2.png --jeu "Plants vs. Zombies 2" --prefixe pvz2
//   node jeux/outils/intrus/importerPlanche.js --dossier ~/Downloads/pvz2/ --jeu "Plants vs. Zombies 2" --prefixe pvz2
//     [--page https://www.spriters-resource.com/…]  page d'origine (crédit)
//     [--min 24] [--max 512] [--ecart 2]           réglages de découpe
//     [--alpha 8]                                  opacité minimale d'un pixel d'objet ; à monter
//                                                  (ex. 200, avec --ecart 0) pour un atlas compact dont
//                                                  les sprites ne sont séparés que par un halo
//     [--dry-run]                                  compte les sprites sans rien écrire

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import { PNG } from "pngjs";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const DATA_DIR = path.join(ROOT, "jeux", "data", "jeux-visuels", "intrus");
const OBJETS_PATH = path.join(DATA_DIR, "objets.json");

const args = process.argv.slice(2);
const arg = (nom, defaut = null) => {
  const i = args.indexOf(nom);
  return i === -1 ? defaut : args[i + 1];
};
const PLANCHE = arg("--planche");
const DOSSIER = arg("--dossier");
const EXTENSIONS = [".png", ".gif", ".jpg", ".jpeg", ".webp"];
const JEU = arg("--jeu");
const PREFIXE = arg("--prefixe");
const PAGE = arg("--page");
const MIN = Number(arg("--min", 24));
const MAX = Number(arg("--max", 512));
const ECART = Number(arg("--ecart", 2));
const ALPHA = Number(arg("--alpha", 8)); // opacité minimale d'un pixel « objet »
const DRY_RUN = args.includes("--dry-run");
const TOLERANCE = 24; // écart de couleur toléré avec le fond opaque

if ((!PLANCHE && !DOSSIER) || !JEU || !/^[a-z0-9-]+$/.test(PREFIXE ?? "")) {
  console.error('Usage : --planche <fichier.png> | --dossier <dossier> --jeu "<Nom du jeu>" --prefixe <minuscules-et-tirets>');
  process.exit(1);
}

// Masque des pixels « objet » : alpha si la planche est transparente, sinon
// tout ce qui s'écarte de la couleur de fond dominante du bord.
function masqueObjets({ width, height, data }) {
  let transparents = 0;
  for (let i = 3; i < data.length; i += 4) if (data[i] <= 8) transparents++;
  const masque = new Uint8Array(width * height);
  if (transparents / (width * height) > 0.05) {
    for (let p = 0; p < width * height; p++) masque[p] = data[p * 4 + 3] > ALPHA ? 1 : 0;
    return { masque, fond: null };
  }
  const compte = new Map();
  const bord = (x, y) => {
    const i = (y * width + x) * 4;
    const cle = (data[i] << 16) | (data[i + 1] << 8) | data[i + 2];
    compte.set(cle, (compte.get(cle) ?? 0) + 1);
  };
  for (let x = 0; x < width; x++) (bord(x, 0), bord(x, height - 1));
  for (let y = 0; y < height; y++) (bord(0, y), bord(width - 1, y));
  const cle = [...compte.entries()].sort((a, b) => b[1] - a[1])[0][0];
  const fond = [(cle >> 16) & 255, (cle >> 8) & 255, cle & 255];
  for (let p = 0; p < width * height; p++) {
    const i = p * 4;
    const d = Math.abs(data[i] - fond[0]) + Math.abs(data[i + 1] - fond[1]) + Math.abs(data[i + 2] - fond[2]);
    masque[p] = d > TOLERANCE ? 1 : 0;
  }
  return { masque, fond };
}

// Boîtes englobantes des zones connexes (8-voisinage).
function zonesConnexes(masque, width, height) {
  const vu = new Uint8Array(width * height);
  const boites = [];
  const pile = [];
  for (let p = 0; p < width * height; p++) {
    if (!masque[p] || vu[p]) continue;
    let [x0, y0, x1, y1] = [width, height, -1, -1];
    pile.push(p);
    vu[p] = 1;
    while (pile.length) {
      const q = pile.pop();
      const x = q % width;
      const y = (q - x) / width;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          const nx = x + dx;
          const ny = y + dy;
          if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
          const n = ny * width + nx;
          if (masque[n] && !vu[n]) (vu[n] = 1, pile.push(n));
        }
      }
    }
    boites.push({ x0, y0, x1, y1 });
  }
  return boites;
}

// Fusionne les boîtes qui se touchent à `ecart` px près, jusqu'à stabilité.
function fusionner(boites, ecart) {
  let liste = [...boites];
  for (let change = true; change; ) {
    change = false;
    const res = [];
    for (const b of liste) {
      const cible = res.find((r) => b.x0 <= r.x1 + ecart && r.x0 <= b.x1 + ecart && b.y0 <= r.y1 + ecart && r.y0 <= b.y1 + ecart);
      if (!cible) {
        res.push({ ...b });
        continue;
      }
      Object.assign(cible, { x0: Math.min(cible.x0, b.x0), y0: Math.min(cible.y0, b.y0), x1: Math.max(cible.x1, b.x1), y1: Math.max(cible.y1, b.y1) });
      change = true;
    }
    liste = res;
  }
  return liste;
}

function extraire(png, { x0, y0, x1, y1 }, fond) {
  const w = x1 - x0 + 1;
  const h = y1 - y0 + 1;
  const out = new PNG({ width: w, height: h });
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      const s = ((y0 + y) * png.width + (x0 + x)) * 4;
      const d = (y * w + x) * 4;
      png.data.copy(out.data, d, s, s + 4);
      if (fond) {
        const ecart = Math.abs(out.data[d] - fond[0]) + Math.abs(out.data[d + 1] - fond[1]) + Math.abs(out.data[d + 2] - fond[2]);
        if (ecart <= TOLERANCE) out.data[d + 3] = 0;
      }
    }
  }
  return PNG.sync.write(out);
}

// « Peashooter_(Plant).png » → « Peashooter (Plant) ».
function nomDepuisFichier(fichier) {
  return path
    .basename(fichier, path.extname(fichier))
    .replace(/[_]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

async function importerDossier() {
  const fichiers = (await fs.readdir(DOSSIER))
    .filter((f) => EXTENSIONS.includes(path.extname(f).toLowerCase()))
    .sort((a, b) => a.localeCompare(b, "fr"));
  const objets = JSON.parse(await fs.readFile(OBJETS_PATH, "utf-8"));
  const dejaImportes = new Set(objets.filter((o) => o.id.startsWith(`${PREFIXE}-`)).map((o) => o.sourceNom));
  const nouveaux = fichiers.filter((f) => !dejaImportes.has(`sprite ${f}`));
  console.log(`${fichiers.length} image(s) dans ${DOSSIER}, ${nouveaux.length} nouvelle(s).`);
  if (DRY_RUN || !nouveaux.length) return;

  const dossier = path.join(DATA_DIR, "sources-local", PREFIXE);
  await fs.mkdir(dossier, { recursive: true });
  let numero = objets.filter((o) => o.id.startsWith(`${PREFIXE}-`)).length;
  for (const f of nouveaux) {
    const id = `${PREFIXE}-${String(++numero).padStart(3, "0")}`;
    const cible = path.join(dossier, `${id}${path.extname(f).toLowerCase()}`);
    await fs.copyFile(path.join(DOSSIER, f), cible);
    const nom = nomDepuisFichier(f);
    objets.push({
      id,
      nom,
      nomVO: nom,
      jeu: JEU,
      image: `${id}.png`,
      source: { localFile: path.relative(ROOT, cible), ...(PAGE ? { page: PAGE } : {}) },
      sourceNom: `sprite ${f}`,
    });
  }
  await fs.writeFile(OBJETS_PATH, JSON.stringify(objets, null, 2) + "\n", "utf-8");
  console.log(`${nouveaux.length} objet(s) ajouté(s) (${path.relative(ROOT, dossier)}/). Ensuite : npm run intrus:verifier, puis tri dans npm run intrus:demo.`);
}

(async () => {
  if (DOSSIER) return importerDossier();
  const png = PNG.sync.read(await fs.readFile(PLANCHE));
  const { masque, fond } = masqueObjets(png);
  const boites = fusionner(zonesConnexes(masque, png.width, png.height), ECART)
    .filter((b) => {
      const w = b.x1 - b.x0 + 1;
      const h = b.y1 - b.y0 + 1;
      return Math.min(w, h) >= MIN && Math.max(w, h) <= MAX;
    })
    // Ordre de lecture : par rangée (à 8 px près), puis de gauche à droite.
    .sort((a, b) => Math.round(a.y0 / 8) - Math.round(b.y0 / 8) || a.x0 - b.x0);

  console.log(`${path.basename(PLANCHE)} : ${png.width}×${png.height}, fond ${fond ? `opaque rgb(${fond.join(", ")})` : "transparent"}, ${boites.length} sprite(s) retenu(s).`);
  if (DRY_RUN || !boites.length) return;

  const objets = JSON.parse(await fs.readFile(OBJETS_PATH, "utf-8"));
  const ids = new Set(objets.map((o) => o.id));
  const dossier = path.join(DATA_DIR, "sources-local", PREFIXE);
  await fs.mkdir(dossier, { recursive: true });
  const dejaLa = objets.filter((o) => o.id.startsWith(`${PREFIXE}-`)).length;
  let ajoutes = 0;
  for (const [i, boite] of boites.entries()) {
    const numero = String(dejaLa + i + 1).padStart(3, "0");
    const id = `${PREFIXE}-${numero}`;
    if (ids.has(id)) continue;
    const fichier = path.join(dossier, `${id}.png`);
    await fs.writeFile(fichier, extraire(png, boite, fond));
    objets.push({
      id,
      nom: `${JEU} #${numero}`,
      nomVO: `${JEU} #${numero}`,
      jeu: JEU,
      image: `${id}.png`,
      source: { localFile: path.relative(ROOT, fichier), ...(PAGE ? { page: PAGE } : {}) },
      sourceNom: `planche locale ${path.basename(PLANCHE)}`,
    });
    ajoutes++;
  }
  await fs.writeFile(OBJETS_PATH, JSON.stringify(objets, null, 2) + "\n", "utf-8");
  console.log(`${ajoutes} objet(s) ajouté(s) à objets.json (${path.relative(ROOT, dossier)}/). Ensuite : npm run intrus:verifier, puis tri dans npm run intrus:demo.`);
})().catch((err) => {
  console.error("Échec de l'import :", err.message);
  process.exit(1);
});
