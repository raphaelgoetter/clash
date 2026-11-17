// Test de bout en bout du handler de Quatre à la suite (contre Kévina et 1v1), sur Redis
// en mémoire ; TOUS les appels Discord sont interceptés (aucun message
// réel). Vérifie les limites Discord des vues et affiche des exemples.
// Usage : node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/quatre/e2eDuel.mjs
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

const h = await import("../../discord/handlers/quatreDuel.js");
const { readDuel, readPvp } = await import("../../services/quatreDuel.js");
const { colonnesLibres, poser } = await import("../../services/quatreRules.js");
const { decodeGrille } = await import("../../services/quatreImage.js");

// Messages en Components V2 : texte (type 10) et rangées de boutons
// (type 1), éventuellement dans un conteneur (type 17).
function aplatir(composants = []) {
  return composants.flatMap((c) => (c.type === 17 ? aplatir(c.components) : [c]));
}
const texte = (v) => aplatir(v.components).filter((c) => c.type === 10).map((c) => c.content).join("\n");
const rangees = (v) => aplatir(v.components).filter((c) => c.type === 1);
// Images (galeries, type 12) : bandeau du pion puis grille
const images = (v) => aplatir(v.components).filter((c) => c.type === 12).map((c) => c.items[0].media.url);
const bandeau = (v) => images(v).find((u) => u.includes("/bandeau?"));
const grille = (v) => images(v).find((u) => u.includes("/grille?"));
const boutons = (v) => rangees(v).flatMap((r) => r.components);

function verifier(v) {
  if (!(v.flags & (1 << 15))) throw new Error("message hors Components V2");
  if ("content" in v || "embeds" in v) throw new Error("content/embeds interdits en Components V2");
  if (texte(v).length > 4000) throw new Error("texte > 4000");
  for (const row of rangees(v)) {
    if (row.components.length > 5) throw new Error("> 5 composants");
    for (const c of row.components) if (c.custom_id.length > 100) throw new Error("custom_id > 100");
    const ids = row.components.map((c) => c.custom_id);
    if (new Set(ids).size !== ids.length) throw new Error("custom_id en double");
  }
  for (const url of images(v)) {
    if (url.includes("/grille?") && !decodeGrille(new URL(url).searchParams.get("d"))) throw new Error("grille illisible");
  }
}

// ── Contre Kévina ──
const ID = "joueur-e2e";
const W = "https://discord.test/webhook";
const lancement = { member: { user: { id: ID, username: "Testeur" } }, channel_id: "salon" };
const resultats = {};
for (let g = 0; g < 5; g++) {
  await h.handleQuatreCommand(W, lancement);
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
// Par partie : plateau public (lancement) puis récapitulatif
const posts = salon.filter((m) => m.method === "POST");
console.log(`Contre Kévina : 5 parties ${JSON.stringify(resultats)}, ${posts.length} messages publiés`);
if (posts.length !== 10) throw new Error("plateau public et résultat attendus pour chaque partie");
if (!salon.some((m) => m.method === "PATCH" && texte(m).includes("Kévina réfléchit"))) throw new Error("plateau public non suivi");

// ── 1v1 ──
const body = (id, nom) => ({ member: { user: { id, username: nom } }, channel_id: "salon" });
await h.handleQuatrePvpCommand("https://discord.test/a", body("A", "Alice"));
await h.handleQuatreOuvrir("https://discord.test/b", body("B", "Bob"));
await h.handleQuatreOuvrir("https://discord.test/c", body("C", "Chloé"));
if (!texte(vues.at(-1)).includes("Ce duel oppose")) throw new Error("3e joueur non refusé");
for (let k = 0; ; k++) {
  if (k > 50) throw new Error("1v1 bloqué");
  const p = await readPvp();
  if (p.statut === "fini") {
    console.log(`1v1 : fini (${p.raisonFin}), gagnant ${p.duel.gagnant}`);
    if (!editionsFollowup) throw new Error("vue du lanceur (followup) jamais mise à jour");
    break;
  }
  const actif = p.sieges[p.duel.actif];
  const libres = colonnesLibres(p.duel.colonnes);
  // Clic hors tour : refusé sans effet
  await h.handleQuatrePoser(`https://discord.test/${actif === "A" ? "b" : "a"}`, actif === "A" ? "B" : "A", 0, { pvp: true });
  await h.handleQuatrePoser(`https://discord.test/${actif === "A" ? "a" : "b"}`, actif, libres[0], { pvp: true });
}

// ── Pion à jouer (◀️ ▶️) : seul le bandeau change ──
await h.handleQuatreCommand(W, lancement);
const depart = vues.at(-1);
if (!bandeau(depart)?.includes("c=3&")) throw new Error("pion pas au centre");
const droite = boutons(depart).find((b) => b.custom_id.startsWith("quatreduel_droite:"));
if (droite.custom_id !== "quatreduel_droite:4") throw new Error(`flèche droite inattendue : ${droite.custom_id}`);
await h.handleQuatreCurseur(W, ID, 4);
const deplace = vues.at(-1);
if (!bandeau(deplace).includes("c=4&")) throw new Error("bandeau non déplacé");
if (grille(deplace) !== grille(depart)) throw new Error("grille modifiée par un simple déplacement");
if (!boutons(deplace).some((b) => b.custom_id === "quatreduel_poser:4")) throw new Error("⬇️ ne vise pas la colonne du pion");
// Colonne 5 pleine : ▶️ depuis la 4 saute à la 6
const { agirDuel } = await import("../../services/quatreDuel.js");
await agirDuel(ID, (d) => {
  for (let k = 0; k < 6; k++) poser(d, d.actif, 5);
});
await h.handleQuatreCurseur(W, ID, 4);
if (!boutons(vues.at(-1)).some((b) => b.custom_id === "quatreduel_droite:6")) throw new Error("colonne pleine non sautée");
// ▶️ depuis la 6 : tour de la grille vers la 0
await h.handleQuatreCurseur(W, ID, 6);
if (!boutons(vues.at(-1)).some((b) => b.custom_id === "quatreduel_droite:0")) throw new Error("pas de tour de la grille");
console.log("Pion à jouer : déplacé sans changer la grille, colonnes pleines sautées");

// ── Délai contre Kévina : coup trop tard = défaite publiée ──
await h.handleQuatreCommand(W, lancement);
if (!texte(salon.filter((m) => m.method === "POST").at(-1)).includes("limite <t:")) throw new Error("limite absente du plateau public");
await agirDuel(ID, (d) => {
  d.tourDepuis = Date.now() - 3 * 60_000;
});
await h.handleQuatrePoser(W, ID, 3, { channelId: "salon", pseudo: "Testeur" });
const finDelai = await readDuel(ID);
if (!finDelai.delai || finDelai.gagnant !== "bot") throw new Error("délai contre Kévina non appliqué");
if (!texte(salon.at(-1)).includes("n'a pas joué à temps")) throw new Error("fin au délai non publiée");
console.log("Délai contre Kévina : défaite publiée");

// ── Abandon (🏳️ puis confirmation) ──
await h.handleQuatreCommand(W, lancement);
await h.handleQuatreAbandon(W, ID, "demande", { channelId: "salon", pseudo: "Testeur" });
if (!texte(vues.at(-1)).includes("Abandonner la partie ?")) throw new Error("confirmation d'abandon absente");
await h.handleQuatreAbandon(W, ID, "non", { channelId: "salon", pseudo: "Testeur" });
if (boutons(vues.at(-1)).length !== 4) throw new Error("Annuler ne rend pas les boutons de jeu");
await h.handleQuatreAbandon(W, ID, "ok", { channelId: "salon", pseudo: "Testeur" });
if (!(await readDuel(ID)).abandon) throw new Error("abandon contre Kévina non enregistré");
if (!texte(salon.at(-1)).includes("abandonne face à Kévina")) throw new Error("abandon contre Kévina non publié");

await h.handleQuatrePvpCommand("https://discord.test/a", body("A", "Alice"));
await h.handleQuatreOuvrir("https://discord.test/b", body("B", "Bob"));
await h.handleQuatreAbandon("https://discord.test/b", "B", "ok", { pvp: true });
const pAbandon = await readPvp();
if (pAbandon.raisonFin !== "abandon" || pAbandon.duel.gagnant !== (pAbandon.sieges.joueur === "A" ? "joueur" : "bot")) {
  throw new Error("abandon 1v1 mal résolu");
}
console.log("Abandon : " + texte(salon.filter((m) => m.method === "POST").at(-1)).split("\n")[1]);

vues.forEach(verifier);
salon.forEach(verifier);
await h.handleQuatreRegles(W);
verifier(vues.at(-1));
console.log(`${vues.length} vues et ${salon.length} messages de salon conformes`);

const exemple = vues.find((v) => boutons(v).length === 4 && texte(v).includes("Kévina joue"));
console.log("\n--- Vue contre Kévina ---\n" + texte(exemple));
console.log("Images :", images(exemple).join("\n        "));
console.log("Boutons :", boutons(exemple).map((c) => `${c.emoji?.name ?? ""}${c.label ?? ""}${c.disabled ? " (grisé)" : ""}`).join(" | "));
console.log("\n--- Récap 1v1 ---\n" + texte(salon.filter((m) => m.method === "POST").at(-1)));
