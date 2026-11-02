// Test de bout en bout du handler de Mascarade (contre Kévina et 1v1), sur
// Redis en mémoire ; TOUS les appels Discord sont interceptés (aucun message
// réel). Vérifie les limites Discord des vues et affiche des exemples.
// Usage : node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/mascarade/e2eDuel.mjs
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

const h = await import("../../discord/handlers/mascaradeDuel.js");
const { readDuel, readPvp } = await import("../../services/mascaradeDuel.js");
const { cartesJouables, COUTS_ANNONCE } = await import("../../services/mascaradeRules.js");
const { decodeTable } = await import("../../services/mascaradeImage.js");

function aplatir(composants = []) {
  return composants.flatMap((c) => (c.type === 17 ? [c, ...aplatir(c.components)] : c.type === 1 ? [c, ...c.components] : [c]));
}
const texte = (v) => aplatir(v.components).filter((c) => c.type === 10).map((c) => c.content).join("\n");
const rangees = (v) => aplatir(v.components).filter((c) => c.type === 1);
const boutons = (v) => rangees(v).flatMap((r) => r.components);
const imageDe = (v) => aplatir(v.components).find((c) => c.type === 12)?.items[0].media.url ?? null;

function verifier(v) {
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
    const t = decodeTable(new URL(url).searchParams.get("d"));
    if (!t) throw new Error(`image illisible : ${url}`);
  }
}

// Action au hasard du siège `moi` : choix en attente, sinon une carte
// jouable (Boule de feu : coût au hasard, après la vue du choix du coût).
async function jouerAuHasard(W, discordId, d, moi, opts) {
  const v = d.vue;
  if (d.attente) {
    const choix = d.attente.type === "squelettes" ? (Math.random() < 0.5 ? "laisser" : "dessous") : String(Math.floor(Math.random() * 2));
    await h.handleMascaradeAction(W, discordId, "choix", choix, v, opts);
    return;
  }
  const cs = cartesJouables(d, moi);
  const carte = cs[Math.floor(Math.random() * cs.length)];
  await h.handleMascaradeAction(W, discordId, "jouer", carte, v, opts);
  if (carte === "bdf") {
    if (!texte(vues.at(-1)).includes("Quel coût")) throw new Error("choix du coût absent");
    await h.handleMascaradeAction(W, discordId, "bdf", String(COUTS_ANNONCE[Math.floor(Math.random() * COUTS_ANNONCE.length)]), v, opts);
  }
}

// ── Contre Kévina ──
const ID = "joueur-e2e";
const W = "https://discord.test/webhook";
const lancement = { member: { user: { id: ID, username: "Testeur" } }, channel_id: "salon" };
const opts = { channelId: "salon", pseudo: "Testeur" };
const resultats = {};
let actions = 0;
for (let g = 0; g < 4; g++) {
  await h.handleMascaradeCommand(W, lancement);
  for (let k = 0; ; k++) {
    if (k > 200) throw new Error("partie bloquée");
    const d = await readDuel(ID);
    if (d.termine) {
      resultats[d.gagnant] = (resultats[d.gagnant] || 0) + 1;
      break;
    }
    await jouerAuHasard(W, ID, d, "joueur", opts);
    actions++;
  }
}
const posts = salon.filter((m) => m.method === "POST");
console.log(`Contre Kévina : 4 parties ${JSON.stringify(resultats)}, ${actions} actions du joueur, ${posts.length} messages publiés`);
if (posts.length !== 8) throw new Error("table publique et résultat attendus pour chaque partie");
if (!salon.some((m) => m.method === "PATCH" && texte(m).includes("Kévina réfléchit"))) throw new Error("table publique non suivie");
if (!vues.some((v) => texte(v).includes("🏁 Manche"))) throw new Error("fin de manche jamais affichée");

// Vue dépassée, carte absente, Trois mousquetaires refusés : partie intacte
await h.handleMascaradeCommand(W, lancement);
const d0 = await readDuel(ID);
await h.handleMascaradeAction(W, ID, "jouer", d0.main.joueur[0], 999, opts);
if (!texte(vues.at(-1)).includes("La table a changé")) throw new Error("clic sur une vue dépassée accepté");
const absente = Object.keys((await import("../../services/mascaradeRules.js")).CARTES).find((c) => !d0.main.joueur.includes(c) && c !== "bdf");
await h.handleMascaradeAction(W, ID, "jouer", absente, d0.vue, opts);
if (!texte(vues.at(-1)).includes("Tu n'as pas cette carte")) throw new Error("carte absente acceptée");
if ((await readDuel(ID)).vue !== d0.vue) throw new Error("coup interdit joué");
// Retour depuis le choix du coût
await h.handleMascaradeAction(W, ID, "retour", null, d0.vue, opts);
if (!texte(vues.at(-1)).includes("joue une de tes deux cartes")) throw new Error("retour à la vue normale absent");

// ── 1v1 ──
const body = (id, nom) => ({ member: { user: { id, username: nom } }, channel_id: "salon" });
await h.handleMascaradePvpCommand("https://discord.test/a", body("A", "Alice"));
await h.handleMascaradeOuvrir("https://discord.test/b", body("B", "Bob"));
await h.handleMascaradeOuvrir("https://discord.test/c", body("C", "Chloé"));
if (!texte(vues.at(-1)).includes("Ce duel oppose")) throw new Error("3e joueur non refusé");
for (let k = 0; ; k++) {
  if (k > 300) throw new Error("1v1 bloqué");
  const p = await readPvp();
  if (p.statut === "fini") {
    console.log(`1v1 : fini (${p.raisonFin}), gagnant ${p.duel.gagnant}, manches ${JSON.stringify(p.duel.manches)}`);
    if (!editionsFollowup) throw new Error("vue du lanceur (followup) jamais mise à jour");
    break;
  }
  const qui = p.duel.attente ? p.duel.attente.id : p.duel.actif;
  const actif = p.sieges[qui];
  const autre = actif === "A" ? "B" : "A";
  // Clic hors tour : refusé sans effet
  const carteAutre = p.duel.main[qui === "joueur" ? "bot" : "joueur"][0];
  await h.handleMascaradeAction(`https://discord.test/${autre.toLowerCase()}`, autre, "jouer", carteAutre, p.duel.vue, { pvp: true });
  if ((await readPvp()).duel.vue !== p.duel.vue) throw new Error("coup hors tour accepté");
  await jouerAuHasard(`https://discord.test/${actif.toLowerCase()}`, actif, p.duel, qui, { pvp: true });
}

// ── Abandon (🏳️ puis confirmation) ──
await h.handleMascaradeCommand(W, lancement);
await h.handleMascaradeAbandon(W, ID, "demande", opts);
if (!texte(vues.at(-1)).includes("Abandonner la partie ?")) throw new Error("confirmation d'abandon absente");
await h.handleMascaradeAbandon(W, ID, "non", opts);
if (!imageDe(vues.at(-1))) throw new Error("Annuler ne rend pas la table");
await h.handleMascaradeAbandon(W, ID, "ok", opts);
if (!(await readDuel(ID)).abandon) throw new Error("abandon contre Kévina non enregistré");
if (!texte(salon.at(-1)).includes("abandonne face à Kévina")) throw new Error("abandon contre Kévina non publié");

vues.forEach(verifier);
salon.forEach(verifier);
await h.handleMascaradeRegles(W);
verifier(vues.at(-1));
console.log(`${vues.length} vues et ${salon.length} messages de salon conformes`);

const exemple = vues.find((v) => texte(v).includes("Kévina joue") && boutons(v).some((b) => b.custom_id.startsWith("mascaradeduel_jouer")));
console.log("\n--- Vue contre Kévina ---\n" + texte(exemple));
console.log("Boutons : " + boutons(exemple).map((b) => `[${b.label ?? b.emoji?.name}${b.disabled ? " (grisé)" : ""}]`).join(" "));
console.log("Image : " + JSON.stringify(decodeTable(new URL(imageDe(exemple)).searchParams.get("d"))));
const fin = vues.find((v) => texte(v).includes("🏁 Manche"));
console.log("\n--- Fin de manche ---\n" + texte(fin));
const recapSolo = salon.find((m) => m.method === "POST" && /bat (Kévina|Testeur)/.test(texte(m)));
console.log("\n--- Récap contre Kévina ---\n" + texte(recapSolo));
console.log("\n--- Récap 1v1 ---\n" + texte(salon.filter((m) => m.method === "POST" && texte(m).includes("Alice")).at(-1)));
console.log("\n--- Règles ---\n" + texte(vues.at(-1)));
