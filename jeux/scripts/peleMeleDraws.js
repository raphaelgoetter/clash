#!/usr/bin/env node
// peleMeleDraws.js
// Complète la file des tirages Pêle-mêle préparés à l'avance (jusqu'à
// PREPARED_DRAWS_TARGET) puis affiche, pour chaque manche à venir, le
// nombre de cartes trouvables — sans les lettres ni les cartes, sauf avec
// --reveal.
//
// Usage : node jeux/scripts/peleMeleDraws.js [--reveal]

import "../env.js";

import {
  refillPreparedDraws,
  listPreparedDraws,
  loadEligiblePool,
  computeValidWordsForDraw,
} from "../services/pelemele.js";

const REVEAL = process.argv.includes("--reveal");

(async () => {
  try {
    await refillPreparedDraws();
    const [draws, pool] = await Promise.all([listPreparedDraws(), loadEligiblePool()]);
    console.log(`${draws.length} tirages Pêle-mêle préparés :\n`);
    draws.forEach((draw, idx) => {
      const validWords = computeValidWordsForDraw(pool, draw.letters);
      const details = REVEAL ? ` — ${draw.letters.join("")} (${validWords.map((w) => w.fr).join(", ")})` : "";
      console.log(`${String(idx + 1).padStart(2)}. ${validWords.length} cartes trouvables${details}`);
    });
  } catch (err) {
    console.error("Échec de la préparation des tirages :", err.message);
    process.exit(1);
  }
})();
