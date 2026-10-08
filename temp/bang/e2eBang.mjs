// Bang! complet (annonce, jours, fin) de bout en bout, Redis et Discord
// simulés. Usage : node --import ./temp/fake-redis/register.mjs temp/bang/e2eBang.mjs [joueurs]
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
  if (u.endsWith("/messages") && opts.method === "POST") return { ok: true, json: async () => ({ id: `msg${sent.length}` }) };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
};

const H = await import("../../api/discord/_handlers/bang.js");
const S = await import("../../backend/services/bang.js");

const nb = Number(process.argv[2] || 12);
const ids = Array.from({ length: nb }, (_, i) => `u${i + 1}`);
const lastPost = () => [...sent].reverse().find((s) => s.url.endsWith("/channels/chan/messages") && s.method === "POST")?.body;
const lastPatchTable = () => [...sent].reverse().find((s) => /\/channels\/chan\/messages\/msg/.test(s.url) && s.method === "PATCH")?.body;
const lastEph = (id) => [...sent].reverse().find((s) => s.url === `wh-${id}/messages/@original` && s.body)?.body;

await S.resetBang({ clearManches: true });
await H.postBang("chan", { force: true, noPing: true });
await H.postBang("chan", { force: true, noPing: true });
for (let jour = 1; jour <= 7; jour++) {
  const state = await S.readState();
  if (state.termine) break;
  // 2/3 des joueurs au J1, le reste au J2 ; u12 tente sa chance au J3
  const arrives = ids.slice(0, jour === 1 ? Math.ceil((nb * 2) / 3) : jour === 2 ? nb - 1 : nb);
  for (const id of arrives) {
    if ((await S.readState()).termine) break;
    if (id !== "u1" && Math.random() < 0.25) continue;
    await H.handleDeck(`wh-${id}`, id, `Joueur ${id}`);
    let e = lastEph(id);
    if (e.content) {
      if (jour === 3) console.log(`--- ${id} au J3 : ${e.content}`);
      continue;
    }
    // Joue une carte au hasard (cible au hasard), puis pioche 1 à 2 fois
    const menu = e.components.find((r) => r.components[0].custom_id === "bang_carte")?.components[0];
    if (menu && Math.random() < 0.7) {
      const carte = menu.options[Math.floor(Math.random() * menu.options.length)].value;
      await H.handleCarte(`wh-${id}`, id, `Joueur ${id}`, carte);
      e = lastEph(id);
      const cibles = e.components.find((r) => r.components[0].custom_id?.startsWith("bang_cible"))?.components[0];
      if (cibles) await H.handleCible(`wh-${id}`, id, `Joueur ${id}`, carte, cibles.options[Math.floor(Math.random() * cibles.options.length)].value);
      if (id === "u1") console.log(`--- u1 joue ${carte} ---\n${lastEph(id).embeds[0].description.split("\n\n")[0]}`);
    }
    for (let k = 0; k < 1 + (Math.random() < 0.4); k++) {
      await H.handlePiocher(`wh-${id}`, id, `Joueur ${id}`);
      e = lastEph(id);
      if (e.components.some((r) => r.components[0].custom_id === "bang_placer")) {
        await H.handlePlacer(`wh-${id}`, id, `Joueur ${id}`, Math.random() < 0.5 ? "1" : "hasard");
        if (id === "u1") console.log(`--- u1 cache une bombe ---\n${lastEph(id).embeds[0].description}`);
      }
    }
  }
  if (jour === 1) console.log(`\n===== Table J1 en direct =====\n${lastPatchTable()?.embeds[0].description}`);
  if ((await S.readState()).termine) break;
  await H.postBang("chan", { force: true, noPing: true, isPublic: true });
  const e = lastPost().embeds[0];
  console.log(`\n===== ${e.title} =====\n${e.description}`);
}
const st = await S.readState();
console.log(`\nÉtat final : termine=${st.termine}, manches=${(await S.listManches()).length}`);
if (!lastPost().embeds[0].title.includes("terminée")) console.log(lastPost().embeds[0].description);
