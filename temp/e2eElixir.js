// Partie complète de bout en bout, Discord simulé (fetch intercepté)
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
process.env.DISCORD_TOKEN = "fake";

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  if (!String(url).startsWith("wh") && !String(url).includes("discord.com")) return realFetch(url, opts);
  const body = opts.body ? JSON.parse(opts.body) : null;
  sent.push({ url: String(url), method: opts.method || "GET", body });
  if (String(url).endsWith("/messages") && opts.method === "POST") return { ok: true, json: async () => ({ id: "msg1" }) };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
};

const H = await import("../api/discord/_handlers/elixirDuel.js");
const S = await import("../backend/services/elixirDuel.js");

const players = process.argv[2] ? Number(process.argv[2]) : 1;
await S.resetElixirDuel();
await H.handleElixirCommand("wh", { channel_id: "chan" }, { maxPlayers: players, totalManches: 5 });
const ids = ["u1", "u2", "u3"].slice(0, players);
const lastPublic = () => [...sent].reverse().find((s) => s.url.includes("/channels/chan/messages"));
const lastEphemeral = () => [...sent].reverse().find((s) => s.url === "wh/messages/@original");

for (const id of ids) await H.handleJouer("wh", id, "Joueur " + id);
for (let m = 1; m <= 5; m++) {
  for (const [i, id] of ids.entries()) {
    const view = await S.readPlayerView(await S.readState(), id);
    if (i === 1 && m === 2) { await H.handlePasser("wh", id); continue; }
    const idx = view.cards.findIndex((c) => c.minBid <= view.me.stock);
    if (idx < 0) { await H.handlePasser("wh", id); continue; }
    await H.handleCarte("wh", id, String((idx + i) % view.cards.length === idx ? idx : idx));
    if (m === 1 && i === 0) console.log("--- éphémère après choix carte ---\n" + JSON.stringify(lastEphemeral().body, null, 1).slice(0, 1500));
    await H.handleMise("wh", id, String(Math.min(view.me.stock, view.cards[idx].minBid + (i === 0 ? 1 : 0))));
    await H.handleValider("wh", id);
  }
  const pub = lastPublic().body.embeds[0];
  console.log(`\n===== ${pub.title} =====\n${pub.description}`);
}
await H.handleRegles("wh");
console.log("\n===== Règles =====\n" + lastEphemeral().body.embeds[0].description);
await S.resetElixirDuel();
