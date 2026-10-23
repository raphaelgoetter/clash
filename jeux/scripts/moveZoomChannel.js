#!/usr/bin/env node
// moveZoomChannel.js
// Reposte la manche Zoom carte actuellement active dans un autre salon,
// sans faire avancer la partie ni perdre aucune donnée (scores,
// participants, indices, tentatives, résultats archivés restent intacts).
// L'ancien message reste techniquement fonctionnel mais n'est plus la
// référence.
//
// Usage : node jeux/scripts/moveZoomChannel.js <channelId>

import "../env.js";

const channelId = process.argv[2];
if (!channelId) {
  console.error("Usage : node jeux/scripts/moveZoomChannel.js <channelId>");
  process.exit(1);
}

const { repostZoom } = await import("../discord/handlers/zoom.js");

(async () => {
  try {
    const result = await repostZoom(channelId);
    console.log(`Manche ${result.state.seasonManche} repostée dans ${channelId} — message ${result.message.id}.`);
  } catch (err) {
    console.error("Échec :", err.message);
    process.exit(1);
  }
})();
