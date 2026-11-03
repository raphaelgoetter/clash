// Test de bout en bout du handler du Pendu (solo et 1v1), sur Redis en mémoire ;
// TOUS les appels Discord sont interceptés (aucun message réel). Vérifie
// les limites Discord des vues, que le mot n'apparaît nulle part avant la
// fin (textes, adresses des images), et affiche des exemples.
// Usage : node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/pendu/e2eDuel.mjs
import { Redis } from "@upstash/redis";

if (!Redis.isFake) throw new Error("À lancer avec registerFakeRedis.js (voir l'en-tête)");

const vues = [];
const salon = [];
globalThis.fetch = async (url, init = {}) => {
  const u = String(url);
  if (u.startsWith("https://discord.test")) {
    if (init.body) vues.push({ url: u, ...JSON.parse(init.body) });
    if (init.method === "POST") return new Response(JSON.stringify({ id: `vue-${vues.length}` }));
  } else if (u.startsWith("https://discord.com")) {
    if (init.body) salon.push({ method: init.method, ...JSON.parse(init.body) });
    return new Response(JSON.stringify({ id: `msg-${salon.length}` }));
  } else throw new Error(`Appel réseau inattendu : ${u}`);
  return new Response("{}");
};
process.env.DISCORD_TOKEN = "faux";
// Pauses instantanées (surveillance du délai)
const setTimeoutReel = globalThis.setTimeout;
globalThis.setTimeout = (fn, _ms, ...args) => setTimeoutReel(fn, 0, ...args);

const h = await import("../../discord/handlers/penduDuel.js");
const { readPvp } = await import("../../services/penduDuel.js");
const { CONSONNES, VOYELLES } = await import("../../services/penduRules.js");

function aplatir(composants = []) {
  return composants.flatMap((c) => (c.type === 17 ? [c, ...aplatir(c.components)] : c.type === 1 ? [c, ...c.components] : [c]));
}
const texte = (v) => aplatir(v.components).filter((c) => c.type === 10).map((c) => c.content).join("\n");
const images = (v) => aplatir(v.components).filter((c) => c.type === 12).flatMap((c) => c.items.map((i) => i.media.url));
const composants = (v) => aplatir(v.components).filter((c) => c.type === 2 || c.type === 3);

function verifier(v) {
  if (!(v.flags & (1 << 15))) throw new Error("message hors Components V2");
  if ("content" in v || "embeds" in v) throw new Error("content/embeds interdits en Components V2");
  if (texte(v).length > 4000) throw new Error("texte > 4000");
  const rangees = aplatir(v.components).filter((c) => c.type === 1);
  if (rangees.length > 5) throw new Error("> 5 rangées");
  for (const row of rangees) {
    if (row.components.length > 5) throw new Error("> 5 composants");
    if (row.components.some((c) => c.type === 3) && row.components.length > 1) throw new Error("menu non seul sur sa rangée");
    for (const c of row.components) {
      if (c.custom_id.length > 100) throw new Error("custom_id > 100");
      if (c.type === 2 && !c.label && !c.emoji) throw new Error("bouton sans libellé ni emoji");
      if (c.type === 3 && (c.options.length < 1 || c.options.length > 25)) throw new Error("menu : 1 à 25 options");
    }
  }
}

// Le mot (sans accent) ne doit apparaître ni dans un texte ni dans une
// adresse d'image avant la fin de la partie
function sansFuite(v, cible) {
  const decode = images(v).map((u) => Buffer.from(new URL(u).searchParams.get("d"), "base64url").toString());
  const tout = [texte(v), ...decode].join("\n").toUpperCase().normalize("NFD").replace(/[̀-ͯ]/g, "");
  if (tout.includes(cible)) throw new Error(`mot dévoilé avant la fin : ${texte(v).slice(0, 200)}`);
}

const body = (id, nom) => ({ member: { user: { id, username: nom } }, channel_id: "salon" });
const ordre = [..."EASIRNTOULCDMPGBVHFQYXJZKW"];
const W = (id) => `https://discord.test/${id.toLowerCase()}`;

async function partie(strategie) {
  const debut = { vues: vues.length, salon: salon.length };
  await h.handlePenduPvpCommand(W("A"), body("A", "Alice"));
  await h.handlePenduOuvrir(W("B"), body("B", "Bob"));
  const p0 = await readPvp();
  const cible = p0.duel.cible;
  for (let k = 0; ; k++) {
    if (k > 80) throw new Error("partie bloquée");
    const p = await readPvp();
    if (p.statut === "fini") break;
    for (const id of ["A", "B"]) {
      const siege = Object.keys(p.sieges).find((s) => p.sieges[s] === id);
      const j = p.duel.joueurs[siege];
      if (j.fin) continue;
      await strategie(id, j, cible, k);
    }
  }
  const fin = await readPvp();
  // Avant la fin : jamais le mot
  const avantFin = [...vues.slice(debut.vues), ...salon.slice(debut.salon)].filter((v) => !texte(v).includes("Le mot était") && !texte(v).includes("Trouvé avec") && !texte(v).includes("C'est le mot"));
  for (const v of avantFin) {
    verifier(v);
    sansFuite(v, cible);
  }
  return fin;
}

// Stratégie : lettres dans l'ordre de fréquence (A propose le mot vers la fin)
const frequence = (aleaMot, opts = {}) => async (id, j, cible) => {
  const restantes = ordre.filter((l) => !j.lettres.includes(l));
  if (aleaMot && [...cible].filter((c) => j.lettres.includes(c)).length >= cible.length - 2) return h.handlePenduMot(W(id), id, cible.toLowerCase(), opts);
  // Un peu de hasard : parties différentes pour les deux joueurs
  return h.handlePenduLettre(W(id), id, Math.random() < 0.3 ? restantes[Math.floor(Math.random() * restantes.length)] : restantes[0], opts);
};

const resultats = {};
for (let g = 0; g < 6; g++) {
  const p = await partie(frequence(g % 2 === 0));
  resultats[p.duel.gagnant] = (resultats[p.duel.gagnant] || 0) + 1;
}
console.log("6 parties 1v1 :", resultats);
const finals = salon.filter((m) => m.method === "POST" && texte(m).includes("Le mot était"));
if (finals.length !== 6) throw new Error(`récapitulatif attendu pour chaque partie (${finals.length})`);
if (!images(finals[0]).some((u) => u.includes("/api/pendu/final?d="))) throw new Error("image finale absente");
console.log("\nExemple de récapitulatif :\n" + texte(finals.at(-1)));

// Boutons : voyelles et menu des consonnes, lettres jouées retirées
{
  await h.handlePenduPvpCommand(W("A"), body("A", "Alice"));
  await h.handlePenduOuvrir(W("B"), body("B", "Bob"));
  await h.handlePenduLettre(W("A"), "A", "E");
  await h.handlePenduLettre(W("A"), "A", "B");
  const v = vues.at(-1);
  const ids = composants(v).map((c) => c.custom_id);
  for (const l of VOYELLES) if (!ids.includes(`penduduel_lettre:${l}`)) throw new Error(`voyelle ${l} absente`);
  if (!composants(v).find((c) => c.custom_id === "penduduel_lettre:E").disabled) throw new Error("E joué non grisé");
  const menu = composants(v).find((c) => c.type === 3);
  if (menu.options.length !== CONSONNES.length - 1 || menu.options.some((o) => o.value === "B")) throw new Error("menu des consonnes faux");
  console.log("\nExemple de vue :\n" + texte(v));
  await h.handlePenduLettre(W("A"), "A", "E");
  if (!texte(vues.at(-1)).includes("déjà proposée")) throw new Error("lettre rejouée acceptée");
  // 3e joueur refusé
  await h.handlePenduOuvrir(W("C"), body("C", "Chloé"));
  if (!vues.at(-1).components.some((c) => c.type === 10 && c.content.includes("Ce duel oppose"))) throw new Error("3e joueur non refusé");
}

// Délai : Bob ne joue plus, pendu ; le message public le dit sans rien dévoiler
{
  const p = await readPvp();
  const bob = Object.keys(p.sieges).find((s) => p.sieges[s] === "B");
  p.duel.joueurs[bob].dernierCoupAt -= 120_000;
  await new Redis({}).set("penduduel:pvp", JSON.stringify(p));
  await h.handlePenduLettre(W("A"), "A", "A");
  const pub = salon.filter((m) => m.method === "PATCH").at(-1);
  if (!texte(pub).includes("✔️ Bob a terminé")) throw new Error("fin au délai absente du message public");
  if (!vues.some((v) => v.url === W("B") + "/messages/@original" && texte(v).includes("Temps écoulé"))) throw new Error("vue de Bob non prévenue");
  sansFuite(pub, p.duel.cible);
}

// Abandon (🏳️ puis confirmation) : défaite immédiate
{
  await h.handlePenduAbandon(W("A"), "A", "demande");
  if (!texte(vues.at(-1)).includes("Abandonner la partie")) throw new Error("confirmation absente");
  await h.handlePenduAbandon(W("A"), "A", "ok");
  const p = await readPvp();
  if (p.statut !== "fini" || p.duel.abandon === null) throw new Error("abandon non pris en compte");
  console.log("\nAbandon :", texte(salon.filter((m) => m.method === "POST").at(-1)).split("\n")[1]);
}

// ── Solo ──
{
  const { readPartie } = await import("../../services/penduDuel.js");
  const S = "S";
  const resultatsSolo = {};
  for (let g = 0; g < 4; g++) {
    await h.handlePenduSoloCommand(W(S), body(S, "Sam"));
    const cible = (await readPartie(S)).duel.cible;
    for (let k = 0; ; k++) {
      if (k > 40) throw new Error("partie solo bloquée");
      const p = await readPartie(S);
      if (p.statut === "fini") {
        resultatsSolo[p.duel.gagnant ?? "pendu"] = (resultatsSolo[p.duel.gagnant ?? "pendu"] || 0) + 1;
        break;
      }
      const v = vues.at(-1);
      if (p.duel.joueurs.joueur.lettres.length && !composants(v).some((c) => c.custom_id === "penduduel_proposer:solo")) throw new Error("boutons solo sans :solo");
      sansFuite(v, cible);
      await frequence(g % 2 === 0, { solo: true })(S, p.duel.joueurs.joueur, cible);
    }
  }
  console.log("\n4 parties solo :", resultatsSolo);
  const fin = salon.filter((m) => m.method === "POST" && texte(m).includes("en solo") && texte(m).includes("Le mot était")).at(-1);
  if (!fin) throw new Error("récapitulatif solo absent");
  console.log("Exemple de récapitulatif solo :\n" + texte(fin));
  // Ma vue solo, abandon solo
  await h.handlePenduSoloCommand(W(S), body(S, "Sam"));
  await h.handlePenduOuvrir(W(S), body(S, "Sam"), { solo: true });
  if (!texte(vues.at(-1)).includes("Pendu · solo")) throw new Error("Ma vue solo absente");
  await h.handlePenduAbandon(W(S), S, "ok", { solo: true });
  if ((await readPartie(S)).statut !== "fini") throw new Error("abandon solo non pris en compte");
  // Le 1v1 en cours n'est pas touché par le solo
  await h.handlePenduOuvrir(W("X"), body("X", "Xavier"), { solo: true });
  if (!texte(vues.at(-1)).includes("Aucune partie solo")) throw new Error("solo sans partie mal géré");
}

console.log("\ne2e Pendu OK");
