import assert from "assert";
import { Redis } from "@upstash/redis";
import { OBJECTIFS, QUETES_DU_MOIS, calculerTampons, objectifsDe, lirePasseport, noterJeuSpecial, noterManche, noterVictoireDuel, queteDuMois } from "./passeport.js";

const base = { manches: [], victoiresKevina: 0, victoiresQuete: 0, quete: QUETES_DU_MOIS[0], speciauxJoueur: [], speciauxMois: [], moisTermine: false };
const valides = (registre) => calculerTampons({ ...base, ...registre }).map((t) => t.valide);

// ── calculerTampons ──
assert.deepStrictEqual(valides({}), [false, false, false, false, false]);
assert.strictEqual(valides({ victoiresQuete: 1 })[4], true);

// ── objectifsDe : novembre 2026 allégé, complets ensuite ──
assert.deepStrictEqual(objectifsDe(138), { jeux: 3, manches: 5, kevina: 1 });
assert.deepStrictEqual(objectifsDe(139), OBJECTIFS);
const allege = calculerTampons({ ...base, objectifs: objectifsDe(138), manches: ["frame:1", "concept:2", "zoom2:3", "frame:4", "frame:5"], victoiresKevina: 1 });
assert.deepStrictEqual(allege.slice(0, 3).map((t) => t.valide), [true, true, true]);
assert.strictEqual(allege[0].libelle, "Jouer à 3 mini-jeux différents");

// ── queteDuMois : rotation, novembre 2026 = Frise ──
assert.strictEqual(queteDuMois(138).jeu, "frise");
assert.strictEqual(queteDuMois(139).jeu, "punto");
assert.strictEqual(queteDuMois(138 + QUETES_DU_MOIS.length).jeu, "frise");
assert.strictEqual(queteDuMois(137).jeu, QUETES_DU_MOIS.at(-1).jeu);
// 4 jeux différents, mais 4 manches seulement
assert.deepStrictEqual(valides({ manches: ["frame:1", "concept:2", "zoom2:3", "trivia:4"] }).slice(0, 2), [true, false]);
// 10 manches d'un même jeu : un seul jeu différent
const dixFrames = Array.from({ length: 10 }, (_, i) => `frame:${i}`);
assert.deepStrictEqual(valides({ manches: dixFrames }).slice(0, 2), [false, true]);
assert.strictEqual(valides({ victoiresKevina: 1 })[2], false);
assert.strictEqual(valides({ victoiresKevina: 2 })[2], true);
// Jeu spécial : joué, ou aucun dans le mois une fois le mois fini
assert.strictEqual(valides({ speciauxJoueur: ["meow"], speciauxMois: ["meow"] })[3], true);
assert.strictEqual(valides({ speciauxMois: ["meow"], moisTermine: true })[3], false);
assert.strictEqual(valides({ moisTermine: false })[3], false);
assert.strictEqual(valides({ moisTermine: true })[3], true);

// ── Registre (Redis en mémoire) ──
if (Redis.isFake) {
  const novembre = new Date("2026-11-13T20:00:00Z");
  const decembre = new Date("2026-12-02T20:00:00Z");

  await noterManche("1", "frame", "f001", novembre);
  await noterManche("1", "frame", "f001", novembre); // idempotent
  await noterManche("1", "concept", "c001", novembre);
  await noterManche("1", "zoom2", "z001", decembre); // compte pour décembre
  await noterVictoireDuel("1", "frise", "bot", novembre);
  await noterVictoireDuel("1", "quatre", "bot", novembre);
  await noterVictoireDuel("1", "punto", "pvp", novembre); // 1v1 : pas pour Kévina
  await noterVictoireDuel("1", "frise", "pvp", decembre); // Frise : quête de novembre, pas de décembre
  await noterVictoireDuel("1", "punto", "pvp", decembre); // Punto en 1v1 : quête de décembre
  await noterJeuSpecial("2", "meow", novembre); // un autre joueur

  const p = await lirePasseport("1", { now: novembre });
  assert.strictEqual(p.seasonId, 138);
  const parCle = Object.fromEntries(p.tampons.map((t) => [t.cle, t]));
  assert.strictEqual(parCle.jeux.valeur, 2);
  assert.strictEqual(parCle.manches.valeur, 2);
  assert.strictEqual(parCle.kevina.valeur, 2);
  assert.strictEqual(parCle.kevina.valide, true);
  assert.strictEqual(parCle.special.valide, false); // Meow a eu lieu, sans lui
  assert.strictEqual(parCle.quete.valide, true); // Frise gagnée contre Kévina
  assert.strictEqual(p.complet, false);

  // Décembre : sans jeu spécial, validé d'office une fois le mois fini
  const dec = await lirePasseport("1", { now: decembre });
  assert.strictEqual(dec.tampons.find((t) => t.cle === "manches").valeur, 1);
  assert.strictEqual(dec.quete.jeu, "punto");
  assert.strictEqual(dec.tampons.find((t) => t.cle === "quete").valide, true);
  const finDec = await lirePasseport("1", { now: new Date("2027-01-02T10:00:00Z"), seasonId: 139 });
  assert.strictEqual(finDec.tampons.find((t) => t.cle === "special").valide, true);

  // Entrées invalides ignorées, jamais d'erreur
  await noterVictoireDuel("1", "frise", "nul", novembre);
  await noterManche(null, "frame", "f002", novembre);
  assert.strictEqual((await lirePasseport("1", { now: novembre })).tampons[2].valeur, 2);
}

console.log("passeport.test.js OK");
