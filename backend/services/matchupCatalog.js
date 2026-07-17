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
const LOCAL_PATH = path.resolve(
  __dirname,
  "../../data/clash-royale-matchup-catalog.json",
);

let _cache = null;
let _cacheTime = 0;
const TTL = 5 * 60 * 1000; // 5 minutes

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
    });
  }
  return byName;
}

/**
 * Retourne { winConditionsByName, normalizeCardName }.
 * winConditionsByName : Map<nomNormalisé, {name, archetype, hardCounters, softCounters}>.
 * Utilise GitHub Contents API en production, le fichier local en dev.
 * En cas d'erreur, retourne un catalogue vide (Layers 1/2 se neutralisent alors partout).
 */
export async function getWinConditionsCatalog() {
  if (_cache !== null && Date.now() - _cacheTime < TTL) return _cache;

  const repo = process.env.GITHUB_REPO;
  const token = process.env.GITHUB_TOKEN;

  // Fallback local : utilisé quand les variables GitHub ne sont pas définies
  if (!repo || !token) {
    try {
      const raw = await fs.readFile(LOCAL_PATH, "utf8");
      const winConditionsByName = buildWinConditionsByName(JSON.parse(raw));
      _cache = { winConditionsByName, normalizeCardName };
      _cacheTime = Date.now();
      return _cache;
    } catch {
      _cache = { winConditionsByName: new Map(), normalizeCardName };
      _cacheTime = Date.now();
      return _cache;
    }
  }

  try {
    const res = await fetch(
      `https://api.github.com/repos/${repo}/contents/data/clash-royale-matchup-catalog.json`,
      {
        headers: {
          Authorization: `token ${token}`,
          Accept: "application/vnd.github+json",
        },
      },
    );
    if (!res.ok) {
      _cache = { winConditionsByName: new Map(), normalizeCardName };
      _cacheTime = Date.now();
      return _cache;
    }
    const json = await res.json();
    const rawCatalog = JSON.parse(
      Buffer.from(json.content, "base64").toString("utf8"),
    );
    const winConditionsByName = buildWinConditionsByName(rawCatalog);
    _cache = { winConditionsByName, normalizeCardName };
    _cacheTime = Date.now();
    return _cache;
  } catch {
    _cache = { winConditionsByName: new Map(), normalizeCardName };
    _cacheTime = Date.now();
    return _cache;
  }
}

// ------------------------------------------------------------
// Données statiques (Layers 1 et 3) — recopiées telles quelles du
// system prompt fourni (temp/matchup-v2/gemini-code-1784305026864.md).
// Ce ne sont pas des "counters" éditables à chaud : toute évolution de
// ces règles de structure passe par un déploiement.
// ------------------------------------------------------------

// Layer 1 — avantage d'archétype directionnel : ARCHETYPE_ADVANTAGE[X]
// contient les archétypes contre lesquels X a l'avantage (+10%).
export const ARCHETYPE_ADVANTAGE = {
  Beatdown: ["Siege", "Control"],
  Cycle: ["Beatdown"],
  Control: ["Bridge Spam", "Cycle"],
  Bait: ["Control"],
  Siege: ["Bait", "Bridge Spam"],
};

// Layer 3 — catégories utilitaires
export const SMALL_SPELLS = [
  "The Log",
  "Zap",
  "Arrows",
  "Barbarian Barrel",
  "Giant Snowball",
  "Rage",
];

export const BIG_SPELLS = ["Fireball", "Poison", "Lightning", "Rocket", "Void"];

export const DEFENSIVE_BUILDINGS = [
  "Cannon",
  "Tesla",
  "Inferno Tower",
  "Bomb Tower",
  "Tombstone",
  "Goblin Cage",
];

export const TANK_KILLERS = [
  "Mini P.E.K.K.A",
  "P.E.K.K.A",
  "Hunter",
  "Mighty Miner",
  "Inferno Dragon",
  "Elite Barbarians",
];

export const HEAVY_BEATDOWN_WIN_CONDITIONS = [
  "Golem",
  "Giant",
  "Electro Giant",
  "Lava Hound",
];

export const SPLIT_PUSH_TRIGGER_CARDS = ["Three Musketeers", "Royal Hogs"];

function toNormalizedSet(names) {
  return new Set(names.map((name) => normalizeCardName(name)));
}

export const SMALL_SPELLS_SET = toNormalizedSet(SMALL_SPELLS);
export const BIG_SPELLS_SET = toNormalizedSet(BIG_SPELLS);
export const DEFENSIVE_BUILDINGS_SET = toNormalizedSet(DEFENSIVE_BUILDINGS);
export const TANK_KILLERS_SET = toNormalizedSet(TANK_KILLERS);
export const HEAVY_BEATDOWN_WIN_CONDITIONS_SET = toNormalizedSet(
  HEAVY_BEATDOWN_WIN_CONDITIONS,
);
export const SPLIT_PUSH_TRIGGER_CARDS_SET = toNormalizedSet(
  SPLIT_PUSH_TRIGGER_CARDS,
);
