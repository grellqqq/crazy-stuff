/**
 * Coin store integration test (#25) — runs the REAL persistence path against
 * mongodb-memory-server, exercising the curated rotation, transactional coin
 * debit + item grant, buyId idempotency, dupes-allowed, and the rejection
 * paths (not-in-rotation, insufficient coins).
 *
 * Run: npx tsx --test tests/integration/store.int.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { currentSeasonId } from '../../src/shared/season.ts';
import { STORE_PRICES } from '../../src/shared/store.ts';

let replset: MongoMemoryReplSet;
let mongo: typeof import('../../src/server/src/db/mongo.ts');

const USER = 'store-user-1';

async function setCoins(amount: number): Promise<void> {
  await mongo.getDB().collection('players').updateOne({ userId: USER }, { $set: { coins: amount } });
}
async function coins(): Promise<number> {
  const p = await mongo.getPlayer(USER);
  return p!.coins;
}
async function invCount(itemId: string): Promise<number> {
  // getInventory normalizes to snake_case (item_id), matching the client UIs.
  const inv = await mongo.getInventory(USER);
  return inv.filter((i: any) => i.item_id === itemId).length;
}

before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = replset.getUri();
  mongo = await import('../../src/server/src/db/mongo.ts');
  await mongo.connectDB();
  await mongo.getOrCreatePlayer(USER, 'Shopper');
  // Curate this month's store: two commons (500) + a rare (4000).
  await mongo.setStoreRotation(currentSeasonId(), ['tshirt_red', 'tshirt_blue', 'wizard_hat']);
});

after(async () => {
  await mongo?.closeDB();
  await replset?.stop({ doCleanup: true, force: true });
});

test('store_getCurrent_returnsCuratedItemsWithRarityPrices', async () => {
  const store = await mongo.getCurrentStore();
  assert.equal(store.seasonId, currentSeasonId());
  const ids = store.items.map((i: any) => i.id).sort();
  assert.deepEqual(ids, ['tshirt_blue', 'tshirt_red', 'wizard_hat']);
  const wizard = store.items.find((i: any) => i.id === 'wizard_hat');
  assert.equal(wizard.price, STORE_PRICES.rare);
  const tee = store.items.find((i: any) => i.id === 'tshirt_red');
  assert.equal(tee.price, STORE_PRICES.common);
});

test('store_buy_debitsCoinsAndGrantsItem', async () => {
  // Arrange
  await setCoins(10000);
  // Act
  const result = await mongo.buyStoreItem(USER, 'wizard_hat', 'buy-1');
  // Assert
  assert.equal(result.price, STORE_PRICES.rare);
  assert.equal(result.coins, 10000 - STORE_PRICES.rare);
  assert.equal(await coins(), 10000 - STORE_PRICES.rare);
  assert.equal(await invCount('wizard_hat'), 1, 'item granted once');
});

test('store_buy_sameBuyId_isIdempotent', async () => {
  // Arrange — coins after the previous test.
  const before = await coins();
  // Act — replay the SAME buyId.
  const replay = await mongo.buyStoreItem(USER, 'wizard_hat', 'buy-1');
  // Assert — no second charge, no second grant.
  assert.equal(replay.idempotent, true);
  assert.equal(await coins(), before, 'not charged again');
  assert.equal(await invCount('wizard_hat'), 1, 'still exactly one');
});

test('store_buy_allowsDuplicates_withNewBuyId', async () => {
  await setCoins(10000);
  await mongo.buyStoreItem(USER, 'tshirt_red', 'buy-dup-A');
  await mongo.buyStoreItem(USER, 'tshirt_red', 'buy-dup-B');
  assert.equal(await invCount('tshirt_red'), 2, 'duplicates allowed');
  assert.equal(await coins(), 10000 - 2 * STORE_PRICES.common);
});

test('store_buy_itemNotInRotation_rejected', async () => {
  await setCoins(10000);
  await assert.rejects(
    () => mongo.buyStoreItem(USER, 'tshirt_green', 'buy-bad-1'),
    (e: any) => e.code === 'NOT_IN_STORE',
  );
  assert.equal(await coins(), 10000, 'no charge on rejected buy');
});

test('store_buy_insufficientCoins_rejected', async () => {
  await setCoins(100); // less than a 500 common
  await assert.rejects(
    () => mongo.buyStoreItem(USER, 'tshirt_blue', 'buy-poor-1'),
    (e: any) => e.code === 'INSUFFICIENT_COINS',
  );
  assert.equal(await coins(), 100, 'untouched');
  assert.equal(await invCount('tshirt_blue'), 0, 'nothing granted');
});

test('store_setRotation_rejectsUnreleasedOrTooMany', async () => {
  // Unreleased catalog item (art-gated) cannot be curated.
  await assert.rejects(
    () => mongo.setStoreRotation('2099-01', ['hoodie_black']),
    (e: any) => e.code === 'INVALID_ITEM',
  );
  // More than STORE_SIZE (5) released items.
  await assert.rejects(
    () => mongo.setStoreRotation('2099-02',
      ['tshirt_red', 'tshirt_blue', 'tshirt_green', 'tshirt_white', 'tshirt_black', 'tshirt_pink']),
    (e: any) => e.code === 'TOO_MANY',
  );
});
