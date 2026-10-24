#!/usr/bin/env node
// verifierCatalogue.js
// Vérifie le catalogue du jeu "Intrus de l'inventaire"
// (jeux/data/jeux-visuels/intrus/objets.json et intrus.json), télécharge les
// icônes et les normalise en PNG carrés de 256 px dans images/.
//
// Pour chaque objet :
// - source MediaWiki (`source.wiki` = URL de api.php, `source.titre`,
//   `source.fichier`) : la page de l'objet doit exister sur le wiki du jeu,
//   et l'URL de l'icône est relue depuis l'API (imageinfo) ;
// - source locale (`source.localFile`) : icône lue depuis un fichier local
//   versionné (chemin relatif à la racine du dépôt) ;
// - autre source (API ou CDN officiel) : `source.page` doit répondre 200,
//   l'icône est `source.image`.
// Pour chaque manche : 4 objets distincts et connus, les 3 objets du jeu
// partagent `jeu`, l'intrus vient de `jeuIntrus` (différent), difficulté
// connue, `numero` = position dans le fichier.
//
// Usage :
//   node jeux/outils/intrus/verifierCatalogue.js              — vérifie en ligne, télécharge les icônes manquantes
//   node jeux/outils/intrus/verifierCatalogue.js --force      — retélécharge toutes les icônes
//   node jeux/outils/intrus/verifierCatalogue.js --hors-ligne — contrôles locaux seulement (aucune requête)
//   node jeux/outils/intrus/verifierCatalogue.js --planches   — + une planche PNG par manche dans temp/intrus-planches/
//                                                              (intrus toujours en A, pour la relecture)
//   node jeux/outils/intrus/verifierCatalogue.js --netteté    — + rapport de netteté par objet/manche
//                                                              dans temp/intrus-planches/nettete-report.json
//   node jeux/outils/intrus/verifierCatalogue.js --propositions-netteté
//                                                            — + propositions de remplacement pour les manches
//                                                              refusées dans temp/intrus-planches/validation.json
// Après tout ajout d'icône : npm run assets:upload-blob -- jeux-visuels/intrus

import fs from "fs/promises";
import os from "os";
import path from "path";
import { execFile } from "child_process";
import { promisify } from "util";
import { fileURLToPath } from "url";
import { Resvg } from "@resvg/resvg-js";
import { PNG } from "pngjs";
import { DIFFICULTES, parseIntrusEntry } from "../../services/intrus.js";
import { buildGridSvg, rasterizeGrid } from "../../services/intrusImage.js";
import { computeNetteteScore, analyserIcone, intrusVisible } from "./analyseObjets.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, "..", "..", "..");
const DATA_DIR = path.join(ROOT, "jeux", "data", "jeux-visuels", "intrus");
const IMAGES_DIR = path.join(DATA_DIR, "images");
const PLANCHES_DIR = path.join(ROOT, "temp", "intrus-planches");
const FONT_PATH = path.join(ROOT, "data", "fonts", "Inter-Bold.ttf");
const VALIDATION_PATH = path.join(PLANCHES_DIR, "validation.json");

const FORCE = process.argv.includes("--force");
const OFFLINE = process.argv.includes("--hors-ligne");
const PLANCHES = process.argv.includes("--planches");
const NETTETE = process.argv.includes("--netteté") || process.argv.includes("--nettete");
const PROPOSITIONS_NETTETE = process.argv.includes("--propositions-netteté")
  || process.argv.includes("--propositions-nettete");

const ICON_SIZE = 256;
const USER_AGENT = "TrustRoyale-intrus/1.0 (raphael@alsacreations.fr)";
const DELAY_MS = 400; // politesse envers les wikis
const NETTETE_RATIO_ALERT = 3.5;
const MIME_BY_MAGIC = [
  [[0x89, 0x50, 0x4e, 0x47], "image/png"],
  [[0xff, 0xd8, 0xff], "image/jpeg"],
  [[0x47, 0x49, 0x46], "image/gif"],
  [[0x52, 0x49, 0x46, 0x46], "image/webp"],
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchOk(url, init = {}) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(url, { ...init, headers: { "User-Agent": USER_AGENT, ...init.headers } });
    if (res.ok) return res;
    if (attempt >= 3 || ![429, 500, 502, 503, 504].includes(res.status)) {
      throw new Error(`HTTP ${res.status} sur ${url}`);
    }
    await sleep(2000 * attempt);
  }
}

function decodePng(buffer) {
  return PNG.sync.read(buffer);
}

function ratio(max, min) {
  const safeMin = Math.max(min, 0.01);
  return Number((max / safeMin).toFixed(2));
}

async function buildNetteteReport({ objets, manches }) {
  const byId = new Map();
  for (const o of objets) {
    const file = path.join(IMAGES_DIR, o.image);
    const buffer = await fs.readFile(file);
    const score = computeNetteteScore(decodePng(buffer));
    byId.set(o.id, score);
  }

  const manchesReport = manches.map((m) => {
    const ids = [m.intrus, ...m.objets];
    const details = ids.map((id) => ({ id, score: byId.get(id) ?? 0 }));
    const scores = details.map((d) => d.score);
    const min = Math.min(...scores);
    const max = Math.max(...scores);
    const avg = Number((scores.reduce((a, b) => a + b, 0) / scores.length).toFixed(2));
    const scoreRatio = ratio(max, min);
    return {
      numero: m.numero,
      id: `i${String(m.numero).padStart(3, "0")}`,
      jeu: m.jeu,
      jeuIntrus: m.jeuIntrus,
      scoreMoyen: avg,
      scoreMin: min,
      scoreMax: max,
      ratio: scoreRatio,
      alerte: scoreRatio >= NETTETE_RATIO_ALERT,
      objets: details,
    };
  });

  const topAlertes = manchesReport
    .filter((m) => m.alerte)
    .sort((a, b) => b.ratio - a.ratio);

  return {
    generatedAt: new Date().toISOString(),
    seuilAlerteRatio: NETTETE_RATIO_ALERT,
    objets: objets
      .map((o) => ({ id: o.id, jeu: o.jeu, scoreNettete: byId.get(o.id) ?? 0 }))
      .sort((a, b) => b.scoreNettete - a.scoreNettete),
    manches: manchesReport,
    alertes: topAlertes,
  };
}

async function readValidationDecisions() {
  try {
    const parsed = JSON.parse(await fs.readFile(VALIDATION_PATH, "utf-8"));
    return parsed?.decisions ?? {};
  } catch (error) {
    if (error?.code === "ENOENT") return {};
    throw error;
  }
}

function median(values) {
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 0) return (sorted[mid - 1] + sorted[mid]) / 2;
  return sorted[mid];
}

function computeOutlier(ids, scoreById) {
  const pairs = ids.map((id) => ({ id, score: scoreById.get(id) ?? 0 }));
  const target = median(pairs.map((p) => p.score));
  const ranked = pairs
    .map((p) => ({ ...p, delta: Math.abs(p.score - target) }))
    .sort((a, b) => b.delta - a.delta);
  return { targetScore: Number(target.toFixed(2)), outlier: ranked[0], all: ranked };
}

function buildNettetePropositions({ objets, manches, report, validationDecisions }) {
  const byId = new Map(objets.map((o) => [o.id, o]));
  const scoreById = new Map(report.objets.map((o) => [o.id, o.scoreNettete]));
  const manchesById = new Map(manches.map((m) => [`i${String(m.numero).padStart(3, "0")}`, m]));
  const idToManche = new Map(
    manches.flatMap((m) => {
      const gameId = `i${String(m.numero).padStart(3, "0")}`;
      return [m.intrus, ...m.objets].map((id) => [id, gameId]);
    }),
  );
  const used = new Set(manches.flatMap((m) => [m.intrus, ...m.objets]));
  const reserve = objets.filter((o) => !used.has(o.id));

  const refusedIds = Object.entries(validationDecisions)
    .filter(([, d]) => d?.statut === "refuse")
    .map(([id]) => id.toLowerCase())
    .sort((a, b) => a.localeCompare(b, "fr"));
  const targetIds = refusedIds.length ? refusedIds : report.alertes.map((a) => a.id.toLowerCase());

  const propositions = targetIds.flatMap((gameId) => {
    const manche = manchesById.get(gameId);
    if (!manche) return [];
    const ids = [manche.intrus, ...manche.objets];
    const { targetScore, outlier } = computeOutlier(ids, scoreById);
    const outlierType = outlier.id === manche.intrus ? "intrus" : "objet";
    const requiredGame = outlierType === "intrus" ? manche.jeuIntrus : manche.jeu;

    const reserveCandidates = reserve
      .filter((o) => o.jeu === requiredGame)
      .map((o) => {
        const score = scoreById.get(o.id) ?? 0;
        return {
          type: "reserve",
          id: o.id,
          nom: o.nom,
          jeu: o.jeu,
          scoreNettete: score,
          delta: Number(Math.abs(score - targetScore).toFixed(2)),
        };
      })
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 5);

    const swapCandidates = objets
      .filter((o) => o.jeu === requiredGame && !ids.includes(o.id))
      .map((o) => {
        const score = scoreById.get(o.id) ?? 0;
        const sourceGameId = idToManche.get(o.id) ?? null;
        return {
          type: "echange",
          id: o.id,
          nom: o.nom,
          jeu: o.jeu,
          scoreNettete: score,
          delta: Number(Math.abs(score - targetScore).toFixed(2)),
          mancheSource: sourceGameId,
          mancheSourceRefusee: sourceGameId ? validationDecisions[sourceGameId]?.statut === "refuse" : null,
        };
      })
      .sort((a, b) => a.delta - b.delta)
      .slice(0, 8);

    const candidates = [...reserveCandidates, ...swapCandidates].slice(0, 8);

    const details = ids.map((id) => ({
      id,
      nom: byId.get(id)?.nom ?? id,
      jeu: byId.get(id)?.jeu ?? "inconnu",
      scoreNettete: scoreById.get(id) ?? 0,
    }));

    return [{
      gameId,
      numero: manche.numero,
      jeu: manche.jeu,
      jeuIntrus: manche.jeuIntrus,
      commentaireRefus: validationDecisions[gameId]?.commentaire ?? null,
      typeOutlier: outlierType,
      outlier: {
        id: outlier.id,
        nom: byId.get(outlier.id)?.nom ?? outlier.id,
        jeu: byId.get(outlier.id)?.jeu ?? "inconnu",
        scoreNettete: outlier.score,
        ecartAuCentre: Number(outlier.delta.toFixed(2)),
      },
      scoreCible: targetScore,
      objetsActuels: details,
      candidatesReserve: reserveCandidates,
      candidatesEchange: swapCandidates,
      candidates,
    }];
  });

  return {
    generatedAt: new Date().toISOString(),
    sourceValidation: path.relative(ROOT, VALIDATION_PATH),
    manchesCiblees: targetIds.length,
    manchesRefusees: refusedIds.length,
    reserveObjets: reserve.length,
    propositions,
  };
}

async function queryWiki(api, params) {
  const url = new URL(api);
  for (const [k, v] of Object.entries({ action: "query", format: "json", redirects: "1", ...params })) {
    url.searchParams.set(k, v);
  }
  const res = await fetchOk(url);
  return res.json();
}

function resolveLocalPath(localFile) {
  const absolute = path.resolve(ROOT, localFile);
  const rootPrefix = `${ROOT}${path.sep}`;
  if (!absolute.startsWith(rootPrefix)) {
    throw new Error(`localFile hors dépôt : ${localFile}`);
  }
  return absolute;
}

// Source de l'icône, après vérification que la page de l'objet existe.
async function resolveSource(objet) {
  const { source } = objet;
  if (source.localFile) {
    const absolute = resolveLocalPath(source.localFile);
    const buffer = await fs.readFile(absolute);
    return { kind: "local", buffer };
  }
  if (source.wiki) {
    const page = await queryWiki(source.wiki, { titles: source.titre });
    const p = Object.values(page.query?.pages ?? {})[0];
    if (!p || "missing" in p || "invalid" in p) throw new Error(`page « ${source.titre} » absente de ${source.wiki}`);
    if (!source.fichier) return { kind: "remote", url: source.image };
    const file = await queryWiki(source.wiki, { titles: `File:${source.fichier}`, prop: "imageinfo", iiprop: "url" });
    const f = Object.values(file.query?.pages ?? {})[0];
    const url = f?.imageinfo?.[0]?.url;
    if (!url) throw new Error(`fichier « ${source.fichier} » absent de ${source.wiki}`);
    return { kind: "remote", url };
  }
  await fetchOk(source.page);
  return { kind: "remote", url: source.image };
}

function sniffMime(buffer) {
  const hit = MIME_BY_MAGIC.find(([magic]) => magic.every((b, i) => buffer[i] === b));
  if (!hit) throw new Error("format d'image non reconnu");
  return hit[1];
}

// resvg ne décode pas le WebP : conversion en PNG par `sips` (macOS).
async function webpToPng(buffer) {
  const tmp = path.join(os.tmpdir(), `intrus-${process.pid}-${Date.now()}`);
  await fs.writeFile(`${tmp}.webp`, buffer);
  try {
    await promisify(execFile)("sips", ["-s", "format", "png", `${tmp}.webp`, "--out", `${tmp}.png`]);
    return await fs.readFile(`${tmp}.png`);
  } catch {
    throw new Error("icône WebP : conversion PNG impossible (sips requis, macOS)");
  } finally {
    await fs.rm(`${tmp}.webp`, { force: true });
    await fs.rm(`${tmp}.png`, { force: true });
  }
}

function renderIcon(dataUrl, { pixel, remplir, viewBox = `0 0 ${ICON_SIZE} ${ICON_SIZE}` }) {
  const rendering = pixel ? ' image-rendering="optimizeSpeed"' : "";
  const fit = remplir ? "xMidYMid slice" : "xMidYMid meet";
  const svg = `<svg width="${ICON_SIZE}" height="${ICON_SIZE}" viewBox="${viewBox}" xmlns="http://www.w3.org/2000/svg">
  <image x="0" y="0" width="${ICON_SIZE}" height="${ICON_SIZE}" preserveAspectRatio="${fit}"${rendering} href="${dataUrl}"/>
</svg>`;
  return new Resvg(svg, { fitTo: { mode: "width", value: ICON_SIZE } }).render();
}

// Carré englobant les pixels visibles (alpha > 8), marges transparentes
// exclues : sans ce rognage, une source à large marge (Wakfu) paraît plus
// petite que les autres et trahit l'intrus.
function visibleSquare({ pixels, width, height }) {
  let [x0, y0, x1, y1] = [width, height, -1, -1];
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (pixels[(y * width + x) * 4 + 3] <= 8) continue;
      x0 = Math.min(x0, x); y0 = Math.min(y0, y); x1 = Math.max(x1, x); y1 = Math.max(y1, y);
    }
  }
  if (x1 < 0) return null;
  const side = Math.max(x1 - x0 + 1, y1 - y0 + 1);
  return `${(x0 + x1 + 1 - side) / 2} ${(y0 + y1 + 1 - side) / 2} ${side} ${side}`;
}

// Icône centrée dans un carré transparent de 256 px, marges rognées.
// `pixel` : agrandissement au plus proche voisin (pixel art), sinon lissé.
// `remplir` : icône rectangulaire opaque recadrée au centre (Dota 2), pour
// que sa forme ne la distingue pas des icônes carrées.
async function normalizeIcon(buffer, { pixel = false, remplir = false } = {}) {
  if (sniffMime(buffer) === "image/webp") buffer = await webpToPng(buffer);
  const dataUrl = `data:${sniffMime(buffer)};base64,${buffer.toString("base64")}`;
  const first = renderIcon(dataUrl, { pixel, remplir });
  // Une image non décodée par resvg donne un rendu entièrement transparent.
  const viewBox = visibleSquare(first);
  if (!viewBox) throw new Error("icône vide après normalisation");
  return Buffer.from(renderIcon(dataUrl, { pixel, remplir, viewBox }).asPng());
}

async function exists(file) {
  return fs.access(file).then(() => true, () => false);
}

function checkManches(manches, objetsById) {
  const errors = [];
  manches.forEach((m, i) => {
    const where = `manche ${m.numero ?? `#${i + 1}`}`;
    if (m.numero !== i + 1) errors.push(`${where} : numero attendu ${i + 1}`);
    if (!DIFFICULTES[m.difficulte]) errors.push(`${where} : difficulté inconnue « ${m.difficulte} »`);
    if (!m.explication) errors.push(`${where} : explication manquante`);
    const ids = [m.intrus, ...(m.objets ?? [])];
    if (ids.length !== 4 || new Set(ids).size !== 4) errors.push(`${where} : 4 objets distincts attendus`);
    const missing = ids.filter((id) => !objetsById.has(id));
    if (missing.length) return errors.push(`${where} : objets inconnus ${missing.join(", ")}`);
    if (m.jeu === m.jeuIntrus) errors.push(`${where} : l'intrus doit venir d'un autre jeu`);
    for (const id of m.objets) {
      if (objetsById.get(id).jeu !== m.jeu) errors.push(`${where} : ${id} ne vient pas de « ${m.jeu} »`);
    }
    if (objetsById.get(m.intrus).jeu !== m.jeuIntrus) errors.push(`${where} : l'intrus ${m.intrus} ne vient pas de « ${m.jeuIntrus} »`);
  });
  return errors;
}

(async () => {
  const objets = JSON.parse(await fs.readFile(path.join(DATA_DIR, "objets.json"), "utf-8"));
  const manches = JSON.parse(await fs.readFile(path.join(DATA_DIR, "intrus.json"), "utf-8"));
  const objetsById = new Map(objets.map((o) => [o.id, o]));
  const errors = [];

  if (objetsById.size !== objets.length) errors.push("identifiants d'objets en double");
  for (const o of objets) {
    if (o.image !== `${o.id}.png`) errors.push(`${o.id} : image attendue « ${o.id}.png »`);
    if (!o.nom || !o.jeu || !o.source) errors.push(`${o.id} : nom, jeu ou source manquant`);
  }
  errors.push(...checkManches(manches, objetsById));

  await fs.mkdir(IMAGES_DIR, { recursive: true });
  for (const o of objets) {
    const file = path.join(IMAGES_DIR, o.image);
    try {
      if (OFFLINE) {
        if (!(await exists(file))) throw new Error("icône absente");
        continue;
      }
      const resolved = await resolveSource(o);
      if (FORCE || !(await exists(file))) {
        const buffer = resolved.kind === "local"
          ? resolved.buffer
          : Buffer.from(await (await fetchOk(resolved.url)).arrayBuffer());
        await fs.writeFile(file, await normalizeIcon(buffer, { pixel: o.pixel, remplir: o.remplir }));
        console.log(`↓ ${o.id} (${o.jeu})`);
      }
      await sleep(DELAY_MS);
    } catch (err) {
      errors.push(`${o.id} : ${err.message}`);
    }
  }

  const used = new Set(manches.flatMap((m) => [m.intrus, ...m.objets]));
  // Intrus repérable à l'œil (3 objets quasi identiques, forme à part) :
  // casse le jeu, toujours bloquant.
  if (!errors.length) {
    for (const m of manches) {
      const signatures = await Promise.all(
        [m.intrus, ...m.objets].map(async (id) => analyserIcone(await fs.readFile(path.join(IMAGES_DIR, objetsById.get(id).image))).signature),
      );
      const { raisons } = intrusVisible(signatures);
      if (raisons.length) errors.push(`manche ${m.numero} : intrus visible à l'œil (${raisons.join(", ")})`);
    }
  }
  const unused = objets.filter((o) => !used.has(o.id)).map((o) => o.id);
  if (unused.length) console.log(`Objets sans manche (réserve) : ${unused.join(", ")}`);

  if (PLANCHES && errors.length === 0) {
    await fs.mkdir(PLANCHES_DIR, { recursive: true });
    for (const m of manches) {
      const entry = parseIntrusEntry(m, objetsById);
      const cells = await Promise.all(
        entry.images.map(async (image, i) => ({
          letter: "ABCD"[i],
          dataUrl: `data:image/png;base64,${(await fs.readFile(path.join(IMAGES_DIR, image))).toString("base64")}`,
        })),
      );
      const { buffer } = await rasterizeGrid(buildGridSvg(cells), FONT_PATH);
      await fs.writeFile(path.join(PLANCHES_DIR, `${entry.id}.png`), buffer);
    }
    console.log(`Planches écrites dans ${path.relative(ROOT, PLANCHES_DIR)}/ (intrus en A).`);
  }

  let netteteReport = null;
  if ((NETTETE || PROPOSITIONS_NETTETE) && errors.length === 0) {
    await fs.mkdir(PLANCHES_DIR, { recursive: true });
    const report = await buildNetteteReport({ objets, manches });
    netteteReport = report;
    const reportPath = path.join(PLANCHES_DIR, "nettete-report.json");
    await fs.writeFile(reportPath, JSON.stringify(report, null, 2) + "\n");
    if (report.alertes.length) {
      const top = report.alertes
        .slice(0, 10)
        .map((a) => `${a.id} (ratio ${a.ratio})`)
        .join(", ");
      console.log(`Alerte netteté (${report.alertes.length} manches) : ${top}`);
    } else {
      console.log("Alerte netteté : aucune manche au-dessus du seuil.");
    }
    console.log(`Rapport netteté écrit : ${path.relative(ROOT, reportPath)}`);
  }

  if (PROPOSITIONS_NETTETE && errors.length === 0) {
    const validationDecisions = await readValidationDecisions();
    const report = netteteReport ?? await buildNetteteReport({ objets, manches });
    const propositions = buildNettetePropositions({
      objets,
      manches,
      report,
      validationDecisions,
    });
    const outPath = path.join(PLANCHES_DIR, "nettete-propositions.json");
    await fs.writeFile(outPath, JSON.stringify(propositions, null, 2) + "\n");
    console.log(
      `Propositions netteté : ${propositions.propositions.length} manche(s) écrites dans ${path.relative(ROOT, outPath)}`,
    );
  }

  const counts = Object.keys(DIFFICULTES).map((d) => `${d} ${manches.filter((m) => m.difficulte === d).length}`);
  console.log(`${objets.length} objets, ${manches.length} manches (${counts.join(", ")}).`);
  if (errors.length) {
    console.error(`\n${errors.length} erreur(s) :\n- ${errors.join("\n- ")}`);
    process.exit(1);
  }
  console.log("Catalogue valide.");
})();
