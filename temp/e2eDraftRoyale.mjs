// Draft Royale complet (annonce, 7 jours, fin) de bout en bout, Redis et
// Discord simulés. Usage : node --import ./temp/fake-redis/register.mjs temp/e2eDraftRoyale.mjs [joueurs]
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

const H = await import("../api/discord/_handlers/draftroyale.js");
const S = await import("../backend/services/draftroyale.js");
const { choixGlouton } = await import("../backend/services/draftRules.js");

const nb = Number(process.argv[2] || 8);
const ids = Array.from({ length: nb }, (_, i) => `u${i + 1}`);
const lastPost = () => [...sent].reverse().find((s) => s.url.endsWith("/channels/chan/messages") && s.method === "POST").body;
const lastEph = (id) => [...sent].reverse().find((s) => s.url === `wh-${id}/messages/@original` && s.body).body;

await S.resetDraftRoyale({ clearManches: true });
await H.postDraftRoyale("chan", { force: true, noPing: true });
await H.postDraftRoyale("chan", { force: true, noPing: true });
for (let jour = 1; jour <= 7; jour++) {
  // Arrivées échelonnées : la moitié des joueurs au J1, un de plus chaque jour
  const actifs = ids.slice(0, Math.min(nb, Math.ceil(nb / 2) + jour - 1));
  for (const id of actifs) {
    if (id !== "u1" && Math.random() < 0.2) continue; // absent ce jour
    await H.handleJouer(`wh-${id}`, String(jour), id, `Joueur ${id}`);
    const joueur = await S.readJoueur(id);
    const partieJour = await S.readPartie();
    const choix = choixGlouton(joueur.main, partieJour.marche, Math.random, partieJour.vedettes || []);
    await H.handleChoixSelect(`wh-${id}`, String(jour), "prise", id, `Joueur ${id}`, choix.prise);
    if (id !== "u2" || jour !== 2) await H.handleChoixSelect(`wh-${id}`, String(jour), "depot", id, `Joueur ${id}`, choix.depot);
    if (id === "u1" && (joueur.joker || 0) >= 1) {
      await H.handleJoker(`wh-${id}`, String(jour), "espion", id, `Joueur ${id}`, ids.find((x) => x !== id));
      await H.handleJoker(`wh-${id}`, String(jour), "bonus", id, `Joueur ${id}`, "priorite");
    }
    if (id === "u1" && jour <= 4) {
      const e = lastEph(id);
      console.log(`--- éphémère u1, J${jour} (${e.components.length} menus) ---\n${e.embeds[0].description}\n[${e.embeds[1].title}] ${e.embeds[1].description}`);
    }
    if (id === "u2" && jour === 2) console.log(`--- u2 sans dépôt ---\n${lastEph(id).embeds[0].description.split("\n").at(-1)}`);
  }
  await H.postDraftRoyale("chan", { force: true, noPing: true, isPublic: jour === 7 });
  const e = lastPost().embeds[0];
  const partie = await S.readPartie();
  console.log(`\n===== ${e.title} ===== (${partie.familles.length} cartes en jeu, marché ${partie.marche.length})\n${e.description}`);
}
const fin = await S.readPartie();
const total = Object.values(await S.readJoueurs()).reduce((n, j) => n + j.main.length, 0) + fin.marche.length + fin.reserve.length;
console.log(`\nCartes en circulation : ${total} (attendu ${fin.familles.length * 4}), cartes en jeu : ${fin.familles.join(", ")}`);
