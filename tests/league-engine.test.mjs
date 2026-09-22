// This used to diff App.jsx's own replayGames/computePlacements against the
// shared engine module, as a migration-safety check while both copies
// existed. App.jsx now imports directly from
// supabase/functions/_shared/leagueEngine.mjs (single source of truth per
// CMD-02) -- there is no separate "legacy" copy left to diff against, so
// that comparison always fails on a ReferenceError. Replaced with direct
// determinism/invariant checks of the shared module itself.
import test from "node:test";
import assert from "node:assert/strict";
import * as shared from "../supabase/functions/_shared/leagueEngine.mjs";

function fixture(preference) {
  const players = ["a", "b", "c", "d"].map((id) => ({ id, name: id, preferredRole: preference, mmr: 1000, pts: 0 }));
  const games = Array.from({ length: 12 }, (_, i) => ({
    id: "g" + i,
    date: new Date(Date.UTC(2026, 8, i + 1, 12)).toISOString(),
    sideA: ["a", "b"],
    sideB: ["c", "d"],
    scoreA: i % 2 ? 4 : 10,
    scoreB: i % 2 ? 10 : 6,
    winner: i % 2 ? "B" : "A",
    roles: { a: "ATK", b: "DEF", c: i % 3 ? "ATK" : "FLEX", d: i % 3 ? "DEF" : "FLEX" },
    penalties: i === 6 ? { a: { yellow: 1, red: 0 } } : {},
  }));
  const seasons = [{ id: "season", startAt: "2026-09-01T00:00:00Z" }];
  return { players, games, seasons };
}

for (const preference of ["ATK", "DEF", "FLEX"]) {
  test("replayGames is deterministic: " + preference, () => {
    const { players, games, seasons } = fixture(preference);
    const first = shared.replayGames(players, games, seasons[0].startAt, seasons);
    const second = shared.replayGames(players, games, seasons[0].startAt, seasons);
    assert.deepEqual(first, second);
    assert.equal(first.players.length, players.length);
    for (const id of ["a", "b", "c", "d"]) {
      assert.ok(first.players.some((p) => p.id === id), `missing player ${id}`);
    }
  });

  test("computePlacements is deterministic: " + preference, () => {
    const { games, seasons } = fixture(preference);
    const first = shared.computePlacements(games, seasons);
    const second = shared.computePlacements(games, seasons);
    assert.deepEqual(first, second);
  });
}
