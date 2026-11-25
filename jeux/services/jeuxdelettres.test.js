import assert from "assert";
import { getActiveLetterGame } from "./jeuxdelettres.js";

// Jeux de mots : rien avant la bascule (novembre 2026 = 138), puis Concept
// et Pêle-mêle une saison sur deux (voir refonte.test.js pour tous les groupes).
assert.strictEqual(getActiveLetterGame(137), null);
assert.strictEqual(getActiveLetterGame(138), "concept");
assert.strictEqual(getActiveLetterGame(139), "pelemele");
assert.strictEqual(getActiveLetterGame(140), "concept");

console.log("✓ jeuxdelettres service tests passed");
