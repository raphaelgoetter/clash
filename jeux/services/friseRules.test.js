import assert from "assert";
import fs from "fs";
import {
  choisir,
  choixKevina,
  construirePaquet,
  creerDuel,
  creneauJuste,
  libelleCreneau,
  placer,
  probaErreurKevina,
} from "./friseRules.js";

// Hasard reproductible
function rngFixe(graine = 1) {
  let s = graine;
  return () => ((s = (s * 16807) % 2147483647) - 1) / 2147483646;
}

const CARTES = Array.from({ length: 30 }, (_, k) => ({ libelle: `Événement ${k}`, annee: 1000 + k * 10 }));

// ── Paquet : cartes à au moins `ecartMin` ans les unes des autres ──
{
  const proches = [
    { libelle: "A", annee: 1900 },
    { libelle: "B", annee: 1901 },
    { libelle: "C", annee: 1950 },
  ];
  const paquet = construirePaquet(proches, { ecartMin: 3, rng: rngFixe(3) });
  assert.strictEqual(paquet.length, 2);
  assert.ok(paquet.some((c) => c.libelle === "C"));
}

// ── Données réelles : années entières, libellés ≤ 60 caractères, sources ──
{
  const cartes = JSON.parse(fs.readFileSync(new URL("../data/frise/cartes.json", import.meta.url)));
  for (const c of cartes) {
    assert.ok(Number.isInteger(c.annee), c.libelle);
    assert.ok(c.libelle.length <= 60, c.libelle);
    assert.ok(c.source?.startsWith("https://"), c.libelle);
  }
  assert.strictEqual(new Set(cartes.map((c) => c.libelle)).size, cartes.length, "libellés en double");
  // Assez de cartes pour une partie, même après le filtre des écarts
  assert.ok(construirePaquet(cartes, { ecartMin: 3, rng: rngFixe(7) }).length >= 20);
}

// ── Créneaux ──
{
  const d = creerDuel(CARTES, { rng: rngFixe(1) });
  d.frise = [{ libelle: "x", annee: 1500 }, { libelle: "y", annee: 1800 }];
  assert.strictEqual(libelleCreneau(d, 0), "Avant 1500");
  assert.strictEqual(libelleCreneau(d, 1), "Entre 1500 et 1800");
  assert.strictEqual(libelleCreneau(d, 2), "Après 1800");
  assert.strictEqual(creneauJuste(d, 0, 1400), true);
  assert.strictEqual(creneauJuste(d, 1, 1400), false);
  assert.strictEqual(creneauJuste(d, 1, 1789), true);
  assert.strictEqual(creneauJuste(d, 2, 2000), true);
}

// ── Coup juste : la carte reste, la main diminue, le tour passe ──
{
  const d = creerDuel(CARTES, { tailleMain: 2, rng: rngFixe(2) });
  d.frise = [{ libelle: "x", annee: 1500 }];
  d.mains.joueur = [{ libelle: "a", annee: 1200 }, { libelle: "b", annee: 1700 }];
  choisir(d, "joueur", 1);
  const r = placer(d, "joueur", 1);
  assert.strictEqual(r.juste, true);
  assert.deepStrictEqual(d.frise.map((c) => c.annee), [1500, 1700]);
  assert.deepStrictEqual(d.frise.map((c) => c.par ?? null), [null, "joueur"]); // auteur de la pose
  assert.strictEqual(d.mains.joueur.length, 1);
  assert.strictEqual(d.actif, "bot");
  assert.strictEqual(d.vue, 1);
  assert.deepStrictEqual(placer(d, "joueur", 0), { erreur: "pasTonTour" });
}

// ── Coup faux : carte rangée à sa place, pénalité piochée ──
{
  const d = creerDuel(CARTES, { tailleMain: 2, rng: rngFixe(4) });
  d.frise = [{ libelle: "x", annee: 1500 }];
  d.mains.joueur = [{ libelle: "a", annee: 1200 }, { libelle: "b", annee: 1700 }];
  const avant = d.pioche.length;
  const r = placer(d, "joueur", 1); // « a » (1200) après 1500 : faux
  assert.strictEqual(r.juste, false);
  assert.deepStrictEqual(d.frise.map((c) => c.annee), [1200, 1500]);
  assert.strictEqual(d.mains.joueur.length, 2);
  assert.strictEqual(d.pioche.length, avant - 1);
}

// ── Fin : le premier vide sa main, le second joue un dernier tour ──
{
  const d = creerDuel(CARTES, { tailleMain: 1, rng: rngFixe(5) });
  d.frise = [{ libelle: "x", annee: 1500 }];
  d.mains.joueur = [{ libelle: "a", annee: 1600 }];
  d.mains.bot = [{ libelle: "b", annee: 1400 }];
  placer(d, "joueur", 1);
  assert.strictEqual(d.termine, false);
  assert.strictEqual(d.dernierTour, true);
  assert.strictEqual(d.actif, "bot");
  placer(d, "bot", 0); // juste : les deux mains vides
  assert.deepStrictEqual([d.termine, d.gagnant], [true, "nul"]);
}
{
  const d = creerDuel(CARTES, { tailleMain: 1, rng: rngFixe(6) });
  d.frise = [{ libelle: "x", annee: 1500 }];
  d.mains.joueur = [{ libelle: "a", annee: 1600 }];
  d.mains.bot = [{ libelle: "b", annee: 1400 }];
  placer(d, "joueur", 1);
  placer(d, "bot", 1); // faux : le premier joueur gagne
  assert.deepStrictEqual([d.termine, d.gagnant], [true, "joueur"]);
}
{
  // Le second vide sa main le premier : victoire immédiate
  const d = creerDuel(CARTES, { tailleMain: 1, rng: rngFixe(8) });
  d.frise = [{ libelle: "x", annee: 1500 }];
  d.mains.joueur = [{ libelle: "a", annee: 1600 }];
  d.mains.bot = [{ libelle: "b", annee: 1400 }];
  placer(d, "joueur", 0); // faux, pioche
  placer(d, "bot", 0);
  assert.deepStrictEqual([d.termine, d.gagnant], [true, "bot"]);
}

// ── Kévina : erreur plus probable près des voisines, carte la plus sûre ──
{
  const d = creerDuel(CARTES, { rng: rngFixe(9) });
  d.frise = [{ libelle: "x", annee: 1500 }, { libelle: "y", annee: 1800 }];
  assert.ok(probaErreurKevina(d, 1505) > probaErreurKevina(d, 1650));
  d.mains.bot = [{ libelle: "proche", annee: 1503 }, { libelle: "loin", annee: 1650 }];
  const sansErreur = choixKevina(d, "bot", { rng: () => 0.999 });
  assert.deepStrictEqual(sansErreur, { index: 1, creneau: 1 });
  const avecErreur = choixKevina(d, "bot", { rng: () => 0 });
  assert.strictEqual(avecErreur.index, 1);
  assert.notStrictEqual(avecErreur.creneau, 1);
}

console.log("friseRules.test.js OK");
