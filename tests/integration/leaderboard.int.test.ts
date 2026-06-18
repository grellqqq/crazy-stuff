/**
 * Seasonal-leaderboard integration test (#23) — runs the REAL persistence path
 * against mongodb-memory-server, so awardPostRace season rollover, the
 * {seasonId, seasonXp} ranking query, and getPlayerSeasonRank are exercised
 * for real. Covers ranking order, the wins/username tiebreaks, footer-rank vs
 * board-row consistency, unranked players, and month rollover.
 *
 * Run: npx tsx --test tests/integration/leaderboard.int.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { currentSeasonId } from '../../src/shared/season.ts';

let replset: MongoMemoryReplSet;
let mongo: typeof import('../../src/server/src/db/mongo.ts');

before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = replset.getUri();
  mongo = await import('../../src/server/src/db/mongo.ts');
  await mongo.connectDB();
});

after(async () => {
  await mongo?.closeDB();
  await replset?.stop({ doCleanup: true, force: true });
});

test('leaderboard_rank_byXpThenWins_ordersCorrectly', async () => {
  // Arrange — three players, season scores set via awardPostRace.
  await mongo.getOrCreatePlayer('u-alice', 'alice');
  await mongo.getOrCreatePlayer('u-bob', 'bob');
  await mongo.getOrCreatePlayer('u-cara', 'cara');
  // alice: 300 XP, 1 win
  await mongo.awardPostRace('u-alice', 300, 10, true);
  // bob: 300 XP across 3 winning races → ties alice on XP, more wins
  await mongo.awardPostRace('u-bob', 100, 10, true);
  await mongo.awardPostRace('u-bob', 200, 10, true);
  await mongo.awardPostRace('u-bob', 0, 0, true);
  // cara: 500 XP, 0 wins
  await mongo.awardPostRace('u-cara', 500, 10, false);

  // Act
  const board = await mongo.getLeaderboard(10);

  // Assert — cara leads on XP; bob beats alice on the wins tiebreak at 300 XP.
  assert.equal(board.seasonId, currentSeasonId());
  assert.deepEqual(board.entries.map((e: any) => e.username), ['cara', 'bob', 'alice']);
  assert.deepEqual(board.entries.map((e: any) => e.rank), [1, 2, 3]);
  assert.deepEqual(board.entries.map((e: any) => e.seasonXp), [500, 300, 300]);
  assert.deepEqual(board.entries.map((e: any) => e.seasonWins), [0, 3, 1]);
});

test('leaderboard_playerRank_matchesBoardRow_forTiedPlayer', async () => {
  // alice is tied with bob on XP but loses the wins tiebreak → row #3.
  const aliceRank = await mongo.getPlayerSeasonRank('u-alice');
  assert.equal(aliceRank.rank, 3, 'footer rank matches board row, not the XP-only #2');
  assert.equal(aliceRank.seasonXp, 300);
  assert.equal(aliceRank.seasonWins, 1);
  assert.equal(aliceRank.totalRanked, 3);

  const caraRank = await mongo.getPlayerSeasonRank('u-cara');
  assert.equal(caraRank.rank, 1);
});

test('leaderboard_playerRank_neverScored_isUnranked', async () => {
  // Arrange — a fresh player who has not raced this season.
  await mongo.getOrCreatePlayer('u-dan', 'dan');
  // Act
  const danRank = await mongo.getPlayerSeasonRank('u-dan');
  // Assert
  assert.equal(danRank.rank, null);
  assert.equal(danRank.seasonXp, 0);
  assert.equal(danRank.totalRanked, 3, 'dan is not counted among ranked players');

  const board = await mongo.getLeaderboard(10);
  assert.ok(!board.entries.some((e: any) => e.username === 'dan'), 'unscored player absent from board');
});

test('leaderboard_seasonRollover_resetsPointsOnNewSeason', async () => {
  // Arrange — force alice into a PAST season with stale points, as if last month.
  const db = mongo.getDB();
  await db.collection('players').updateOne(
    { userId: 'u-alice' },
    { $set: { seasonId: '2000-01', seasonXp: 9999, seasonWins: 42 } },
  );

  // Act — a new race in the current season must roll the season totals over.
  await mongo.awardPostRace('u-alice', 150, 5, true);

  // Assert — season points reflect only the new race, not last season's 9999.
  const rank = await mongo.getPlayerSeasonRank('u-alice');
  assert.equal(rank.seasonXp, 150, 'stale 9999 dropped; only this race counts');
  assert.equal(rank.seasonWins, 1, 'stale 42 wins dropped');

  // Lifetime XP, by contrast, keeps accumulating across seasons.
  const player = await mongo.getPlayer('u-alice');
  assert.equal(player!.xp, 450, 'lifetime xp = 300 + 150, unaffected by rollover');
});
