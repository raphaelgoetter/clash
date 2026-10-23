import assert from "assert";
import { Redis } from "@upstash/redis";
import * as concept from "./concept.js";

// Ce test écrit dans Redis : il ne doit jamais tourner sur l'Upstash de prod.
if (!Redis.isFake) {
  throw new Error("concept.test.js doit être lancé via `npm test` (Redis en mémoire), jamais directement");
}

console.log("Running concept tests...");

// Validation en mots entiers, accents/casse/ponctuation/ligatures ignorés.
const up = { accepte: ["Là-haut", "Up"] };
assert.strictEqual(concept.checkAnswer(up, "up"), true);
assert.strictEqual(concept.checkAnswer(up, "Le film Là-Haut !"), true);
assert.strictEqual(concept.checkAnswer(up, "supermarché"), false, "« up » ne valide pas un mot qui le contient");
const oeuf = { accepte: ["oeuf ou la poule"] };
assert.strictEqual(concept.checkAnswer(oeuf, "L'œuf ou la poule"), true, "ligature œ");
assert.strictEqual(concept.checkAnswer({ accepte: ["Ch'tis", "Chtis"] }, "bienvenue chez les chtis"), true);
assert.strictEqual(concept.checkAnswer({ accepte: ["Pandore"], refuse: ["boite"] }, "boîte de Pandore"), false, "refuse prioritaire");
assert.strictEqual(concept.checkAnswer(up, "   "), false);
console.log("✓ vérification des réponses");

// Masque de la réponse (indice).
assert.deepStrictEqual(concept.buildMasque("Forrest Gump"), { masque: "_ _ _ _ _ _ _   _ _ _ _", lettres: [7, 4] });
assert.deepStrictEqual(concept.buildMasque("S.O.S. Fantômes"), { masque: "_ . _ . _ .   _ _ _ _ _ _ _ _", lettres: [3, 8] });
assert.deepStrictEqual(concept.buildMasque("Bienvenue chez les Ch'tis").lettres, [9, 4, 3, 5]);
console.log("✓ masque");

// Barème de Frame avec un seul indice, plancher 1.
assert.strictEqual(concept.computeScore(0, false), 10);
assert.strictEqual(concept.computeScore(0, true), 7);
assert.strictEqual(concept.computeScore(2, true), 3);
assert.strictEqual(concept.computeScore(9, true), 1);
console.log("✓ barème");

// Catalogue : numero = position, chaque entrée jouable.
const catalogue = await concept.loadConcepts();
catalogue.forEach((q, i) => {
  assert.strictEqual(q.numero, i + 1, `numero ${q.numero}`);
  assert.ok(q.emojis && q.categorie && q.reponse && q.solution && q.accepte.length > 0, `entrée ${q.numero}`);
  assert.ok(concept.checkAnswer(q, q.solution), `la solution du n° ${q.numero} doit être acceptée`);
});
const ids = catalogue.map(concept.gameIdFor);
assert.strictEqual(new Set(ids).size, ids.length, "gameId uniques");
console.log("✓ catalogue valide");

// Manche complète : indice, tentative ratée, résolution, archive.
const { state, entry } = await concept.startNewGame("salon-test");
assert.strictEqual(state.gameId, "c001");
assert.strictEqual((await concept.recordHintUsed("c001", "u1", "u1")).alreadyUsed, false);
assert.strictEqual((await concept.recordHintUsed("c001", "u1", "u1")).alreadyUsed, true);
await concept.recordAttempt("c001", "u1", "u1");
const { participant, score } = await concept.markSolved("c001", "u1", "u1");
assert.strictEqual(score, 5, "10 - 2 (1 erreur) - 3 (indice)");
await concept.archiveSolve(state, entry, "u1", "u1", score, participant.solvedAt);
await concept.archiveSolve(state, entry, "u1", "u1", score, participant.solvedAt); // double soumission
const { score: s2, participant: p2 } = await concept.markSolved("c001", "u2", "u2");
await concept.archiveSolve(state, entry, "u2", "u2", s2, p2.solvedAt);
const ranking = await concept.computeSeasonRanking(state.seasonId);
assert.deepStrictEqual(ranking.map((r) => [r.discordId, r.totalScore]), [["u2", 10], ["u1", 5]]);
assert.strictEqual(await concept.hasPlayerInteracted("c001", "u1"), true);
console.log("✓ manche complète");

// Manche suivante : purge de la progression, archives conservées.
const suivante = await concept.startNewGame("salon-test");
assert.strictEqual(suivante.state.gameId, "c002");
assert.strictEqual(await concept.readParticipant("c001", "u1"), null);
assert.strictEqual((await concept.getAllArchivedResults()).length, 2);

await concept.resetGame();
assert.strictEqual(await concept.readState(), null);
assert.strictEqual((await concept.getAllArchivedResults()).length, 0);
console.log("✓ manche suivante et remise à zéro");
