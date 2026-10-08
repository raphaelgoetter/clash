// Test local : rendu de l'image /matchup avec icônes évolution/héros
// Usage : node temp/test_deck_icons.mjs <sortie.png>
import "dotenv/config";
import fs from "node:fs";
import { fetchBattleLog, fetchClan } from "../backend/services/clashApi.js";
import { FAMILY_CLAN_TAGS } from "../backend/services/warHistory.js";

const src = fs.readFileSync("api/discord/interactions.js", "utf8");
const grab = (re) => src.match(re)[0];
const code = `
import { Resvg } from "@resvg/resvg-js";
import { getOrSet } from "../backend/services/cache.js";
import { fetchCards } from "../backend/services/clashApi.js";
import { readBlobAsset } from "../backend/services/blobAssets.js";
const CARD_ICON_CACHE = new Map();
const CARD_DEF_CACHE_TTL = 3600000;
${grab(/async function loadCardDefinitions\(\)[\s\S]*?\n}\n/)}
${grab(/const CARD_ART_OVERRIDES[\s\S]*?\nconst BLOB_ICON_PREFIX = "blob:";\n/)}
${grab(/async function fetchImageDataUrl\([\s\S]*?\n}\n/)}
export ${grab(/async function buildWarDecksImage\([\s\S]*?\n}\n/)}
`;
fs.writeFileSync("temp/_deckIconsExtract.mjs", code);
const { buildWarDecksImage } = await import("./_deckIconsExtract.mjs");
const { summarizeRecentBattlesForMatchup } = await import("../backend/services/battleLogUtils.js");

// Joueur dont le battle log contient Bandit + évolution + héros si possible
let best = null;
for (const ct of FAMILY_CLAN_TAGS) {
  const clan = await fetchClan(ct);
  for (const m of clan.memberList ?? []) {
    const log = await fetchBattleLog(m.tag);
    const cards = (log ?? []).flatMap((b) => b.team?.[0]?.cards ?? []);
    const base = (n) => cards.some((c) => c.name === n && !c.evolutionLevel);
    const score = (base("Mega Minion") ? 4 : 0) + (base("Musketeer") ? 2 : 0) + (base("Bandit") ? 1 : 0);
    if (!best || score > best.score) best = { score, tag: m.tag, name: m.name, log };
    if (score === 7) break;
  }
  if (best?.score === 7) break;
}
console.log("Joueur :", best.name, best.tag, "score", best.score);
const decks = (await summarizeRecentBattlesForMatchup(best.log, 6, null)).slice(0, 2);
// Deck fabriqué : les 3 cartes à l'illustration remplacée, en version normale
const { fetchCards } = await import("../backend/services/clashApi.js");
const all = await fetchCards();
const ids = ["Mega Minion", "Musketeer", "Bandit", "Valkyrie", "Knight", "Zap", "Hog Rider", "Cannon"]
  .map((n) => String(all.find((c) => c.name === n).id));
decks.unshift({ cardIds: ids, cardNames: [], matches: [] });
const img = await buildWarDecksImage(decks, { maxRows: 6, kind: "recent" });
fs.writeFileSync(process.argv[2], img.buffer);
fs.unlinkSync("temp/_deckIconsExtract.mjs");
process.exit(0);
