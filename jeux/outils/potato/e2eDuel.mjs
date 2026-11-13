// Test de bout en bout du handler de Potato (contre Kévina et 1v1), sur
// Redis en mémoire ; TOUS les appels Discord sont interceptés (aucun message
// réel). Vérifie les limites Discord des vues, l'anti-spoiler des images et
// affiche des exemples.
// Usage : node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/potato/e2eDuel.mjs
import { Redis } from "@upstash/redis";

if (!Redis.isFake) throw new Error("À lancer avec registerFakeRedis.js (voir l'en-tête)");

const vues = [];
let editionsFollowup = 0;
const salon = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://discord.test")) {
    if (init.body) vues.push(JSON.parse(init.body));
    if (init.method === "PATCH" && u.includes("/messages/vue-")) editionsFollowup++;
    if (init.method === "POST") return new Response(JSON.stringify({ id: `vue-${vues.length}` }));
  } else if (u.startsWith("https://discord.com")) {
    if (init.body) salon.push({ method: init.method, ...JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: `msg-${salon.length}` }));
  } else throw new Error(`Appel réseau inattendu : ${u}`);
  return new Response("{}");
};
process.env.DISCORD_TOKEN = "faux";
// Pauses instantanées (réflexion de Kévina, fins de manche, délai 1v1)
const setTimeoutReel = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...args) => setTimeoutReel(fn, 0, ...args);

const h = await import("../../discord/handlers/potatoDuel.js");
const { readDuel, readPvp } = await import("../../services/potatoDuel.js");
const { decodePublic, decodeVue } = await import("../../services/potatoImage.js");
const { chauffePermise } = await import("../../services/potatoRules.js");

function aplatir(composants = []) {
  return composants.flatMap((c) => (c.type === 17 ? [c, ...aplatir(c.components)] : c.type === 1 ? [c, ...c.components] : [c]));
}
const texte = (v) => aplatir(v.components).filter((c) => c.type === 10).map((c) => c.content).join("\n");
const rangees = (v) => aplatir(v.components).filter((c) => c.type === 1);
const boutons = (v) => rangees(v).flatMap((r) => r.components);
const imageDe = (v) => aplatir(v.components).find((c) => c.type === 12)?.items[0].media.url ?? null;

function verifier(v, { public: estPublic = false } = {}) {
  if (!(v.flags & (1 << 15))) throw new Error("message hors Components V2");
  if ("content" in v || "embeds" in v) throw new Error("content/embeds interdits en Components V2");
  if (texte(v).length > 4000) throw new Error("texte > 4000");
  if (aplatir(v.components).length > 40) throw new Error(`${aplatir(v.components).length} composants > 40`);
  for (const row of rangees(v)) {
    if (row.components.length > 5) throw new Error("> 5 composants");
    for (const c of row.components) {
      if (c.custom_id.length > 100) throw new Error("custom_id > 100");
      if (!c.label && !c.emoji) throw new Error("bouton sans libellé ni emoji");
      if (c.label && c.label.length > 80) throw new Error("libellé > 80");
    }
  }
  const url = imageDe(v);
  if (url) {
    const u = new URL(url);
    const d = u.searchParams.get("d");
    const t = u.pathname.endsWith("/public") ? decodePublic(d) : decodeVue(d);
    if (!t) throw new Error(`image illisible : ${url}`);
    // Anti-spoiler : aucune température d'explosion dans une image publique
    if (estPublic && !u.pathname.endsWith("/public")) throw new Error("vue d'un joueur dans le salon");
    if (t.explosion && t.evenement !== "thermo") throw new Error("température d'explosion hors Thermomètre");
  }
}

// Chauffe permise au hasard du siège `moi` (Chauffe imposée respectée)
const auHasard = (d, moi) => {
  const ks = [0, 1, 2].filter((k) => chauffePermise(d, moi, k));
  return ks[Math.floor(Math.random() * ks.length)];
};
const evenementsVus = new Set();

// ── Contre Kévina ──
const ID = "joueur-e2e";
const W = "https://discord.test/webhook";
const lancement = { member: { user: { id: ID, username: "Testeur" } }, channel_id: "salon" };
const opts = { channelId: "salon", pseudo: "Testeur" };
const resultats = {};
let actions = 0;
for (let g = 0; g < 10; g++) {
  await h.handlePotatoCommand(W, lancement);
  for (let k = 0; ; k++) {
    if (k > 200) throw new Error("partie bloquée");
    const d = await readDuel(ID);
    if (d.termine) {
      resultats[d.gagnant] = (resultats[d.gagnant] || 0) + 1;
      break;
    }
    const b = boutons(vues.at(-1)).filter((x) => x.custom_id.startsWith("potatoduel_chauffer"));
    if (b.length !== 3) throw new Error("3 boutons de chauffe attendus");
    if (d.evenement?.id === "joueur") {
      evenementsVus.add(d.evenement.type);
      if (!texte(vues.at(-1)).includes("**")) throw new Error("ligne de l'événement absente");
    }
    await h.handlePotatoChauffer(W, ID, auHasard(d, "joueur"), d.vue, opts);
    actions++;
  }
}
const posts = salon.filter((m) => m.method === "POST");
console.log(`Contre Kévina : 10 parties ${JSON.stringify(resultats)}, ${actions} chauffes du joueur, ${posts.length} messages publiés`);
if (posts.length !== 20) throw new Error("message public et résultat attendus pour chaque partie");
if (!salon.some((m) => m.method === "PATCH" && texte(m).includes("Kévina réfléchit"))) throw new Error("message public non suivi");
if (!vues.some((v) => texte(v).includes("💥 La patate"))) throw new Error("explosion jamais racontée");

console.log(`Événements vus par le joueur : ${[...evenementsVus].join(", ")}`);

// Vue dépassée, chauffe inconnue : partie intacte
await h.handlePotatoCommand(W, lancement);
const d0 = await readDuel(ID);
await h.handlePotatoChauffer(W, ID, 0, 999, opts);
if (!texte(vues.at(-1)).includes("La patate a changé")) throw new Error("clic sur une vue dépassée accepté");
await h.handlePotatoChauffer(W, ID, 7, d0.vue, opts);
if ((await readDuel(ID)).vue !== d0.vue) throw new Error("chauffe interdite jouée");

// Délai dépassé contre Kévina : défaite publiée au clic suivant
{
  const d = await readDuel(ID);
  await new Redis({}).set(`potatoduel:${ID}`, JSON.stringify({ ...d, tourDepuis: Date.now() - 120_000 }));
  await h.handlePotatoChauffer(W, ID, 0, d.vue, opts);
  if (!texte(salon.at(-1)).includes("n'a pas joué à temps")) throw new Error("délai dépassé contre Kévina non publié");
  if (!(await readDuel(ID)).delai) throw new Error("délai contre Kévina non enregistré");
}

// ── 1v1 ──
const body = (id, nom) => ({ member: { user: { id, username: nom } }, channel_id: "salon" });
await h.handlePotatoPvpCommand("https://discord.test/a", body("A", "Alice"));
await h.handlePotatoOuvrir("https://discord.test/b", body("B", "Bob"));
await h.handlePotatoOuvrir("https://discord.test/c", body("C", "Chloé"));
if (!texte(vues.at(-1)).includes("Ce duel oppose")) throw new Error("3e joueur non refusé");
for (let k = 0; ; k++) {
  if (k > 300) throw new Error("1v1 bloqué");
  const p = await readPvp();
  if (p.statut === "fini") {
    console.log(`1v1 : fini (${p.raisonFin}), gagnant ${p.duel.gagnant}, manches ${JSON.stringify(p.duel.manches)}`);
    if (!editionsFollowup) throw new Error("vue du lanceur (followup) jamais mise à jour");
    break;
  }
  const actif = p.sieges[p.duel.actif];
  const autre = actif === "A" ? "B" : "A";
  // Clic hors tour : refusé sans effet
  await h.handlePotatoChauffer(`https://discord.test/${autre.toLowerCase()}`, autre, 0, p.duel.vue, { pvp: true });
  if ((await readPvp()).duel.vue !== p.duel.vue) throw new Error("chauffe hors tour acceptée");
  await h.handlePotatoChauffer(`https://discord.test/${actif.toLowerCase()}`, actif, auHasard(p.duel, p.duel.actif), p.duel.vue, { pvp: true });
}

// ── Abandon (🏳️ puis confirmation) ──
await h.handlePotatoCommand(W, lancement);
await h.handlePotatoAbandon(W, ID, "demande", opts);
if (!texte(vues.at(-1)).includes("Abandonner la partie ?")) throw new Error("confirmation d'abandon absente");
await h.handlePotatoAbandon(W, ID, "non", opts);
if (!imageDe(vues.at(-1))) throw new Error("Annuler ne rend pas la vue");
await h.handlePotatoAbandon(W, ID, "ok", opts);
if (!(await readDuel(ID)).abandon) throw new Error("abandon contre Kévina non enregistré");
if (!texte(salon.at(-1)).includes("abandonne face à Kévina")) throw new Error("abandon contre Kévina non publié");

vues.forEach((v) => verifier(v));
salon.forEach((m) => verifier(m, { public: true }));
await h.handlePotatoRegles(W);
verifier(vues.at(-1));
console.log(`${vues.length} vues et ${salon.length} messages de salon conformes`);

const exemple = vues.find((v) => texte(v).includes("Kévina chauffe") && boutons(v).some((b) => b.custom_id.startsWith("potatoduel_chauffer")));
console.log("\n--- Vue contre Kévina ---\n" + texte(exemple));
console.log("Boutons : " + boutons(exemple).map((b) => `[${b.emoji?.name ?? ""} ${b.label ?? ""}]`).join(" "));
console.log("Image : " + JSON.stringify(decodeVue(new URL(imageDe(exemple)).searchParams.get("d"))));
const evenement = vues.find((v) => imageDe(v) && decodeVue(new URL(imageDe(v)).searchParams.get("d"))?.evenement);
if (evenement) console.log("Image avec événement : " + JSON.stringify(decodeVue(new URL(imageDe(evenement)).searchParams.get("d"))));
const fin = vues.find((v) => texte(v).includes("💥 La patate"));
console.log("\n--- Explosion (vue) ---\n" + texte(fin));
const pub = salon.find((m) => m.method === "PATCH" && texte(m).includes("chauffe"));
console.log("\n--- Message public ---\n" + texte(pub));
console.log("Image : " + JSON.stringify(decodePublic(new URL(imageDe(pub)).searchParams.get("d"))));
const recapSolo = salon.find((m) => m.method === "POST" && /bat (Kévina|Testeur)/.test(texte(m)));
console.log("\n--- Récap contre Kévina ---\n" + texte(recapSolo));
if (!imageDe(recapSolo)?.includes("/api/potato/public")) throw new Error("image du résultat absente");
console.log("Image : " + JSON.stringify(decodePublic(new URL(imageDe(recapSolo)).searchParams.get("d"))));
console.log("\n--- Récap 1v1 ---\n" + texte(salon.filter((m) => m.method === "POST" && texte(m).includes("Alice")).at(-1)));
console.log("\n--- Règles ---\n" + texte(vues.at(-1)));
