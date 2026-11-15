import assert from "assert";
import { buildPublicSvg, decodePublic, encodePublic } from "./potatoImage.js";

// Barre publique : un Glaçon (chauffe négative) survit à l'encodage et
// s'affiche en bande glacée
{
  const chauffes = [[0, 15], [1, 10], [0, -15], [1, 5]];
  const d = decodePublic(encodePublic({ noms: ["A", "B"], manches: [0, 0], chauffes }));
  assert.deepStrictEqual(d.chauffes, chauffes);
  assert.ok(buildPublicSvg(d).includes("−15"));
  // Valeurs hors bornes écartées
  const e = decodePublic(encodePublic({ noms: ["A", "B"], manches: [0, 0], chauffes: [[0, -40], [0, 0], [1, 10]] }));
  assert.deepStrictEqual(e.chauffes, [[1, 10]]);
}
