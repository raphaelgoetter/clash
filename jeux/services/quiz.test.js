import assert from "assert";
import { loadQuizConfig, validateQuizConfig, QUESTIONS_PAR_MANCHE } from "./quiz.js";

console.log("Running quiz tests...");

// Le contenu réel doit toujours passer la validation (sinon le post échoue).
const config = await loadQuizConfig();
assert.ok(config.manches.length > 0, "quiz.json doit contenir au moins une manche");
console.log("✓ jeux/data/quiz/quiz.json valide");

const question = (overrides = {}) => ({
  type: "qcm",
  enonce: "?",
  image: null,
  choix: ["A", "B", "C"],
  bonne_reponse: 0,
  ...overrides,
});
const manche = (questions) => ({ manches: [{ id: "test", theme: "Test", questions }] });
const full = (overrides) => Array.from({ length: QUESTIONS_PAR_MANCHE }, () => question(overrides));

assert.doesNotThrow(() => validateQuizConfig(manche(full())));
assert.throws(() => validateQuizConfig(manche(full().slice(1))), /questions au lieu de/, "Nombre de questions incorrect");
assert.throws(() => validateQuizConfig(manche(full({ choix: ["A"] }))), /choix distincts/, "Un seul choix");
assert.throws(() => validateQuizConfig(manche(full({ choix: ["A", "A"] }))), /choix distincts/, "Choix en double");
assert.throws(() => validateQuizConfig(manche(full({ bonne_reponse: 3 }))), /bonne_reponse/, "Bonne réponse hors des choix");
console.log("✓ validateQuizConfig rejette les manches mal formées");
