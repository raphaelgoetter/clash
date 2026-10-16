// Meow complet (présentation, 7 jours, fin) de bout en bout, Redis et
// Discord simulés, horloge avancée à la main.
// Usage : node --import ./temp/fake-redis/register.mjs temp/meow/e2eMeow.mjs [joueurs]
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
  if (u.includes("trustroyale")) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
};

// Horloge simulée (les règles lisent Date.now())
const { parisInstant, ajouterJours } = await import("../../backend/services/meowRules.js");
let horloge = parisInstant("2026-10-19", 9);
Date.now = () => horloge;
const aller = (date, h, min = 0) => (horloge = parisInstant(date, h) + min * 60_000);

console.warn = () => {};
const H = await import("../../api/discord/_handlers/meow.js");
const S = await import("../../backend/services/meow.js");

const nb = Number(process.argv[2] || 14);
const ids = Array.from({ length: nb }, (_, i) => `u${i + 1}`);
const nom = (id) => `Joueur ${id}`;
const lastPost = () => [...sent].reverse().find((s) => s.url.endsWith("/channels/chan/messages") && s.method === "POST")?.body;
const lastEph = (id) => [...sent].reverse().find((s) => s.url === `wh-${id}/messages/@original` && s.body)?.body;

function verifier(e, ctx) {
  if (!e) throw new Error(`${ctx} : aucun éphémère`);
  if ((e.components || []).length > 5) throw new Error(`${ctx} : plus de 5 lignes de composants`);
  for (const row of e.components || []) {
    if (row.components.length > 5) throw new Error(`${ctx} : plus de 5 composants sur une ligne`);
    for (const c of row.components) {
      if (c.custom_id.length > 100) throw new Error(`${ctx} : custom_id trop long`);
      if (c.type === 3) {
        if (!c.options.length || c.options.length > 25) throw new Error(`${ctx} : menu ${c.custom_id} à ${c.options.length} options`);
        if (c.placeholder.length > 150) throw new Error(`${ctx} : placeholder trop long`);
        for (const o of c.options) if (o.label.length > 100 || (o.description || "").length > 100) throw new Error(`${ctx} : option trop longue`);
        if (new Set(c.options.map((o) => o.value)).size !== c.options.length) throw new Error(`${ctx} : valeurs en double`);
      }
      if (c.type === 2 && c.label.length > 80) throw new Error(`${ctx} : bouton trop long`);
    }
  }
  for (const em of e.embeds || []) if ((em.description || "").length > 4096) throw new Error(`${ctx} : description > 4096`);
}

const menu = (e, id) => e.components?.flatMap((r) => r.components).find((c) => c.custom_id === id);
const boutons = (e, prefix) => e.components?.flatMap((r) => r.components).filter((c) => c.custom_id?.startsWith(prefix)) ?? [];

await S.resetMeow({ clearManches: true });
await H.postMeow("chan", { force: true, noPing: true });
for (const id of ids) await H.handleParticiper(`wh-${id}`, id, nom(id));
await H.handleDesinscrire(`wh-${ids.at(-1)}`, ids.at(-1));
await H.handleParticiper(`wh-${ids.at(-1)}`, ids.at(-1), nom(ids.at(-1)));
console.log(`--- Annonce : ${lastPost().embeds[0].title}`);

const j1 = await H.postMeow("chan", { force: true, noPing: true, pnj: false, forceClose: true });
console.log(`--- Lancement : jour ${j1.jour}\n${lastPost().embeds[0].description.split("\n").slice(0, 12).join("\n")}`);

// Un passage de joueur : appelle tous ses chats sur un coin, puis squatte
// le meilleur coin possible (manche par manche, retraite si < 30 %).
async function passage(id) {
  await H.handleJouer(`wh-${id}`, id, nom(id));
  let e = lastEph(id);
  verifier(e, `jouer ${id}`);
  const appel = menu(e, "meow_appel_coin");
  if (appel) {
    await H.handleAppelCoin(`wh-${id}`, id, nom(id), appel.options[0].value);
    e = lastEph(id);
    verifier(e, `choix coin ${id}`);
    const tout = boutons(e, "meow_appeler:").at(-1);
    const [, coin, n] = tout.custom_id.split(":");
    await H.handleAppeler(`wh-${id}`, id, nom(id), coin, n);
    e = lastEph(id);
    verifier(e, `appel ${id}`);
  }
  for (let k = 0; k < 2; k++) {
    const squat = menu(e, "meow_squat");
    if (!squat || squat.disabled) break;
    await H.handleSquat(`wh-${id}`, id, nom(id), squat.options[0].value);
    e = lastEph(id);
    verifier(e, `squat ${id}`);
    for (let m = 0; m < 30 && boutons(e, "meow_retraite").length; m++) {
      const chance = Number(/(\d+) %/.exec(e.embeds[0].description)?.[1] ?? 0);
      await H.handleCombat(`wh-${id}`, id, nom(id), chance < 30 ? "retraite" : m % 3 === 2 ? "bout" : "manche");
      e = lastEph(id);
      verifier(e, `combat ${id}`);
    }
  }
}

let date = "2026-10-19";
for (let jour = 1; jour <= 7; jour++) {
  if (jour === 3) {
    aller(date, 8, 30);
    const p0 = await S.readPartie();
    const b1 = p0.joueurs.u1.bande;
    const mate = ids.find((id) => id !== "u1" && p0.joueurs[id].bande === b1);
    const rival = ids.find((id) => p0.joueurs[id].bande !== b1);
    await H.handleMessageSubmit("wh-u1", "u1", nom("u1"), "On prend le Canapé à 13h ?");
    verifier(lastEph("u1"), "message");
    console.log(`\n--- Message envoyé : ${lastEph("u1").embeds[0].description.split("\n").slice(0, 3).join(" / ")}`);
    aller(date, 8, 31);
    await H.handleJouer(`wh-${mate}`, mate, nom(mate));
    if (!boutons(lastEph(mate), "meow_bande_vue")[0].label.includes("(1)")) throw new Error("nouveau message non signalé");
    await H.handleBande(`wh-${mate}`, mate, nom(mate));
    verifier(lastEph(mate), "ma bande");
    if (!lastEph(mate).embeds[0].description.includes("Canapé à 13h")) throw new Error("message absent pour le coéquipier");
    await H.handleBande(`wh-${rival}`, rival, nom(rival));
    if (lastEph(rival).embeds[0].description.includes("Canapé à 13h")) throw new Error("message visible par une autre bande");
    await H.handleJouer(`wh-${mate}`, mate, nom(mate));
    if (boutons(lastEph(mate), "meow_bande_vue")[0].label.includes("(")) throw new Error("message toujours signalé après lecture");
    console.log(`--- Ma bande (coéquipier) : ${lastEph(mate).embeds[0].description.split("\n").find((l) => l.includes("💬")) ?? "plus de nouveau message"}`);
  }
  for (const [h, actifs] of [[9, 0.7], [14, 0.5], [19, 0.6]]) {
    aller(date, h, 15);
    for (const id of ids) if (Math.random() < actifs) await passage(id);
  }
  // Tentative de squat pendant la sieste
  aller(ajouterJours(date, 1), 2);
  await H.handleJouer(`wh-u1`, "u1", nom("u1"));
  const sieste = menu(lastEph("u1"), "meow_squat");
  if (jour < 7 && !sieste?.disabled) throw new Error(`squat possible pendant la sieste : ${JSON.stringify(lastEph("u1")).slice(0, 1500)}`);
  date = ajouterJours(date, 1);
  aller(date, 8, 22);
  const r = await H.postMeow("chan", { force: false, noPing: true });
  const p = lastPost();
  if (r.final) {
    console.log(`\n--- Fin (après le jour ${jour}) :\n${p.embeds[0].description}`);
    break;
  }
  console.log(`\n--- ${p.embeds[0].title}\n${p.embeds[0].description.split("\n").slice(0, 5).join("\n")}`);
  const again = await H.postMeow("chan", { force: false, noPing: true });
  if (!again.skipped) throw new Error("double publication du même jour");
}

await H.handleJournal("wh-u1", "u1");
verifier(lastEph("u1"), "journal");
await H.handleRegles("wh-u1");
verifier(lastEph("u1"), "règles");
console.log(`\n--- Règles : ${lastEph("u1").embeds[0].description.length} caractères`);
const partie = await S.readPartie();
console.log(`--- Squats : ${partie.journal.filter((e) => e.k === "squat").length}, décomptes : ${partie.decomptes.length}, terminé : ${partie.termine}`);
