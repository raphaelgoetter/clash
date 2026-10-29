// Test de bout en bout du handler de Punto (contre Kévina et 1v1), sur Redis
// en mémoire ; TOUS les appels Discord sont interceptés (aucun message
// réel). Vérifie les limites Discord des vues et affiche des exemples.
// Usage : node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/punto/e2eDuel.mjs
import { Redis } from "@upstash/redis";

if (!Redis.isFake) throw new Error("À lancer avec registerFakeRedis.js (voir l'en-tête)");

const vues = [];
// Éditions d'une vue renvoyée en followup (vue du lanceur en 1v1)
let editionsFollowup = 0;
const salon = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://discord.test")) {
    // DELETE : vue éphémère supprimée (fin de partie)
    if (init.body) vues.push(JSON.parse(init.body));
    if (init.method === "PATCH" && u.includes("/messages/vue-")) editionsFollowup++;
    // Followup (vue renvoyée sous le message public) : son id
    if (init.method === "POST") return new Response(JSON.stringify({ id: `vue-${vues.length}` }));
  }
  else if (u.startsWith("https://discord.com")) {
    if (init.body) salon.push({ method: init.method, ...JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: `msg-${salon.length}` }));
  } else throw new Error(`Appel réseau inattendu : ${u}`);
  return new Response("{}");
};
process.env.DISCORD_TOKEN = "faux";
// Pauses instantanées : la surveillance du délai 1v1 (surveillerDelai)
// attendrait sinon l'échéance réelle après chaque coup
const setTimeoutReel = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...args) => setTimeoutReel(fn, 0, ...args);

const h = await import("../../discord/handlers/puntoDuel.js");
const { readDuel, readPvp } = await import("../../services/puntoDuel.js");
const { casesJouables } = await import("../../services/puntoRules.js");

// Messages en Components V2 : texte (type 10) et rangées de boutons
// (type 1), éventuellement dans un conteneur (type 17).
function aplatir(composants = []) {
  return composants.flatMap((c) => (c.type === 17 ? [c, ...aplatir(c.components)] : c.type === 1 ? [c, ...c.components] : [c]));
}
const texte = (v) => aplatir(v.components).filter((c) => c.type === 10).map((c) => c.content).join("\n");
const rangees = (v) => aplatir(v.components).filter((c) => c.type === 1);

function verifier(v) {
  if (!(v.flags & (1 << 15))) throw new Error("message hors Components V2");
  if ("content" in v || "embeds" in v) throw new Error("content/embeds interdits en Components V2");
  if (texte(v).length > 4000) throw new Error("texte > 4000");
  // Limite Discord des Components V2 : 40 composants au total
  if (aplatir(v.components).length > 40) throw new Error(`${aplatir(v.components).length} composants > 40`);
  for (const row of rangees(v)) {
    if (row.components.length > 5) throw new Error("> 5 composants");
    for (const c of row.components) {
      if (c.custom_id.length > 100) throw new Error("custom_id > 100");
      if (!c.label && !c.emoji) throw new Error("bouton sans libellé ni emoji");
    }
  }
}

// ── Contre Kévina ──
const ID = "joueur-e2e";
const W = "https://discord.test/webhook";
const lancement = { member: { user: { id: ID, username: "Testeur" } }, channel_id: "salon" };
const resultats = {};
for (let g = 0; g < 5; g++) {
  await h.handlePuntoCommand(W, lancement);
  for (let k = 0; ; k++) {
    if (k > 80) throw new Error("partie bloquée");
    const d = await readDuel(ID);
    if (d.termine) {
      resultats[d.gagnant] = (resultats[d.gagnant] || 0) + 1;
      break;
    }
    const cases = casesJouables(d.grille, d.carte);
    await h.handlePuntoPoser(W, ID, cases[Math.floor(Math.random() * cases.length)], d.coups, { channelId: "salon", pseudo: "Testeur" });
  }
}
// Par partie : plateau public (lancement) puis récapitulatif
const posts = salon.filter((m) => m.method === "POST");
console.log(`Contre Kévina : 5 parties ${JSON.stringify(resultats)}, ${posts.length} messages publiés`);
if (posts.length !== 10) throw new Error("plateau public et résultat attendus pour chaque partie");
if (!salon.some((m) => m.method === "PATCH" && texte(m).includes("Kévina réfléchit"))) throw new Error("plateau public non suivi");

// Case interdite : avertissement, partie intacte
await h.handlePuntoCommand(W, lancement);
await h.handlePuntoPoser(W, ID, 0, 0, { channelId: "salon", pseudo: "Testeur" });
if (!texte(vues.at(-1)).includes("ne peut pas aller sur cette case")) throw new Error("case interdite acceptée");
if ((await readDuel(ID)).coups !== 0) throw new Error("coup interdit joué");
// Vue dépassée (numéro de coup ancien) : refusée, même sur une case jouable
await h.handlePuntoPoser(W, ID, 12, 5, { channelId: "salon", pseudo: "Testeur" });
if (!texte(vues.at(-1)).includes("Le plateau a changé")) throw new Error("clic sur une vue dépassée accepté");
if ((await readDuel(ID)).coups !== 0) throw new Error("coup d'une vue dépassée joué");

// ── 1v1 ──
const body = (id, nom) => ({ member: { user: { id, username: nom } }, channel_id: "salon" });
await h.handlePuntoPvpCommand("https://discord.test/a", body("A", "Alice"));
await h.handlePuntoOuvrir("https://discord.test/b", body("B", "Bob"));
await h.handlePuntoOuvrir("https://discord.test/c", body("C", "Chloé"));
if (!texte(vues.at(-1)).includes("Ce duel oppose")) throw new Error("3e joueur non refusé");
for (let k = 0; ; k++) {
  if (k > 80) throw new Error("1v1 bloqué");
  const p = await readPvp();
  if (p.statut === "fini") {
    console.log(`1v1 : fini (${p.raisonFin}), gagnant ${p.duel.gagnant}, ${p.duel.coups} coups`);
    if (!editionsFollowup) throw new Error("vue du lanceur (followup) jamais mise à jour");
    break;
  }
  const actif = p.sieges[p.duel.actif];
  const cases = casesJouables(p.duel.grille, p.duel.carte);
  // Clic hors tour : refusé sans effet
  await h.handlePuntoPoser(`https://discord.test/${actif === "A" ? "b" : "a"}`, actif === "A" ? "B" : "A", cases[0], p.duel.coups, { pvp: true });
  await h.handlePuntoPoser(`https://discord.test/${actif === "A" ? "a" : "b"}`, actif, cases[0], p.duel.coups, { pvp: true });
}

// ── Abandon (🏳️ puis confirmation) ──
await h.handlePuntoCommand(W, lancement);
await h.handlePuntoAbandon(W, ID, "demande", { channelId: "salon", pseudo: "Testeur" });
if (!texte(vues.at(-1)).includes("Abandonner la partie ?")) throw new Error("confirmation d'abandon absente");
await h.handlePuntoAbandon(W, ID, "non", { channelId: "salon", pseudo: "Testeur" });
if (rangees(vues.at(-1)).length !== 6) throw new Error("Annuler ne rend pas le plateau en boutons");
await h.handlePuntoAbandon(W, ID, "ok", { channelId: "salon", pseudo: "Testeur" });
if (!(await readDuel(ID)).abandon) throw new Error("abandon contre Kévina non enregistré");
if (!texte(salon.at(-1)).includes("abandonne face à Kévina")) throw new Error("abandon contre Kévina non publié");

await h.handlePuntoPvpCommand("https://discord.test/a", body("A", "Alice"));
await h.handlePuntoOuvrir("https://discord.test/b", body("B", "Bob"));
await h.handlePuntoAbandon("https://discord.test/b", "B", "ok", { pvp: true });
const pAbandon = await readPvp();
if (pAbandon.raisonFin !== "abandon" || pAbandon.duel.gagnant !== (pAbandon.sieges.joueur === "A" ? "joueur" : "bot")) {
  throw new Error("abandon 1v1 mal résolu");
}
console.log("Abandon : " + texte(salon.filter((m) => m.method === "POST").at(-1)).split("\n")[1]);

vues.forEach(verifier);
salon.forEach(verifier);
await h.handlePuntoRegles(W);
verifier(vues.at(-1));
console.log(`${vues.length} vues et ${salon.length} messages de salon conformes`);

const exemple = vues.find((v) => rangees(v).length === 6 && texte(v).includes("Kévina pose"));
console.log("\n--- Vue contre Kévina ---\n" + texte(exemple));
console.log(
  "Boutons :\n" +
    rangees(exemple)
      .slice(0, 5)
      .map((r) => r.components.map((c) => `[${c.label ?? c.emoji?.name}]`).join(" "))
      .join("\n"),
);
console.log("\n--- Récap 1v1 ---\n" + texte(salon.filter((m) => m.method === "POST").at(-1)));
console.log("\n--- Règles ---\n" + texte(vues.at(-1)));
