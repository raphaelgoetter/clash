import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import * as zoom from "./zoom.js";
import { renderZoomStages } from "./zoomImage.js";

// Ce test écrit dans Redis : il ne doit jamais tourner sur l'Upstash de prod.
if (!Redis.isFake) {
  throw new Error("zoom.test.js doit être lancé via `npm test` (Redis en mémoire), jamais directement");
}

console.log("Running zoom tests...");

const IMAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "jeux-visuels", "zoom", "images");

// Barème : -2 par erreur, indice -3, plancher 1.
assert.strictEqual(zoom.computeScore(0, false), 10);
assert.strictEqual(zoom.computeScore(1, true), 5);
assert.strictEqual(zoom.computeScore(9, true), 1);
console.log("✓ barème");

// Catalogue : identifiants uniques et opaques, photo JPEG présente,
// réglages de zoom plausibles, aucune réponse acceptée pour deux objets.
const catalog = await zoom.loadZoomCatalog();
const vues = new Map();
for (const e of catalog) {
  assert.match(e.id, /^t\d{3}$/, `id ${e.id}`);
  assert.ok(e.answer && e.accept.includes(e.answer), `réponse acceptée pour ${e.id}`);
  assert.ok(zoom.checkAnswer(e, e.answer), e.id);
  assert.ok(e.sourceUrl?.startsWith("https://commons.wikimedia.org/") && e.licence, `source et licence de ${e.id}`);
  const jpg = fs.readFileSync(path.join(IMAGES_DIR, e.image));
  assert.strictEqual(jpg.toString("hex", 0, 3), "ffd8ff", `${e.image} est un JPEG`);
  if (e.focal) assert.ok([e.focal.x, e.focal.y].every((v) => v >= 0 && v <= 1), `focal de ${e.id}`);
  if (e.zoomStages) assert.ok(e.zoomStages.stage0 >= e.zoomStages.stage1 && e.zoomStages.stage1 >= 1, `zoomStages de ${e.id}`);
  const cles = e.accept.map(zoom.answerKey);
  assert.strictEqual(new Set(cles).size, cles.length, `variante redondante pour ${e.id}`);
  for (const c of cles) {
    assert.ok(!vues.has(c), `« ${c} » accepté pour ${vues.get(c)} et ${e.answer}`);
    vues.set(c, e.answer);
  }
}
assert.strictEqual(new Set(catalog.map((e) => e.id)).size, catalog.length, "id uniques");
assert.strictEqual(fs.readdirSync(IMAGES_DIR).length, catalog.length, "aucune image orpheline");
console.log("✓ catalogue valide");

// Article de tête, pluriel et accents ignorés ; jamais de sous-chaîne.
const ciseaux = catalog.find((e) => e.answer === "Ciseaux");
const allumette = catalog.find((e) => e.answer === "Allumette");
const brosse = catalog.find((e) => e.answer === "Brosse à dents");
assert.strictEqual(zoom.checkAnswer(ciseaux, "une paire de ciseaux"), true);
assert.strictEqual(zoom.checkAnswer(ciseaux, "Ciseau"), true);
assert.strictEqual(zoom.checkAnswer(allumette, "des allumettes"), true);
assert.strictEqual(zoom.checkAnswer(allumette, "L'allumette !"), true);
assert.strictEqual(zoom.checkAnswer(brosse, "brosse a dent"), true);
assert.strictEqual(zoom.checkAnswer(brosse, "brosse"), false);
assert.strictEqual(zoom.checkAnswer(ciseaux, ""), false);
console.log("✓ vérification des réponses");

// Rendu des trois images d'un objet, sans Redis ni Blob.
const rendu = renderZoomStages(catalog[0], fs.readFileSync(path.join(IMAGES_DIR, catalog[0].image)));
for (const etape of ["stage0", "stage1", "reveal"]) {
  assert.strictEqual(rendu[etape].buffer.toString("hex", 0, 4), "89504e47", etape);
}
console.log("✓ rendu des images");

// Manche complète : indice, tentative ratée, résolution, archive.
const [premier, second] = catalog;
assert.strictEqual(await zoom.isGamePosted(premier.id), false, "anti-spoiler avant publication");
const { state, entry } = await zoom.startNewGame("salon-test");
assert.strictEqual(state.gameId, premier.id);
assert.strictEqual(entry, premier);
assert.strictEqual(await zoom.isGamePosted(premier.id), true);
assert.strictEqual(await zoom.isGamePosted(second.id), false);
assert.strictEqual((await zoom.recordHintUsed(premier.id, "u1", "u1")).alreadyUsed, false);
assert.strictEqual((await zoom.recordHintUsed(premier.id, "u1", "u1")).alreadyUsed, true);
await zoom.recordAttempt(premier.id, "u1", "u1", false);
const { participant, score } = await zoom.markSolved(premier.id, "u1", "u1");
assert.strictEqual(score, 5, "10 - 2 (1 erreur) - 3 (indice)");
await zoom.archiveSolve(state, entry, "u1", "u1", score, participant.solvedAt);
await zoom.archiveSolve(state, entry, "u1", "u1", score, participant.solvedAt); // double soumission
const { score: s2, participant: p2 } = await zoom.markSolved(premier.id, "u2", "u2");
await zoom.archiveSolve(state, entry, "u2", "u2", s2, p2.solvedAt);
const ranking = await zoom.computeSeasonRanking(state.seasonId);
assert.deepStrictEqual(ranking.map((r) => [r.discordId, r.totalScore]), [["u2", 10], ["u1", 5]]);
assert.strictEqual(await zoom.getZoomRoundLabel(premier.id), premier.answer);
console.log("✓ manche complète");

// Manche suivante : purge de la progression, archives conservées.
const suivante = await zoom.startNewGame("salon-test");
assert.strictEqual(suivante.state.gameId, second.id);
assert.strictEqual(await zoom.readParticipant(premier.id, "u1"), null);
assert.strictEqual((await zoom.getAllArchivedResults()).length, 2);

await zoom.resetGame();
assert.strictEqual(await zoom.readState(), null);
assert.strictEqual((await zoom.getAllArchivedResults()).length, 0);
console.log("✓ manche suivante et remise à zéro");
