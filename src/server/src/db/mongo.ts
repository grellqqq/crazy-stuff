import { MongoClient, Db, ObjectId, ClientSession } from 'mongodb';
import { ITEMS } from '../../../shared/items';

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

  return db;
}

export function getDB(): Db { return db; }

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

// DEV / early-access grant: during development every player is given one of
// every catalog item so the full wardrobe can be exercised in-game. Narrow this
// to a real starter kit before launch (see ensureStarterItems).

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
async function ensureStarterItems(playerId: string, session?: ClientSession): Promise<void> {
  const inv = db.collection('inventory');
  const owned = await inv.find({ playerId }, { session }).project({ itemId: 1 }).toArray();
  const ownedIds = new Set(owned.map((d) => d.itemId));
  const now = new Date();
  const missing = Object.values(ITEMS)
    .filter((item) => !ownedIds.has(item.id))
    .map((item) => ({
      playerId,
      itemType: item.slot,
      itemId: item.id,
      rarity: item.rarity,
      equipped: false,
      obtainedAt: now,
    }));
  if (missing.length > 0) {
    await inv.insertMany(missing, { session });
  }
}

export async function getOrCreatePlayer(userId: string, username: string) {
  const players = db.collection('players');
  const existing = await players.findOne({ userId });
  if (existing) {
    // Backfill catalog items for accounts created before they existed (and any
    // items added to the catalog since this player last logged in).
    await withTransaction((session) => ensureStarterItems(existing._id.toString(), session));
    return existing;
  }

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
      createdAt: now,
      updatedAt: now,
    }, { session });

    await ensureStarterItems(result.insertedId.toString(), session);

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
  // Map _id to id for client compatibility
  return items.map(i => ({ ...i, id: i._id.toString() }));
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
