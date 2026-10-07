// Poste des variantes de /stats-clan (50 lignes, 1 embed) dans le salon test, sans ping.
import "dotenv/config";
import fs from "node:fs";
import { getStoredWarMatchupPerformanceSamples } from "../backend/services/matchupPerformance.js";
import { aggregateMatchupPerformance } from "../backend/services/battleLogUtils.js";
const src = fs.readFileSync("api/discord/interactions.js", "utf8");
const code = src.slice(src.indexOf("function getStatsClanScenario"), src.indexOf("const STATS_CLAN_CACHE_TTL_MS"));
const mod = new Function("getStoredWarMatchupPerformanceSamples", "aggregateMatchupPerformance", "trustClanUrl",
  code + "; return { attachStatsClanPerformance, buildStatsClanRows };")(getStoredWarMatchupPerformanceSamples, aggregateMatchupPerformance, () => "");
const data = await (await fetch("https://trustroyale.vercel.app/api/clan/Y8JUPC9C/analysis?fast=true")).json();
await mod.attachStatsClanPerformance(data);
const rows = mod.buildStatsClanRows(data, "training", "avgFame");
const variants = {
  "A (actuel)": rows,
  "B (liste désactivée 1\\.)": rows.map((r) => r.replace(/^(\d+)\./, "$1\\.")),
  "C (sans 🃏, decks 16/16)": rows.map((r) => r.replace(/🃏 (\S+)/, "$1/16")),
  "D (sans gras)": rows.map((r) => r.replaceAll("**", "")),
};
for (const [label, lines] of Object.entries(variants)) {
  const description = lines.join("\n");
  const r = await fetch(`https://discord.com/api/v10/channels/${process.env.DISCORD_CHANNEL_FRAME_TEST}/messages`, {
    method: "POST",
    headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, "Content-Type": "application/json" },
    body: JSON.stringify({ content: `Test /stats-clan : variante ${label}`, allowed_mentions: { parse: [] }, embeds: [{ title: "Stats GDC : La Resistance", color: 0x5865f2, description }] }),
  });
  console.log(label, lines.length, description.length, r.status);
}
