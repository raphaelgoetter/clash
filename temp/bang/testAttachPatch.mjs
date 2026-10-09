// Test : PATCH d'un message avec pièce jointe de même nom — l'ancienne est-elle retirée ?
import dotenv from "dotenv";
dotenv.config();
const token = process.env.DISCORD_TOKEN, ch = process.env.DISCORD_CHANNEL_FRAME_TEST;
const png = Buffer.from(await (await fetch("https://trustroyale.vercel.app/api/bang/illustration")).arrayBuffer());
const form = (payload, name) => { const f = new FormData(); f.append("payload_json", JSON.stringify(payload)); f.append("files[0]", new Blob([png]), name); return f; };
const api = (u, m, body) => fetch(`https://discord.com/api/v10${u}`, { method: m, headers: { Authorization: `Bot ${token}` }, body }).then(r => r.json());
const mode = process.argv[2];
const msg = await api(`/channels/${ch}/messages`, "POST", form({ embeds: [{ title: "test", image: { url: "attachment://plateau.png" } }], attachments: [{ id: 0, filename: "plateau.png" }] }, "plateau.png"));
console.log("POST", msg.attachments?.map(a => a.id + " " + a.filename));
const name = mode === "unique" ? "plateau-2.png" : "plateau.png";
const ed = await api(`/channels/${ch}/messages/${msg.id}`, "PATCH", form({ embeds: [{ title: "test2", image: { url: `attachment://${name}` } }], attachments: [{ id: 0, filename: name }] }, name));
console.log("PATCH", ed.attachments?.map(a => a.id + " " + a.filename), ed.embeds?.[0]?.image?.url?.slice(0, 90));
await fetch(`https://discord.com/api/v10/channels/${ch}/messages/${msg.id}`, { method: "DELETE", headers: { Authorization: `Bot ${token}` } });
