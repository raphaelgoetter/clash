import assert from "assert";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";
import { Redis } from "@upstash/redis";
import * as sekoidon from "./sekoidon.js";
import * as trivia from "./trivia.js";

// Ce test écrit dans Redis : il ne doit jamais tourner sur l'Upstash de prod.
if (!Redis.isFake) {
  throw new Error("sekoidon.test.js doit être lancé via `npm test` (Redis en mémoire), jamais directement");
}

console.log("Running sekoidon tests...");

const IMAGES_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "data", "jeux-visuels", "sekoidon", "images");

// Catalogue : numero = position, 4 réponses distinctes, textes joueurs sans
// em dash, source et crédit photo complets, photo JPEG présente.
const objets = await sekoidon.loadObjets();
assert.ok(objets.length >= 40, `au moins 40 objets (${objets.length})`);
assert.strictEqual(new Set(objets.map((o) => o.objet)).size, objets.length, "objets uniques");
objets.forEach((o, i) => {
  const ref = `${o.objet} (n° ${o.numero})`;
  assert.strictEqual(o.numero, i + 1, `numero de ${ref}`);
  assert.strictEqual(o.leurres.length, 3, `3 leurres pour ${ref}`);
  const reponses = [o.bonne, ...o.leurres].map((r) => r.trim().toLowerCase());
  assert.strictEqual(new Set(reponses).size, 4, `réponses distinctes pour ${ref}`);
  for (const texte of [o.nom, o.epoque, o.bonne, ...o.leurres, o.explication]) {
    assert.ok(texte && !texte.includes("—"), `texte vide ou em dash pour ${ref}`);
  }
  assert.ok(/^https:\/\//.test(o.source), `source de ${ref}`);
  assert.ok(o.photo.page.startsWith("https://commons.wikimedia.org/wiki/File:") && o.photo.licence, `crédit photo de ${ref}`);
  assert.ok(![o.photo.auteur, o.photo.licence].some((t) => /&[a-z#0-9]+;/i.test(t ?? "")), `entité HTML dans le crédit de ${ref}`);
  const jpg = fs.readFileSync(path.join(IMAGES_DIR, o.image));
  assert.strictEqual(jpg.toString("hex", 0, 3), "ffd8ff", `${o.image} est un JPEG`);
});
assert.strictEqual(fs.readdirSync(IMAGES_DIR).length, objets.length, "aucune image orpheline");
console.log("✓ catalogue valide");

// Ordre de jeu : jamais le même univers ni la même famille « moderne » ou
// « classique » à moins de 3 manches d'écart, jamais 3 « étranges » d'affilée.
const FAMILLES = ["etrange", "moderne", "classique"];
objets.forEach((o, i) => {
  assert.ok(FAMILLES.includes(o.famille) && o.univers, `famille et univers de ${o.objet}`);
  const avant = objets.slice(Math.max(0, i - 2), i);
  assert.ok(!avant.some((x) => x.univers === o.univers), `univers ${o.univers} trop proche (n° ${o.numero})`);
  if (o.famille !== "etrange") assert.ok(!avant.some((x) => x.famille === o.famille), `famille ${o.famille} trop proche (n° ${o.numero})`);
  else assert.ok(!(avant.length === 2 && avant.every((x) => x.famille === "etrange")), `3 « étranges » d'affilée (n° ${o.numero})`);
});
console.log("✓ familles et univers espacés");

// Entrée du moteur : bonne réponse en options[0], question fixe, crédit photo
// dans la source affichée à la révélation.
const premiere = sekoidon.parseSekoidonEntry(objets[0]);
assert.strictEqual(premiere.id, "s001");
assert.strictEqual(premiere.question, sekoidon.QUESTION);
assert.strictEqual(premiere.options[0], objets[0].bonne);
assert.ok(premiere.explication.startsWith(`**${objets[0].nom}**`));
assert.ok(premiere.source.includes(objets[0].photo.page));
assert.strictEqual(
  sekoidon.creditPhoto({ page: "https://commons.wikimedia.org/wiki/File:X.jpg", auteur: "", licence: "CC0" }),
  "📷 Photo : [Wikimedia Commons](https://commons.wikimedia.org/wiki/File:X.jpg), CC0",
);
console.log("✓ entrée du moteur");

// Manche complète, isolée du Trivia.
const { state, order } = await sekoidon.startNewGame("salon-test");
assert.strictEqual(state.gameId, "s001");
const bonne = sekoidon.getCorrectLetter(order);
const mauvaise = sekoidon.LETTERS.find((l) => l !== bonne);
for (const [id, lettre] of [["u1", bonne], ["u2", mauvaise]]) {
  const correct = sekoidon.checkAnswer(order, lettre);
  const { participant } = await sekoidon.recordAnswer(state.gameId, id, id, lettre, correct, sekoidon.computeScore(correct));
  await sekoidon.archiveAnswer(state, premiere, id, id, participant.score, participant.answeredAt);
}
const ranking = await sekoidon.computeSeasonRanking(state.seasonId);
assert.deepStrictEqual(ranking.map((r) => [r.discordId, r.totalScore]), [["u1", 1], ["u2", 0]]);
assert.strictEqual(await sekoidon.isGamePosted("s001"), true);
assert.strictEqual(await sekoidon.isGamePosted("s002"), false);
assert.strictEqual(await trivia.readState(), null, "Trivia intact");
console.log("✓ manche Sékoidon isolée du Trivia");

console.log("All sekoidon tests passed.");
