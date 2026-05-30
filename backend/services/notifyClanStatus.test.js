import assert from "assert";
import {
  buildClanStatusEmbed,
  buildClanStatusPayload,
  collectClanStatusIssues,
} from "../../scripts/notifyClanStatus.js";

const warDayNow = new Date("2026-05-28T11:00:00.000Z");
const trainingDayNow = new Date("2026-05-27T11:00:00.000Z");

const openClan = {
  clan: {
    name: "La Resistance",
    type: "open",
  },
};

const inviteOnlyClan = {
  clan: {
    name: "Les Resistants",
    type: "inviteOnly",
  },
};

const warDayIssue = collectClanStatusIssues(openClan, "Y8JUPC9C", warDayNow);
assert.ok(warDayIssue, "War day should require InvitationOnly");
assert.strictEqual(warDayIssue.expectedType, "inviteOnly");
assert.strictEqual(warDayIssue.actualType, "open");

const trainingDayIssue = collectClanStatusIssues(
  inviteOnlyClan,
  "LRQP20V9",
  trainingDayNow,
);
assert.ok(trainingDayIssue, "Training day should require open status");
assert.strictEqual(trainingDayIssue.expectedType, "open");
assert.strictEqual(trainingDayIssue.actualType, "inviteOnly");

const embed = buildClanStatusEmbed(warDayIssue);
assert.strictEqual(
  embed.title,
  "<:sweat:1504139431106576405> Avertissement statut du clan",
);
assert.strictEqual(embed.fields[0].name, "Statut actuel");
assert.strictEqual(embed.fields[1].value, "InvitationOnly");

const payload = buildClanStatusPayload(warDayIssue, {
  id: "1234567890",
  mention: "<@&1234567890>",
});
assert.strictEqual(payload.content, "<@&1234567890>");
assert.deepStrictEqual(payload.allowed_mentions, {
  parse: [],
  roles: ["1234567890"],
});

console.log("notifyClanStatus.test.js passed");
