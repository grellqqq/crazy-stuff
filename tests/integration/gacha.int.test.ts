/**
 * Gacha integration test — runs the REAL persistence path against a real
 * single-node MongoDB replica set (mongodb-memory-server), so transactions,
 * the unique-pullId idempotency index, and the starter kit are exercised for
 * real. Covers gacha GDD §8 AC2 (idempotency), AC9 (starter kit), free-pull
 * gating, and the paid multi-pull guarantee.
 *
 * Run: GACHA_PAID_ENABLED=1 GACHA_DEV=1 npx tsx --test tests/integration/gacha.int.test.ts
 * (the env vars must be set before import — PAID_ENABLED is read at load time.)
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';

let replset: MongoMemoryReplSet;
let mongo: typeof import('../../src/server/src/db/mongo.ts');

before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = replset.getUri();
  process.env.GACHA_PAID_ENABLED = '1';
  process.env.GACHA_DEV = '1';
  mongo = await import('../../src/server/src/db/mongo.ts');
  await mongo.connectDB();
});

after(async () => {
  await mongo?.closeDB();
  await replset?.stop({ doCleanup: true, force: true });
});

const USER = 'authuser-1';

test('AC9 — new account gets the 3-item starter kit, auto-equipped', async () => {
  const player = await mongo.getOrCreatePlayer(USER, 'Tester');
  assert.ok(player);
  assert.equal(player!.pityCounter, 0);
  assert.equal(player!.lastFreePullAt, null);
  assert.equal(player!.pullCredits, 0);
  assert.deepEqual(player!.equippedLoadout, {
    upper_body: 'worn_tshirt', lower_body: 'blue_jeans', feet: 'beatup_sneakers',
  });

  const inv = await mongo.getInventory(USER);
  assert.equal(inv.length, 3, 'exactly 3 starter items');
  assert.deepEqual(
    inv.map((i: any) => i.itemId).sort(),
    ['beatup_sneakers', 'blue_jeans', 'worn_tshirt'],
  );
  assert.ok(inv.every((i: any) => i.equipped), 'all starter items equipped');
});

test('returning account is grandfathered (no re-grant, no backfill)', async () => {
  await mongo.getOrCreatePlayer(USER, 'Tester'); // login again
  const inv = await mongo.getInventory(USER);
  assert.equal(inv.length, 3, 'still 3 — no duplicate grant, no catalog backfill');
});

test('status reports a free pull available', async () => {
  const s = await mongo.getGachaStatus(USER);
  assert.equal(s.freeAvailable, true);
  assert.equal(s.pityCounter, 0);
  assert.equal(s.paidEnabled, true);
});

test('free pull grants exactly one item and consumes the daily entitlement', async () => {
  const out = await mongo.executePull(USER, 'pull-A', { count: 1, paid: false });
  assert.equal(out.funding, 'free');
  assert.equal(out.results.length, 1);

  const inv = await mongo.getInventory(USER);
  assert.equal(inv.length, 4, 'starter 3 + 1 pulled');

  const s = await mongo.getGachaStatus(USER);
  assert.equal(s.freeAvailable, false, 'free pull now used');
  assert.ok(s.nextFreeAt, 'countdown target set');
});

test('a second free pull the same UTC day is refused (edge case 1)', async () => {
  await assert.rejects(
    () => mongo.executePull(USER, 'pull-B', { count: 1, paid: false }),
    (e: any) => e?.code === 'FREE_PULL_USED',
  );
  const inv = await mongo.getInventory(USER);
  assert.equal(inv.length, 4, 'no extra item granted');
});

test('AC2 — replaying the same pullId returns the recorded result, no double grant', async () => {
  const replay = await mongo.executePull(USER, 'pull-A', { count: 1, paid: false });
  assert.equal(replay.idempotent, true);
  assert.equal(replay.results.length, 1);

  const inv = await mongo.getInventory(USER);
  assert.equal(inv.length, 4, 'still 4 — idempotent replay granted nothing');

  const pulls = await mongo.getDB().collection('pulls').find({ pullId: 'pull-A' }).toArray();
  assert.equal(pulls.length, 1, 'exactly one pull record for pullId');
});

test('AC5 — paid 10-pull grants 10 items including a guaranteed Rare+', async () => {
  const credits = await mongo.devGrantCredits(USER, 10);
  assert.equal(credits, 10);

  const out = await mongo.executePull(USER, 'pull-C', { count: 10, paid: true });
  assert.equal(out.funding, 'credits');
  assert.equal(out.results.length, 10);
  assert.ok(
    out.results.some((r: any) => ['rare', 'epic', 'legendary', 'crazy'].includes(r.rarity)),
    '10-pull guarantees Rare+',
  );

  const inv = await mongo.getInventory(USER);
  assert.equal(inv.length, 14, 'starter 3 + 1 free + 10 paid');

  const s = await mongo.getGachaStatus(USER);
  assert.equal(s.pullCredits, 0, 'all 10 credits consumed');
});

test('paid pull with no credits is refused', async () => {
  await assert.rejects(
    () => mongo.executePull(USER, 'pull-D', { count: 10, paid: true }),
    (e: any) => e?.code === 'INSUFFICIENT_CREDITS',
  );
});
