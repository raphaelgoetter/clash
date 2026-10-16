// Vue Jouer au matin après une nuit (horloge de test)
process.env.DISCORD_TOKEN = "fake";
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  sent.push({ url: String(url), body: typeof opts.body === "string" ? JSON.parse(opts.body) : null });
  if (String(url).endsWith("/messages") && opts.method === "POST") return { ok: true, json: async () => ({ id: "m1" }) };
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};
console.warn = console.error = () => {};
const H = await import("../../api/discord/_handlers/meow.js");
const S = await import("../../backend/services/meow.js");
await S.resetMeow({ clearManches: true });
const o = { force: true, noPing: true, forceClose: true, pnj: true };
await H.postMeow("chan", o);
await H.handleParticiper("wh-u1", "u1", "Raphaël");
await H.postMeow("chan", o);
await H.postMeow("chan", { ...o, avancer: "jour" });
await H.handleJouer("wh-u1", "u1", "Raphaël");
const e = [...sent].reverse().find((x) => x.url === "wh-u1/messages/@original" && x.body).body;
console.log(e.embeds[0].description.split("\n").slice(0, 6).join("\n"));
