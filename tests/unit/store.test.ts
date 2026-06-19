/**
 * Coin store config unit tests — src/shared/store.ts (System #25).
 * Run: npx tsx --test tests/unit/store.test.ts
 *
 * Pure functions over synthetic ItemDefs — no DB, no network.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { STORE_PRICES, STORE_SIZE, storePrice, inStorePool } from '../../src/shared/store.ts';
import type { ItemDef } from '../../src/shared/items.ts';

function item(over: Partial<ItemDef>): ItemDef {
  return {
    id: 'x', slot: 'head_accessory', fitProfile: 'shared',
    displayName: 'X', rarity: 'common', ...over,
  };
}

test('store_size_isFive', () => {
  assert.equal(STORE_SIZE, 5);
});

test('store_price_matchesRarityTable', () => {
  assert.equal(storePrice(item({ rarity: 'common' })), STORE_PRICES.common);
  assert.equal(storePrice(item({ rarity: 'crazy' })), STORE_PRICES.crazy);
  // Pricier tier is monotonic by rarity.
  const order: Array<ItemDef['rarity']> = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'crazy'];
  for (let i = 1; i < order.length; i++) {
    assert.ok(STORE_PRICES[order[i]] > STORE_PRICES[order[i - 1]], `${order[i]} > ${order[i - 1]}`);
  }
});

test('store_pool_releasedAndStoreSourced_isEligible', () => {
  // Released, no explicit sources (defaults to gacha+store) → eligible.
  assert.equal(inStorePool(item({})), true);
  // Released, explicit store source → eligible.
  assert.equal(inStorePool(item({ sources: ['store'] })), true);
});

test('store_pool_unreleased_isExcluded', () => {
  assert.equal(inStorePool(item({ released: false })), false);
});

test('store_pool_nonStoreSource_isExcluded', () => {
  // Gacha-only or event-only items never enter the coin store.
  assert.equal(inStorePool(item({ sources: ['gacha'] })), false);
  assert.equal(inStorePool(item({ sources: ['event'] })), false);
});
