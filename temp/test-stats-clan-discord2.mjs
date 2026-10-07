// Poste le payload réel de /stats-clan (2 embeds) dans le salon test, sans ping ni boutons.
import "dotenv/config";
import fs from "node:fs";
import { getStoredWarMatchupPerformanceSamples } from "../backend/services/matchupPerformance.js";
import { aggregateMatchupPerformance } from "../backend/services/battleLogUtils.js";
const src = fs.readFileSync("api/discord/interactions.js", "utf8");
const code = src.slice(src.indexOf("function getStatsClanScenario"), src.indexOf("const STATS_CLAN_CACHE_TTL_MS"));
const mod = new Function("getStoredWarMatchupPerformanceSamples", "aggregateMatchupPerformance", "trustClanUrl",
  code + "; return { attachStatsClanPerformance, buildStatsClanPayload };")(getStoredWarMatchupPerformanceSamples, aggregateMatchupPerformance, (t) => `https://trustroyale.vercel.app/clan/${t}`);
const data = await (await fetch("https://trustroyale.vercel.app/api/clan/Y8JUPC9C/analysis?fast=true")).json();
await mod.attachStatsClanPerformance(data);
const { embeds, components } = mod.buildStatsClanPayload({ data, clanName: "La Resistance", clanTag: "Y8JUPC9C", clanVal: "1", sortMode: "avgFame", isWarPeriod: false });
const r = await fetch(`https://discord.com/api/v10/channels/${process.env.DISCORD_CHANNEL_FRAME_TEST}/messages`, {
  method: "POST",
  headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, "Content-Type": "application/json" },
  body: JSON.stringify({ content: "Test /stats-clan : séparateur avant le pseudo (boutons = version prod)", allowed_mentions: { parse: [] }, embeds, components }),
});
console.log(embeds.length, embeds.map((e) => e.description.split("\n").length), r.status);
