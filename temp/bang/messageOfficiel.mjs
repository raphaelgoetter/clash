// Lecture seule : pièces jointes et image de l'embed du message officiel Bang!
import dotenv from "dotenv";
dotenv.config();
const { readState } = await import("../../backend/services/bang.js");
const s = await readState();
const m = await fetch(`https://discord.com/api/v10/channels/${s.channelId}/messages/${s.messageId}`, { headers: { Authorization: `Bot ${process.env.DISCORD_TOKEN}` } }).then(r => r.json());
console.log(m.embeds?.length, "embed(s) ; image :", m.embeds?.[0]?.image?.url?.slice(0, 100));
console.log("pièces jointes :", m.attachments?.map(a => `${a.filename} ${a.url.slice(0, 90)}`));
