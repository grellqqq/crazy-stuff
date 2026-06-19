/**
 * Coin store config (System #25, roadmap M2-3).
 *
 * The store sells a small set of **admin-curated** cosmetics for Crazy Coins,
 * rotated monthly (one `store_rotation` doc per UTC season — see
 * `getStoreRotation`). Prices are by rarity, server-authoritative. Pure +
 * dependency-light so client and server share pricing and eligibility.
 *
 * Pricing tier ("pricier/grindier") is anchored to the race economy
 * (~50 coins per decent finish, RaceRoom/terrain scoring): a Common is ~10
 * races, a Crazy is a long grind — or you gacha for it.
 */
import { ItemDef, Rarity } from './items';

/** Number of items featured in the store each month. */
export const STORE_SIZE = 5;

/** Coin price by rarity. Tuning knob — keep in sync with the race coin faucet. */
export const STORE_PRICES: Record<Rarity, number> = {
  common: 500,
  uncommon: 1500,
  rare: 4000,
  epic: 10000,
  legendary: 25000,
  crazy: 50000,
};

/** Coin price for a catalog item (by its rarity). */
export function storePrice(item: ItemDef): number {
  return STORE_PRICES[item.rarity];
}

/**
 * Whether an item may be sold in the coin store: its art exists
 * (`released !== false`) AND its sources allow 'store' (omitted sources default
 * in). Mirrors `inGachaPool` so unreleased items can't be curated into an
 * invisible (missing-texture) purchase. The admin curation UI filters on this.
 */
export function inStorePool(item: ItemDef): boolean {
  if (item.released === false) return false;
  return item.sources === undefined || item.sources.includes('store');
}
