import assert from "assert";
import {
  buildInactiveEmbed,
  collectInactiveMembers,
  formatInactiveLine,
} from "../../scripts/notifyLastSeen.js";

const now = new Date("2026-05-28T11:00:00.000Z");

const clanOneMembers = [
  {
    name: "Alpha",
    tag: "#A1",
    role: "member",
    isNew: false,
    lastSeen: "20260524T110000.000Z",
  },
  {
    name: "Bravo",
    tag: "#B2",
    role: "elder",
    isNew: true,
    lastSeen: "20260521T110000.000Z",
  },
  {
    name: "Charlie",
    tag: "#C3",
    role: "leader",
    isNew: false,
    lastSeen: "20260528T060000.000Z",
  },
];

const clanThreeMembers = [
  {
    name: "Delta",
    tag: "#D4",
    role: "member",
    isNew: false,
    lastSeen: "20260523T110000.000Z",
  },
  {
    name: "Echo",
    tag: "#E5",
    role: "member",
    isNew: true,
    lastSeen: "20260521T110000.000Z",
  },
];

const clanOneResult = collectInactiveMembers(clanOneMembers, "Y8JUPC9C", now);
assert.strictEqual(
  clanOneResult.warnings.length,
  1,
  "Clan 1 should have one warning",
);
assert.strictEqual(
  clanOneResult.errors.length,
  1,
  "Clan 1 should have one error",
);
assert.ok(
  formatInactiveLine(clanOneResult.warnings[0]).includes(
    "pas connecté depuis 4 jours",
  ),
  "Warning line should mention 4 days",
);
assert.ok(
  formatInactiveLine(clanOneResult.errors[0]).includes("nouveau"),
  "Error line should mention new player",
);

const clanThreeResult = collectInactiveMembers(
  clanThreeMembers,
  "QU9UQJRL",
  now,
);
assert.strictEqual(
  clanThreeResult.warnings.length,
  0,
  "Clan 3 should not have warnings",
);
assert.strictEqual(
  clanThreeResult.errors.length,
  1,
  "Clan 3 should have one error only",
);

const embed = buildInactiveEmbed(
  "Y8JUPC9C",
  "La Resistance",
  clanOneResult.warnings,
  clanOneResult.errors,
);
assert.strictEqual(embed.title, "Avertissement joueurs inactifs");
assert.strictEqual(
  embed.fields.length,
  2,
  "Embed should expose both severities",
);

console.log("notifyLastSeen.test.js passed");
