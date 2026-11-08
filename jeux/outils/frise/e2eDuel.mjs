// Test de bout en bout du handler de Frise (contre Kévina et 1v1), sur Redis
// en mémoire ; TOUS les appels Discord sont interceptés (aucun message
// réel). Vérifie les limites Discord des vues et affiche des exemples.
// Usage : node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/frise/e2eDuel.mjs
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
// Pauses instantanées (réflexion de Kévina, surveillance du délai 1v1)
const setTimeoutReel = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...args) => setTimeoutReel(fn, 0, ...args);

const h = await import("../../discord/handlers/friseDuel.js");
const { readDuel, readPvp } = await import("../../services/friseDuel.js");
const { creneauJuste, nbCreneaux } = await import("../../services/friseRules.js");

// Joueur simulé : bon créneau avec une probabilité `p`, sinon au hasard
function coupSimule(d, moi, p = 0.6) {
  const index = Math.floor(Math.random() * d.mains[moi].length);
  const annee = d.mains[moi][index].annee;
  const bons = [...Array(nbCreneaux(d)).keys()].filter((i) => creneauJuste(d, i, annee));
  const creneau = Math.random() < p ? bons[0] : Math.floor(Math.random() * nbCreneaux(d));
  return { index, creneau };
}

function aplatir(composants = []) {
  return composants.flatMap((c) => (c.type === 17 ? [c, ...aplatir(c.components)] : c.type === 1 ? [c, ...c.components] : [c]));
}
const texte = (v) => aplatir(v.components).filter((c) => c.type === 10).map((c) => c.content).join("\n");
const rangees = (v) => aplatir(v.components).filter((c) => c.type === 1);
const menus = (v) => aplatir(v.components).filter((c) => c.type === 3);

function verifier(v) {
  if (!(v.flags & (1 << 15))) throw new Error("message hors Components V2");
  if ("content" in v || "embeds" in v) throw new Error("content/embeds interdits en Components V2");
  if (texte(v).length > 4000) throw new Error(`texte > 4000 (${texte(v).length})`);
  if (aplatir(v.components).length > 40) throw new Error(`${aplatir(v.components).length} composants > 40`);
  for (const row of rangees(v)) {
    if (row.components.length > 5) throw new Error("> 5 composants");
    if (row.components.some((c) => c.type === 3) && row.components.length !== 1) throw new Error("menu non seul dans sa rangée");
    for (const c of row.components) {
      if (c.custom_id.length > 100) throw new Error("custom_id > 100");
      if (c.type === 2 && !c.label && !c.emoji) throw new Error("bouton sans libellé ni emoji");
      if (c.type === 3) {
        if (!c.options.length || c.options.length > 25) throw new Error(`menu à ${c.options.length} options`);
        if (c.placeholder && c.placeholder.length > 150) throw new Error("placeholder > 150");
        for (const o of c.options) {
          if (o.label.length > 100 || (o.description ?? "").length > 100) throw new Error("option > 100");
        }
        if (new Set(c.options.map((o) => o.value)).size !== c.options.length) throw new Error("valeurs en double");
      }
    }
  }
}

// ── Contre Kévina ──
const ID = "joueur-e2e";
const W = "https://discord.test/webhook";
const lancement = { member: { user: { id: ID, username: "Testeur" } }, channel_id: "salon" };
const opts = { channelId: "salon", pseudo: "Testeur" };
const resultats = {};
let coups = 0;
let friseMax = 0;
for (let g = 0; g < 20; g++) {
  await h.handleFriseCommand(W, lancement);
  for (let k = 0; ; k++) {
    if (k > 200) throw new Error("partie bloquée");
    const d = await readDuel(ID);
    friseMax = Math.max(friseMax, d.frise.length);
    if (d.termine) {
      resultats[d.gagnant] = (resultats[d.gagnant] || 0) + 1;
      break;
    }
    const { index, creneau } = coupSimule(d, "joueur");
    await h.handleFriseChoisir(W, ID, index, d.vue);
    await h.handleFrisePlacer(W, ID, creneau, d.vue, opts);
    coups++;
  }
}
const posts = salon.filter((m) => m.method === "POST");
console.log(`Contre Kévina (joueur à 60 % de bons coups) : 20 parties ${JSON.stringify(resultats)}, ${coups} coups, frise max ${friseMax} cartes`);
if (posts.length !== 40) throw new Error("message public et résultat attendus pour chaque partie");
if (!salon.some((m) => m.method === "PATCH" && texte(m).includes("Kévina réfléchit"))) throw new Error("message public non suivi");

// Choix de carte : ▶️ sur la carte choisie ; vue dépassée refusée
await h.handleFriseCommand(W, lancement);
const d0 = await readDuel(ID);
await h.handleFriseChoisir(W, ID, 2, d0.vue);
if ((await readDuel(ID)).choix.joueur !== 2) throw new Error("choix de carte non enregistré");
if (!texte(vues.at(-1)).includes(`▶️ ${d0.mains.joueur[2].libelle}`)) throw new Error("carte choisie non marquée");
await h.handleFrisePlacer(W, ID, 0, 999, opts);
if (!texte(vues.at(-1)).includes("La frise a changé")) throw new Error("vue dépassée acceptée");
if ((await readDuel(ID)).vue !== d0.vue) throw new Error("coup d'une vue dépassée joué");
// Créneau hors frise : refusé
await h.handleFrisePlacer(W, ID, 99, d0.vue, opts);
if ((await readDuel(ID)).vue !== d0.vue) throw new Error("créneau invalide joué");

// Frise longue (> 25 créneaux) : créneaux répartis sur plusieurs menus
{
  const { Redis: R } = await import("@upstash/redis");
  const r = new R({ url: "x", token: "x", automaticDeserialization: false });
  const d = await readDuel(ID);
  d.frise = Array.from({ length: 30 }, (_, k) => ({ libelle: `Carte ${k}`, annee: 1000 + 10 * k }));
  await r.set(`friseduel:${ID}`, JSON.stringify(d));
  await h.handleFriseChoisir(W, ID, 0, d.vue);
  const m = menus(vues.at(-1));
  if (m.length !== 3 || m[1].options.length + m[2].options.length !== 31) throw new Error("créneaux mal répartis");
  verifier(vues.at(-1));
}

// ── 1v1 ──
const body = (id, nom) => ({ member: { user: { id, username: nom } }, channel_id: "salon" });
await h.handleFrisePvpCommand("https://discord.test/a", body("A", "Alice"));
await h.handleFriseOuvrir("https://discord.test/b", body("B", "Bob"));
await h.handleFriseOuvrir("https://discord.test/c", body("C", "Chloé"));
if (!texte(vues.at(-1)).includes("Ce duel oppose")) throw new Error("3e joueur non refusé");
for (let k = 0; ; k++) {
  if (k > 200) throw new Error("1v1 bloqué");
  const p = await readPvp();
  if (p.statut === "fini") {
    console.log(`1v1 : fini (${p.raisonFin}), gagnant ${p.duel.gagnant}, frise de ${p.duel.frise.length} cartes`);
    if (!editionsFollowup) throw new Error("vue du lanceur (followup) jamais mise à jour");
    break;
  }
  const actif = p.sieges[p.duel.actif];
  const autre = actif === "A" ? "B" : "A";
  const url = (id) => `https://discord.test/${id === "A" ? "a" : "b"}`;
  const { index, creneau } = coupSimule(p.duel, p.duel.actif);
  // Coup hors tour : refusé sans effet
  await h.handleFrisePlacer(url(autre), autre, creneau, p.duel.vue, { pvp: true });
  if ((await readPvp()).duel.vue !== p.duel.vue) throw new Error("coup hors tour accepté");
  await h.handleFriseChoisir(url(actif), actif, index, p.duel.vue, { pvp: true });
  await h.handleFrisePlacer(url(actif), actif, creneau, p.duel.vue, { pvp: true });
}

// ── Abandon ──
await h.handleFriseCommand(W, lancement);
await h.handleFriseAbandon(W, ID, "demande", opts);
if (!texte(vues.at(-1)).includes("Abandonner la partie ?")) throw new Error("confirmation d'abandon absente");
await h.handleFriseAbandon(W, ID, "non", opts);
if (!menus(vues.at(-1)).length) throw new Error("Annuler ne rend pas les menus");
await h.handleFriseAbandon(W, ID, "ok", opts);
if (!(await readDuel(ID)).abandon) throw new Error("abandon contre Kévina non enregistré");
if (!texte(salon.at(-1)).includes("abandonne face à Kévina")) throw new Error("abandon contre Kévina non publié");

vues.forEach(verifier);
salon.forEach(verifier);
await h.handleFriseRegles(W);
verifier(vues.at(-1));
console.log(`${vues.length} vues et ${salon.length} messages de salon conformes`);

const exemple = vues.find((v) => menus(v).length >= 2 && texte(v).includes("Kévina place"));
console.log("\n--- Vue contre Kévina ---\n" + texte(exemple));
console.log("Menus :\n" + menus(exemple).map((m) => `[${m.placeholder}] ${m.options.map((o) => o.label).join(" | ")}`).join("\n"));
const recapSolo = salon.find((m) => m.method === "POST" && /bat (Kévina|Testeur)/.test(texte(m)));
console.log("\n--- Récap contre Kévina ---\n" + texte(recapSolo));
console.log("\n--- Message public 1v1 ---\n" + texte(salon.filter((m) => m.method === "PATCH" && texte(m).includes("Alice contre") || texte(m).includes("Bob contre")).at(-2) ?? {}));
console.log("\n--- Règles ---\n" + texte(vues.at(-1)));
