import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import * as platpays from "./platpays.js";

// Ce test écrit dans Redis : il ne doit jamais tourner sur l'Upstash de prod.
if (!Redis.isFake) {
  throw new Error("platpays.test.js doit être lancé via `npm test` (Redis en mémoire), jamais directement");
}

console.log("Running platpays tests...");

const DATA_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "jeux-visuels", "platpays");
const CONTINENTS = ["Europe", "Asie", "Afrique", "Amérique du Nord", "Amérique du Sud", "Océanie"];

// Barème : -1 par erreur, -1 (ingrédients), -3 (continent), plancher 1.
assert.strictEqual(platpays.computeScore(0, []), 10);
assert.strictEqual(platpays.computeScore(0, ["indice1"]), 9);
assert.strictEqual(platpays.computeScore(0, ["indice2"]), 7);
assert.strictEqual(platpays.computeScore(1, ["indice1", "indice2"]), 5);
assert.strictEqual(platpays.computeScore(6, ["indice1", "indice2"]), 1);
console.log("✓ barème");

// Égalité stricte après normalisation, articles de tête ignorés.
const japon = { pays: "Japon", accepte: [] };
const niger = { pays: "Niger", accepte: [] };
const usa = { pays: "États-Unis", accepte: ["usa", "etats unis d amerique"] };
assert.strictEqual(platpays.checkAnswer(japon, "japon"), true);
assert.strictEqual(platpays.checkAnswer(japon, "Le Japon !"), true);
assert.strictEqual(platpays.checkAnswer(japon, "au japon"), true);
assert.strictEqual(platpays.checkAnswer(niger, "Nigeria"), false);
assert.strictEqual(platpays.checkAnswer(usa, "etats-unis"), true);
assert.strictEqual(platpays.checkAnswer(usa, "Les États-Unis d'Amérique"), true);
assert.strictEqual(platpays.checkAnswer(usa, "  "), false);
console.log("✓ vérification des réponses");

// Catalogue (absent tant que la sélection des photos n'est pas faite).
if (!fs.existsSync(path.join(DATA_DIR, "platpays.json"))) {
  console.log("- catalogue absent : tests du catalogue et de la manche ignorés");
} else {
  const catalog = await platpays.loadPlats();
  catalog.forEach((e, i) => {
    assert.strictEqual(e.numero, i + 1, `numero ${e.numero}`);
    assert.ok(e.plat && e.pays && e.ingredients, `champs au n° ${e.numero}`);
    assert.ok(CONTINENTS.includes(e.continent), `continent au n° ${e.numero}`);
    assert.strictEqual(e.image, `${platpays.gameIdFor(e)}.webp`, `image au n° ${e.numero} (nom opaque)`);
    const webp = fs.readFileSync(path.join(DATA_DIR, "images", e.image));
    assert.strictEqual(webp.toString("ascii", 8, 12), "WEBP", `format de ${e.image}`);
    assert.ok(e.credit?.auteur && e.credit?.licence && e.credit?.source, `crédit au n° ${e.numero}`);
    assert.ok(!/ from /.test(e.credit.auteur), `lieu dans le crédit au n° ${e.numero}`);
    assert.ok(platpays.checkAnswer(e, e.pays), `n° ${e.numero}`);
  });
  assert.strictEqual(fs.readdirSync(path.join(DATA_DIR, "images")).length, catalog.length, "aucune image orpheline");
  console.log("✓ catalogue valide");

  // Manche complète : indices, tentative ratée, résolution, archive.
  assert.strictEqual(await platpays.isGamePosted("p001"), false, "anti-spoiler avant publication");
  const { state, entry } = await platpays.startNewGame("salon-test");
  assert.strictEqual(state.gameId, "p001");
  assert.strictEqual(await platpays.isGamePosted("p001"), true);
  assert.strictEqual(await platpays.isGamePosted("p002"), false);
  assert.strictEqual((await platpays.recordHintUsed("p001", "u1", "u1", "indice2")).alreadyUsed, false);
  assert.strictEqual((await platpays.recordHintUsed("p001", "u1", "u1", "indice2")).alreadyUsed, true);
  await platpays.recordAttempt("p001", "u1", "u1");
  const { participant, score } = await platpays.markSolved("p001", "u1", "u1");
  assert.strictEqual(score, 6, "10 - 1 (1 erreur) - 3 (continent)");
  await platpays.archiveSolve(state, entry, "u1", "u1", score, participant.solvedAt);
  await platpays.archiveSolve(state, entry, "u1", "u1", score, participant.solvedAt); // double soumission
  const { score: s2, participant: p2 } = await platpays.markSolved("p001", "u2", "u2");
  await platpays.archiveSolve(state, entry, "u2", "u2", s2, p2.solvedAt);
  const ranking = await platpays.computeSeasonRanking(state.seasonId);
  assert.deepStrictEqual(ranking.map((r) => [r.discordId, r.totalScore]), [["u2", 10], ["u1", 6]]);
  assert.strictEqual(await platpays.getPlatLabel("p001"), `${entry.plat} (${entry.pays})`);
  console.log("✓ manche complète");

  const suivante = await platpays.startNewGame("salon-test");
  assert.strictEqual(suivante.state.gameId, "p002");
  assert.strictEqual(await platpays.readParticipant("p001", "u1"), null);
  assert.strictEqual((await platpays.getAllArchivedResults()).length, 2);

  await platpays.resetGame();
  assert.strictEqual(await platpays.readState(), null);
  assert.strictEqual(await platpays.isGamePosted("p001"), false);
  console.log("✓ manche suivante et remise à zéro");
}
