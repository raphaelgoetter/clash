// Test de bout en bout du handler Bang! Duel : vrai Redis (clé de test),
// appels Discord interceptés ; vérifie les limites Discord des vues.
import dotenv from "dotenv";
dotenv.config();
const vues = [];
const fetchOrig = globalThis.fetch;
globalThis.fetch = async (url, init) => {
  if (String(url).startsWith("https://discord.test")) {
    vues.push(JSON.parse(init.body));
    return new Response("{}");
  }
  return fetchOrig(url, init);
};
const h = await import("../../api/discord/_handlers/bangDuel.js");
const { readDuel, supprimerDuel } = await import("../../backend/services/bangDuel.js");
const ID = "test-e2e-duel";
const W = "https://discord.test/webhook";

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

let parties = 0, actions = 0;
const resultats = {};
for (let g = 0; g < 3; g++) {
  await supprimerDuel(ID);
  await h.handleBangDuelCommand(W, ID);
  for (let k = 0; ; k++) {
    if (k >= 80) throw new Error("partie bloquée");
    const d = await readDuel(ID);
    if (!d || d.termine) { resultats[d?.gagnant ?? "nul"] = (resultats[d?.gagnant ?? "nul"] || 0) + 1; break; }
    const j = d.joueurs.joueur;
    actions++;
    if (j.enAttente) await h.handleBangDuelPlacer(W, ID, "1");
    else if (j.vol) await h.handleBangDuelVoler(W, ID, d.joueurs.bot.main[0]);
    else if (j.main.includes("voleuse") && j.jouees < 3 && Math.random() < 0.5) await h.handleBangDuelCarte(W, ID, "voleuse");
    else if (j.main.includes("sarbacane") && j.jouees < 3 && Math.random() < 0.5) await h.handleBangDuelCarte(W, ID, "sarbacane");
    else await h.handleBangDuelPiocher(W, ID);
  }
  parties++;
}
vues.forEach(verifier);
await h.handleBangDuelRegles(W);
verifier(vues.at(-1));
console.log(`${parties} parties, ${actions} actions, ${vues.length} vues conformes ; résultats`, resultats);
const exemple = vues.find((v) => v.embeds?.[0]?.description?.includes("Tour du Bot"));
console.log("\n--- Exemple de vue ---\n" + exemple.embeds[0].title + "\n" + exemple.embeds[0].description);
console.log("Composants :", exemple.components.map((r) => r.components.map((c) => c.label || c.placeholder).join(" | ")).join(" / "));
console.log("\n--- Vue finale ---\n" + vues.at(-2).embeds[0].title + "\n" + vues.at(-2).embeds[0].description);
await supprimerDuel(ID);
