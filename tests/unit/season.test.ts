/**
 * Seasonal-leaderboard time math — unit tests for src/shared/season.ts.
 * Run: npx tsx --test tests/unit/season.test.ts
 *
 * Pure functions — no DB, no network. Dates are constructed explicitly (UTC).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  currentSeasonId, seasonLabel, compareLeaderboard,
  type RankableEntry,
} from '../../src/shared/season.ts';

test('season_currentSeasonId_midMonth_returnsZeroPaddedYearMonth', () => {
  // Arrange
  const when = new Date(Date.UTC(2026, 5, 18, 12, 0, 0)); // June 18 2026 UTC
  // Act
  const id = currentSeasonId(when);
  // Assert
  assert.equal(id, '2026-06');
});

test('season_currentSeasonId_january_padsToTwoDigits', () => {
  const id = currentSeasonId(new Date(Date.UTC(2027, 0, 1, 0, 0, 0)));
  assert.equal(id, '2027-01');
});

test('season_currentSeasonId_december_returnsMonth12', () => {
  const id = currentSeasonId(new Date(Date.UTC(2026, 11, 31, 23, 59, 59)));
  assert.equal(id, '2026-12');
});

test('season_currentSeasonId_usesUTCNotLocalTime', () => {
  // 2026-07-01 00:30 UTC is still July in UTC regardless of the runner's TZ.
  const id = currentSeasonId(new Date(Date.UTC(2026, 6, 1, 0, 30, 0)));
  assert.equal(id, '2026-07');
});

test('season_seasonLabel_validId_returnsMonthNameAndYear', () => {
  assert.equal(seasonLabel('2026-06'), 'June 2026');
  assert.equal(seasonLabel('2027-01'), 'January 2027');
  assert.equal(seasonLabel('2026-12'), 'December 2026');
});

test('season_seasonLabel_malformedId_fallsBackToRaw', () => {
  assert.equal(seasonLabel('not-a-season'), 'not-a-season');
});

test('season_compareLeaderboard_higherXpRanksFirst', () => {
  // Arrange
  const lower: RankableEntry = { seasonXp: 100, seasonWins: 9, username: 'aaa' };
  const higher: RankableEntry = { seasonXp: 200, seasonWins: 0, username: 'zzz' };
  // Act
  const ordered = [lower, higher].sort(compareLeaderboard);
  // Assert — XP dominates wins and username
  assert.deepEqual(ordered.map((e) => e.username), ['zzz', 'aaa']);
});

test('season_compareLeaderboard_equalXp_winsBreakTie', () => {
  const fewWins: RankableEntry = { seasonXp: 100, seasonWins: 1, username: 'aaa' };
  const moreWins: RankableEntry = { seasonXp: 100, seasonWins: 5, username: 'zzz' };
  const ordered = [fewWins, moreWins].sort(compareLeaderboard);
  assert.deepEqual(ordered.map((e) => e.username), ['zzz', 'aaa']);
});

test('season_compareLeaderboard_equalXpAndWins_usernameBreaksTieStably', () => {
  const b: RankableEntry = { seasonXp: 50, seasonWins: 2, username: 'bob' };
  const a: RankableEntry = { seasonXp: 50, seasonWins: 2, username: 'alice' };
  const ordered = [b, a].sort(compareLeaderboard);
  assert.deepEqual(ordered.map((e) => e.username), ['alice', 'bob']);
});
