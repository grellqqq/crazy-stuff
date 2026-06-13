/**
 * Roll-engine unit tests — design/gdd/24-gacha-system.md §8 acceptance criteria.
 * Run: npx tsx --test tests/unit/gacha.test.ts
 *
 * Uses a seeded PRNG for determinism. No DB, no network — the engine is pure.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';

import {
  buildPool, computeOdds, pullBatch, seededRng, GACHA_CONFIG, RARITIES,
  freeAvailable, nextMidnightUTC,
  type Pool,
} from '../../src/shared/gacha.ts';
import type { ItemDef, Rarity } from '../../src/shared/items.ts';

/** Build a synthetic catalog with N items per given rarity. */
function makePool(counts: Partial<Record<Rarity, number>>): Pool {
  const items: Record<string, ItemDef> = {};
  for (const r of RARITIES) {
    for (let i = 0; i < (counts[r] ?? 0); i++) {
      const id = `${r}_${i}`;
      items[id] = { id, slot: 'upper_body', fitProfile: 'shared', displayName: id, rarity: r };
    }
  }
  return buildPool(items);
}

test('AC1 — renormalized odds match F1 within ±0.5pp (today: 25 common + 1 rare)', () => {
  const pool = makePool({ common: 25, rare: 1 });
  const odds = computeOdds(pool);
  // F1: P(C) = 50/65 = 0.7692, P(R) = 15/65 = 0.2308
  assert.ok(Math.abs((odds.common ?? 0) - 50 / 65) < 1e-9);
  assert.ok(Math.abs((odds.rare ?? 0) - 15 / 65) < 1e-9);
  assert.equal(odds.uncommon, undefined); // empty tier absent

  // empirical: 100k rolls, frequencies within 0.5pp
  const rng = seededRng(12345);
  const N = 100_000;
  let common = 0, rare = 0;
  for (let i = 0; i < N; i++) {
    const { results } = pullBatch({ pool, count: 1, pityCounter: 0, rng });
    if (results[0].rarity === 'common') common++;
    else if (results[0].rarity === 'rare') rare++;
  }
  assert.ok(Math.abs(common / N - 50 / 65) < 0.005, `common ${common / N}`);
  assert.ok(Math.abs(rare / N - 15 / 65) < 0.005, `rare ${rare / N}`);
});

test('AC1b — full six-tier pool renormalizes to the raw weights', () => {
  const pool = makePool({ common: 5, uncommon: 5, rare: 5, epic: 5, legendary: 5, crazy: 5 });
  const odds = computeOdds(pool);
  const sum = Object.values(GACHA_CONFIG.tierWeights).reduce((a, b) => a + b, 0);
  for (const r of RARITIES) {
    assert.ok(Math.abs((odds[r] ?? 0) - GACHA_CONFIG.tierWeights[r] / sum) < 1e-9, r);
  }
});

test('AC4 — pity forces Epic+ at the threshold and resets the counter', () => {
  // Pool with Epic+ present so pity can fire.
  const pool = makePool({ common: 25, rare: 1, epic: 2, legendary: 1, crazy: 1 });
  const rng = seededRng(999);
  // Start one short of the threshold; a single sub-Epic pull tips it over,
  // then the NEXT pull must be Epic+.
  let pity = GACHA_CONFIG.pityThreshold; // already at threshold
  const { results, pityCounter } = pullBatch({ pool, count: 1, pityCounter: pity, rng });
  const rank = RARITIES.indexOf(results[0].rarity);
  assert.ok(rank >= RARITIES.indexOf('epic'), `forced pull was ${results[0].rarity}`);
  assert.equal(pityCounter, 0, 'counter resets after Epic+');
});

test('AC4b — dormancy: pity never forces while no Epic+ tier exists; counter climbs', () => {
  const pool = makePool({ common: 25, rare: 1 }); // no Epic+
  const rng = seededRng(7);
  const { results, pityCounter } = pullBatch({ pool, count: 1, pityCounter: 80, rng });
  assert.ok(['common', 'rare'].includes(results[0].rarity));
  assert.equal(pityCounter, 81, 'counter keeps climbing during dormancy');
});

test('AC5 — 10-pull forces Rare+ on the last slot only when no natural Rare+ appeared', () => {
  const pool = makePool({ common: 25, rare: 1 });
  // Find a seed whose first 9 rolls are all common (so the guarantee must fire).
  let forcedSeen = false;
  for (let seed = 1; seed < 400 && !forcedSeen; seed++) {
    const rng = seededRng(seed);
    const { results } = pullBatch({ pool, count: 10, pityCounter: 0, rng });
    const rareIdx = results.findIndex((r) => RARITIES.indexOf(r.rarity) >= RARITIES.indexOf('rare'));
    // The guarantee guarantees AT LEAST one Rare+ in every 10-pull.
    assert.ok(rareIdx >= 0, `seed ${seed}: 10-pull had no Rare+`);
    const first9AllCommon = results.slice(0, 9).every((r) => r.rarity === 'common');
    if (first9AllCommon) {
      forcedSeen = true;
      assert.equal(rareIdx, 9, `seed ${seed}: forced Rare+ should land on slot 10`);
    }
  }
  assert.ok(forcedSeen, 'expected at least one seed exercising the forced-last-slot path');
});

test('AC5b — every 10-pull contains a Rare+ across many seeds', () => {
  const pool = makePool({ common: 25, rare: 1 });
  for (let seed = 1; seed <= 200; seed++) {
    const rng = seededRng(seed);
    const { results } = pullBatch({ pool, count: 10, pityCounter: 0, rng });
    assert.ok(
      results.some((r) => RARITIES.indexOf(r.rarity) >= RARITIES.indexOf('rare')),
      `seed ${seed} produced no Rare+`,
    );
  }
});

test('POOL_EMPTY throws when no eligible items exist', () => {
  const pool = makePool({});
  assert.throws(() => pullBatch({ pool, count: 1, pityCounter: 0, rng: seededRng(1) }), /POOL_EMPTY/);
});

test('AC7 — free pull resets on the UTC day boundary', () => {
  // Pulled at 23:59:59Z; one second later is a new UTC day → available again.
  const lateYesterday = new Date('2026-06-13T23:59:59Z');
  const justAfterMidnight = new Date('2026-06-14T00:00:01Z');
  const sameDayLater = new Date('2026-06-13T23:59:59.500Z');

  assert.equal(freeAvailable(lateYesterday, sameDayLater), false, 'same UTC day → used');
  assert.equal(freeAvailable(lateYesterday, justAfterMidnight), true, 'crossed midnight → available');
  assert.equal(freeAvailable(null, sameDayLater), true, 'never pulled → available');

  // nextFreeAt points at the upcoming UTC midnight.
  assert.equal(nextMidnightUTC(lateYesterday).toISOString(), '2026-06-14T00:00:00.000Z');
});
