import { test } from "node:test";
import assert from "node:assert/strict";
import { buildUserPingFields } from "./discordRoles.js";

test("buildUserPingFields : mentionne les vrais identifiants, sans PNJ ni doublon", () => {
  const r = buildUserPingFields(["643461492599029782", "pnj-1", "643461492599029782", "497391862307487751"]);
  assert.equal(r.content, "<@643461492599029782> <@497391862307487751>");
  assert.deepEqual(r.allowed_mentions, { parse: [], users: ["643461492599029782", "497391862307487751"] });
});

test("buildUserPingFields : rien à mentionner → aucun champ", () => {
  assert.deepEqual(buildUserPingFields([]), {});
  assert.deepEqual(buildUserPingFields(["pnj-2"]), {});
});
