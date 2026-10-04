// Partie complète de Draft (duel) de bout en bout, Redis et Discord simulés.
// Usage : node --import ./temp/fake-redis/register.mjs temp/e2eDraftDuel.mjs [joueurs]
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
process.env.DISCORD_TOKEN = "fake";

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith("wh") && !u.includes("discord.com") && !u.includes("trustroyale")) return realFetch(url, opts);
  const body = opts.body && typeof opts.body === "string" ? JSON.parse(opts.body) : null;
  sent.push({ url: u, method: opts.method || "GET", body });
  if (u.endsWith("/messages") && opts.method === "POST") return { ok: true, json: async () => ({ id: "msg1" }) };
  return { ok: u.includes("trustroyale") ? false : true, status: 200, json: async () => ({}), text: async () => "", arrayBuffer: async () => new ArrayBuffer(0) };
};

const H = await import("../api/discord/_handlers/draftDuel.js");
const S = await import("../backend/services/draftDuel.js");

const nb = Number(process.argv[2] || 1);
const ids = ["u1", "u2", "u3"].slice(0, nb);
const lastPublic = () => [...sent].reverse().find((s) => s.url.includes("/channels/chan/messages") && s.body);
const lastEph = (id) => [...sent].reverse().find((s) => s.url === `wh-${id}/messages/@original` && s.body);

await S.resetDraftDuel();
await H.handleDraftCommand("wh-cmd", { channel_id: "chan" }, { maxPlayers: nb });
for (const id of ids) await H.handleJouer(`wh-${id}`, id, "Joueur " + id);

for (let m = 1; m <= 7; m++) {
  for (const id of ids) {
    await H.handlePioche(`wh-${id}`, id);
    let view = await S.readPlayerView(await S.readState(), id);
    if (view.souhaitables.length) {
      for (let r = 1; r <= Math.min(3, view.souhaitables.length); r++) await H.handleVoeu(`wh-${id}`, id, String(r), view.souhaitables[r - 1]);
    }
    if (m <= 6) await H.handleDepot(`wh-${id}`, id, view.me.main[0]);
    if (id === "u1" && (m === 2 || m === 3)) {
      const e = lastEph(id).body;
      console.log(`--- main u1, manche ${m} (${e.components.length} rangées) ---\n${e.embeds[0].description}`);
    }
    await H.handleFinTour(`wh-${id}`, id);
  }
  const pub = lastPublic().body;
  console.log(`\n===== ${pub.embeds?.[0]?.title} =====\n${pub.embeds?.[0]?.description}\nimage: ${pub.embeds?.[0]?.image?.url ?? "-"}`);
}
await H.handleDetails("wh-d", "msg1");
console.log("\n===== Détails =====\n" + [...sent].reverse().find((s) => s.url === "wh-d/messages/@original").body.embeds[0].description);
await H.handleRegles("wh-r");
console.log("\n===== Règles =====\n" + [...sent].reverse().find((s) => s.url === "wh-r/messages/@original").body.embeds[0].description);
