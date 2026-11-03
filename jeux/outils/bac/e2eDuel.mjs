// Test de bout en bout du handler du Petit Bac (contre Kévina et 1v1), sur
// Redis en mémoire ; TOUS les appels Discord sont interceptés (aucun message
// réel). Vérifie les limites Discord des vues et affiche des exemples.
// Usage : node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/bac/e2eDuel.mjs
import { Redis } from "@upstash/redis";

if (!Redis.isFake) throw new Error("À lancer avec registerFakeRedis.js (voir l'en-tête)");

const vues = [];
const salon = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://discord.test")) {
    if (init.body) vues.push(JSON.parse(init.body));
    if (init.method === "POST") return new Response(JSON.stringify({ id: `vue-${vues.length}` }));
  } else if (u.startsWith("https://discord.com")) {
    if (init.body) salon.push({ method: init.method, ...JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: `msg-${salon.length}` }));
  } else throw new Error(`Appel réseau inattendu : ${u}`);
  return new Response("{}");
};
process.env.DISCORD_TOKEN = "faux";
// Pauses instantanées (fin du temps des manches)
const setTimeoutReel = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...args) => setTimeoutReel(fn, 0, ...args);

const h = await import("../../discord/handlers/bacDuel.js");
const { readDuel, readPvp } = await import("../../services/bacDuel.js");
const { chargerTheme, mancheCourante } = await import("../../services/bacRules.js");

function aplatir(composants = []) {
  return composants.flatMap((c) => (c.type === 17 ? [c, ...aplatir(c.components)] : c.type === 1 ? [c, ...c.components] : [c]));
}
const texte = (v) => aplatir(v.components).filter((c) => c.type === 10).map((c) => c.content).join("\n");
const boutons = (v) => aplatir(v.components).filter((c) => c.type === 2);

function verifier(v) {
  if (!(v.flags & (1 << 15))) throw new Error("message hors Components V2");
  if ("content" in v || "embeds" in v) throw new Error("content/embeds interdits en Components V2");
  if (texte(v).length > 4000) throw new Error("texte > 4000");
  for (const row of aplatir(v.components).filter((c) => c.type === 1)) {
    if (row.components.length > 5) throw new Error("> 5 composants");
    for (const c of row.components) {
      if (c.custom_id.length > 100) throw new Error("custom_id > 100");
      if (!c.label && !c.emoji) throw new Error("bouton sans libellé ni emoji");
    }
  }
}

// Un mot du thème (valide ou non) pour la manche en cours
function motPour(m, valide) {
  if (!valide) return `${m.lettre}zzzt`;
  const pool = chargerTheme(m.theme).kevina.get(m.lettre);
  return pool[Math.floor(Math.random() * pool.length)];
}

// Action au hasard du joueur `discordId` (siège `moi`) sur la manche en cours
async function jouer(W, discordId, d, moi, opts) {
  const n = d.manches.length;
  const m = mancheCourante(d);
  if (m.points !== null) return h.handleBacAction(W, discordId, "suivante", n, opts);
  if (m.fige[moi]) return null;
  const x = Math.random();
  if (x < 0.15) return h.handleBacAction(W, discordId, "passer", n, opts);
  return h.handleBacMot(W, discordId, n, motPour(m, x < 0.8), opts);
}

// ── Contre Kévina ──
const ID = "joueur-e2e";
const W = "https://discord.test/webhook";
const lancement = { member: { user: { id: ID, username: "Testeur" } }, channel_id: "salon" };
const opts = { channelId: "salon", pseudo: "Testeur" };
const resultats = {};
for (let g = 0; g < 4; g++) {
  await h.handleBacCommand(W, lancement);
  for (let k = 0; ; k++) {
    if (k > 150) throw new Error("partie bloquée");
    const d = await readDuel(ID);
    if (d.termine) {
      resultats[d.gagnant] = (resultats[d.gagnant] || 0) + 1;
      break;
    }
    await jouer(W, ID, d, "joueur", opts);
  }
}
const posts = salon.filter((m) => m.method === "POST");
console.log(`Contre Kévina : 4 parties ${JSON.stringify(resultats)}, ${posts.length} messages publiés`);
if (posts.length !== 8) throw new Error("table publique et résultat attendus pour chaque partie");
if (!vues.some((v) => texte(v).includes("accepté"))) throw new Error("mot accepté jamais affiché");
if (!vues.some((v) => texte(v).includes("refusé"))) throw new Error("mot refusé jamais affiché");
if (!vues.some((v) => boutons(v).some((b) => b.custom_id.startsWith("bacduel_suivante")))) throw new Error("bouton Manche suivante absent");

// Manche passée et temps écoulé : refusés, la manche se clôt
await h.handleBacCommand(W, lancement);
await h.handleBacMot(W, ID, 9, "kiwi", opts);
if (!texte(vues.at(-1)).includes("Cette manche est passée")) throw new Error("manche dépassée acceptée");
{
  const d = await readDuel(ID);
  mancheCourante(d).debut -= 120_000;
  await new Redis({}).set(`bacduel:${ID}`, JSON.stringify(d));
  await h.handleBacMot(W, ID, 1, "kiwi", opts);
  if (!texte(vues.at(-1)).includes("Temps écoulé")) throw new Error("temps écoulé non signalé");
  if (mancheCourante(await readDuel(ID)).points === null) throw new Error("manche non close au temps écoulé");
}

// ── 1v1 ──
const body = (id, nom) => ({ member: { user: { id, username: nom } }, channel_id: "salon" });
await h.handleBacPvpCommand("https://discord.test/a", body("A", "Alice"));
await h.handleBacOuvrir("https://discord.test/b", body("B", "Bob"));
await h.handleBacOuvrir("https://discord.test/c", body("C", "Chloé"));
if (!texte(vues.at(-1)).includes("Ce duel oppose")) throw new Error("3e joueur non refusé");
for (let k = 0; ; k++) {
  if (k > 300) throw new Error("1v1 bloqué");
  const p = await readPvp();
  if (p.statut === "fini") {
    console.log(`1v1 : fini, gagnant ${p.duel.gagnant}, scores ${JSON.stringify(p.duel.scores)}`);
    break;
  }
  // Chacun son tour au hasard, en même temps dans la manche
  const siege = Math.random() < 0.5 ? "joueur" : "bot";
  const id = p.sieges[siege];
  await jouer(`https://discord.test/${id.toLowerCase()}`, id, p.duel, siege, { pvp: true });
}

// ── Abandon (🏳️ puis confirmation) ──
await h.handleBacCommand(W, lancement);
await h.handleBacAbandon(W, ID, "demande", opts);
if (!texte(vues.at(-1)).includes("Abandonner la partie ?")) throw new Error("confirmation d'abandon absente");
await h.handleBacAbandon(W, ID, "ok", opts);
if (!(await readDuel(ID)).abandon) throw new Error("abandon non enregistré");
if (!texte(salon.filter((m) => m.method === "POST").at(-1)).includes("abandonne")) throw new Error("abandon non publié");

vues.forEach(verifier);
salon.forEach(verifier);
await h.handleBacRegles(W);
verifier(vues.at(-1));
console.log(`${vues.length} vues et ${salon.length} messages de salon conformes`);

const exemple = vues.find((v) => texte(v).includes("accepté") && boutons(v).some((b) => b.custom_id.startsWith("bacduel_proposer")));
console.log("\n--- Vue en cours de manche ---\n" + texte(exemple));
console.log("Boutons : " + boutons(exemple).map((b) => `[${b.label ?? b.emoji?.name}]`).join(" "));
const fin = vues.find((v) => boutons(v).some((b) => b.custom_id.startsWith("bacduel_suivante")));
console.log("\n--- Fin de manche ---\n" + texte(fin));
const recap = salon.find((m) => m.method === "POST" && /bat|Égalité/.test(texte(m)));
if (!JSON.stringify(recap).includes("/api/bac/illustration")) throw new Error("illustration absente du récapitulatif");
console.log("\n--- Récapitulatif ---\n" + texte(recap));
console.log("\n--- Règles ---\n" + texte(vues.at(-1)));
console.log("\n--- Fenêtre ---\n" + JSON.stringify(h.buildModalMot(2, "animaux", "K", false)));
