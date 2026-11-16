import { test } from "node:test";
import assert from "node:assert/strict";
import { creneauA, creneauJouable, jourDeJeu, creneauDepuis, JOURNEE, SOIR } from "./creneaux.js";
import { parisInstant } from "./meowRules.js";

const a = (date, h, min = 0) => parisInstant(date, h) + min * 60_000;

test("creneauA : journée 8h30-20h, soir 20h-8h, fermé 8h-8h30 (heure de Paris)", () => {
  assert.equal(creneauA(a("2026-11-16", 8, 29)), null);
  assert.equal(creneauA(a("2026-11-16", 8, 30)), JOURNEE);
  assert.equal(creneauA(a("2026-11-16", 19, 59)), JOURNEE);
  assert.equal(creneauA(a("2026-11-16", 20)), SOIR);
  assert.equal(creneauA(a("2026-11-17", 7, 59)), SOIR);
  assert.equal(creneauA(a("2026-11-17", 8)), null);
  // Heure d'été
  assert.equal(creneauA(a("2026-07-01", 8, 30)), JOURNEE);
  assert.equal(creneauA(a("2026-07-01", 20)), SOIR);
});

test("jourDeJeu : de 8h à 8h", () => {
  assert.equal(jourDeJeu(a("2026-11-16", 8)), "2026-11-16");
  assert.equal(jourDeJeu(a("2026-11-17", 0, 30)), "2026-11-16");
  assert.equal(jourDeJeu(a("2026-11-17", 7, 59)), "2026-11-16");
});

test("creneauJouable : le soir appartient au jour publié le matin, rien après le décompte de 8h", () => {
  const publie = new Date(a("2026-11-16", 8, 20)).toISOString();
  assert.equal(creneauJouable(publie, a("2026-11-16", 8, 25)), null);
  assert.equal(creneauJouable(publie, a("2026-11-16", 12)), JOURNEE);
  assert.equal(creneauJouable(publie, a("2026-11-17", 3)), SOIR);
  // Cron en retard : le jour suivant n'est pas encore publié à 8h45
  assert.equal(creneauJouable(publie, a("2026-11-17", 8, 45)), null);
  assert.equal(creneauJouable(null, a("2026-11-16", 12)), null);
});

test("creneauDepuis : custom_id sans créneau = journée", () => {
  assert.equal(creneauDepuis(undefined), JOURNEE);
  assert.equal(creneauDepuis("2"), SOIR);
});
