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
const { choixGlouton } = await import("../backend/services/draftRules.js");

const nb = Number(process.argv[2] || 1);
const ids = ["u1", "u2", "u3"].slice(0, nb);
const lastPublic = () => [...sent].reverse().find((s) => s.url.includes("/channels/chan/messages") && s.body);
const lastEph = (id) => [...sent].reverse().find((s) => s.url === `wh-${id}/messages/@original` && s.body);

await S.resetDraftDuel();
await H.handleDraftCommand("wh-cmd", { channel_id: "chan" }, { maxPlayers: nb });
for (const id of ids) await H.handleJouer(`wh-${id}`, id, "Joueur " + id);

for (let m = 1; m <= 7; m++) {
  for (const id of ids) {
    const view = await S.readPlayerView(await S.readState(), id);
    const choix = choixGlouton(view.me.main, view.state.marche);
    await H.handleChoix(`wh-${id}`, id, "prise", choix.prise);
    await H.handleChoix(`wh-${id}`, id, "depot", choix.depot);
    if ((view.me.joker || 0) >= 1) {
      const cible = Object.keys(view.players).find((x) => x !== id);
      await H.handleJoker(`wh-${id}`, id, "ouvrir");
      await H.handleJoker(`wh-${id}`, id, "voirmenu");
      await H.handleJoker(`wh-${id}`, id, "voir", cible);
      const apres = await S.readPlayerView(await S.readState(), id);
      // Voir main puis Échanger carte avec une carte vue, si les points suffisent
      if (apres.action.vu?.main && (apres.me.joker || 0) >= 2) {
        const visee = apres.action.vu.main.find((k) => !apres.me.main.includes(k)) || apres.action.vu.main[0];
        const donnee = apres.me.main.find((k) => k !== choix.depot) || apres.me.main[0];
        await H.handleJoker(`wh-${id}`, id, "type", "echanger");
        await H.handleJoker(`wh-${id}`, id, "cible", cible);
        await H.handleJoker(`wh-${id}`, id, "carte", visee);
        await H.handleJoker(`wh-${id}`, id, "maCarte", donnee);
      }
      const mag = lastEph(id).body;
      console.log(`--- magasin ${id}, manche ${m} (${mag.components.length} rangées) ---\n${mag.embeds[0].description.split("\n").filter((l) => /👁️|Joker prévu/.test(l)).join("\n")}`);
      await H.handleJoker(`wh-${id}`, id, "retour");
      // Une manche jouée avec le Joker seul : échange au marché annulé
      if (id === "u1" && m === 5) {
        await H.handleChoix(`wh-${id}`, id, "annuler");
        const e = lastEph(id).body;
        console.log(`--- u1 Joker seul, manche ${m} : fin de tour ${e.components[2].components[0].disabled ? "désactivée" : "active"}, annuler ${e.components[2].components[2].disabled ? "désactivé" : "actif"} ---\n${e.embeds[0].description.split("\n").slice(-2).join("\n")}`);
      }
    }
    if (id === "u1" && m >= 3 && m <= 4) {
      const e = lastEph(id).body;
      console.log(`--- main u1, manche ${m} (${e.components.length} rangées, fin de tour ${e.components[2]?.components[0].disabled ? "désactivée" : "active"}) ---\n${e.embeds[0].description}\n[${e.embeds[1]?.title}] ${e.embeds[1]?.description}`);
    }
    await H.handleFinTour(`wh-${id}`, id);
  }
  const pub = lastPublic().body;
  console.log(`\n===== ${pub.embeds?.[0]?.title} =====\n${pub.embeds?.[0]?.description}`);
}
await H.handleDetails("wh-d", "msg1");
console.log("\n===== Détails =====\n" + [...sent].reverse().find((s) => s.url === "wh-d/messages/@original").body.embeds[0].description);
await H.handleRegles("wh-r");
console.log("\n===== Règles =====\n" + [...sent].reverse().find((s) => s.url === "wh-r/messages/@original").body.embeds[0].description);
