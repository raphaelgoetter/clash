// Vérifie la présence sur le serveur Discord des inscrits des jeux avec
// inscription (Meow, Goblin Hunters, Qui est-ce ?). Lecture seule.
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
const meow = await import("../backend/services/meow.js");
const gh = await import("../backend/services/goblinhunters.js");
const qc = await import("../backend/services/quiestce.js");

async function present(id) {
  const r = await fetch(`https://discord.com/api/v10/guilds/${process.env.DISCORD_GUILD_ID}/members/${id}`, { headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` } });
  return r.status === 200 ? "OK" : `ABSENT(${r.status})`;
}
const jeux = {
  Meow: async () => Object.entries((await meow.readPartie()).joueurs).map(([id, j]) => [id, j.username]),
  "Goblin Hunters": async () => (await gh.listInscriptions()).map((i) => [i.discordId, i.username]),
  "Qui est-ce ?": async () => Object.entries((await qc.readPartie()).joueurs).map(([id, j]) => [id, j.username]),
};
const states = { Meow: meow, "Goblin Hunters": gh, "Qui est-ce ?": qc };
for (const [nom, lister] of Object.entries(jeux)) {
  const s = await states[nom].readState();
  console.log(`\n# ${nom} (phase ${s?.phase ?? "aucune"}${s?.termine ? ", terminé" : ""})`);
  for (const [id, username] of await lister()) console.log(await present(id), id, username);
}
