// Corrige le titre/footer "dimanche" -> "lundi" sur le message déjà posté
// (voir conversation : lajustecarte.js corrigé pour les prochains posts,
// mais le message en ligne doit être édité manuellement).
import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

const CHANNEL_ID = "1527252707730133082";
const MESSAGE_ID = "1551659772200099883";
const token = process.env.DISCORD_TOKEN;

if (!token) {
  console.error("DISCORD_TOKEN manquant dans .env");
  process.exit(1);
}

const getRes = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, {
  headers: { Authorization: `Bot ${token}` },
});
if (!getRes.ok) {
  console.error("Échec GET :", getRes.status, await getRes.text());
  process.exit(1);
}
const message = await getRes.json();
const embed = message.embeds?.[0];
if (!embed) {
  console.error("Aucun embed trouvé sur ce message.");
  process.exit(1);
}

console.log("Titre actuel :", embed.title);
console.log("Footer actuel :", embed.footer?.text);

const correctedEmbed = {
  ...embed,
  title: embed.title.replace("Le jeu du dimanche", "Le jeu du lundi"),
  footer: embed.footer ? { ...embed.footer, text: "Nouvelle manche : lundi prochain !" } : embed.footer,
};

console.log("Nouveau titre :", correctedEmbed.title);
console.log("Nouveau footer :", correctedEmbed.footer?.text);

const patchRes = await fetch(`https://discord.com/api/v10/channels/${CHANNEL_ID}/messages/${MESSAGE_ID}`, {
  method: "PATCH",
  headers: {
    Authorization: `Bot ${token}`,
    "Content-Type": "application/json",
  },
  body: JSON.stringify({ embeds: [correctedEmbed] }),
});

if (!patchRes.ok) {
  console.error("Échec PATCH :", patchRes.status, await patchRes.text());
  process.exit(1);
}

console.log("Message corrigé avec succès.");
