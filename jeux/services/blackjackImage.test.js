import { test } from "node:test";
import assert from "node:assert/strict";
import { buildFinSvg, buildMainSvg, decodeFin, decodeMain, encodeFin, encodeMain, meilleureMain } from "./blackjackImage.js";

const carte = (rank, suit) => ({ rank, suit });

test("encodeMain / decodeMain : aller-retour d'une main contre un Croupier visible", () => {
  const d = encodeMain({
    joueur: { nom: "Raphaël 🎉", cartes: [carte("10", "♥️"), carte("A", "♣️")], score: 21, statut: "stand", issue: "win" },
    croupier: { nom: "Kévina", cartes: [carte("K", "♠️"), carte("7", "♦️")], score: 17 },
    legende: "Manche 3/10",
  });
  const main = decodeMain(d);
  assert.deepEqual(main.joueur, {
    nom: "Raphaël",
    cartes: [{ rang: "10", couleur: "♥" }, { rang: "A", couleur: "♣" }],
    score: 21,
    statut: "stand",
    issue: "win",
  });
  assert.deepEqual(main.croupier, {
    nom: "Kévina",
    cartes: [{ rang: "K", couleur: "♠" }, { rang: "7", couleur: "♦" }],
    score: 17,
    cache: false,
  });
  assert.equal(main.legende, "Manche 3/10");
});

test("encodeMain : Croupier caché, ni cartes ni score dans l'URL", () => {
  const d = encodeMain({
    joueur: { nom: "Toi", cartes: [carte("5", "♥️"), carte("6", "♣️")], score: 11, statut: "en_cours" },
    croupier: { nom: "Croupier", cartes: [carte("K", "♠️"), carte("9", "♦️")], score: 19, cache: true },
    legende: "Jour 4",
  });
  const brut = JSON.parse(Buffer.from(d, "base64url").toString("utf8"));
  assert.deepEqual(brut.c, ["Croupier"]);
  const main = decodeMain(d);
  assert.deepEqual(main.croupier, { nom: "Croupier", cache: true });
  assert.equal(main.joueur.issue, null);
  assert.ok(!buildMainSvg(main).includes(">19<"));
});

test("decodeMain : paramètre illisible → null ; 1v1 sans Croupier", () => {
  assert.equal(decodeMain("pas-du-json"), null);
  const main = decodeMain(
    encodeMain({ joueur: { nom: "A", cartes: [carte("K", "♥️"), carte("8", "♣️"), carte("5", "♦️")], score: 23, statut: "bust" } }),
  );
  assert.equal(main.croupier, null);
  assert.equal(main.joueur.statut, "bust");
  assert.match(buildMainSvg(main), /<svg/);
});

test("meilleureMain : plus haut score sans dépassement, puis moins de cartes ; null si tout dépasse", () => {
  const longue = { cartes: [carte("2", "♠️"), carte("9", "♥️"), carte("K", "♦️")], score: 21, statut: "stand" };
  const naturel = { cartes: [carte("A", "♠️"), carte("K", "♥️")], score: 21, statut: "stand" };
  const bust = { cartes: [carte("K", "♠️"), carte("Q", "♥️"), carte("5", "♦️")], score: 25, statut: "bust" };
  assert.equal(meilleureMain([longue, naturel, bust]), naturel);
  assert.equal(meilleureMain([{ ...naturel, score: 19 }, longue]), longue);
  assert.equal(meilleureMain([bust]), null);
});

test("encodeFin / decodeFin : aller-retour solo et 1v1", () => {
  const manches = [
    { score: 19, issue: "win" },
    { score: 24, issue: "bust" },
    { score: 20, issue: "push" },
  ];
  const solo = decodeFin(
    encodeFin({
      totalManches: 5,
      joueurs: [{ nom: "Raphaël", points: 3, manches, meilleure: { cartes: [carte("A", "♠️"), carte("8", "♥️")], score: 19 } }],
    }),
  );
  assert.equal(solo.totalManches, 5);
  assert.deepEqual(solo.joueurs[0].manches, manches);
  assert.deepEqual(solo.joueurs[0].meilleure, { cartes: [{ rang: "A", couleur: "♠" }, { rang: "8", couleur: "♥" }], score: 19 });
  assert.match(buildFinSvg(solo), /Meilleure main : 19/);

  const pvp = decodeFin(
    encodeFin({
      totalManches: 5,
      joueurs: [
        { nom: "A", points: 4, manches, meilleure: null },
        { nom: "B", points: 2, manches, meilleure: null },
      ],
    }),
  );
  assert.equal(pvp.joueurs.length, 2);
  assert.equal(pvp.joueurs[1].meilleure, null);
  assert.match(buildFinSvg(pvp), /Victoire de A/);
  assert.equal(decodeFin("pas-du-json"), null);
});
