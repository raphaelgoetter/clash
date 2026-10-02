// Ajoute le bouton Règles à un récap Gobelet Duel déjà posté.
import "dotenv/config";
import { readState } from "../backend/services/gobeletDuel.js";
const messageId = process.argv[2];
const state = await readState();
const candidates = [state?.channelId, process.env.DISCORD_CHANNEL_FRAME_PUBLIC, process.env.DISCORD_CHANNEL_FRAME_TEST].filter(Boolean);
const headers = { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, "Content-Type": "application/json" };
for (const channelId of [...new Set(candidates)]) {
  const get = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, { headers });
  if (!get.ok) { console.log(`salon ${channelId} : ${get.status}`); continue; }
  const msg = await get.json();
  console.log(`trouvé dans ${channelId} : ${msg.embeds?.[0]?.title}`);
  const res = await fetch(`https://discord.com/api/v10/channels/${channelId}/messages/${messageId}`, {
    method: "PATCH", headers,
    body: JSON.stringify({ components: [{ type: 1, components: [{ type: 2, style: 2, label: "Règles", emoji: { name: "📖" }, custom_id: "gobeletduel_regles" }] }] }),
  });
  console.log("PATCH", res.status, res.ok ? "" : await res.text());
  break;
}
