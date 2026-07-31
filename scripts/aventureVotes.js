#!/usr/bin/env node
// aventureVotes.js
// Affiche le décompte des votes du chapitre actif de l'Aventure interactive,
// sans avoir besoin d'ouvrir Discord — pratique pour suivre l'avancement
// avant de décider de relancer manuellement `npm run aventure:public`.
//
// Usage : node scripts/aventureVotes.js

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

import { loadHistoire, readState, assignJourNumber, listVotes } from "../backend/services/aventure.js";

// Même pattern que les résolutions de pseudo déjà utilisées ailleurs dans
// api/discord/interactions.js (ex: /late-ping) : un seul appel groupé,
// jamais un appel par membre.
async function fetchGuildMembersById() {
  const guildId = process.env.DISCORD_GUILD_ID;
  const botToken = process.env.DISCORD_TOKEN;
  if (!guildId || !botToken) return new Map();
  try {
    const res = await fetch(
      `https://discord.com/api/v10/guilds/${guildId}/members?limit=1000`,
      { headers: { Authorization: `Bot ${botToken}` } },
    );
    const members = res.ok ? await res.json() : [];
    return new Map(members.map((m) => [m.user?.id, m]));
  } catch {
    return new Map();
  }
}

(async () => {
  const state = await readState();
  if (!state) {
    console.log("Aucune aventure active pour le moment.");
    return;
  }
  if (state.termine) {
    console.log("L'aventure est déjà terminée (chapitre final atteint).");
    return;
  }

  const histoire = await loadHistoire();
  const chapitreEntry = histoire.chapitres[state.chapitreId];
  const jour = await assignJourNumber(state.chapitreId);
  const votes = await listVotes(state.chapitreId);

  // Les votes enregistrés avant l'ajout du stockage du pseudo (ou dont le
  // pseudo n'a pour une raison ou une autre pas été sauvegardé) n'ont pas
  // de username en base — on les résout ici via l'API Discord (liste des
  // membres du serveur), sans jamais réécrire les votes existants.
  const missing = votes.filter((v) => !v.username);
  if (missing.length > 0) {
    const memberById = await fetchGuildMembersById();
    for (const v of missing) {
      const member = memberById.get(v.discordId);
      v.username =
        member?.nick || member?.user?.global_name || member?.user?.username || v.discordId;
    }
  }

  console.log(`${chapitreEntry.titre} (jour ${jour})\n`);

  if (!chapitreEntry.choix?.length) {
    console.log("Ce chapitre n'a pas de choix (chapitre final).");
    return;
  }

  for (const c of chapitreEntry.choix) {
    const votants = votes.filter((v) => v.choixId === c.id);
    const label = `${c.emoji ? c.emoji + " " : ""}${c.label}`;
    console.log(`${label} — ${votants.length} vote${votants.length > 1 ? "s" : ""}`);
    if (votants.length > 0) {
      console.log(`  ${votants.map((v) => v.username).join(", ")}`);
    }
  }

  console.log(`\nTotal : ${votes.length} vote${votes.length > 1 ? "s" : ""}.`);
})();
