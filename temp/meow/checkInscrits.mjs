// Vérifie la présence des inscrits Meow sur le serveur Discord (lecture seule)
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const { readPartie } = await import("../../backend/services/meow.js");
const p = await readPartie();
for (const j of Object.values(p.joueurs)) {
  const id = j.discordId ?? Object.keys(p.joueurs).find((k) => p.joueurs[k] === j);
  const r = await fetch(`https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members/${id}`, { headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` } });
  console.log(r.status === 200 ? "OK " : `ABSENT(${r.status})`, id, j.username);
}
