// ============================================================
// services/matchupCatalog.js — Catalogue de win conditions / counters
// pour le moteur de %matchup (backend/services/matchupEngine.js).
//
// En production : lit data/clash-royale-matchup-catalog.json depuis GitHub
// (cache 5 min), pour permettre d'ajouter un counter sans redéploiement.
// En dev local : lit directement le fichier local.
// Mêmes principes que backend/services/discordLinks.js.
// ============================================================

import fs from "fs/promises";
import path from "path";
import { fileURLToPath } from "url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const CATALOG_LOCAL_PATH = path.resolve(
  __dirname,
  "../../data/clash-royale-matchup-catalog.json",
);
const CATALOG_REPO_PATH = "data/clash-royale-matchup-catalog.json";
const RULES_LOCAL_PATH = path.resolve(
  __dirname,
  "../../data/clash-royale-matchup-structure-rules.json",
);
const RULES_REPO_PATH = "data/clash-royale-matchup-structure-rules.json";

let _cache = null;
let _cacheTime = 0;
const TTL = 5 * 60 * 1000; // 5 minutes

/**
 * Charge un fichier JSON depuis GitHub Contents API (si GITHUB_REPO/GITHUB_TOKEN
 * définis) sinon depuis le disque local. Retourne `null` en cas d'échec — à
 * charge de l'appelant de définir un repli neutre.
 */
async function loadJsonFile(repoPath, localPath) {
  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;

  if (!repo || !token) {
    try {
      const raw = await fs.readFile(localPath, "utf8");
      return JSON.parse(raw);
    } catch {
      return null;
    }
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/${repoPath}`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!res.ok) return null;
    const json = await res.json();
    return JSON.parse(Buffer.from(json.content, "base64").toString("utf8"));
  } catch {
    return null;
  }
}

/**
 * Normalise un nom de carte pour comparaison : minuscule, sans ponctuation
 * (points, apostrophes) ni accents, espaces multiples réduits.
 * Absorbe les divergences de nommage (ex. "P.E.K.K.A." vs "P.E.K.K.A").
 */
export function normalizeCardName(name) {
  return String(name ?? "")
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.'’]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

// Une "variante" redéfinit archetype/hardCounters/softCounters d'une win
// condition quand une carte compagne précise est aussi présente dans le
// même deck (ex. Balloon + Lava Hound = "LavaLoon", profil Beatdown propre,
// distinct du Balloon "Cycle" seul). `companion` accepte un nom unique ou
// une liste (n'importe laquelle suffit à déclencher la variante).
function buildVariants(rawVariants) {
  if (!Array.isArray(rawVariants)) return [];
  return rawVariants.map((v) => ({
    id: v?.id,
    companion: Array.isArray(v?.companion)
      ? v.companion
      : [v?.companion].filter(Boolean),
    archetype: v?.archetype,
    hardCounters: Array.isArray(v?.hardCounters) ? v.hardCounters : [],
    softCounters: Array.isArray(v?.softCounters) ? v.softCounters : [],
  }));
}

function buildWinConditionsByName(rawCatalog) {
  const winConditions = Array.isArray(rawCatalog?.winConditions)
    ? rawCatalog.winConditions
    : [];
  const byName = new Map();
  for (const entry of winConditions) {
    const key = normalizeCardName(entry?.name);
    if (!key || byName.has(key)) continue;
    byName.set(key, {
      name: entry.name,
      archetype: entry.archetype,
      hardCounters: Array.isArray(entry.hardCounters)
        ? entry.hardCounters
        : [],
      softCounters: Array.isArray(entry.softCounters)
        ? entry.softCounters
        : [],
      variants: buildVariants(entry.variants),
    });
  }
  return byName;
}

function toNormalizedSet(names) {
  return new Set(
    (Array.isArray(names) ? names : []).map((name) => normalizeCardName(name)),
  );
}

// Layer 1 — avantage d'archétype directionnel : ARCHETYPE_ADVANTAGE[X]
// contient les archétypes contre lesquels X a l'avantage (+5%). Donnée
// figée en JS (contrairement au Layer 3, ne bénéficie pas du hot-reload) :
// périmètre volontairement restreint, cf. demande utilisateur qui ne visait
// que le Layer 3 ("Structure du deck").
export const ARCHETYPE_ADVANTAGE = {
  Beatdown: ["Siege", "Control"],
  Cycle: ["Beatdown"],
  Control: ["Bridge Spam", "Cycle"],
  Bait: ["Control"],
  Siege: ["Bait", "Bridge Spam"],
};

/**
 * Compile data/clash-royale-matchup-structure-rules.json (Layer 3) en une
 * forme directement exploitable par matchupEngine.js : cardSets → Set de
 * noms normalisés, règles conservées telles quelles (interprétées par le
 * moteur). En cas d'échec de chargement, retourne des règles vides — le
 * Layer 3 se neutralise alors partout (même logique de repli que pour le
 * catalogue de counters).
 */
function buildStructureRules(raw) {
  const cardSets = {};
  for (const [key, names] of Object.entries(raw?.cardSets ?? {})) {
    cardSets[key] = toNormalizedSet(names);
  }
  return {
    cardSets,
    crossRules: Array.isArray(raw?.crossRules) ? raw.crossRules : [],
    dispersionRules: Array.isArray(raw?.dispersionRules)
      ? raw.dispersionRules
      : [],
    clamp: Number.isFinite(raw?.layerClamp) ? raw.layerClamp : 10,
  };
}

/**
 * Retourne { winConditionsByName, normalizeCardName, structureRules }.
 * winConditionsByName : Map<nomNormalisé, {name, archetype, hardCounters, softCounters}>
 * (Layers 1/2 s'appuient dessus). structureRules : cardSets/crossRules/dispersionRules/clamp
 * compilés depuis data/clash-royale-matchup-structure-rules.json (Layer 3).
 * Les deux fichiers sont lus via GitHub Contents API en production (fichier
 * local en dev), avec le même cache 5 min — éditer l'un ou l'autre sur
 * GitHub est pris en compte par /matchup sans redéploiement.
 */
export async function getWinConditionsCatalog() {
  if (_cache !== null && Date.now() - _cacheTime < TTL) return _cache;

  const [rawCatalog, rawRules] = await Promise.all([
    loadJsonFile(CATALOG_REPO_PATH, CATALOG_LOCAL_PATH),
    loadJsonFile(RULES_REPO_PATH, RULES_LOCAL_PATH),
  ]);

  _cache = {
    winConditionsByName: buildWinConditionsByName(rawCatalog),
    normalizeCardName,
    structureRules: buildStructureRules(rawRules),
  };
  _cacheTime = Date.now();
  return _cache;
}
