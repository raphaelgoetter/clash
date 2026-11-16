import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildFinSvg,
  buildMainSvg,
  buildMancheSvg,
  decodeFin,
  decodeMain,
  decodeManche,
  encodeFin,
  encodeMain,
  encodeManche,
  meilleureCombinaison,
} from "./gobeletImage.js";

test("encodeMain / decodeMain : aller-retour d'une main en cours, adversaire compris", () => {
  const main = decodeMain(
    encodeMain({
      nom: "Raphaël 🎉",
      des: [5, 6, 3, 3, 2],
      tirage: 2,
      statut: "en_cours",
      used: ["Brelan", "Full"],
      adversaire: { nom: "Bob", used: ["Carré", "Joker"] },
      legende: "Manche 3/5",
    }),
  );
  assert.deepEqual(main, {
    nom: "Raphaël",
    des: [5, 6, 3, 3, 2],
    tirage: 2,
    statut: "en_cours",
    category: null,
    points: 0,
    used: ["Brelan", "Full"],
    adversaire: { nom: "Bob", used: ["Carré", "Joker"] },
    legende: "Manche 3/5",
  });
  const svg = buildMainSvg(main);
  assert.match(svg, />2\/3</);
  assert.match(svg, /Déjà faite par Bob/);
});

test("encodeMain : main terminée, combinaison retenue ; paramètre illisible → null", () => {
  const main = decodeMain(
    encodeMain({ nom: "A", des: [4, 4, 4, 4, 2], tirage: 3, statut: "termine", category: "Carré", points: 40, legende: "Manche 1/5" }),
  );
  assert.equal(main.category, "Carré");
  assert.equal(main.points, 40);
  assert.equal(main.adversaire, null);
  assert.match(buildMainSvg(main), /Carré \+40/);
  assert.equal(decodeMain("pas-du-json"), null);
  assert.equal(decodeMain(Buffer.from(JSON.stringify({ d: "12" })).toString("base64url")), null);
});

test("encodeManche / decodeManche : un ou deux joueurs", () => {
  const manche = decodeManche(
    encodeManche({
      titre: "Manche 2 : Raphaël +35",
      joueurs: [
        { nom: "Raphaël", des: [3, 3, 3, 5, 5], category: "Full", points: 35, total: 75 },
        { nom: "Bob", des: [1, 2, 3, 4, 6], category: "Aucune combinaison", points: 0, total: 60 },
      ],
    }),
  );
  assert.equal(manche.titre, "Manche 2 : Raphaël +35");
  assert.deepEqual(
    manche.joueurs.map((j) => [j.nom, j.category, j.points, j.total]),
    [
      ["Raphaël", "Full", 35, 75],
      ["Bob", "Aucune combinaison", 0, 60],
    ],
  );
  const svg = buildMancheSvg(manche);
  assert.match(svg, /Full \+35/);
  assert.match(svg, /Total 60/);
  assert.equal(decodeManche(Buffer.from(JSON.stringify({ j: [] })).toString("base64url")), null);
});

test("meilleureCombinaison : plus de points, puis la plus ancienne ; null sans point", () => {
  const full = { points: 35, category: "Full", des: [3, 3, 3, 5, 5] };
  const pairs = { points: 35, category: "Pairs", des: [2, 2, 4, 6, 6] };
  assert.equal(meilleureCombinaison([full, pairs]), full);
  assert.equal(meilleureCombinaison([{ points: 0, category: "Aucune combinaison" }]), null);
});

test("encodeFin / decodeFin : solo et 1v1", () => {
  const manches = [
    { points: 35, category: "Full" },
    { points: 22, category: "Joker" },
    { points: 0, category: "Aucune combinaison" },
  ];
  const solo = decodeFin(
    encodeFin({ totalManches: 5, joueurs: [{ nom: "Raphaël", points: 57, manches, meilleure: { des: [3, 3, 3, 5, 5], category: "Full", points: 35 } }] }),
  );
  assert.equal(solo.totalManches, 5);
  assert.deepEqual(solo.joueurs[0].manches, manches);
  assert.deepEqual(solo.joueurs[0].meilleure, { des: [3, 3, 3, 5, 5], category: "Full", points: 35 });
  assert.match(buildFinSvg(solo), /Full · 35 pts/);

  const pvp = decodeFin(
    encodeFin({
      totalManches: 5,
      joueurs: [
        { nom: "A", points: 57, manches, meilleure: null },
        { nom: "B", points: 40, manches, meilleure: null },
      ],
    }),
  );
  assert.equal(pvp.joueurs[1].meilleure, null);
  assert.match(buildFinSvg(pvp), /Victoire de A/);
  assert.equal(decodeFin("pas-du-json"), null);
});
