import { test } from "node:test";
import assert from "node:assert/strict";
import { rosterAtDayEnd, wasInClanAtDayEnd } from "./arrivalUtils.js";

test("rosterAtDayEnd : tags normalisés depuis la capture pré-reset", () => {
  const roster = rosterAtDayEnd({
    _cumulFamePreReset: { "#ABC123": 900, "#def456": 0 },
  });
  assert.deepEqual([...roster].sort(), ["ABC123", "DEF456"]);
});

test("rosterAtDayEnd : repli sur _cumulPreReset (snapshot brut)", () => {
  const roster = rosterAtDayEnd({ _cumulPreReset: { "#ABC123": 4 } });
  assert.ok(roster.has("ABC123"));
});

test("rosterAtDayEnd : null sans capture pré-reset", () => {
  assert.equal(rosterAtDayEnd({ decks: { "#ABC123": 4 } }), null);
  assert.equal(rosterAtDayEnd({ _cumulFamePreReset: {} }), null);
  assert.equal(rosterAtDayEnd(null), null);
});

test("wasInClanAtDayEnd : arrivé après la journée écarté, inconnu conservé", () => {
  const roster = rosterAtDayEnd({ _cumulFamePreReset: { "#ABC123": 0 } });
  assert.equal(wasInClanAtDayEnd(roster, "#abc123"), true);
  assert.equal(wasInClanAtDayEnd(roster, "#UV092Q9RG"), false);
  assert.equal(wasInClanAtDayEnd(null, "#UV092Q9RG"), true);
});
