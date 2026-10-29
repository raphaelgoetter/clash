// Test de bout en bout du handler de La Grille (contre Kévina et 1v1), sur Redis
// en mémoire ; TOUS les appels Discord sont interceptés (aucun message
// réel). Vérifie les limites Discord des vues et affiche des exemples.
// Usage : node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/grille/e2eDuel.mjs
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

const h = await import("../../discord/handlers/grilleDuel.js");
const { readDuel, readPvp } = await import("../../services/grilleDuel.js");
const { colonnesLibres } = await import("../../services/grilleRules.js");

// Messages en Components V2 : texte (type 10), séparateur (type 14) et
// rangées de boutons (type 1), éventuellement dans un conteneur (type 17).
function aplatir(composants = []) {
  return composants.flatMap((c) => (c.type === 17 ? [c, ...aplatir(c.components)] : c.type === 1 ? [c, ...c.components] : [c]));
}
const texte = (v) => aplatir(v.components).filter((c) => c.type === 10).map((c) => c.content).join("\n");
const rangees = (v) => aplatir(v.components).filter((c) => c.type === 1);
// Plateau en texte, une rangée de boutons par ligne (aperçu)
const apercu = (v) =>
  aplatir(v.components)
    .filter((c) => c.type === 10 || c.type === 1 || c.type === 14)
    .map((c) =>
      c.type === 10 ? c.content : c.type === 14 ? "-----" : c.components.map((b) => b.label ?? b.emoji?.name).join(" | "),
    )
    .join("\n");

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
  const ids = rangees(v).flatMap((r) => r.components.map((c) => c.custom_id));
  if (new Set(ids).size !== ids.length) throw new Error("custom_id en double");
}

// ── Contre Kévina ──
const ID = "joueur-e2e";
const W = "https://discord.test/webhook";
const lancement = { member: { user: { id: ID, username: "Testeur" } }, channel_id: "salon" };
const resultats = {};
for (let g = 0; g < 5; g++) {
  await h.handleGrilleCommand(W, lancement);
  for (let k = 0; ; k++) {
    if (k > 40) throw new Error("partie bloquée");
    const d = await readDuel(ID);
    if (d.termine) {
      resultats[d.gagnant] = (resultats[d.gagnant] || 0) + 1;
      break;
    }
    const libres = colonnesLibres(d.grilles.joueur);
    await h.handleGrillePoser(W, ID, libres[Math.floor(Math.random() * libres.length)], { channelId: "salon", pseudo: "Testeur" });
  }
}
// Colonne pleine refusée
await h.handleGrilleCommand(W, lancement);
// Par partie : plateau public (lancement) puis récapitulatif ; la 6ᵉ
// partie, lancée seulement, a son plateau public
const posts = salon.filter((m) => m.method === "POST");
console.log(`Contre Kévina : 5 parties ${JSON.stringify(resultats)}, ${posts.length} messages publiés`);
if (posts.length !== 11) throw new Error("plateau public et résultat attendus pour chaque partie");
if (!salon.some((m) => m.method === "PATCH" && texte(m).includes("Kévina réfléchit"))) {
  throw new Error("plateau public non suivi");
}

// ── 1v1 ──
const body = (id, nom) => ({ member: { user: { id, username: nom } }, channel_id: "salon" });
await h.handleGrillePvpCommand("https://discord.test/a", body("A", "Alice"));
await h.handleGrilleOuvrir("https://discord.test/b", body("B", "Bob"));
await h.handleGrilleOuvrir("https://discord.test/c", body("C", "Chloé"));
if (!texte(vues.at(-1)).includes("Ce duel oppose")) throw new Error("3e joueur non refusé");
for (let k = 0; ; k++) {
  if (k > 40) throw new Error("1v1 bloqué");
  const p = await readPvp();
  if (p.statut === "fini") {
    console.log(`1v1 : fini (${p.raisonFin}), gagnant ${p.duel.gagnant}`);
    if (!editionsFollowup) throw new Error("vue du lanceur (followup) jamais mise à jour");
    break;
  }
  const actif = p.sieges[p.duel.actif];
  const libres = colonnesLibres(p.duel.grilles[p.duel.actif]);
  // Clic hors tour : refusé sans effet
  await h.handleGrillePoser(`https://discord.test/${actif === "A" ? "b" : "a"}`, actif === "A" ? "B" : "A", 0, { pvp: true });
  await h.handleGrillePoser(`https://discord.test/${actif === "A" ? "a" : "b"}`, actif, libres[0], { pvp: true });
}

vues.forEach(verifier);
salon.forEach(verifier);
await h.handleGrilleRegles(W);
verifier(vues.at(-1));
console.log(`${vues.length} vues et ${salon.length} messages de salon conformes`);

const exemple = vues.find((v) => texte(v).includes("Kévina pose") && rangees(v).some((r) => r.components[0]?.label === "Gauche"));
console.log("\n--- Vue contre Kévina ---\n" + apercu(exemple));
console.log("\n--- Récap 1v1 ---\n" + apercu(salon.filter((m) => m.method === "POST").at(-1)));
