// ============================================================
// archivesJeuxSupprimes.js — Lecture seule des archives Redis des jeux
// hebdomadaires supprimés (Anagram, Palette, Blind Royale, La Juste Carte)
// et des manches du Quiz (jeu spécial supprimé),
// pour que leurs résultats restent dans /mini-jeux-history et le bouton
// « 📊 Stats ».
// Le code de ces jeux n'existe plus : seules leurs clés d'archive sont relues,
// au même format qu'à l'époque (voir jeux/CONTRIBUTING.md, « Jeux supprimés »).
// ============================================================

import { Redis } from "@upstash/redis";

// Construction paresseuse : les imports ES s'exécutent avant le
// dotenv.config() du script appelant.
let _redis = null;
function getRedis() {
  if (!_redis) {
    _redis = new Redis({
      url: process.env.KV_REST_API_URL,
      token: process.env.KV_REST_API_TOKEN,
      // Sinon le SDK convertit les IDs Discord en Number et les corrompt.
      automaticDeserialization: false,
    });
  }
  return _redis;
}

function fromJson(raw) {
  if (raw == null) return null;
  try {
    return JSON.parse(raw);
  } catch {
    return null;
  }
}

// HGETALL renvoie un tableau plat [champ1, valeur1, …] sans désérialisation.
async function hgetallValues(key) {
  const flat = (await getRedis().hgetall(key)) || [];
  const values = [];
  for (let i = 1; i < flat.length; i += 2) values.push(fromJson(flat[i]));
  return values.filter(Boolean);
}

async function scanKeys(pattern) {
  const keys = [];
  let cursor = "0";
  do {
    const [next, batch] = await getRedis().scan(cursor, { match: pattern, count: 200 });
    cursor = next;
    keys.push(...batch);
  } while (cursor !== "0");
  return keys;
}

// Jeux hebdomadaires : tous les résultats de `<prefixe>:archived:<seasonId>`.
async function resultatsArchives(prefixe) {
  const keys = await scanKeys(`${prefixe}:archived:*`);
  const parCle = await Promise.all(keys.map(hgetallValues));
  return parCle.flat();
}

export const getAnagramResults = () => resultatsArchives("anagram");
export const getPaletteResults = () => resultatsArchives("palette");
export const getBlindRoyaleResults = () => resultatsArchives("blindroyale");
export const getLaJusteCarteResults = () => resultatsArchives("lajustecarte");

// Quiz (jeu spécial) : manches de `quiz:manches`, de la plus récente à la
// plus ancienne ({ manche, mancheId, theme, resolvedAt, ranking, winners,
// maxScore }, score de manche dans `ranking[].score`).
export async function listQuizManches({ limit = 10 } = {}) {
  return (await hgetallValues("quiz:manches")).sort((a, b) => b.manche - a.manche).slice(0, limit);
}

