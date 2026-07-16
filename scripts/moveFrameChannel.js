#!/usr/bin/env node
// moveFrameChannel.js
// Reposte la manche Frame actuellement active dans un autre salon, sans
// faire avancer la partie ni perdre aucune donnée (scores, participants,
// indices, tentatives, résultats archivés restent intacts). L'ancien
// message reste techniquement fonctionnel mais n'est plus la référence.
//
// Usage : node scripts/moveFrameChannel.js <channelId>

import dotenv from "dotenv";
dotenv.config({ path: "./.env" });

const channelId = process.argv[2];
if (!channelId) {
  console.error("Usage : node scripts/moveFrameChannel.js <channelId>");
  process.exit(1);
}

const { repostFrame } = await import("../api/discord/handlers/frames.js");

(async () => {
  try {
    const result = await repostFrame(channelId);
    console.log(
      `Manche ${result.state.currentIndex + 1} (${result.frameEntry.titre}) repostée dans ${channelId} — message ${result.message.id}.`,
    );
  } catch (err) {
    console.error("Échec :", err.message);
    process.exit(1);
  }
})();
