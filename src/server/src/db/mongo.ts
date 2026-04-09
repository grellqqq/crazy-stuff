import { MongoClient, Db, ObjectId } from 'mongodb';

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

// ─── Allowed values ─────────────────────────────────────────────────────────

export const EQUIPMENT_SLOTS = [
  'skin', 'hair', 'head_accessory', 'eyes_accessory', 'mouth_accessory',
  'face_accessory', 'upper_body', 'lower_body', 'feet', 'back', 'air_space', 'hand_1h',
];

const ALLOWED_CHARS = ['male', 'female', 'male-medium', 'female-medium', 'male-dark', 'female-dark'];

const STARTER_ITEMS = [
  { itemType: 'upper_body', itemId: 'worn_tshirt', rarity: 'common' },
  { itemType: 'lower_body', itemId: 'blue_jeans', rarity: 'common' },
  { itemType: 'feet', itemId: 'beatup_sneakers', rarity: 'common' },
];

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
  return db.collection('users').findOne({ username });
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
  // Try to find existing user by email (might have registered with password first)
  const existing = await findUserByEmail(email);
  if (existing) {
    // Link Google account
    await db.collection('users').updateOne({ _id: existing._id }, { $set: { googleSub } });
    return existing;
  }
  const result = await db.collection('users').insertOne({
    email: email.toLowerCase(),
    passwordHash: null,
    googleSub,
    username,
    createdAt: new Date(),
  });
  return { _id: result.insertedId, email, username };
}

export async function getUserById(userId: string) {
  return db.collection('users').findOne({ _id: new ObjectId(userId) });
}

// ─── Player functions ───────────────────────────────────────────────────────

export async function getOrCreatePlayer(userId: string, username: string) {
  const players = db.collection('players');
  let player = await players.findOne({ userId });
  if (player) return player;

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
  });

  player = await players.findOne({ _id: result.insertedId });

  // Add starter items
  const inv = db.collection('inventory');
  const playerId = result.insertedId.toString();
  for (const item of STARTER_ITEMS) {
    await inv.insertOne({
      playerId,
      itemType: item.itemType,
      itemId: item.itemId,
      rarity: item.rarity,
      equipped: false,
      obtainedAt: now,
    });
  }

  return player;
}

export async function getPlayer(userId: string) {
  return db.collection('players').findOne({ userId });
}

export async function awardPostRace(userId: string, xp: number, coins: number, won: boolean) {
  const players = db.collection('players');
  const player = await players.findOne({ userId });
  if (!player) return null;

  const newXp = player.xp + xp;
  const newLevel = Math.floor(newXp / 500) + 1;

  await players.updateOne(
    { userId },
    {
      $inc: { totalRaces: 1, totalWins: won ? 1 : 0 },
      $set: { xp: newXp, coins: player.coins + coins, level: newLevel, updatedAt: new Date() },
    }
  );

  return players.findOne({ userId });
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
async function recomputeLoadout(playerId: string, userId: string): Promise<Record<string, string>> {
  const equipped = await db.collection('inventory')
    .find({ playerId, equipped: true })
    .toArray();
  const loadout: Record<string, string> = {};
  for (const item of equipped) {
    loadout[item.itemType] = item.itemId;
  }
  await db.collection('players').updateOne(
    { userId },
    { $set: { equippedLoadout: loadout, updatedAt: new Date() } }
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

  const item = await inv.findOne({ _id: new ObjectId(inventoryItemId), playerId });
  if (!item) return null;

  // Unequip any item in the same slot
  await inv.updateMany(
    { playerId, itemType: item.itemType, equipped: true },
    { $set: { equipped: false } }
  );

  // Face accessory mutual exclusion
  const conflicts = FACE_CONFLICTS[item.itemType];
  if (conflicts) {
    await inv.updateMany(
      { playerId, itemType: { $in: conflicts }, equipped: true },
      { $set: { equipped: false } }
    );
  }

  // Equip the target
  await inv.updateOne({ _id: item._id }, { $set: { equipped: true } });

  // Recompute denormalized loadout
  await recomputeLoadout(playerId, userId);

  return item;
}

export async function unequipItem(userId: string, inventoryItemId: string) {
  const player = await db.collection('players').findOne({ userId });
  if (!player) return null;
  const playerId = player._id.toString();
  const result = await db.collection('inventory').updateOne(
    { _id: new ObjectId(inventoryItemId), playerId },
    { $set: { equipped: false } }
  );
  if (result.modifiedCount > 0) {
    await recomputeLoadout(playerId, userId);
  }
  return result.modifiedCount > 0;
}
