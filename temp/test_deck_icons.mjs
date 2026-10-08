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
${grab(/const STALE_CARD_ICON_OVERRIDES[\s\S]*?\n\]\);\n/)}
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
    const score = (cards.some((c) => c.name === "Bandit") ? 4 : 0) +
      (cards.some((c) => c.evolutionLevel === 1) ? 1 : 0) +
      (cards.some((c) => c.evolutionLevel >= 2) ? 2 : 0);
    if (!best || score > best.score) best = { score, tag: m.tag, name: m.name, log };
    if (score === 7) break;
  }
  if (best?.score === 7) break;
}
console.log("Joueur :", best.name, best.tag, "score", best.score);
const decks = await summarizeRecentBattlesForMatchup(best.log, 6, null);
for (const d of decks) console.log(d.cardNames.join(", "), "\n  ", d.cardIcons.map((u) => u?.split("/").pop().slice(0, 8)).join(" "));
const img = await buildWarDecksImage(decks, { maxRows: 6, kind: "recent" });
fs.writeFileSync(process.argv[2], img.buffer);
fs.unlinkSync("temp/_deckIconsExtract.mjs");
process.exit(0);
