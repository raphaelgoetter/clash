// Vérifie les MP de lancement (Redis et Discord simulés)
// Usage : node --import ./temp/fake-redis/register.mjs temp/meow/mpLancement.mjs
process.env.DISCORD_TOKEN = "fake";
process.env.DISCORD_GUILD_ID = "guild";
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = typeof opts.body === "string" ? JSON.parse(opts.body) : null;
  sent.push({ url: u, body });
  if (u.endsWith("/users/@me/channels")) return { ok: true, json: async () => ({ id: `dm-${body.recipient_id}` }) };
  if (u.endsWith("/messages") && opts.method === "POST") return { ok: true, json: async () => ({ id: "msg1" }) };
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};
console.warn = () => {};
const H = await import("../../api/discord/_handlers/meow.js");
const S = await import("../../backend/services/meow.js");
await S.resetMeow({ clearManches: true });
await H.postMeow("chan", { force: true, noPing: true });
for (const id of ["u1", "u2", "u3"]) await H.handleParticiper(`wh-${id}`, id, `Joueur ${id}`);
await H.postMeow("chan", { force: true, noPing: true, forceClose: true, pnj: true });
const mps = sent.filter((x) => x.url.includes("/channels/dm-"));
console.log(`${mps.length} MP (attendu : 3, aucun aux PNJ)`);
console.log(mps[0].body.embeds[0].title + "\n" + mps[0].body.embeds[0].description);
