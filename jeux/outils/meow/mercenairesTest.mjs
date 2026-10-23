// Mercenaires au J3 : annonce, MP, journal (Redis et Discord simulés)
process.env.DISCORD_TOKEN = "fake";
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  const body = typeof opts.body === "string" ? JSON.parse(opts.body) : null;
  sent.push({ url: u, method: opts.method, body });
  if (u.endsWith("/users/@me/channels")) return { ok: true, json: async () => ({ id: `dm-${body.recipient_id}` }) };
  if (u.endsWith("/messages") && opts.method === "POST") return { ok: true, json: async () => ({ id: "m1" }) };
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};
console.warn = console.error = () => {};
const H = await import("../../discord/handlers/meow.js");
const S = await import("../../services/meow.js");
await S.resetMeow({ clearManches: true });
const o = { force: true, noPing: true, forceClose: true, pnj: true };
await H.postMeow("chan", o);
for (const id of ["u1", "u2", "u3"]) await H.handleParticiper(`wh-${id}`, id, `Joueur ${id}`);
await H.postMeow("chan", o);
await H.postMeow("chan", { ...o, avancer: "jour" });
const avantJ3 = sent.length;
const r = await H.postMeow("chan", { ...o, avancer: "jour" });
const p = await S.readPartie();
const post = sent.slice(avantJ3).find((x) => x.url.endsWith("/channels/chan/messages") && x.method === "POST").body.embeds[0];
console.log(`Jour ${r.jour} : ${post.description.split("\n")[0]}`);
const mps = sent.slice(avantJ3).filter((x) => x.url.includes("/channels/dm-"));
console.log(`MP : ${mps.length} (humains de la bande ${p.mercenaires.b}) ${mps[0]?.body.embeds[0].description ?? ""}`);
await H.postMeow("chan", { ...o, avancer: "distribution" });
console.log(`MP renvoyés ensuite : ${sent.filter((x) => x.url.includes("/channels/dm-")).length - mps.length - 3}`);
