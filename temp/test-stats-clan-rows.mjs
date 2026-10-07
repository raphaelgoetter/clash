// Rendu de /stats-clan sur données réelles (prod) sans Discord.
import "dotenv/config";
import fs from "node:fs";
import { getStoredWarMatchupPerformanceSamples } from "../backend/services/matchupPerformance.js";
import { aggregateMatchupPerformance } from "../backend/services/battleLogUtils.js";
const src = fs.readFileSync("api/discord/interactions.js", "utf8");
const code = src.slice(src.indexOf("function getStatsClanScenario"), src.indexOf("const STATS_CLAN_CACHE_TTL_MS"));
const trustClanUrl = (t) => `https://x/clan/${t}`;
const mod = new Function("getStoredWarMatchupPerformanceSamples", "aggregateMatchupPerformance", "trustClanUrl",
  code + "; return { attachStatsClanPerformance, buildStatsClanPayload };")(getStoredWarMatchupPerformanceSamples, aggregateMatchupPerformance, trustClanUrl);
const data = await (await fetch("https://trustroyale.vercel.app/api/clan/Y8JUPC9C/analysis?fast=true")).json();
await mod.attachStatsClanPerformance(data);
const p = mod.buildStatsClanPayload({ data, clanName: "La Resistance", clanTag: "Y8JUPC9C", clanVal: "1", sortMode: "avgFame", isWarPeriod: false });
for (const e of p.embeds) console.log(e.title ?? "(sans titre)", e.footer ?? "", e.description.length, "\n" + e.description.split("\n").slice(0, 2).join("\n"));
console.log(p.components[0].components.map((c) => c.label).join(" | "));
