// Test de bout en bout du Bang! Duel 1v1 : vrai Redis (clé bangduel:pvp,
// refuse de tourner si un duel réel est en cours), appels Discord
// interceptés ; vérifie les limites Discord des vues et le déroulé.
import dotenv from "dotenv";
dotenv.config();
process.env.DISCORD_TOKEN ||= "test";
const appels = [];
const fetchOrig = globalThis.fetch;
let nextMsg = 1;
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://discord.test") || u.startsWith("https://discord.com/api")) {
    appels.push({ url: u, method: init.method, body: init.body ? JSON.parse(init.body) : null });
    if (init.method === "POST" && u.includes("/channels/")) return new Response(JSON.stringify({ id: `msg${nextMsg++}` }));
    return new Response("{}");
  }
  return fetchOrig(url, init);
};
const h = await import("../../api/discord/_handlers/bangDuel.js");
const { readPvp } = await import("../../backend/services/bangDuel.js");
const { Redis } = await import("@upstash/redis");
const redis = new Redis({ url: process.env.KV_REST_API_URL, token: process.env.KV_REST_API_TOKEN });

const existante = await readPvp();
if (existante && existante.statut !== "fini") {
  console.log("Un duel 1v1 réel est en cours : test annulé.");
  process.exit(0);
}

function verifier(v) {
  for (const e of v.embeds || []) {
    if ((e.description || "").length > 4096) throw new Error("description > 4096");
    if ((e.title || "").length > 256) throw new Error("titre > 256");
  }
  for (const row of v.components || []) {
    if (row.components.length > 5) throw new Error("> 5 composants");
    for (const c of row.components) {
      if (c.options && (c.options.length > 25 || c.options.length < 1)) throw new Error("options hors limites");
      for (const o of c.options || []) if (o.label.length > 100 || (o.description || "").length > 100) throw new Error("option > 100");
      if (c.custom_id.length > 100) throw new Error("custom_id > 100");
    }
  }
}

const A = { id: "test-pvp-a", nom: "Alice" };
const B = { id: "test-pvp-b", nom: "Bob" };
const C = { id: "test-pvp-c", nom: "Chloé" };
const body = (p) => ({ channel_id: "salon-test", member: { user: { id: p.id, username: p.nom }, roles: [] } });
const W = (p, n = 0) => `https://discord.test/webhook/${p.id}/${n}`;

const resultats = {};
let actions = 0;
for (let g = 0; g < 3; g++) {
  await redis.del("bangduel:pvp");
  await h.handleBangDuelPvpCommand(W(A), body(A));
  // Le lanceur ne peut pas jouer seul, un 2e joueur rejoint, un 3e est refusé
  await h.handleBangDuelOuvrir(W(A, 1), body(A));
  await h.handleBangDuelOuvrir(W(B), body(B));
  await h.handleBangDuelOuvrir(W(C), body(C));
  const refus = appels.at(-1).body.content;
  if (!refus?.includes("oppose")) throw new Error("3e joueur non refusé");
  for (let k = 0; ; k++) {
    if (k >= 120) throw new Error("partie bloquée");
    const p = await readPvp();
    if (p.statut === "fini") {
      const cle = p.duel.gagnant ? p.sieges[p.duel.gagnant] : "nul";
      resultats[cle] = (resultats[cle] || 0) + 1;
      break;
    }
    const d = p.duel;
    const id = p.sieges[d.actif];
    const j = d.joueurs[d.actif];
    const w = W({ id }, k);
    const opts = { pvp: true };
    actions++;
    // L'adversaire en attente actualise de temps en temps
    if (k % 7 === 3) await h.handleBangDuelActualiser(W({ id: p.sieges[d.actif === "joueur" ? "bot" : "joueur"] }, k), p.sieges[d.actif === "joueur" ? "bot" : "joueur"]);
    if (j.enAttente) await h.handleBangDuelPlacer(w, id, "hasard", opts);
    else if (j.main.includes("voleuse") && j.jouees < 3 && Math.random() < 0.5) await h.handleBangDuelCarte(w, id, "voleuse", opts);
    else if (j.main.includes("gang") && j.jouees < 3 && Math.random() < 0.3) await h.handleBangDuelCarte(w, id, "gang", opts);
    else if (j.main.includes("sarbacane") && j.jouees < 3 && Math.random() < 0.5) await h.handleBangDuelCarte(w, id, "sarbacane", opts);
    else await h.handleBangDuelPiocher(w, id, opts);
  }
}

// Délai dépassé
await redis.del("bangduel:pvp");
await h.handleBangDuelPvpCommand(W(A), body(A));
await h.handleBangDuelOuvrir(W(B), body(B));
let p = await readPvp();
const lent = p.sieges[p.duel.actif];
const patient = lent === A.id ? B.id : A.id;
p.dernierCoupAt -= 10 * 60_000;
await redis.set("bangduel:pvp", JSON.stringify(p));
await h.handleBangDuelActualiser(W({ id: patient }, 99), patient);
p = await readPvp();
if (p.statut !== "fini" || p.raisonFin !== "delai" || p.sieges[p.duel.gagnant] !== patient) throw new Error("délai non appliqué");
const finDelai = appels.filter((a) => a.method === "POST" && a.url.includes("/channels/")).at(-1).body.embeds[0].description;

const vues = appels.filter((a) => a.body && (a.body.embeds || a.body.components));
vues.forEach((a) => verifier(a.body));
await redis.del("bangduel:pvp");
console.log(`3 parties, ${actions} actions, ${vues.length} vues conformes ; victoires`, resultats);
console.log("Fin au délai :", finDelai);
const attente = vues.find((a) => a.url.includes("discord.test") && a.body.embeds?.[0]?.description?.includes("(en cours)"));
console.log("\n--- Vue en attente ---\n" + attente.body.embeds[0].title + "\n" + attente.body.embeds[0].description);
console.log("Composants :", attente.body.components.map((r) => r.components.map((c) => c.label || c.placeholder).join(" | ")).join(" / "));
const tour = vues.find((a) => a.url.includes("discord.test") && a.body.embeds?.[0]?.title?.includes("À toi") && a.body.embeds[0].description.includes("Tour d"));
console.log("\n--- Vue à son tour ---\n" + tour.body.embeds[0].title + "\n" + tour.body.embeds[0].description);
const pub = vues.find((a) => a.method === "PATCH" && a.url.includes("/channels/") && a.body.embeds[0].title.includes("contre"));
console.log("\n--- Message public ---\n" + pub.body.embeds[0].title + "\n" + pub.body.embeds[0].description);
