import assert from "assert";
import { determineWinningChoix } from "./aventure.js";

async function main() {
  const choix = [
    { id: "option_a", label: "Poser un PEKKA", prochain_chapitre: "chapitre_2a" },
    { id: "option_b", label: "Inspecter l'élément", prochain_chapitre: "chapitre_2b" },
    { id: "option_c", label: "Fuir", prochain_chapitre: "chapitre_2c" },
  ];

  // Vainqueur net
  assert.strictEqual(
    determineWinningChoix(choix, { option_a: 2, option_b: 5, option_c: 1 }).id,
    "option_b",
  );

  // Égalité entre deux choix — le premier du tableau (dans l'ordre d'apparition) gagne
  assert.strictEqual(
    determineWinningChoix(choix, { option_a: 3, option_b: 3, option_c: 0 }).id,
    "option_a",
  );

  // Égalité entre le 2e et le 3e choix (le 1er n'a aucun vote) — toujours l'ordre d'apparition
  assert.strictEqual(
    determineWinningChoix(choix, { option_b: 4, option_c: 4 }).id,
    "option_b",
  );

  // Zéro vote partout — égalité totale, le premier choix du tableau gagne par défaut
  assert.strictEqual(determineWinningChoix(choix, {}).id, "option_a");

  // Chapitre final (aucun choix) — pas de vainqueur
  assert.strictEqual(determineWinningChoix([], { option_a: 3 }), null);
  assert.strictEqual(determineWinningChoix(undefined, {}), null);

  console.log("✓ aventure service tests passed");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
