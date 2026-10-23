// Vérifie l'avance d'horloge du salon de test (Redis et Discord simulés)
// Usage : node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/meow/horlogeTest.mjs
process.env.DISCORD_TOKEN = "fake";
const sent = [];
globalThis.fetch = async (url, opts = {}) => {
  sent.push({ url: String(url), method: opts.method, body: typeof opts.body === "string" ? JSON.parse(opts.body) : null });
  if (String(url).endsWith("/messages") && opts.method === "POST") return { ok: true, json: async () => ({ id: "m1" }) };
  return { ok: false, status: 404, json: async () => ({}), text: async () => "" };
};
console.warn = console.error = () => {};
const H = await import("../../discord/handlers/meow.js");
const S = await import("../../services/meow.js");
const { horloge, parisParts } = await import("../../services/meowRules.js");
await S.resetMeow({ clearManches: true });
const opts = { force: true, noPing: true, forceClose: true, pnj: true };
await H.postMeow("chan", opts);
await H.handleParticiper("wh-u1", "u1", "Raphaël");
const etapes = ["jour", "distribution", "distribution", "distribution", ...Array(7).fill("jour")];
let r = await H.postMeow("chan", opts);
console.log(`lancement → jour ${r.jour}`);
for (const avancer of etapes) {
  r = await H.postMeow("chan", { ...opts, avancer });
  const p = await S.readPartie();
  const { date, h, min } = parisParts(horloge(p));
  console.log(`${avancer.padEnd(12)} → ${r.final ? "FIN" : `jour ${r.jour}`} (${date} ${h}h${String(min).padStart(2, "0")}), squats : ${p.journal.filter((e) => e.k === "squat").length}, décomptes : ${p.decomptes.length}`);
  if (r.final || r.termine) break;
}
