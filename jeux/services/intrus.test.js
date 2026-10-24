import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import * as intrus from "./intrus.js";
import * as triviaGeek from "./triviageek.js";
import { buildGridSvg } from "./intrusImage.js";
import { analyserIcone, intrusVisible } from "../outils/intrus/analyseObjets.js";

// Ce test écrit dans Redis : il ne doit jamais tourner sur l'Upstash de prod.
if (!Redis.isFake) {
  throw new Error("intrus.test.js doit être lancé via `npm test` (Redis en mémoire), jamais directement");
}

console.log("Running intrus tests...");

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const IMAGES_DIR = path.resolve(__dirname, "..", "data", "jeux-visuels", "intrus", "images");

// Catalogue : au moins 40 manches, 4 objets distincts (3 du même jeu + 1
// intrus d'un autre jeu), chaque objet dans une seule manche, jamais deux
// manches consécutives sur le même jeu, icônes présentes.
const objets = await intrus.loadObjets();
const manches = await intrus.loadManches();
const objetsById = new Map(objets.map((o) => [o.id, o]));
assert.strictEqual(objetsById.size, objets.length, "ids d'objets uniques");
assert.ok(manches.length >= 40, `au moins 40 manches (${manches.length})`);
const vus = new Set();
manches.forEach((m, i) => {
  assert.strictEqual(m.numero, i + 1, `numero ${m.numero}`);
  assert.ok(intrus.DIFFICULTES[m.difficulte], `difficulté manche ${m.numero}`);
  assert.ok(m.explication && !m.explication.includes("—"), `explication manche ${m.numero}`);
  assert.notStrictEqual(m.jeu, m.jeuIntrus, `jeux distincts manche ${m.numero}`);
  assert.strictEqual(m.objets.length, 3, `3 objets manche ${m.numero}`);
  for (const id of m.objets) assert.strictEqual(objetsById.get(id)?.jeu, m.jeu, `${id} (manche ${m.numero})`);
  assert.strictEqual(objetsById.get(m.intrus)?.jeu, m.jeuIntrus, `intrus manche ${m.numero}`);
  for (const id of [m.intrus, ...m.objets]) {
    assert.ok(!vus.has(id), `objet ${id} réutilisé (manche ${m.numero})`);
    vus.add(id);
  }
  if (i > 0) assert.notStrictEqual(m.jeu, manches[i - 1].jeu, `jeu répété aux manches ${i} et ${i + 1}`);
});
for (const o of objets) {
  assert.ok(o.nom && o.jeu && o.source, `champs de ${o.id}`);
  assert.ok(o.accentuation == null || [1, 2, 3].includes(o.accentuation), `accentuation de ${o.id}`);
  if (vus.has(o.id)) assert.ok(!o.exclu, `objet exclu ${o.id} utilisé dans une manche`);
  assert.strictEqual(o.image, `${o.id}.png`, `image de ${o.id}`);
  assert.ok(fs.existsSync(path.join(IMAGES_DIR, o.image)), `icône ${o.image}`);
}
// Jamais d'intrus repérable à l'œil : 3 variantes d'un même objet, ou une
// forme à part face à un trio homogène (voir analyseObjets.js).
const signature = (id) => analyserIcone(fs.readFileSync(path.join(IMAGES_DIR, objetsById.get(id).image))).signature;
for (const m of manches) {
  const { raisons } = intrusVisible([m.intrus, ...m.objets].map(signature));
  assert.deepStrictEqual(raisons, [], `manche ${m.numero} : intrus visible à l'œil`);
}
for (const d of Object.keys(intrus.DIFFICULTES)) {
  assert.ok(manches.some((m) => m.difficulte === d), `au moins une manche « ${d} »`);
}
console.log("✓ catalogue valide");

// Entrée du moteur : l'intrus est toujours options[0], avec son jeu et son image.
const catalog = await intrus.loadTriviaCatalog();
const premiere = catalog[0];
assert.strictEqual(premiere.id, "i001");
assert.strictEqual(premiere.options[0], objetsById.get(manches[0].intrus).nom);
assert.strictEqual(premiere.optionNotes[0], manches[0].jeuIntrus);
assert.strictEqual(premiere.images.length, 4);
assert.ok(premiere.label.includes(manches[0].jeu));
assert.throws(() => intrus.parseIntrusEntry({ ...manches[0], intrus: "inconnu" }, objetsById), /inconnu/);
console.log("✓ entrées du moteur");

// Image : 4 icônes et les 4 lettres.
const svg = buildGridSvg(["A", "B", "C", "D"].map((letter) => ({ letter, dataUrl: "data:image/png;base64,AA==" })));
assert.strictEqual((svg.match(/<image /g) || []).length, 4);
for (const l of ["A", "B", "C", "D"]) assert.ok(svg.includes(`>${l}</text>`));
console.log("✓ grille 2×2");

// Manche complète, isolée de Trivia Geek.
const { state, order } = await intrus.startNewGame("salon-test");
assert.strictEqual(state.gameId, "i001");
const bonne = intrus.getCorrectLetter(order);
const mauvaise = intrus.LETTERS.find((l) => l !== bonne);
for (const [id, lettre] of [["u1", bonne], ["u2", mauvaise]]) {
  const correct = intrus.checkAnswer(order, lettre);
  const { participant } = await intrus.recordAnswer(state.gameId, id, id, lettre, correct, intrus.computeScore(correct));
  await intrus.archiveAnswer(state, premiere, id, id, participant.score, participant.answeredAt);
}
const ranking = await intrus.computeSeasonRanking(state.seasonId);
assert.deepStrictEqual(ranking.map((r) => [r.discordId, r.totalScore]), [["u1", 1], ["u2", 0]]);
assert.strictEqual(await intrus.isGamePosted("i001"), true);
assert.strictEqual(await intrus.isGamePosted("i002"), false);
assert.ok(premiere.label.startsWith((await intrus.getTriviaRoundLabel("i001")).replace(/…$/, "")));
assert.strictEqual(await triviaGeek.readState(), null, "Trivia Geek intact");
console.log("✓ manche Intrus isolée de Trivia Geek");

console.log("All intrus tests passed.");
