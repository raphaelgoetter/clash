// Affiche la vue Jouer d'un joueur à une heure donnée (Redis simulé).
// Usage : node --import ./temp/fake-redis/register.mjs temp/meow/vueJouer.mjs
process.env.DISCORD_TOKEN = "fake";
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  sent.push({ url: String(url), body: typeof opts.body === "string" ? JSON.parse(opts.body) : null });
  if (String(url).endsWith("/messages") && opts.method === "POST") return { ok: true, json: async () => ({ id: "m1" }) };
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};
console.warn = () => {};
const { parisInstant } = await import("../../backend/services/meowRules.js");
let horloge = parisInstant("2026-10-19", 9);
Date.now = () => horloge;
const H = await import("../../api/discord/_handlers/meow.js");
const S = await import("../../backend/services/meow.js");
await S.resetMeow({ clearManches: true });
await H.postMeow("chan", { force: true, noPing: true });
await H.handleParticiper("wh-u1", "u1", "Raphaël");
await H.postMeow("chan", { force: true, noPing: true, forceClose: true, pnj: true });
for (const [h, min] of [[10, 45], [12, 30], [20, 10]]) {
  horloge = parisInstant("2026-10-19", h) + min * 60_000;
  await H.handleJouer("wh-u1", "u1", "Raphaël");
  const e = [...sent].reverse().find((x) => x.url === "wh-u1/messages/@original" && x.body).body;
  console.log(`\n=== ${h}h${String(min).padStart(2, "0")} ===\n${e.embeds[0].description.split("\n").slice(0, 5).join("\n")}`);
}
const partie = await S.readPartie();
const squats = partie.journal.filter((e) => e.k === "squat");
console.log(`\nPNJ : ${Object.keys(partie.joueurs).filter((id) => id.startsWith("pnj-")).length}, squats des PNJ à 20h10 : ${squats.length}`);
console.log(squats.slice(0, 3).map((e) => `- ${e.issue} ${e.de} → ${e.vers}`).join("\n"));
