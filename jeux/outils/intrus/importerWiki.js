#!/usr/bin/env node
// importerWiki.js
// Ajoute au catalogue du jeu "Intrus de l'inventaire" les icônes d'une
// catégorie de fichiers d'un wiki MediaWiki hors Fandom (Fandom refuse le
// téléchargement des images aux scripts) : Nookipedia, Miraheze, wiki.gg…
// Seules les références sont écrites dans objets.json (source `wiki`,
// `titre` = page du fichier, `fichier`) : npm run intrus:verifier contrôle
// chaque fichier sur le wiki, télécharge et normalise l'icône.
//
// Échantillon réparti sur toute la catégorie (`--max`), pour la variété et
// pour ne pas noyer le catalogue sous un seul jeu. Nom = titre du fichier
// sans extension ni motif `--retirer` (ex. « 1-Up Mushroom PC Icon.png » →
// « 1-Up Mushroom » avec --retirer " PC Icon$"). Fichiers déjà importés
// ignorés (relance sans doublon).
//
// Usage :
//   node jeux/outils/intrus/importerWiki.js --wiki https://nookipedia.com/w/api.php \
//     --categorie "Pocket Camp fish icons" --jeu "Animal Crossing: Pocket Camp" --prefixe acpc \
//     [--max 40] [--retirer " PC Icon$"] [--exclure "regex"] [--dry-run]

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const OBJETS_PATH = path.join(ROOT, "jeux", "data", "jeux-visuels", "intrus", "objets.json");
const USER_AGENT = "TrustRoyale-intrus/1.0 (raphael@alsacreations.fr)";

const args = process.argv.slice(2);
const arg = (nom, defaut = null) => {
  const i = args.indexOf(nom);
  return i === -1 ? defaut : args[i + 1];
};
const WIKI = arg("--wiki");
const CATEGORIE = arg("--categorie");
const JEU = arg("--jeu");
const PREFIXE = arg("--prefixe");
const MAX = Number(arg("--max", 40));
const RETIRER = arg("--retirer") ? new RegExp(arg("--retirer"), "i") : null;
const EXCLURE = arg("--exclure") ? new RegExp(arg("--exclure"), "i") : null;
const DRY_RUN = args.includes("--dry-run");

if (!WIKI || !CATEGORIE || !JEU || !/^[a-z0-9-]+$/.test(PREFIXE ?? "")) {
  console.error('Usage : --wiki <api.php> --categorie "<Catégorie>" --jeu "<Jeu>" --prefixe <minuscules-et-tirets>');
  process.exit(1);
}

async function fichiersDeCategorie() {
  const titres = [];
  let suite = null;
  do {
    const url = new URL(WIKI);
    const params = {
      action: "query",
      list: "categorymembers",
      cmtitle: `Category:${CATEGORIE}`,
      cmtype: "file",
      cmlimit: "500",
      format: "json",
      ...(suite ? { cmcontinue: suite } : {}),
    };
    for (const [k, v] of Object.entries(params)) url.searchParams.set(k, v);
    const res = await fetch(url, { headers: { "User-Agent": USER_AGENT } });
    if (!res.ok) throw new Error(`HTTP ${res.status} sur ${WIKI}`);
    const data = await res.json();
    titres.push(...(data.query?.categorymembers ?? []).map((m) => m.title));
    suite = data.continue?.cmcontinue ?? null;
  } while (suite);
  return titres.filter((t) => /\.(png|gif|jpe?g|webp)$/i.test(t));
}

function nomDepuisTitre(titre) {
  let nom = titre.replace(/^[^:]+:/, "").replace(/\.[a-z]+$/i, "");
  if (RETIRER) nom = nom.replace(RETIRER, "");
  return nom.replace(/_/g, " ").replace(/\s+/g, " ").trim();
}

// `n` éléments répartis régulièrement sur la liste.
function echantillon(liste, n) {
  if (liste.length <= n) return liste;
  return Array.from({ length: n }, (_, i) => liste[Math.floor((i * liste.length) / n)]);
}

(async () => {
  const objets = JSON.parse(await fs.readFile(OBJETS_PATH, "utf-8"));
  const dejaImportes = new Set(objets.filter((o) => o.source?.wiki === WIKI).map((o) => o.source.fichier));
  const titres = (await fichiersDeCategorie())
    .filter((t) => !EXCLURE || !EXCLURE.test(t))
    .filter((t) => !dejaImportes.has(t.replace(/^[^:]+:/, "")));
  const choisis = echantillon(titres, MAX);
  console.log(`Catégorie « ${CATEGORIE} » : ${titres.length} fichier(s) nouveaux, ${choisis.length} retenu(s).`);
  if (DRY_RUN) {
    console.log(choisis.slice(0, 15).map(nomDepuisTitre).join(" | "));
    return;
  }

  const base = new URL(WIKI);
  let numero = objets.filter((o) => o.id.startsWith(`${PREFIXE}-`)).length;
  for (const titre of choisis) {
    const id = `${PREFIXE}-${String(++numero).padStart(3, "0")}`;
    const nom = nomDepuisTitre(titre);
    const fichier = titre.replace(/^[^:]+:/, "");
    objets.push({
      id,
      nom,
      nomVO: nom,
      jeu: JEU,
      image: `${id}.png`,
      source: {
        wiki: WIKI,
        titre,
        fichier,
        page: `${base.origin}/wiki/${encodeURIComponent(titre.replace(/ /g, "_"))}`,
      },
      sourceNom: `${base.hostname}, catégorie « ${CATEGORIE} »`,
    });
  }
  await fs.writeFile(OBJETS_PATH, JSON.stringify(objets, null, 2) + "\n", "utf-8");
  console.log(`${choisis.length} objet(s) ajouté(s). Ensuite : npm run intrus:verifier (téléchargement), puis tri dans npm run intrus:demo.`);
})().catch((err) => {
  console.error("Échec de l'import :", err.message);
  process.exit(1);
});
