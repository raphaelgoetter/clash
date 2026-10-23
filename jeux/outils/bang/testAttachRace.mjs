// Test : deux PATCH simultanés avec pièce jointe — reste-t-il une image orpheline ?
import dotenv from "dotenv";
dotenv.config();
const token = process.env.DISCORD_TOKEN, ch = process.env.DISCORD_CHANNEL_FRAME_TEST;
const png = Buffer.from(await (await fetch("https://trustroyale.vercel.app/api/bang/illustration")).arrayBuffer());
const form = (payload) => { const f = new FormData(); f.append("payload_json", JSON.stringify({ ...payload, attachments: [{ id: 0, filename: "plateau.png" }] })); f.append("files[0]", new Blob([png]), "plateau.png"); return f; };
const api = (u, m, body) => fetch(`https://discord.com/api/v10${u}`, { method: m, headers: { Authorization: `Bot ${token}` }, body }).then(r => r.json());
const msg = await api(`/channels/${ch}/messages`, "POST", form({ embeds: [{ title: "t0", image: { url: "attachment://plateau.png" } }] }));
await Promise.all([1, 2, 3].map(i => api(`/channels/${ch}/messages/${msg.id}`, "PATCH", form({ embeds: [{ title: `t${i}`, image: { url: "attachment://plateau.png" } }] }))));
const fin = await api(`/channels/${ch}/messages/${msg.id}`, "GET");
console.log(fin.embeds?.[0]?.title, "pièces jointes visibles :", fin.attachments?.length);
await fetch(`https://discord.com/api/v10/channels/${ch}/messages/${msg.id}`, { method: "DELETE", headers: { Authorization: `Bot ${token}` } });
