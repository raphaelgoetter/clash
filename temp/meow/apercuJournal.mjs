// Aperçu du bloc Aujourd'hui et du Journal après une journée de PNJ actifs
// Usage : node --import ./temp/fake-redis/register.mjs temp/meow/apercuJournal.mjs
process.env.DISCORD_TOKEN = "fake";
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  sent.push({ url: String(url), method: opts.method, body: typeof opts.body === "string" ? JSON.parse(opts.body) : null });
  if (String(url).endsWith("/messages") && opts.method === "POST") return { ok: true, json: async () => ({ id: "m1" }) };
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};
console.warn = console.error = () => {};
const { parisInstant } = await import("../../backend/services/meowRules.js");
let horloge = parisInstant("2026-10-19", 9);
Date.now = () => horloge;
const H = await import("../../api/discord/_handlers/meow.js");
const S = await import("../../backend/services/meow.js");
await S.resetMeow({ clearManches: true });
await H.postMeow("chan", { force: true, noPing: true });
await H.handleParticiper("wh-u1", "u1", "Raphaël");
await H.postMeow("chan", { force: true, noPing: true, forceClose: true, pnj: true });
horloge = parisInstant("2026-10-20", 8) + 22 * 60_000;
await H.postMeow("chan", { force: true, noPing: true });
horloge = parisInstant("2026-10-20", 20);
await H.handleJouer("wh-u1", "u1", "Raphaël");
const squat = [...sent].reverse().find((x) => x.url === "wh-u1/messages/@original" && x.body).body.components.flatMap((r) => r.components).find((c) => c.custom_id === "meow_squat");
if (!squat.disabled) await H.handleSquat("wh-u1", "u1", "Raphaël", squat.options[0].value), await H.handleCombat("wh-u1", "u1", "Raphaël", "bout");
await H.postMeow("chan", { force: true, noPing: true });
const jour = [...sent].reverse().find((x) => x.url.endsWith("/channels/chan/messages") && x.method === "POST").body.embeds[0].description;
console.log("=== Message du jour, bloc Aujourd'hui ===\n" + jour.slice(jour.indexOf("**💥")));
await H.handleJournal("wh-u1", "u1");
const j = [...sent].reverse().find((x) => x.url === "wh-u1/messages/@original" && x.body).body.embeds[0];
console.log(`\n=== ${j.title} ===\n${j.description}`);
