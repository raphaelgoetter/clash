// Test de bout en bout du handler de Quatre à la suite (contre Kévina et 1v1), sur Redis
// en mémoire ; TOUS les appels Discord sont interceptés (aucun message
// réel). Vérifie les limites Discord des vues et affiche des exemples.
// Usage : node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/quatre/e2eDuel.mjs
import { Redis } from "@upstash/redis";

if (!Redis.isFake) throw new Error("À lancer avec registerFakeRedis.js (voir l'en-tête)");

const vues = [];
const salon = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://discord.test")) vues.push(JSON.parse(init.body));
  else if (u.startsWith("https://discord.com")) {
    if (init.body) salon.push({ method: init.method, ...JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: `msg-${salon.length}` }));
  } else throw new Error(`Appel réseau inattendu : ${u}`);
  return new Response("{}");
};
process.env.DISCORD_TOKEN = "faux";

const h = await import("../../discord/handlers/quatreDuel.js");
const { readDuel, readPvp } = await import("../../services/quatreDuel.js");
const { colonnesLibres } = await import("../../services/quatreRules.js");

function verifier(v) {
  for (const e of v.embeds || []) {
    if ((e.description || "").length > 4096) throw new Error("description > 4096");
    if ((e.title || "").length > 256) throw new Error("titre > 256");
  }
  for (const row of v.components || []) {
    if (row.components.length > 5) throw new Error("> 5 composants");
    for (const c of row.components) if (c.custom_id.length > 100) throw new Error("custom_id > 100");
  }
}

// ── Contre Kévina ──
const ID = "joueur-e2e";
const W = "https://discord.test/webhook";
const resultats = {};
for (let g = 0; g < 5; g++) {
  await h.handleQuatreCommand(W, ID);
  for (let k = 0; ; k++) {
    if (k > 50) throw new Error("partie bloquée");
    const d = await readDuel(ID);
    if (d.termine) {
      resultats[d.gagnant] = (resultats[d.gagnant] || 0) + 1;
      break;
    }
    const libres = colonnesLibres(d.colonnes);
    await h.handleQuatrePoser(W, ID, libres[Math.floor(Math.random() * libres.length)], { channelId: "salon", pseudo: "Testeur" });
  }
}
console.log(`Contre Kévina : 5 parties ${JSON.stringify(resultats)}, ${salon.length} résultats publiés`);
if (salon.length !== 5) throw new Error("un résultat par partie attendu");

// ── 1v1 ──
const body = (id, nom) => ({ member: { user: { id, username: nom } }, channel_id: "salon" });
await h.handleQuatrePvpCommand("https://discord.test/a", body("A", "Alice"));
await h.handleQuatreOuvrir("https://discord.test/b", body("B", "Bob"));
await h.handleQuatreOuvrir("https://discord.test/c", body("C", "Chloé"));
if (!vues.at(-1).content?.includes("Ce duel oppose")) throw new Error("3e joueur non refusé");
for (let k = 0; ; k++) {
  if (k > 50) throw new Error("1v1 bloqué");
  const p = await readPvp();
  if (p.statut === "fini") {
    console.log(`1v1 : fini (${p.raisonFin}), gagnant ${p.duel.gagnant}`);
    break;
  }
  const actif = p.sieges[p.duel.actif];
  const libres = colonnesLibres(p.duel.colonnes);
  // Clic hors tour : refusé sans effet
  await h.handleQuatrePoser(`https://discord.test/${actif === "A" ? "b" : "a"}`, actif === "A" ? "B" : "A", 0, { pvp: true });
  await h.handleQuatrePoser(`https://discord.test/${actif === "A" ? "a" : "b"}`, actif, libres[0], { pvp: true });
}

vues.forEach(verifier);
salon.forEach(verifier);
await h.handleQuatreRegles(W);
verifier(vues.at(-1));
console.log(`${vues.length} vues et ${salon.length} messages de salon conformes`);

const exemple = vues.find((v) => v.components?.length === 3 && v.embeds?.[0]?.description?.includes("Kévina joue"));
console.log("\n--- Vue contre Kévina ---\n" + exemple.embeds[0].title + "\n" + exemple.embeds[0].description);
console.log("Boutons :", exemple.components.map((r) => r.components.map((c) => `${c.label}${c.disabled ? " (grisé)" : ""}`).join(" | ")).join(" / "));
console.log("\n--- Récap 1v1 ---\n" + salon.filter((m) => m.method === "POST").at(-1).embeds[0].description);
