import { test } from "node:test";
import assert from "node:assert/strict";
import {
  toutesLesEgalites,
  toutes,
  tirerEgalite,
  lireSaisie,
  retour,
  gagne,
  etatPave,
  pointsDuJour,
  compatibles,
  classementMois,
  bilanJour,
  serieAffichee,
  serieApresVictoire,
  egaliteLisible,
  gabarit,
  BIEN,
  PRESENT,
  ABSENT,
} from "./pilepoilRules.js";
import { encodePlateau, decodePlateau, buildPlateauSvg, buildRecapSvg } from "./pilepoilImage.js";

test("égalités : 3 240 par signe, nombres et résultat de 10 à 99, calcul juste", () => {
  for (const signe of ["+", "-"]) {
    const liste = toutesLesEgalites(signe);
    assert.equal(liste.length, 3240);
    for (const e of liste) {
      assert.match(e, /^\d{2}[+-]\d{2}=\d{2}$/);
      const [, a, s, b, c] = e.match(/^(\d{2})([+-])(\d{2})=(\d{2})$/);
      assert.equal(s === "+" ? Number(a) + Number(b) : Number(a) - Number(b), Number(c));
    }
  }
  assert.equal(toutes().length, 6480);
});

test("tirage : jamais une égalité déjà sortie", () => {
  const plus = toutesLesEgalites("+");
  const sorties = new Set([...plus, ...toutesLesEgalites("-").slice(1)]);
  // Il ne reste qu'une égalité libre : elle sort, quel que soit le signe tiré
  assert.equal(tirerEgalite(sorties, () => 0.1), toutesLesEgalites("-")[0]);
  assert.equal(tirerEgalite(sorties, () => 0.9), toutesLesEgalites("-")[0]);
});

test("saisie tolérante : 6 chiffres exactement", () => {
  assert.equal(lireSaisie("47+38=85"), "473885");
  assert.equal(lireSaisie(" 47 38 85 "), "473885");
  assert.equal(lireSaisie("473885"), "473885");
  assert.equal(lireSaisie("4738"), null);
  assert.equal(lireSaisie("4738851"), null);
  assert.equal(lireSaisie(""), null);
});

test("retour : bien placés d'abord, doublons comme au Wordle", () => {
  const sol = "47+38=85";
  assert.deepEqual(retour("473885", sol), [BIEN, BIEN, BIEN, BIEN, BIEN, BIEN]);
  assert.ok(gagne(retour("473885", sol)));
  // 12+34=46 : 3 bien placé, 4 présent (une seule fois), 6 absent
  assert.deepEqual(retour("123446", sol), [ABSENT, ABSENT, BIEN, PRESENT, ABSENT, ABSENT]);
  // Ordre inversé : chiffres présents mais pas l'égalité exacte
  assert.ok(!gagne(retour("384785", sol)));
  // Un 8 deux fois dans la solution (38, 85) : deux 8 de l'essai colorés au plus
  assert.deepEqual(retour("888888", sol), [ABSENT, ABSENT, ABSENT, BIEN, BIEN, ABSENT]);
  assert.deepEqual(retour("880000", sol), [PRESENT, PRESENT, ABSENT, ABSENT, ABSENT, ABSENT]);
});

test("pavé : meilleur état connu de chaque chiffre", () => {
  const sol = "47+38=85";
  const essais = ["123446", "473885"].map((c) => ({ chiffres: c, retour: retour(c, sol) }));
  const pave = etatPave(essais.slice(0, 1));
  assert.equal(pave[3], BIEN);
  assert.equal(pave[4], PRESENT);
  assert.equal(pave[1], ABSENT);
  assert.equal(pave[9], null);
  assert.equal(etatPave(essais)[4], BIEN);
});

test("points : 6 au 1er essai … 1 au 6e", () => {
  assert.deepEqual([1, 2, 3, 4, 5, 6].map((n) => pointsDuJour(n, 6)), [6, 5, 4, 3, 2, 1]);
});

test("compatibles : la solution reste toujours possible", () => {
  const sol = "47+38=85";
  const essais = ["123446", "567890"].map((c) => ({ chiffres: c, retour: retour(c, sol) }));
  const reste = compatibles(toutesLesEgalites("+"), essais);
  assert.ok(reste.includes(sol));
  assert.ok(reste.length < 3240);
});

test("classement du mois : points, puis le moins de jours joués, ex aequo assumés", () => {
  const r = classementMois({ a: 10, b: 10, c: 12, d: 10 }, { a: 4, b: 3, c: 5, d: 3 });
  assert.deepEqual(r.map((x) => x.discordId), ["c", "b", "d", "a"]);
});

test("bilan du jour : regroupé par nombre d'essais", () => {
  const b = bilanJour({
    a: { essais: [1, 2, 3], trouve: true },
    b: { essais: [1, 2, 3], trouve: true },
    c: { essais: [1, 2, 3, 4, 5, 6], trouve: false },
    d: { essais: [], trouve: false },
  });
  assert.equal(b.joueurs, 3);
  assert.equal(b.trouves, 2);
  assert.deepEqual(b.parEssais, { 3: ["a", "b"] });
  assert.deepEqual(b.rates, ["c"]);
});

test("série : jours consécutifs trouvés, remise à 0 après un jour manqué", () => {
  let s = serieApresVictoire(null, 5);
  assert.deepEqual(s, { serie: 1, dernierJourTrouve: 5 });
  s = serieApresVictoire(s, 6);
  assert.equal(s.serie, 2);
  assert.equal(serieApresVictoire(s, 6).serie, 2, "idempotent le même jour");
  assert.equal(serieAffichee(s, 7), 2, "pas encore joué aujourd'hui");
  assert.equal(serieAffichee(s, 8), 0, "un jour manqué");
  assert.equal(serieApresVictoire(s, 8).serie, 1);
});

test("affichage : gabarit et égalité lisible", () => {
  assert.equal(gabarit("-"), "__-__=__");
  assert.equal(egaliteLisible("-", "925735"), "92 − 57 = 35");
});

test("image : plateau encodé sans la solution, rendu valide", () => {
  const sol = "47+38=85";
  const essais = ["123446", "473885"].map((c) => ({ chiffres: c, retour: retour(c, sol) }));
  const plateau = { jour: 12, signe: "+", essaisMax: 6, essais, trouve: true };
  const d = encodePlateau(plateau);
  assert.deepEqual(decodePlateau(d), plateau);
  assert.equal(decodePlateau("n'importe quoi"), null);
  assert.equal(decodePlateau(Buffer.from(JSON.stringify({ j: 1, s: "*", m: 6, e: [], t: 0 })).toString("base64url")), null);
  const svg = buildPlateauSvg(plateau);
  assert.ok(svg.startsWith("<svg") && svg.includes("Trouvé en 2 essais"));
  // Pseudo échappé dans le récap
  assert.ok(buildRecapSvg({ jour: 3, grilles: [{ nom: "<b>&", trouve: true, retours: [[2, 2, 2, 2, 2, 2]] }] }).includes("&lt;b&gt;&amp;"));
});
