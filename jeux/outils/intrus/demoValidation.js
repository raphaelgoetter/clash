#!/usr/bin/env node
// demoValidation.js
// Démo locale de relecture du jeu "Intrus de l'inventaire" :
// - Planches : chaque manche rendue à la volée par le code de production
//   (buildGridSvg, intrus toujours en A), validation / refus / commentaire,
//   et réglages des 4 objets (accentuation 0..3, style, étiquettes, exclusion) ;
// - Objets : tout le catalogue filtrable par netteté (seuil), style, jeu,
//   étiquette, réserve ; exclusion en lot des plus flous.
//
// Netteté et style automatique : analyseObjets.js. Les réglages d'objet sont
// écrits dans jeux/data/jeux-visuels/intrus/objets.json (versionné, lu en
// production : `accentuation` est appliquée au rendu) ; les décisions de
// planche dans temp/intrus-planches/validation.json (lu par
// verifierCatalogue.js --propositions-netteté).
//
// Usage :
//   node jeux/outils/intrus/demoValidation.js               — démarre sur http://localhost:3391/api/intrus/demo
//   node jeux/outils/intrus/demoValidation.js --port 4000   — change le port
//   node jeux/outils/intrus/demoValidation.js --check        — analyse le catalogue puis quitte

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";
import express from "express";
import { Resvg } from "@resvg/resvg-js";
import { parseIntrusEntry, DIFFICULTES } from "../../services/intrus.js";
import { buildGridSvg, rasterizeGrid, accentuationFilter, ACCENTUATION_FORCES } from "../../services/intrusImage.js";
import { analyserIcone, intrusVisible, distMixte, STYLES } from "./analyseObjets.js";
import { normalizeAnswer } from "@clash/commun/textNormalize.js";
import { categorieDe, categorieDuTrio } from "./categories.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const DATA_DIR = path.join(ROOT, "jeux", "data", "jeux-visuels", "intrus");
const OBJETS_PATH = path.join(DATA_DIR, "objets.json");
const MANCHES_PATH = path.join(DATA_DIR, "intrus.json");
const IMAGES_DIR = path.join(DATA_DIR, "images");
const PLANCHES_DIR = path.join(ROOT, "temp", "intrus-planches");
const DECISIONS_PATH = path.join(PLANCHES_DIR, "validation.json");
const PROPOSITIONS_PATH = path.join(PLANCHES_DIR, "nettete-propositions.json");
const FONT_PATH = path.join(ROOT, "data", "fonts", "Inter-Bold.ttf");
const STATUTS = ["valide", "refuse", "a_revoir"];
const NETTETE_RATIO_MAX = 3.5;
const REMPLACANTS_MAX = 30;
// Familles de style (comme assemblerManches.js) : aplat et peint se recouvrent.
const FAMILLES = { pixel: "pixel", carree: "carree", aplat: "illustre", peint: "illustre" };
const MAX_ACCENTUATION = ACCENTUATION_FORCES.length - 1;

function readPortArg(args) {
  const idx = args.indexOf("--port");
  if (idx === -1) return 3391;
  const value = Number.parseInt(args[idx + 1] ?? "", 10);
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    throw new Error("Port invalide : utilisez --port <1..65535>.");
  }
  return value;
}

async function readJson(file, fallback) {
  try {
    return JSON.parse(await fs.readFile(file, "utf-8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

// Écriture atomique (fichier temporaire puis renommage) : un fichier n'est
// jamais lu à moitié écrit.
async function writeJson(file, data) {
  const tmp = `${file}.${process.pid}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(data, null, 2) + "\n", "utf-8");
  await fs.rename(tmp, file);
}

// Toutes les écritures passent par une seule file : deux clics rapprochés
// (décisions, réglages, remplacements) ne s'écrasent jamais.
let fileEcriture = Promise.resolve();
function enFile(tache) {
  const run = fileEcriture.then(tache);
  fileEcriture = run.catch(() => {});
  return run;
}

const gameIdOf = (numero) => `i${String(numero).padStart(3, "0")}`;

// Analyse mise en cache par image (recalculée si le fichier change).
const analyseCache = new Map();
async function analyse(objet) {
  const file = path.join(IMAGES_DIR, objet.image);
  const { mtimeMs } = await fs.stat(file);
  const cached = analyseCache.get(objet.id);
  if (cached?.mtimeMs === mtimeMs) return cached.result;
  const result = analyserIcone(await fs.readFile(file));
  analyseCache.set(objet.id, { mtimeMs, result });
  return result;
}

// Réglages de relecture d'un objet : valeur par défaut = clé absente, pour
// garder objets.json lisible.
function applyPatch(objet, patch) {
  if ("accentuation" in patch) {
    const level = Number(patch.accentuation);
    if (!Number.isInteger(level) || level < 0 || level > MAX_ACCENTUATION) throw new Error("accentuation invalide");
    if (level) objet.accentuation = level;
    else delete objet.accentuation;
  }
  if ("style" in patch) {
    if (patch.style && !STYLES[patch.style]) throw new Error("style inconnu");
    if (patch.style) objet.style = patch.style;
    else delete objet.style;
  }
  if ("etiquettes" in patch) {
    const tags = [...new Set((patch.etiquettes ?? []).map((t) => String(t).trim().toLowerCase()).filter(Boolean))];
    if (tags.length) objet.etiquettes = tags.slice(0, 10);
    else delete objet.etiquettes;
  }
  if ("exclu" in patch) {
    if (patch.exclu) objet.exclu = true;
    else delete objet.exclu;
  }
}

function updateObjets(ids, patch) {
  return enFile(async () => {
    const objets = JSON.parse(await fs.readFile(OBJETS_PATH, "utf-8"));
    const byId = new Map(objets.map((o) => [o.id, o]));
    for (const id of ids) {
      const objet = byId.get(id);
      if (!objet) throw new Error(`objet inconnu : ${id}`);
      applyPatch(objet, patch);
    }
    await writeJson(OBJETS_PATH, objets);
    return ids.map((id) => byId.get(id));
  });
}

async function iconDataUrl(image) {
  return `data:image/png;base64,${(await fs.readFile(path.join(IMAGES_DIR, image))).toString("base64")}`;
}

async function renderPlanche(gameId) {
  const [objets, manches] = await Promise.all([readJson(OBJETS_PATH, []), readJson(MANCHES_PATH, [])]);
  const manche = manches.find((m) => gameIdOf(m.numero) === gameId);
  if (!manche) return null;
  const entry = parseIntrusEntry(manche, new Map(objets.map((o) => [o.id, o])));
  const cells = await Promise.all(
    entry.images.map(async (image, i) => ({
      letter: "ABCD"[i],
      dataUrl: await iconDataUrl(image),
      accentuation: entry.accentuations[i],
    })),
  );
  return (await rasterizeGrid(buildGridSvg(cells), FONT_PATH)).buffer;
}

// Icône seule, avec une accentuation donnée (aperçu avant enregistrement).
async function renderIcone(objet, level) {
  const size = 220;
  const filter = level > 0 ? ` filter="url(#acc${level})"` : "";
  const svg = `<svg width="${size}" height="${size}" xmlns="http://www.w3.org/2000/svg">
  ${level > 0 ? `<defs>${accentuationFilter(level)}</defs>` : ""}
  <image width="${size}" height="${size}"${filter} href="${await iconDataUrl(objet.image)}"/>
</svg>`;
  return Buffer.from(new Resvg(svg).render().asPng());
}

function formatManche(m, analyses) {
  const ids = [m.intrus, ...m.objets];
  const signatures = ids.map((id) => analyses.get(id)?.signature);
  return { ...m, id: gameIdOf(m.numero), ids, visuel: signatures.every(Boolean) ? intrusVisible(signatures) : null };
}

async function analyserTout(objets) {
  return new Map(await Promise.all(objets.map(async (o) => [o.id, await analyse(o)])));
}

// Objets de remplacement pour la position `index` d'une manche (0 = intrus),
// pris parmi les objets non exclus et absents de toute manche : même jeu
// pour un objet du trio, autre jeu (sans homonyme dans le jeu du trio) pour
// l'intrus. Ordre : même catégorie que la manche (baie parmi des baies,
// voir categories.js), puis compatibles (même famille de style, netteté
// comparable, intrus non visible), puis du plus proche visuellement au plus
// loin. `recherche` filtre sur le nom ou le jeu.
async function listerRemplacants(gameId, index, recherche = "") {
  const [objets, manches] = await Promise.all([readJson(OBJETS_PATH, []), readJson(MANCHES_PATH, [])]);
  const manche = manches.find((m) => gameIdOf(m.numero) === gameId);
  if (!manche || !(index >= 0 && index <= 3)) return null;
  const analyses = await analyserTout(objets);
  const byId = new Map(objets.map((o) => [o.id, o]));
  const ids = [manche.intrus, ...manche.objets];
  const utilises = new Set(manches.flatMap((m) => [m.intrus, ...m.objets]));
  const famille = (o) => FAMILLES[o.style ?? analyses.get(o.id).styleAuto];
  const autres = ids.filter((_, i) => i !== index).map((id) => byId.get(id));
  const categorie = categorieDuTrio(autres);
  const filtre = normalizeAnswer(recherche);
  const nomsDuJeu = new Set(objets.filter((o) => o.jeu === manche.jeu).map((o) => normalizeAnswer(o.nom)));
  // Référence de proximité : le trio pour l'intrus, les 2 autres objets du
  // trio pour un objet du trio.
  const reference = (index === 0 ? ids.slice(1) : ids.slice(1).filter((_, i) => i + 1 !== index)).map((id) => analyses.get(id).signature);

  return objets
    .filter((o) => !o.exclu && !utilises.has(o.id))
    .filter((o) => (index === 0 ? o.jeu !== manche.jeu && !nomsDuJeu.has(normalizeAnswer(o.nom)) : o.jeu === manche.jeu))
    .filter((o) => !filtre || normalizeAnswer(`${o.nom} ${o.nomVO ?? ""} ${o.jeu}`).includes(filtre))
    .map((o) => {
      const nouveaux = ids.map((id, i) => (i === index ? o.id : id));
      const { raisons } = intrusVisible(nouveaux.map((id) => analyses.get(id).signature));
      const nets = nouveaux.map((id) => Math.max(analyses.get(id).nettete, 0.01));
      const problemes = raisons.map((r) => `intrus visible (${r})`);
      if (autres.some((a) => famille(a) !== famille(o))) problemes.push("style différent");
      if (Math.max(...nets) / Math.min(...nets) >= NETTETE_RATIO_MAX) problemes.push("netteté inégale");
      const distance = reference.reduce((s, sig) => s + distMixte(analyses.get(o.id).signature, sig), 0) / reference.length;
      const memeCategorie = Boolean(categorie) && categorieDe(o) === categorie;
      return { id: o.id, nom: o.nom, jeu: o.jeu, nettete: analyses.get(o.id).nettete, accentuation: o.accentuation ?? 0, problemes, memeCategorie, distance: Number(distance.toFixed(3)) };
    })
    .sort((a, b) => b.memeCategorie - a.memeCategorie || a.problemes.length - b.problemes.length || a.distance - b.distance)
    .slice(0, REMPLACANTS_MAX);
}

function remplacer(gameId, index, id) {
  return enFile(async () => {
    const [objets, manches] = await Promise.all([readJson(OBJETS_PATH, []), readJson(MANCHES_PATH, [])]);
    const manche = manches.find((m) => gameIdOf(m.numero) === gameId);
    const objet = objets.find((o) => o.id === id);
    if (!manche || !objet || !(index >= 0 && index <= 3)) throw new Error("remplacement invalide");
    if (manches.some((m) => [m.intrus, ...m.objets].includes(id))) throw new Error("objet déjà utilisé : invalide");
    if (index === 0) {
      if (objet.jeu === manche.jeu) throw new Error("l'intrus doit venir d'un autre jeu : invalide");
      manche.intrus = id;
      manche.jeuIntrus = objet.jeu;
      manche.explication = `${objet.nom} vient de ${objet.jeu} ; les trois autres objets viennent de ${manche.jeu}.`;
    } else {
      if (objet.jeu !== manche.jeu) throw new Error(`l'objet doit venir de ${manche.jeu} : invalide`);
      manche.objets[index - 1] = id;
    }
    await writeJson(MANCHES_PATH, manches);
    return formatManche(manche, await analyserTout(objets));
  });
}

async function buildState() {
  const [objets, manches, decisionsFile, propositionsFile] = await Promise.all([
    readJson(OBJETS_PATH, []),
    readJson(MANCHES_PATH, []),
    readJson(DECISIONS_PATH, { updatedAt: null, decisions: {} }),
    readJson(PROPOSITIONS_PATH, { propositions: [] }),
  ]);
  const mancheByObjet = new Map(manches.flatMap((m) => [m.intrus, ...m.objets].map((id) => [id, gameIdOf(m.numero)])));
  const analyses = new Map(await Promise.all(objets.map(async (o) => [o.id, await analyse(o)])));
  // La signature (512 valeurs) reste côté serveur : seul le verdict par
  // manche est envoyé à la page.
  const analysed = objets.map((o) => {
    const { signature, ...mesures } = analyses.get(o.id);
    void signature;
    return { ...o, analyse: mesures, manche: mancheByObjet.get(o.id) ?? null };
  });
  return {
    styles: STYLES,
    difficultes: DIFFICULTES,
    maxAccentuation: MAX_ACCENTUATION,
    objets: analysed,
    manches: manches.map((m) => formatManche(m, analyses)),
    decisions: decisionsFile.decisions ?? {},
    updatedAt: decisionsFile.updatedAt ?? null,
    propositions: Object.fromEntries(
      (propositionsFile.propositions ?? []).filter((p) => typeof p?.gameId === "string").map((p) => [p.gameId.toLowerCase(), p]),
    ),
  };
}

async function main() {
  const args = process.argv.slice(2);
  const port = readPortArg(args);

  if (args.includes("--check")) {
    const state = await buildState();
    const parStyle = {};
    for (const o of state.objets) {
      const style = o.style ?? o.analyse.styleAuto;
      parStyle[style] = (parStyle[style] ?? 0) + 1;
    }
    console.log(`${state.objets.length} objets analysés, ${state.manches.length} manches.`);
    console.log(`Styles : ${Object.entries(parStyle).map(([s, n]) => `${STYLES[s]} ${n}`).join(", ")}.`);
    return;
  }

  await fs.mkdir(PLANCHES_DIR, { recursive: true });
  const app = express();
  app.use(express.json({ limit: "64kb" }));
  app.use("/api/intrus/demo/static", express.static(path.join(__dirname, "demo")));

  app.get("/api/intrus/demo", (_req, res) => res.sendFile(path.join(__dirname, "demo", "index.html")));

  app.get("/api/intrus/demo/state", async (_req, res, next) => {
    try {
      res.json(await buildState());
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/intrus/demo/planche/:gameId.png", async (req, res, next) => {
    try {
      const buffer = await renderPlanche(req.params.gameId.toLowerCase());
      if (!buffer) return res.status(404).end();
      res.setHeader("Cache-Control", "no-store");
      res.type("png").send(buffer);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/intrus/demo/icone/:id.png", async (req, res, next) => {
    try {
      const objet = (await readJson(OBJETS_PATH, [])).find((o) => o.id === req.params.id);
      if (!objet) return res.status(404).end();
      const level = Math.min(MAX_ACCENTUATION, Math.max(0, Number.parseInt(req.query.acc ?? objet.accentuation ?? 0, 10) || 0));
      res.setHeader("Cache-Control", "no-store");
      res.type("png").send(await renderIcone(objet, level));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/intrus/demo/objets", async (req, res, next) => {
    try {
      const { ids, patch } = req.body ?? {};
      if (!Array.isArray(ids) || !ids.length || typeof patch !== "object" || patch === null) {
        return res.status(400).json({ error: "attendu { ids: [...], patch: {...} }" });
      }
      res.json({ objets: await updateObjets(ids.map(String), patch) });
    } catch (error) {
      if (/invalide|inconnu/.test(error.message)) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  app.get("/api/intrus/demo/remplacants/:gameId/:index", async (req, res, next) => {
    try {
      const liste = await listerRemplacants(req.params.gameId.toLowerCase(), Number(req.params.index), String(req.query.q ?? ""));
      if (!liste) return res.status(404).end();
      res.json({ remplacants: liste });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/intrus/demo/remplacer", async (req, res, next) => {
    try {
      const { gameId, index, id } = req.body ?? {};
      res.json({ manche: await remplacer(String(gameId).toLowerCase(), Number(index), String(id)) });
    } catch (error) {
      if (/invalide/.test(error.message)) return res.status(400).json({ error: error.message });
      next(error);
    }
  });

  app.post("/api/intrus/demo/decision", async (req, res, next) => {
    try {
      const { id, statut, commentaire } = req.body ?? {};
      if (!/^i\d{3}$/i.test(String(id ?? ""))) return res.status(400).json({ error: "id invalide (attendu iXXX)" });
      if (!STATUTS.includes(statut)) return res.status(400).json({ error: "statut invalide (valide|refuse|a_revoir)" });
      const saved = await enFile(async () => {
        const current = await readJson(DECISIONS_PATH, { updatedAt: null, decisions: {} });
        current.decisions[id.toLowerCase()] = {
          statut,
          commentaire: typeof commentaire === "string" ? commentaire.slice(0, 600) : "",
        };
        const data = { updatedAt: new Date().toISOString(), decisions: current.decisions };
        await writeJson(DECISIONS_PATH, data);
        return data;
      });
      res.json(saved);
    } catch (error) {
      next(error);
    }
  });

  app.use((error, _req, res, _next) => {
    console.error("intrus demoValidation:", error.message);
    res.status(500).json({ error: "Erreur interne démo intrus" });
  });

  app.listen(port, () => {
    console.log(`Démo intrus disponible : http://localhost:${port}/api/intrus/demo`);
    console.log(`Réglages d'objets → ${path.relative(ROOT, OBJETS_PATH)} ; décisions → ${path.relative(ROOT, DECISIONS_PATH)}.`);
  });
}

main().catch((error) => {
  console.error("Erreur intrus demoValidation:", error.message);
  process.exit(1);
});
