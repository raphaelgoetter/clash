import assert from "assert";
import { Redis } from "@upstash/redis";
import { parseTriviaEntry, pickNextTriviaIndex, checkAnswer, getCorrectLetter } from "./triviaEngine.js";
import * as trivia from "./trivia.js";
import * as triviaGeek from "./triviageek.js";

// Ce test écrit dans Redis : il ne doit jamais tourner sur l'Upstash de prod.
if (!Redis.isFake) {
  throw new Error("triviaEngine.test.js doit être lancé via `npm test` (Redis en mémoire), jamais directement");
}

console.log("Running triviaEngine tests...");

// Fonctions pures : la bonne réponse (« √ ») passe toujours en options[0].
const entry = parseTriviaEntry({ titre: "Titre", question: "Q ?", choices: ["a", "b √", "c", "d"] }, 7);
assert.deepStrictEqual(entry.options, ["b", "a", "c", "d"]);
assert.strictEqual(entry.id, "q007");
assert.strictEqual(entry.titre, "Titre");
assert.strictEqual(parseTriviaEntry({ question: "Q", choices: ["a √", "b", "c", "d"] }, 0).titre, null);
assert.strictEqual(pickNextTriviaIndex(null, [1, 2, 3]), 0);
assert.strictEqual(pickNextTriviaIndex({ currentIndex: 2 }, [1, 2, 3]), 0);
assert.strictEqual(checkAnswer([2, 0, 1, 3], "B"), true);
assert.strictEqual(checkAnswer([2, 0, 1, 3], "A"), false);
assert.strictEqual(getCorrectLetter([2, 3, 1, 0]), "D");
console.log("✓ parsing, tirage et vérification");

// Catalogue Trivia Geek : chaque entrée a 4 choix, une seule bonne réponse,
// un titre, une source, et `numero` = position dans le fichier.
const raw = (await import("../data/triviageek/trivia-geek.json", { with: { type: "json" } })).default;
raw.forEach((q, i) => {
  assert.strictEqual(q.numero, i + 1, `numero ${q.numero}`);
  assert.strictEqual(q.choices.length, 4, `choix q${i}`);
  assert.strictEqual(q.choices.filter((c) => /√\s*$/.test(c)).length, 1, `bonne réponse q${i}`);
  assert.ok(q.titre && q.source, `titre/source q${i}`);
});
const geekCatalog = await triviaGeek.loadTriviaCatalog();
assert.strictEqual(geekCatalog.length, raw.length);
console.log("✓ catalogue Trivia Geek valide");

// Manche complète sur Trivia Geek, sans toucher aux clés de Trivia.
const { state, order } = await triviaGeek.startNewGame("salon-test");
assert.strictEqual(state.gameId, "q000");
const bonne = getCorrectLetter(order);
const mauvaise = ["A", "B", "C", "D"].find((l) => l !== bonne);
for (const [id, lettre] of [["u1", bonne], ["u2", mauvaise]]) {
  const correct = triviaGeek.checkAnswer(order, lettre);
  const { participant, alreadyAnswered } = await triviaGeek.recordAnswer(state.gameId, id, id, lettre, correct, triviaGeek.computeScore(correct));
  assert.strictEqual(alreadyAnswered, false);
  await triviaGeek.archiveAnswer(state, geekCatalog[0], id, id, participant.score, participant.answeredAt);
}
assert.strictEqual((await triviaGeek.recordAnswer(state.gameId, "u1", "u1", mauvaise, false, 0)).alreadyAnswered, true);
const ranking = await triviaGeek.computeSeasonRanking(state.seasonId);
assert.deepStrictEqual(ranking.map((r) => [r.discordId, r.totalScore]), [["u1", 1], ["u2", 0]]);
assert.strictEqual(await triviaGeek.isGamePosted("q000"), true);
assert.strictEqual(await trivia.readState(), null, "Trivia Clash Royale intact");
assert.strictEqual((await trivia.getAllArchivedResults()).length, 0);
assert.strictEqual((await triviaGeek.getAllArchivedResults()).length, 2);
console.log("✓ manche Trivia Geek isolée de Trivia");

// Erratum : point offert à tous les participants, idempotent.
assert.strictEqual(await triviaGeek.grantErratumPoint("q000", "corrigée"), 2);
await triviaGeek.grantErratumPoint("q000", "corrigée");
const apres = await triviaGeek.computeSeasonRanking(state.seasonId);
assert.deepStrictEqual(apres.map((r) => r.totalScore), [1, 1]);
console.log("✓ erratum");

// Manche suivante : avance d'une question, nouvelle numérotation de saison.
const suivante = await triviaGeek.startNewGame("salon-test");
assert.strictEqual(suivante.state.gameId, "q001");
assert.strictEqual(suivante.state.seasonManche, 2);

await triviaGeek.resetGame();
assert.strictEqual(await triviaGeek.readState(), null);
assert.strictEqual((await triviaGeek.getAllArchivedResults()).length, 0);
console.log("✓ remise à zéro");
