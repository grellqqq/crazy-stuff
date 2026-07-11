/**
 * Gacha roll engine — pure, deterministic given an injected RNG.
 *
 * Single source of truth for: tier weights, pity, the 10-pull guarantee, and
 * the two-stage catalog-driven roll. Implements design/gdd/24-gacha-system.md
 * (§3.1 roll, §4 formulas F1–F4). Kept free of MongoDB/HTTP so it is unit-
 * testable (seeded RNG) and reusable client-side for odds display.
 *
 * The server injects a crypto-grade RNG (cryptoRng below); tests inject a
 * seeded PRNG. Real money rides on these rolls — never use Math.random.
 */
import { ITEMS, ItemDef, Rarity, inGachaPool } from './items';

/** Rarity tiers, low → high. Index doubles as ordinal rank. */
export const RARITIES: Rarity[] = [
  'common', 'uncommon', 'rare', 'epic', 'legendary', 'crazy',
];

const RANK: Record<Rarity, number> = {
  common: 0, uncommon: 1, rare: 2, epic: 3, legendary: 4, crazy: 5,
};

/**
 * Tunable gacha configuration. Per the GDD these belong in external config;
 * for now they live here as the single typed source. Prices are USD cents.
 */
export const GACHA_CONFIG = {
  /** Base tier weights (F1) — renormalized over non-empty tiers at roll time. */
  tierWeights: {
    common: 50, uncommon: 30, rare: 15, epic: 4, legendary: 0.9, crazy: 0.1,
  } as Record<Rarity, number>,
  /** Pulls without an Epic+ before the next roll is forced Epic+ (F3). */
  pityThreshold: 50,
  /** Floor tier the pity force guarantees. */
  pityFloor: 'epic' as Rarity,
  /** A 10-pull guarantees at least one of this tier or above (F4). */
  tenPullGuaranteeFloor: 'rare' as Rarity,
  /** Batch sizes the machine offers and their price in USD cents. */
  prices: { 1: 199, 5: 899, 10: 1699 } as Record<number, number>,
  /** Free pulls granted per UTC day. */
  freePullsPerDay: 1,
} as const;

// ─── Admin-tunable override (persisted in Mongo `gacha_config`) ──────────────

/** Per-item tuning the admin dashboard can set. `enabled:false` pulls a
 *  released item OUT of the pool; `rarity` moves it to a different tier. */
export interface ItemOverride {
  rarity?: Rarity;
  enabled?: boolean;
}

/** The full admin override document (all fields optional → fall back to the
 *  hardcoded GACHA_CONFIG / catalog defaults). */
export interface GachaOverride {
  tierWeights?: Partial<Record<Rarity, number>>;
  itemOverrides?: Record<string, ItemOverride>;
}

/** Effective tier weights = code defaults merged with any valid overrides.
 *  Invalid entries (negative, NaN, unknown tier) are ignored, never trusted. */
export function resolveTierWeights(override?: GachaOverride): Record<Rarity, number> {
  const w = { ...GACHA_CONFIG.tierWeights };
  const ov = override?.tierWeights;
  if (ov) {
    for (const r of RARITIES) {
      const v = ov[r];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) w[r] = v;
    }
  }
  return w;
}

/** Coerce an untrusted Mongo document into a safe GachaOverride. Real money
 *  rides on the roll, so the server sanitizes before ever using the config. */
export function sanitizeGachaOverride(raw: unknown): GachaOverride {
  const out: GachaOverride = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = raw as Record<string, unknown>;
  if (r.tierWeights && typeof r.tierWeights === 'object') {
    const tw: Partial<Record<Rarity, number>> = {};
    for (const rar of RARITIES) {
      const v = (r.tierWeights as Record<string, unknown>)[rar];
      if (typeof v === 'number' && Number.isFinite(v) && v >= 0) tw[rar] = v;
    }
    out.tierWeights = tw;
  }
  if (r.itemOverrides && typeof r.itemOverrides === 'object') {
    const io: Record<string, ItemOverride> = {};
    for (const [id, val] of Object.entries(r.itemOverrides as Record<string, unknown>)) {
      if (!val || typeof val !== 'object') continue;
      const v = val as Record<string, unknown>;
      const o: ItemOverride = {};
      if (typeof v.rarity === 'string' && (RANK as Record<string, number>)[v.rarity] !== undefined) {
        o.rarity = v.rarity as Rarity;
      }
      if (typeof v.enabled === 'boolean') o.enabled = v.enabled;
      if (o.rarity !== undefined || o.enabled !== undefined) io[id] = o;
    }
    out.itemOverrides = io;
  }
  return out;
}

export type RNG = () => number; // uniform in [0, 1)

export interface PullResult {
  itemId: string;
  rarity: Rarity;
  slot: string;
}

export interface BatchOutcome {
  results: PullResult[];
  /** Pity counter after the batch, to persist on the player. */
  pityCounter: number;
}

export type Pool = Record<Rarity, ItemDef[]>;

// ─── Pool & odds ──────────────────────────────────────────────────────────

/**
 * Group the gacha-eligible catalog into a per-rarity pool. An optional admin
 * override may DISABLE a released item (`enabled:false` → skipped) or reassign
 * its tier (`rarity`). It can never force an UNRELEASED item into the pool —
 * `inGachaPool` still gates on art existing, so a bad override can't award an
 * item with no sprites.
 */
export function buildPool(items: Record<string, ItemDef> = ITEMS, override?: GachaOverride): Pool {
  const pool = {
    common: [], uncommon: [], rare: [], epic: [], legendary: [], crazy: [],
  } as Pool;
  const ov = override?.itemOverrides;
  for (const item of Object.values(items)) {
    if (!inGachaPool(item)) continue;
    const o = ov?.[item.id];
    if (o?.enabled === false) continue;
    pool[o?.rarity ?? item.rarity].push(item);
  }
  return pool;
}

function nonEmptyTiers(pool: Pool, floor: Rarity = 'common'): Rarity[] {
  const floorRank = RANK[floor];
  return RARITIES.filter((r) => RANK[r] >= floorRank && pool[r].length > 0);
}

/**
 * F1 — renormalized tier probabilities over non-empty tiers at or above
 * `floor`. Returns an empty object when no tier qualifies (caller falls back).
 */
export function computeOdds(
  pool: Pool,
  floor: Rarity = 'common',
  weights: Record<Rarity, number> = GACHA_CONFIG.tierWeights,
): Partial<Record<Rarity, number>> {
  const tiers = nonEmptyTiers(pool, floor);
  const total = tiers.reduce((s, r) => s + weights[r], 0);
  if (total <= 0) return {};
  const odds: Partial<Record<Rarity, number>> = {};
  for (const r of tiers) odds[r] = weights[r] / total;
  return odds;
}

// ─── Rolling ────────────────────────────────────────────────────────────────

/** Sample one tier from an odds map. Returns null if the map is empty. */
function sampleTier(odds: Partial<Record<Rarity, number>>, rng: RNG): Rarity | null {
  const entries = Object.entries(odds) as [Rarity, number][];
  if (entries.length === 0) return null;
  let x = rng();
  for (const [tier, p] of entries) {
    x -= p;
    if (x < 0) return tier;
  }
  return entries[entries.length - 1][0]; // float-error guard
}

/** Uniformly pick an item within a tier. */
function sampleItem(pool: Pool, tier: Rarity, rng: RNG): ItemDef {
  const items = pool[tier];
  return items[Math.min(items.length - 1, Math.floor(rng() * items.length))];
}

/**
 * Roll a full batch of `count` pulls. Applies, per slot:
 *  - pity: when the running counter ≥ threshold and an Epic+ tier exists,
 *    force the rarity roll into Epic+ (F3). Resets on any Epic+; else +1.
 *  - 10-pull guarantee: if count === 10 and no Rare+ has appeared, the last
 *    slot is forced into Rare+ (F4). A pity-forced Epic+ satisfies it too.
 *  - dormancy: a floor with no non-empty tiers is skipped (no force), so the
 *    counter accumulates until higher-tier content exists.
 */
export function pullBatch(opts: {
  pool: Pool;
  count: number;
  pityCounter: number;
  rng: RNG;
  tierWeights?: Record<Rarity, number>;
}): BatchOutcome {
  const { pool, count, rng } = opts;
  const weights = opts.tierWeights ?? GACHA_CONFIG.tierWeights;
  const baseOdds = computeOdds(pool, 'common', weights);
  const pityOdds = computeOdds(pool, GACHA_CONFIG.pityFloor, weights);
  const guaranteeOdds = computeOdds(pool, GACHA_CONFIG.tenPullGuaranteeFloor, weights);
  const epicPlusExists = Object.keys(pityOdds).length > 0;

  let pity = opts.pityCounter;
  let hadRarePlus = false;
  const results: PullResult[] = [];

  for (let i = 0; i < count; i++) {
    let tier: Rarity | null = null;

    if (pity >= GACHA_CONFIG.pityThreshold && epicPlusExists) {
      tier = sampleTier(pityOdds, rng);
    }
    if (tier === null && count === 10 && i === count - 1 && !hadRarePlus) {
      tier = sampleTier(guaranteeOdds, rng); // null if no Rare+ exists → normal
    }
    if (tier === null) {
      tier = sampleTier(baseOdds, rng);
    }
    if (tier === null) {
      throw new Error('POOL_EMPTY'); // no eligible items at all
    }

    const item = sampleItem(pool, tier, rng);
    results.push({ itemId: item.id, rarity: tier, slot: item.slot });

    if (RANK[tier] >= RANK.rare) hadRarePlus = true;
    if (RANK[tier] >= RANK[GACHA_CONFIG.pityFloor]) pity = 0;
    else pity += 1;
  }

  return { results, pityCounter: pity };
}

// ─── RNG adapters ─────────────────────────────────────────────────────────

/**
 * Crypto-grade uniform [0,1) for production rolls. Uses the Web Crypto API
 * (Node 18+ exposes globalThis.crypto). 32 bits of entropy per draw.
 */
export const cryptoRng: RNG = () => {
  const buf = new Uint32Array(1);
  globalThis.crypto.getRandomValues(buf);
  return buf[0] / 0x1_0000_0000;
};

// ─── Free-pull cadence (F5) ─────────────────────────────────────────────────

/** Most recent UTC midnight at or before `d`. */
export function floorMidnightUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()));
}

/** Next UTC midnight strictly after `d` (for the client countdown). */
export function nextMidnightUTC(d: Date): Date {
  return new Date(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate() + 1));
}

/**
 * F5 — the daily free pull is available when the last one was taken before the
 * current UTC day began. Server clock is authoritative (edge case 13).
 */
export function freeAvailable(lastFreePullAt: Date | string | null | undefined, now: Date): boolean {
  return !lastFreePullAt || new Date(lastFreePullAt) < floorMidnightUTC(now);
}

/** Seeded PRNG (mulberry32) for deterministic tests. NOT for production rolls. */
export function seededRng(seed: number): RNG {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 0x1_0000_0000;
  };
}
