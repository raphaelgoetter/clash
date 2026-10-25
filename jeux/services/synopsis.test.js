import assert from "assert";
import { Redis } from "@upstash/redis";
import * as synopsis from "./synopsis.js";

// Ce test écrit dans Redis : il ne doit jamais tourner sur l'Upstash de prod.
if (!Redis.isFake) {
  throw new Error("synopsis.test.js doit être lancé via `npm test` (Redis en mémoire), jamais directement");
}

console.log("Running synopsis tests...");

const VARIANTES = new Set([
  "Ultra-littéral",
  "Une phrase",
  "Leboncoin",
  "Gros titre",
  "Avis 1 étoile",
  "Figurant",
  "Patch notes",
  "Commentaire sportif",
  "Djeunz",
  "Enfant",
]);

// Barème de Frame (deux indices), plancher 1.
assert.strictEqual(synopsis.computeScore(0, 0), 10);
assert.strictEqual(synopsis.computeScore(1, 1), 5);
assert.strictEqual(synopsis.computeScore(0, 2), 4);
assert.strictEqual(synopsis.computeScore(9, 2), 1);
console.log("✓ barème");

// Catalogue : numero = position, chaque entrée jouable, titre accepté.
const catalogue = await synopsis.loadSynopsis();
catalogue.forEach((e, i) => {
  assert.strictEqual(e.numero, i + 1, `numero ${e.numero}`);
  assert.ok(VARIANTES.has(e.variante), `variante inconnue au n° ${e.numero} : ${e.variante}`);
  assert.ok(e.synopsis && /^\d{4}$/.test(e.indice1) && e.indice2 && e.titre, `entrée ${e.numero}`);
  assert.ok(e.accepte.length > 0 && e.accepte.every((t) => t.length >= 4), `mot-clé trop court au n° ${e.numero}`);
  assert.ok(!e.synopsis.includes("—"), `tiret cadratin au n° ${e.numero}`);
  assert.ok(synopsis.checkAnswer(e, e.titre), `le titre du n° ${e.numero} doit être accepté`);
});
const ids = catalogue.map(synopsis.gameIdFor);
assert.strictEqual(new Set(ids).size, ids.length, "gameId uniques");
assert.strictEqual(new Set(catalogue.map((e) => e.titre)).size, catalogue.length, "pas de titre en double");
console.log("✓ catalogue valide");

// Système de réponses de Frame : sous-chaîne, `refuse` prioritaire.
const shrek = catalogue.find((e) => e.titre === "Shrek");
assert.strictEqual(synopsis.checkAnswer(shrek, "c'est Shrek !"), true);
assert.strictEqual(synopsis.checkAnswer(shrek, "Shrek 2"), false);
console.log("✓ vérification des réponses");

// Manche complète : deux indices, tentative ratée, résolution, archive.
const { state, entry } = await synopsis.startNewGame("salon-test");
assert.strictEqual(state.gameId, "s001");
assert.strictEqual((await synopsis.recordHintUsed("s001", "u1", "u1", "indice1")).alreadyUsed, false);
assert.strictEqual((await synopsis.recordHintUsed("s001", "u1", "u1", "indice1")).alreadyUsed, true);
assert.strictEqual((await synopsis.recordHintUsed("s001", "u1", "u1", "indice2")).alreadyUsed, false);
await synopsis.recordAttempt("s001", "u1", "u1");
const { participant, score } = await synopsis.markSolved("s001", "u1", "u1");
assert.strictEqual(score, 2, "10 - 2 (1 erreur) - 6 (2 indices)");
await synopsis.archiveSolve(state, entry, "u1", "u1", score, participant.solvedAt);
await synopsis.archiveSolve(state, entry, "u1", "u1", score, participant.solvedAt); // double soumission
const { score: s2, participant: p2 } = await synopsis.markSolved("s001", "u2", "u2");
await synopsis.archiveSolve(state, entry, "u2", "u2", s2, p2.solvedAt);
const ranking = await synopsis.computeSeasonRanking(state.seasonId);
assert.deepStrictEqual(ranking.map((r) => [r.discordId, r.totalScore]), [["u2", 10], ["u1", 2]]);
assert.strictEqual(await synopsis.hasPlayerInteracted("s001", "u1"), true);
assert.strictEqual(await synopsis.getSynopsisLabel("s001"), entry.titre);
console.log("✓ manche complète");

// Manche suivante : purge de la progression, archives conservées.
const suivante = await synopsis.startNewGame("salon-test");
assert.strictEqual(suivante.state.gameId, "s002");
assert.strictEqual(await synopsis.readParticipant("s001", "u1"), null);
assert.strictEqual((await synopsis.getAllArchivedResults()).length, 2);

await synopsis.resetGame();
assert.strictEqual(await synopsis.readState(), null);
assert.strictEqual((await synopsis.getAllArchivedResults()).length, 0);
console.log("✓ manche suivante et remise à zéro");
