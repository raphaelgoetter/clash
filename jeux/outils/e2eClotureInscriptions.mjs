// Clôture des inscriptions à l'heure (Meow, Qui est-ce ?, Goblin Hunters),
// Redis et Discord simulés.
// Usage : node --import @clash/commun/testing/registerFakeRedis.js jeux/outils/e2eClotureInscriptions.mjs
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
process.env.DISCORD_TOKEN = "fake";
delete process.env.DISCORD_GUILD_ID;

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith("wh") && !u.includes("discord.com") && !u.includes("trustroyale")) return realFetch(url, opts);
  let body = null;
  if (typeof opts.body === "string") body = JSON.parse(opts.body);
  else if (opts.body instanceof FormData) body = JSON.parse(opts.body.get("payload_json"));
  sent.push({ url: u, method: opts.method || "GET", body });
  if (u.endsWith("/messages") && opts.method === "POST") return { ok: true, json: async () => ({ id: `msg${sent.length}` }) };
  if (u.includes("trustroyale")) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
};
console.warn = () => {};
const assert = (c, m) => { if (!c) throw new Error(m); };
const dernierPatch = () => [...sent].reverse().find((s) => s.method === "PATCH" && s.url.includes("/channels/"))?.body;
const eph = (id) => [...sent].reverse().find((s) => s.url === `wh-${id}/messages/@original`)?.body;

const JEUX = [
  { nom: "Meow", h: "../discord/handlers/meow.js", s: "../services/meow.js", reset: "resetMeow", post: "postMeow", inscrire: "handleParticiper", desinscrire: "handleDesinscrire" },
  { nom: "Qui est-ce ?", h: "../discord/handlers/quiestce.js", s: "../services/quiestce.js", reset: "resetQuiEstCe", post: "postQuiEstCe", inscrire: "handleParticiper", desinscrire: "handleDesinscrire" },
  { nom: "Goblin Hunters", h: "../discord/handlers/goblinhunters.js", s: "../services/goblinhunters.js", reset: "resetGoblinHunters", post: "postGoblinHunters", inscrire: "handleRegisterButton", desinscrire: "handleUnregisterButton" },
];

for (const jeu of JEUX) {
  const H = await import(jeu.h);
  const S = await import(jeu.s);
  for (const assez of [false, true]) {
    await S[jeu.reset]({ clearManches: true });
    await H[jeu.post]("chan", { isPublic: true, noPing: true });
    const st0 = await S.readState();
    assert(st0.openedAt, `${jeu.nom} : openedAt absent`);
    const min = (await (S.loadMeowConfig || S.loadQuiEstCeConfig || S.loadGoblinHuntersConfig)()).effectif_min;
    const n = assez ? min : min - 2;
    for (let i = 1; i <= n; i++) await H[jeu.inscrire](`wh-u${i}`, `u${i}`, `Joueur ${i}`, "fake");
    // Inscriptions encore ouvertes : rien à clôturer
    assert((await H.cloturerInscriptions()).skipped, `${jeu.nom} : clôture avant l'heure`);
    await S.writeState({ ...(await S.readState()), closingAt: new Date(Date.now() - 60_000).toISOString() });
    // Clic après l'heure : refus + message remplacé
    await H[jeu.inscrire]("wh-tard", "tard", "Retardataire", "fake");
    assert(/closes/.test(eph("tard").content), `${jeu.nom} : inscription tardive acceptée`);
    await H[jeu.desinscrire]("wh-u1", "u1", "fake");
    const e1 = eph("u1");
    assert(/closes|Aucune partie/.test(e1?.content), `${jeu.nom} : désinscription tardive acceptée (${JSON.stringify(e1)})`);
    const p = dernierPatch();
    const st = await S.readState();
    if (assez) {
      assert(st.cloture && !st.termine, `${jeu.nom} : état après clôture`);
      assert(/inscriptions closes/.test(p.embeds[0].title), `${jeu.nom} : titre clôture`);
      assert(p.components.length === 1 && p.components[0].components.length === 1, `${jeu.nom} : seul Règles attendu`);
    } else {
      assert(st.termine, `${jeu.nom} : partie non annulée`);
      assert(/annulée/.test(p.embeds[0].title) && /ouvertes du .* au .*minimum/.test(p.embeds[0].description), `${jeu.nom} : texte d'annulation`);
      assert(p.components.length === 0, `${jeu.nom} : boutons restants`);
    }
    // Deuxième passage : rien
    assert((await H.cloturerInscriptions()).skipped, `${jeu.nom} : double clôture`);
    // Cron du matin : lancement du Jour 1 si assez d'inscrits
    if (assez) {
      await S.writeState({ ...(await S.readState()), publishedAt: new Date(Date.now() - 86_400_000).toISOString() });
      const r = await H[jeu.post]("chan", { isPublic: true, noPing: true });
      assert(r.jour === 1 || r.message, `${jeu.nom} : Jour 1 non lancé`);
      assert((await S.readState()).phase !== "annonce" && (await S.readState()).phase !== "inscription", `${jeu.nom} : phase après lancement`);
    }
    console.log(`✅ ${jeu.nom} ${assez ? "(effectif atteint)" : "(annulée)"} : ${p.embeds[0].description.split("\n")[0]}`);
  }
}
