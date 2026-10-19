// Mesure le temps avant la première réponse pour /stats-clan (pas d'envoi Discord réel)
import "dotenv/config";
const { routeAdmin } = await import("../api/discord/_routes/admin.js");
const { routeJoueur } = await import("../api/discord/_routes/joueur.js");
const { routeClan } = await import("../api/discord/_routes/clan.js");
globalThis.fetch = async (u) => { console.log("fetch", String(u).slice(0,80)); return new Response("{}", {status: 500}); };
const body = { type: 2, token: "x", guild_id: "1", data: { name: "stats-clan", options: [{ name: "clan", value: "1" }] }, member: { user: { id: "1" }, roles: [] } };
const res = { headersSent: false, status(c) { this.c = c; return this; }, json(p) { this.headersSent = true; console.log("RESP", this.c, JSON.stringify(p).slice(0,200), Date.now() - t0, "ms"); return this; }, end() { this.headersSent = true; } };
const t0 = Date.now();
for (const r of [routeAdmin, routeJoueur, routeClan]) { await r(body, res, { authorizedPingIds: new Set() }); console.log(r.name, Date.now() - t0, "ms", res.headersSent); if (res.headersSent) break; }
setTimeout(() => process.exit(0), 3000);
