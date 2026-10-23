import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import { normalizeAnswer } from "@clash/commun/textNormalize.js";
import * as zoom2 from "./zoom2.js";
import { renderZoom2Stages } from "./zoom2Image.js";

// Ce test écrit dans Redis : il ne doit jamais tourner sur l'Upstash de prod.
if (!Redis.isFake) {
  throw new Error("zoom2.test.js doit être lancé via `npm test` (Redis en mémoire), jamais directement");
}

console.log("Running zoom2 tests...");

const IMAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "jeux-visuels", "zoom2", "images");

// Barème de Zoom carte (un seul indice), plancher 1.
assert.strictEqual(zoom2.computeScore(0, false), 10);
assert.strictEqual(zoom2.computeScore(1, true), 5);
assert.strictEqual(zoom2.computeScore(9, true), 1);
console.log("✓ barème");

// Catalogue : numero = position, image présente aux bonnes dimensions,
// réglages de zoom plausibles, aucune réponse acceptée pour deux logos.
const catalog = await zoom2.loadZoom2Catalog();
const vues = new Map();
catalog.forEach((e, i) => {
  assert.strictEqual(e.numero, i + 1, `numero ${e.numero}`);
  assert.ok(e.answer && e.accept.includes(e.answer), `réponse acceptée au n° ${e.numero}`);
  assert.ok(zoom2.checkAnswer(e, e.answer), `n° ${e.numero}`);
  const png = fs.readFileSync(path.join(IMAGES_DIR, e.image));
  assert.deepStrictEqual([png.readUInt32BE(16), png.readUInt32BE(20)], [e.width, e.height], `dimensions de ${e.image}`);
  if (e.focal) assert.ok([e.focal.x, e.focal.y].every((v) => v >= 0 && v <= 1), `focal au n° ${e.numero}`);
  if (e.zoomStages) assert.ok(e.zoomStages.stage0 >= e.zoomStages.stage1 && e.zoomStages.stage1 >= 1, `zoomStages au n° ${e.numero}`);
  const normalisees = e.accept.map(normalizeAnswer);
  assert.strictEqual(new Set(normalisees).size, normalisees.length, `variante redondante au n° ${e.numero}`);
  for (const a of normalisees) {
    assert.ok(!vues.has(a), `« ${a} » accepté pour ${vues.get(a)} et ${e.answer}`);
    vues.set(a, e.answer);
  }
});
assert.strictEqual(new Set(catalog.map(zoom2.gameIdFor)).size, catalog.length, "gameId uniques");
assert.strictEqual(fs.readdirSync(IMAGES_DIR).length, catalog.length, "aucune image orpheline");
console.log("✓ catalogue valide");

// Égalité stricte après normalisation : pas de sous-chaîne.
const lg = catalog.find((e) => e.answer === "LG");
assert.strictEqual(zoom2.checkAnswer(lg, "lg electronics"), true);
assert.strictEqual(zoom2.checkAnswer(lg, "LG !"), true);
assert.strictEqual(zoom2.checkAnswer(lg, "Algérie"), false);
console.log("✓ vérification des réponses");

// Rendu des trois images d'un logo, sans Redis ni Blob.
const rendu = renderZoom2Stages(catalog[0], fs.readFileSync(path.join(IMAGES_DIR, catalog[0].image)));
for (const etape of ["stage0", "stage1", "reveal"]) {
  assert.strictEqual(rendu[etape].buffer.toString("hex", 0, 4), "89504e47", etape);
}
console.log("✓ rendu des images");

// Manche complète : indice, tentative ratée, résolution, archive.
assert.strictEqual(await zoom2.isGamePosted("l001"), false, "anti-spoiler avant publication");
const { state, entry } = await zoom2.startNewGame("salon-test");
assert.strictEqual(state.gameId, "l001");
assert.strictEqual(entry, catalog[0]);
assert.strictEqual(await zoom2.isGamePosted("l001"), true);
assert.strictEqual(await zoom2.isGamePosted("l002"), false);
assert.strictEqual((await zoom2.recordHintUsed("l001", "u1", "u1")).alreadyUsed, false);
assert.strictEqual((await zoom2.recordHintUsed("l001", "u1", "u1")).alreadyUsed, true);
await zoom2.recordAttempt("l001", "u1", "u1");
const { participant, score } = await zoom2.markSolved("l001", "u1", "u1");
assert.strictEqual(score, 5, "10 - 2 (1 erreur) - 3 (indice)");
await zoom2.archiveSolve(state, entry, "u1", "u1", score, participant.solvedAt);
await zoom2.archiveSolve(state, entry, "u1", "u1", score, participant.solvedAt); // double soumission
const { score: s2, participant: p2 } = await zoom2.markSolved("l001", "u2", "u2");
await zoom2.archiveSolve(state, entry, "u2", "u2", s2, p2.solvedAt);
const ranking = await zoom2.computeSeasonRanking(state.seasonId);
assert.deepStrictEqual(ranking.map((r) => [r.discordId, r.totalScore]), [["u2", 10], ["u1", 5]]);
assert.strictEqual(await zoom2.hasPlayerInteracted("l001", "u1"), true);
assert.strictEqual(await zoom2.getZoom2RoundLabel("l001"), entry.answer);
console.log("✓ manche complète");

// Manche suivante : purge de la progression, archives conservées.
const suivante = await zoom2.startNewGame("salon-test");
assert.strictEqual(suivante.state.gameId, "l002");
assert.strictEqual(await zoom2.readParticipant("l001", "u1"), null);
assert.strictEqual((await zoom2.getAllArchivedResults()).length, 2);

await zoom2.resetGame();
assert.strictEqual(await zoom2.readState(), null);
assert.strictEqual(await zoom2.isGamePosted("l001"), false);
assert.strictEqual((await zoom2.getAllArchivedResults()).length, 0);
console.log("✓ manche suivante et remise à zéro");
