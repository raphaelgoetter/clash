import { test } from "node:test";
import assert from "node:assert/strict";
import { texteAffichable, tronquer } from "./texteImage.js";

test("texteAffichable remplace les petites capitales", () => {
  assert.equal(texteAffichable("ᴄʟᴀsʜ ᴋɪɴɢ"), "CLAsH KING");
  assert.equal(texteAffichable("F𝕠𝕣𝕥"), "F𝕠𝕣𝕥");
});

test("texteAffichable retire les sélecteurs de variante", () => {
  assert.equal(texteAffichable("𝐋𝐮𝐟𝐟𝐲❤️"), "𝐋𝐮𝐟𝐟𝐲❤");
});

test("tronquer compte les graphèmes, pas les unités UTF-16", () => {
  assert.equal(tronquer("F𝕠𝕣𝕥 𝕄𝕚𝕟𝕠𝕣", 11), "F𝕠𝕣𝕥 𝕄𝕚𝕟𝕠𝕣");
  assert.equal(tronquer("𝕾𝖆̊𝖙𝖔̸𝖗𝖚̄✰", 4), "𝕾𝖆̊𝖙…");
  assert.equal(tronquer("⚡𝐋𝐮𝐟𝐟𝐲❤️𝐁𝐚𝐢𝐭⚡", 8), "⚡𝐋𝐮𝐟𝐟𝐲❤…");
});

test("tronquer laisse les textes courts intacts", () => {
  assert.equal(tronquer("nb", 11), "nb");
  assert.equal(tronquer("☆. Père Fouras", 11), "☆. Père Fo…");
});
