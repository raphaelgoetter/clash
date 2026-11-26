#!/usr/bin/env node
// peleMeleDraws.js
// Complète, pour chaque thème, la file des tirages Pêle-mêle préparés à
// l'avance (jusqu'à PREPARED_DRAWS_TARGET) puis affiche, pour chaque manche
// à venir de ce thème, le nombre de noms trouvables — sans les lettres ni
// les noms, sauf avec --reveal.
//
// Usage : node jeux/scripts/peleMeleDraws.js [--reveal]

import "../env.js";

import {
  THEME_ORDER,
  refillPreparedDraws,
  listPreparedDraws,
  loadEligiblePool,
  computeValidWordsForDraw,
} from "../services/pelemele.js";

const REVEAL = process.argv.includes("--reveal");

(async () => {
  try {
    for (const theme of THEME_ORDER) {
      await refillPreparedDraws(theme);
      const [draws, pool] = await Promise.all([listPreparedDraws(theme), loadEligiblePool(theme)]);
      console.log(`\n${draws.length} tirages préparés, thème ${theme} :\n`);
      draws.forEach((draw, idx) => {
        const validWords = computeValidWordsForDraw(pool, draw.letters);
        const details = REVEAL ? ` — ${draw.letters.join("")} (${validWords.map((w) => w.fr).join(", ")})` : "";
        console.log(`${String(idx + 1).padStart(2)}. ${validWords.length} noms trouvables${details}`);
      });
    }
  } catch (err) {
    console.error("Échec de la préparation des tirages :", err.message);
    process.exit(1);
  }
})();
