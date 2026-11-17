import { test } from "node:test";
import assert from "node:assert/strict";
import { buildBandeauSvg, buildGrilleSvg, decodeGrille, encodeGrille } from "./quatreImage.js";
import { creerDuel, poser } from "./quatreRules.js";

test("encodeGrille / decodeGrille : pions vus par le siège demandé, dernier coup, noms sans emoji", () => {
  const d = creerDuel();
  poser(d, "joueur", 3);
  poser(d, "bot", 3);
  poser(d, "joueur", 2);
  const vueBot = decodeGrille(encodeGrille(d, "bot", { moi: "Toi", adv: "Raphaël 🎉" }));
  assert.deepEqual(vueBot, {
    colonnes: [[], [], ["rouge"], ["rouge", "bleu"], [], [], []],
    noms: { moi: "Toi", adv: "Raphaël" },
    dernier: [2, 0],
    alignement: [],
  });
  const vueJoueur = decodeGrille(encodeGrille(d, "joueur", { moi: "Toi", adv: "Kévina" }));
  assert.deepEqual(vueJoueur.colonnes[3], ["bleu", "rouge"]);
});

test("encodeGrille : alignement gagnant cerclé d'or dans l'image", () => {
  const d = creerDuel();
  for (const [id, c] of [["joueur", 0], ["bot", 6], ["joueur", 1], ["bot", 6], ["joueur", 2], ["bot", 6], ["joueur", 3]]) poser(d, id, c);
  assert.equal(d.gagnant, "joueur");
  const grille = decodeGrille(encodeGrille(d, "joueur", { moi: "Toi", adv: "Kévina" }));
  assert.deepEqual([...grille.alignement].sort(), [[0, 0], [1, 0], [2, 0], [3, 0]]);
  const svg = buildGrilleSvg(grille);
  assert.equal(svg.match(/stroke="#f0c040"/g)?.length, 4);
  assert.match(svg, />Kévina</);
});

test("decodeGrille : paramètre invalide → null", () => {
  assert.equal(decodeGrille("pas-du-json"), null);
  assert.equal(decodeGrille(Buffer.from(JSON.stringify({ g: "b-r" })).toString("base64url")), null);
});

test("buildBandeauSvg : numéro de la colonne dans le pion", () => {
  assert.match(buildBandeauSvg(0), />1</);
  assert.match(buildBandeauSvg(6), />7</);
});
