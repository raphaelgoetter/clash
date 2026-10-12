// Qui est-ce ? complet (présentation, 7 jours, fin) de bout en bout, Redis et
// Discord simulés. Usage : node --import ./temp/fake-redis/register.mjs temp/quiestce/e2eQuiEstCe.mjs [joueurs]
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });
process.env.DISCORD_TOKEN = "fake";

const sent = [];
const realFetch = globalThis.fetch;
globalThis.fetch = async (url, opts = {}) => {
  const u = String(url);
  if (!u.startsWith("wh") && !u.includes("discord.com") && !u.includes("trustroyale")) return realFetch(url, opts);
  const body = opts.body && typeof opts.body === "string" ? JSON.parse(opts.body) : null;
  sent.push({ url: u, method: opts.method || "GET", body });
  if (u.endsWith("/messages") && opts.method === "POST") return { ok: true, json: async () => ({ id: `msg${sent.length}` }) };
  if (u.includes("trustroyale")) return { ok: false, status: 404 };
  return { ok: true, status: 200, json: async () => ({}), text: async () => "" };
};

const H = await import("../../api/discord/_handlers/quiestce.js");
const S = await import("../../backend/services/quiestce.js");

const nb = Number(process.argv[2] || 15);
const ids = Array.from({ length: nb }, (_, i) => `u${i + 1}`);
const nom = (id) => `Joueur ${id}`;
const lastPost = () => [...sent].reverse().find((s) => s.url.endsWith("/channels/chan/messages") && s.method === "POST")?.body;
const lastEph = (id) => [...sent].reverse().find((s) => s.url === `wh-${id}/messages/@original` && s.body)?.body;

// Contrôles des limites Discord sur chaque éphémère
function verifier(e, ctx) {
  if (!e) throw new Error(`${ctx} : aucun éphémère`);
  if ((e.components || []).length > 5) throw new Error(`${ctx} : plus de 5 lignes de composants`);
  for (const row of e.components || []) {
    for (const c of row.components) {
      if (c.type === 3) {
        if (!c.options.length || c.options.length > 25) throw new Error(`${ctx} : menu ${c.custom_id} à ${c.options.length} options`);
        if (c.placeholder.length > 150) throw new Error(`${ctx} : placeholder trop long`);
        for (const o of c.options) if (o.label.length > 100 || (o.description || "").length > 100) throw new Error(`${ctx} : option trop longue`);
      }
      if (c.type === 2 && c.label.length > 80) throw new Error(`${ctx} : bouton trop long`);
    }
  }
  for (const em of e.embeds || []) if ((em.description || "").length > 4096) throw new Error(`${ctx} : description > 4096`);
}

const menu = (e, prefix) => e.components?.flatMap((r) => r.components).filter((c) => c.custom_id?.startsWith(prefix)) ?? [];

await S.resetQuiEstCe({ clearManches: true });
await H.postQuiEstCe("chan", { force: true, noPing: true });
// Inscriptions : 8 joueurs d'abord (sous le minimum de 10)
for (const id of ids.slice(0, 8)) {
  await H.handleParticiper(`wh-${id}`, id, nom(id));
  verifier(lastEph(id), `inscription ${id}`);
}
await H.handleDesinscrire("wh-u8", "u8");
console.log(`--- Désinscription de u8 : ${lastEph("u8").content}`);
// Rappel (fenêtre non close), puis clôture forcée sous le minimum : prolongation
await H.postQuiEstCe("chan", { force: true, noPing: true, pnj: false });
console.log(`--- Rappel : ${lastPost().embeds[0].description.split("\n").slice(-2).join(" / ")}`);
const prolong = await H.postQuiEstCe("chan", { force: true, noPing: true, pnj: false, forceClose: true });
console.log(`--- Prolongation : ${prolong.prolongation} · ${lastPost().embeds[0].title}\n${lastPost().embeds[0].description.split("\n")[0]}`);
for (const id of ids) await H.handleParticiper(`wh-${id}`, id, nom(id));
console.log(`--- Inscription au-delà de ${nb > 18 ? 18 : nb} : ${lastEph(ids.at(-1)).content || "acceptée"}`);
await H.postQuiEstCe("chan", { force: true, noPing: true, pnj: false, forceClose: true });
console.log(`\n===== ${lastPost().embeds[0].title} =====\n${lastPost().embeds[0].description}`);

for (let jour = 1; jour <= 7; jour++) {
  const arrives = jour === 1 ? ids : ids;
  for (const id of arrives) {
    if (Math.random() < 0.2 && id !== "u1") continue;
    await H.handleEnqueter(`wh-${id}`, id, nom(id));
    let e = lastEph(id);
    verifier(e, `enquêter ${id} J${jour}`);
    if (e.content) {
      if (jour <= 3 && id === ids.at(-1)) console.log(`--- ${id} au J${jour} : ${e.content}`);
      continue;
    }
    // Choix de cible si besoin (bouton proposé par défaut)
    const viser = menu(e, "quiestce_cible:")[0];
    if (viser) {
      await H.handleCible(`wh-${id}`, id, nom(id), viser.custom_id.split(":")[1]);
      e = lastEph(id);
      verifier(e, `cible ${id}`);
    }
    // Objet de temps en temps, depuis le menu de l'enquête
    const m = menu(e, "quiestce_objet")[0];
    if (m && !m.disabled && Math.random() < 0.4) {
      const choix = m.options[Math.floor(Math.random() * m.options.length)].value;
      await H.handleObjet(`wh-${id}`, id, nom(id), choix);
      e = lastEph(id);
      verifier(e, `objet ${choix}`);
      console.log(`--- ${id} utilise ${choix} : ${e.embeds[0].description.split("\n")[0]}`);
    }
    // Question (première option), puis accusation à 2 candidats ou moins
    for (let k = 0; k < 2; k++) {
      const q = menu(e, "quiestce_question")[0];
      if (!q) break;
      await H.handleQuestion(`wh-${id}`, id, nom(id), q.options[0].value);
      e = lastEph(id);
      verifier(e, `question ${id}`);
    }
    const acc = menu(e, "quiestce_accuser");
    const options = acc.flatMap((m) => m.options);
    if (options.length && options.length <= 2) {
      await H.handleAccuser(`wh-${id}`, id, nom(id), options[Math.floor(Math.random() * options.length)].value);
      e = lastEph(id);
      verifier(e, `accuser ${id}`);
      if (id === "u1") console.log(`--- u1 accuse ---\n${e.embeds[0].description.split("\n\n")[0]}`);
    }
    if (id === "u1" && jour === 2) console.log(`--- Enquête de u1 (J2) ---\n${e.embeds[0].description}`);
  }
  if (jour === 3) {
    await H.handleJournal("wh-u1", "u1");
    console.log(`\n===== Journal de u1 (J3) =====\n${lastEph("u1").embeds[0].description.slice(0, 1200)}`);
  }
  await H.postQuiEstCe("chan", { force: true, noPing: true, isPublic: true });
  const em = lastPost().embeds[0];
  console.log(`\n===== ${em.title} =====\n${em.description}`);
}
const st = await S.readState();
console.log(`\nÉtat final : termine=${st.termine}, manches=${(await S.listManches()).length}`);
