// Corrige le rang affiché dans le post Mario Clash Jour 7/7 (bug null < jour).
// Usage : node temp/fix-mario-arrivee.mjs [--apply]
import "dotenv/config";

const CHANNEL = "1527252707730133082";
const MESSAGE = "1558396893254516818";
const AVANT = "\n🏆 nb caracole en tête avec une solide avance sur le reste du peloton.";
const APRES = "";

const url = `https://discord.com/api/v10/channels/${CHANNEL}/messages/${MESSAGE}`;
const headers = { Authorization: `Bot ${process.env.DISCORD_TOKEN}`, "Content-Type": "application/json" };

const msg = await (await fetch(url, { headers })).json();
if (!msg.embeds) throw new Error(JSON.stringify(msg));
const embeds = msg.embeds.map((e) => ({ ...e, description: e.description?.replace(AVANT, APRES) }));
const modifie = embeds.some((e, i) => e.description !== msg.embeds[i].description);
console.log(embeds.map((e) => e.description).join("\n---\n"));
console.log("Remplacement trouvé :", modifie);

if (process.argv.includes("--apply") && modifie) {
  const res = await fetch(url, { method: "PATCH", headers, body: JSON.stringify({ embeds }) });
  console.log("PATCH", res.status);
}
