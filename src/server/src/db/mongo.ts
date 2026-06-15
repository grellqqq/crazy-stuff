import { MongoClient, Db, ObjectId, ClientSession } from 'mongodb';
import { ITEMS } from '../../../shared/items';
import {
  buildPool, pullBatch, computeOdds, cryptoRng, GACHA_CONFIG, RARITIES,
  freeAvailable, nextMidnightUTC,
} from '../../../shared/gacha';

const MONGODB_URI = process.env.MONGODB_URI ?? '';

let db: Db;
let client: MongoClient;

export async function connectDB(): Promise<Db> {
  if (db) return db;
  if (!MONGODB_URI) {
    console.warn('[MongoDB] MONGODB_URI not set — database features disabled');
    throw new Error('MONGODB_URI not set');
  }
  client = new MongoClient(MONGODB_URI);
  await client.connect();
  db = client.db('crazystuff');
  console.log('[MongoDB] connected');

  // Create indexes
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  await db.collection('users').createIndex({ googleSub: 1 }, { sparse: true });
  await db.collection('players').createIndex({ userId: 1 }, { unique: true });
  await db.collection('inventory').createIndex({ playerId: 1 });
  // Gacha: pullId is the idempotency key (one pull request → one outcome).
  await db.collection('pulls').createIndex({ pullId: 1 }, { unique: true });
  await db.collection('pulls').createIndex({ userId: 1, createdAt: -1 });

  return db;
}

export function getDB(): Db { return db; }

/** Close the client and reset module state (tests / graceful shutdown). */
export async function closeDB(): Promise<void> {
  await client?.close();
  db = undefined as unknown as Db;
  client = undefined as unknown as MongoClient;
}

// ─── Transactions ───────────────────────────────────────────────────────────

/**
 * Whether the connected deployment supports multi-document transactions.
 * Transactions require a replica set (single-node replica is fine for dev;
 * Atlas is always a replica set). Flipped to false on the first failed
 * attempt so subsequent calls skip the doomed transaction start.
 */
let txnSupported = true;

/**
 * Run `fn` inside a MongoDB multi-document transaction. The session is passed
 * to `fn`, and every read/write inside MUST forward it via the `{ session }`
 * option or it silently escapes the transaction.
 *
 * On a standalone server (no replica set) this falls back to running `fn`
 * without a session and logs a one-time warning — acceptable for free-feature
 * dev work, NOT for anything that touches paid currency (see ADR-004 /
 * the gacha launch blocker). `fn` may be retried by the driver on transient
 * transaction errors, so it must be safe to re-run from the top.
 */
export async function withTransaction<T>(
  fn: (session?: ClientSession) => Promise<T>
): Promise<T> {
  if (!txnSupported) return fn(undefined);
  const session = client.startSession();
  try {
    let result!: T;
    await session.withTransaction(async () => {
      result = await fn(session);
    });
    return result;
  } catch (err: any) {
    const msg: string = err?.message ?? '';
    if (err?.code === 20 || /Transaction numbers are only allowed|replica set/i.test(msg)) {
      txnSupported = false;
      console.warn(
        '[MongoDB] multi-document transactions unsupported (standalone server?) — ' +
        'falling back to non-transactional writes. Run a replica set before launch.'
      );
      return fn(undefined);
    }
    throw err;
  } finally {
    await session.endSession();
  }
}

// ─── Allowed values ─────────────────────────────────────────────────────────

export const EQUIPMENT_SLOTS = [
  'skin', 'hair', 'head_accessory', 'eyes_accessory', 'mouth_accessory',
  'face_accessory', 'upper_body', 'lower_body', 'feet', 'back', 'air_space', 'hand_1h',
];

const ALLOWED_CHARS = ['male', 'female', 'male-medium', 'female-medium', 'male-dark', 'female-dark'];

/**
 * Starter kit granted (and auto-equipped) to every NEW account — replaces the
 * old full-catalog dev grant at gacha launch (gacha GDD §3.1). One item per
 * slot, no conflicts. Existing accounts are grandfathered (keep whatever they
 * already own); they receive no starter grant and no catalog backfill.
 */
const STARTER_KIT = ['worn_tshirt', 'blue_jeans', 'beatup_sneakers'];

/** Face accessory is mutually exclusive with eyes + mouth accessories. */
const FACE_CONFLICTS: Record<string, string[]> = {
  face_accessory: ['eyes_accessory', 'mouth_accessory'],
  eyes_accessory: ['face_accessory'],
  mouth_accessory: ['face_accessory'],
};

// ─── User functions (auth) ──────────────────────────────────────────────────

export async function findUserByEmail(email: string) {
  return db.collection('users').findOne({ email: email.toLowerCase() });
}

export async function findUserByUsername(username: string) {
  // Case-insensitive lookup — users who registered "PlayerOne" can log in as "playerone".
  return db.collection('users').findOne(
    { username },
    { collation: { locale: 'en', strength: 2 } },
  );
}

export async function findUserByGoogleSub(googleSub: string) {
  return db.collection('users').findOne({ googleSub });
}

export async function createUser(email: string, passwordHash: string, username: string) {
  const result = await db.collection('users').insertOne({
    email: email.toLowerCase(),
    passwordHash,
    googleSub: null,
    username,
    createdAt: new Date(),
  });
  return { _id: result.insertedId, email, username };
}

export async function createGoogleUser(email: string, googleSub: string, username: string) {
  const result = await db.collection('users').insertOne({
    email: email.toLowerCase(),
    passwordHash: null,
    googleSub,
    username,
    createdAt: new Date(),
  });
  return { _id: result.insertedId, email, username };
}

export async function linkGoogleToUser(userId: ObjectId, googleSub: string) {
  await db.collection('users').updateOne({ _id: userId }, { $set: { googleSub } });
}

export async function getUserById(userId: string) {
  return db.collection('users').findOne({ _id: new ObjectId(userId) });
}

// ─── Player functions ───────────────────────────────────────────────────────

/**
 * Ensure a player owns one of every catalog item (DEV/early-access grant).
 *
 * Idempotent: only inserts items the player doesn't already have, deduped by
 * itemId. This backfills accounts created before items existed AND picks up any
 * newly-added catalog items on the player's next login — without ever creating
 * duplicates. Replace with a real starter kit before launch.
 */
/**
 * Grant the starter kit to a brand-new player and return the equipped loadout.
 * Items are inserted already-equipped (one per slot, no conflicts) so a new
 * player spawns dressed. Caller runs this inside the create transaction.
 */
async function grantStarterKit(
  playerId: string, now: Date, session?: ClientSession,
): Promise<Record<string, string>> {
  const loadout: Record<string, string> = {};
  const rows = STARTER_KIT.map((id) => {
    const item = ITEMS[id];
    loadout[item.slot] = item.id;
    return {
      playerId,
      itemType: item.slot,
      itemId: item.id,
      rarity: item.rarity,
      equipped: true,
      obtainedAt: now,
      source: 'starter',
    };
  });
  await db.collection('inventory').insertMany(rows, { session });
  return loadout;
}

export async function getOrCreatePlayer(userId: string, username: string) {
  const players = db.collection('players');
  const existing = await players.findOne({ userId });
  // Returning players are grandfathered: no starter grant, no catalog backfill.
  if (existing) return existing;

  return withTransaction(async (session) => {
    const now = new Date();
    const result = await players.insertOne({
      userId,
      username,
      xp: 0,
      level: 1,
      coins: 0,
      totalRaces: 0,
      totalWins: 0,
      equippedChar: 'male',
      equippedLoadout: {},
      // Gacha state (gacha GDD §3.3).
      pityCounter: 0,
      lastFreePullAt: null,
      pullCredits: 0,
      createdAt: now,
      updatedAt: now,
    }, { session });

    const loadout = await grantStarterKit(result.insertedId.toString(), now, session);
    await players.updateOne(
      { _id: result.insertedId },
      { $set: { equippedLoadout: loadout } },
      { session },
    );

    return players.findOne({ _id: result.insertedId }, { session });
  });
}

export async function getPlayer(userId: string) {
  return db.collection('players').findOne({ userId });
}

export async function awardPostRace(userId: string, xp: number, coins: number, won: boolean) {
  const players = db.collection('players');
  return withTransaction(async (session) => {
    const player = await players.findOne({ userId }, { session });
    if (!player) return null;

    const newXp = player.xp + xp;
    const newLevel = Math.floor(newXp / 500) + 1;

    await players.updateOne(
      { userId },
      {
        $inc: { totalRaces: 1, totalWins: won ? 1 : 0 },
        $set: { xp: newXp, coins: player.coins + coins, level: newLevel, updatedAt: new Date() },
      },
      { session }
    );

    return players.findOne({ userId }, { session });
  });
}

export async function getEquippedChar(userId: string): Promise<string> {
  const player = await db.collection('players').findOne({ userId });
  return player?.equippedChar ?? 'male';
}

export async function equipChar(userId: string, charKey: string): Promise<string | null> {
  if (!ALLOWED_CHARS.includes(charKey)) return null;
  await db.collection('players').updateOne(
    { userId },
    { $set: { equippedChar: charKey, updatedAt: new Date() } }
  );
  return charKey;
}

// ─── Loadout functions ──────────────────────────────────────────────────────

/** Get the denormalized equipped loadout for a player (slot → itemId). */
export async function getLoadout(userId: string): Promise<Record<string, string>> {
  const player = await db.collection('players').findOne({ userId });
  return player?.equippedLoadout ?? {};
}

/** Recompute equippedLoadout from inventory and store on player doc. */
async function recomputeLoadout(
  playerId: string,
  userId: string,
  session?: ClientSession
): Promise<Record<string, string>> {
  const equipped = await db.collection('inventory')
    .find({ playerId, equipped: true }, { session })
    .toArray();
  const loadout: Record<string, string> = {};
  for (const item of equipped) {
    loadout[item.itemType] = item.itemId;
  }
  await db.collection('players').updateOne(
    { userId },
    { $set: { equippedLoadout: loadout, updatedAt: new Date() } },
    { session }
  );
  return loadout;
}

// ─── Inventory functions ────────────────────────────────────────────────────

export async function getInventory(userId: string) {
  const player = await db.collection('players').findOne({ userId });
  if (!player) return [];
  const items = await db.collection('inventory')
    .find({ playerId: player._id.toString() })
    .sort({ obtainedAt: -1 })
    .toArray();
  // Normalize to the snake_case shape both client UIs (and the dev fixture)
  // read. The DB stores camelCase (itemType/itemId); returning the raw doc
  // made every inventory card render a blank name + empty equipment panel.
  return items.map((i) => ({
    id: i._id.toString(),
    item_type: i.itemType,
    item_id: i.itemId,
    rarity: i.rarity,
    equipped: i.equipped ?? false,
    obtainedAt: i.obtainedAt,
    source: i.source,
  }));
}

export async function addItem(userId: string, itemType: string, itemId: string, rarity: string) {
  const player = await db.collection('players').findOne({ userId });
  if (!player) return null;
  const result = await db.collection('inventory').insertOne({
    playerId: player._id.toString(),
    itemType,
    itemId,
    rarity,
    equipped: false,
    obtainedAt: new Date(),
  });
  return db.collection('inventory').findOne({ _id: result.insertedId });
}

export async function equipItem(userId: string, inventoryItemId: string) {
  const player = await db.collection('players').findOne({ userId });
  if (!player) return null;
  const playerId = player._id.toString();
  const inv = db.collection('inventory');

  return withTransaction(async (session) => {
    const item = await inv.findOne({ _id: new ObjectId(inventoryItemId), playerId }, { session });
    if (!item) return null;

    // Unequip any item in the same slot
    await inv.updateMany(
      { playerId, itemType: item.itemType, equipped: true },
      { $set: { equipped: false } },
      { session }
    );

    // Face accessory mutual exclusion
    const conflicts = FACE_CONFLICTS[item.itemType];
    if (conflicts) {
      await inv.updateMany(
        { playerId, itemType: { $in: conflicts }, equipped: true },
        { $set: { equipped: false } },
        { session }
      );
    }

    // Equip the target
    await inv.updateOne({ _id: item._id }, { $set: { equipped: true } }, { session });

    // Recompute denormalized loadout
    await recomputeLoadout(playerId, userId, session);

    return item;
  });
}

export async function unequipItem(userId: string, inventoryItemId: string) {
  const player = await db.collection('players').findOne({ userId });
  if (!player) return null;
  const playerId = player._id.toString();

  return withTransaction(async (session) => {
    const result = await db.collection('inventory').updateOne(
      { _id: new ObjectId(inventoryItemId), playerId },
      { $set: { equipped: false } },
      { session }
    );
    if (result.modifiedCount > 0) {
      await recomputeLoadout(playerId, userId, session);
    }
    return result.modifiedCount > 0;
  });
}

// ─── Gacha (gacha GDD §24) ──────────────────────────────────────────────────

/** Paid pulls stay off until Payment Integration + the regulation question
 *  (GDD open Q1) land. Free daily pull always works. */
const PAID_ENABLED = process.env.GACHA_PAID_ENABLED === '1';

/** A typed error whose `.code` the HTTP layer maps to a client message. */
export class GachaError extends Error {
  constructor(public code: string) { super(code); this.name = 'GachaError'; }
}

/** Public odds disclosure (gacha GDD §3.1, edge case 3): renormalized tier
 *  probabilities over the live catalog, plus item counts per tier. */
export function getGachaOdds() {
  const pool = buildPool();
  const odds = computeOdds(pool);
  const tiers = RARITIES.map((r) => ({
    rarity: r,
    count: pool[r].length,
    probability: odds[r] ?? 0,
  }));
  return { tiers, prices: GACHA_CONFIG.prices, paidEnabled: PAID_ENABLED };
}

/** Per-player machine state for the UI (free availability, pity, credits). */
export async function getGachaStatus(userId: string) {
  const player = await db.collection('players').findOne({ userId });
  if (!player) throw new GachaError('NO_PLAYER');
  const now = new Date();
  const avail = freeAvailable(player.lastFreePullAt, now);
  return {
    freeAvailable: avail,
    nextFreeAt: avail ? null : nextMidnightUTC(now).toISOString(),
    pityCounter: player.pityCounter ?? 0,
    pityThreshold: GACHA_CONFIG.pityThreshold,
    pullCredits: player.pullCredits ?? 0,
    paidEnabled: PAID_ENABLED,
  };
}

interface PullRequest { count: number; paid: boolean; }

/**
 * Execute one pull request (free single or paid batch) atomically and
 * idempotently. Implements gacha GDD §3.1 + edge cases 1, 2, 5, 8, 9, 10.
 *
 * - `pullId` is the idempotency key: a retry returns the recorded outcome.
 * - Free pulls (paid=false) are always count 1 and require free availability,
 *   else FREE_PULL_USED (a double-tapped free pull never silently charges).
 * - Paid pulls require PAID_ENABLED + enough credits; the whole batch is one
 *   transaction so the 10-pull guarantee and mid-batch pity are atomic.
 */
export async function executePull(userId: string, pullId: string, req: PullRequest) {
  const { paid } = req;
  const count = paid ? req.count : 1;
  if (![1, 5, 10].includes(count)) throw new GachaError('BAD_COUNT');

  const pulls = db.collection('pulls');
  const players = db.collection('players');
  const inv = db.collection('inventory');

  // Fast idempotency path (cheap; re-guarded by the unique index in the txn).
  const prior = await pulls.findOne({ pullId });
  if (prior) {
    return { results: prior.results, pityCounter: prior.pityAfter, funding: prior.funding, idempotent: true };
  }

  if (paid && !PAID_ENABLED) throw new GachaError('PAID_DISABLED');

  try {
    return await withTransaction(async (session) => {
      const player = await players.findOne({ userId }, { session });
      if (!player) throw new GachaError('NO_PLAYER');

      const now = new Date();
      let funding: 'free' | 'credits';
      if (!paid) {
        if (!freeAvailable(player.lastFreePullAt, now)) throw new GachaError('FREE_PULL_USED');
        funding = 'free';
      } else {
        if ((player.pullCredits ?? 0) < count) throw new GachaError('INSUFFICIENT_CREDITS');
        funding = 'credits';
      }

      const pool = buildPool();
      const pityBefore = player.pityCounter ?? 0;
      const outcome = pullBatch({ pool, count, pityCounter: pityBefore, rng: cryptoRng });

      // Grant items (gacha-sourced; never auto-equipped — player chooses).
      const rows = outcome.results.map((r) => ({
        playerId: player._id.toString(),
        itemType: r.slot,
        itemId: r.itemId,
        rarity: r.rarity,
        equipped: false,
        obtainedAt: now,
        source: 'gacha',
      }));
      await inv.insertMany(rows, { session });

      const set: Record<string, unknown> = { pityCounter: outcome.pityCounter, updatedAt: now };
      const update: Record<string, unknown> = { $set: set };
      if (funding === 'free') set.lastFreePullAt = now;
      else update.$inc = { pullCredits: -count };
      await players.updateOne({ userId }, update, { session });

      // Recording the pull (unique pullId) is the idempotency commit point.
      await pulls.insertOne({
        pullId, userId, count, paid, funding,
        results: outcome.results, pityBefore, pityAfter: outcome.pityCounter,
        createdAt: now,
      }, { session });

      return { results: outcome.results, pityCounter: outcome.pityCounter, funding };
    });
  } catch (e: any) {
    // Concurrent request with the SAME pullId won the unique-index race.
    if (e?.code === 11000) {
      const rec = await pulls.findOne({ pullId });
      if (rec) return { results: rec.results, pityCounter: rec.pityAfter, funding: rec.funding, idempotent: true };
    }
    throw e;
  }
}

/** DEV ONLY (env GACHA_DEV=1): grant pull credits so multi-pull can be tested
 *  in-game before Payment Integration exists. Never enabled in production. */
export async function devGrantCredits(userId: string, amount: number) {
  if (process.env.GACHA_DEV !== '1') throw new GachaError('DEV_DISABLED');
  const n = Math.max(0, Math.min(100, Math.floor(amount)));
  await db.collection('players').updateOne({ userId }, { $inc: { pullCredits: n }, $set: { updatedAt: new Date() } });
  const player = await db.collection('players').findOne({ userId });
  return player?.pullCredits ?? 0;
}
