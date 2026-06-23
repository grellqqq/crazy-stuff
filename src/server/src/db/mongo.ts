import { MongoClient, Db, ObjectId, ClientSession } from 'mongodb';
import crypto from 'crypto';
import { ITEMS, ItemDef } from '../../../shared/items';
import { currentSeasonId } from '../../../shared/season';
import { storePrice, inStorePool, STORE_SIZE } from '../../../shared/store';
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

  // Detect replica-set / mongos support up front so transactional writes
  // (provisioning, gacha) degrade gracefully on a standalone server instead of
  // failing the first user's registration. `hello` needs no special privileges.
  try {
    const hello = await db.command({ hello: 1 });
    txnSupported = !!(hello.setName || hello.msg === 'isdbgrid');
    console.log(
      `[MongoDB] multi-document transactions ${txnSupported
        ? 'supported'
        : 'UNAVAILABLE (standalone — run a replica set before launch!)'}`
    );
  } catch (e) {
    txnSupported = false;
    console.warn('[MongoDB] could not probe transaction support; assuming standalone', e);
  }

  // Create indexes
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('users').createIndex({ username: 1 }, { unique: true });
  await db.collection('users').createIndex({ googleSub: 1 }, { sparse: true });
  await db.collection('players').createIndex({ userId: 1 }, { unique: true });
  // Compound so getInventory's `find({playerId}).sort({obtainedAt:-1})` is fully
  // index-served (was playerId-only → an in-memory sort on every inventory open).
  await db.collection('inventory').createIndex({ playerId: 1, obtainedAt: -1 });
  // Gacha: pullId is the idempotency key (one pull request → one outcome).
  await db.collection('pulls').createIndex({ pullId: 1 }, { unique: true });
  await db.collection('pulls').createIndex({ userId: 1, createdAt: -1 });
  // Seasonal leaderboard (#23): rank by season XP within the current season.
  await db.collection('players').createIndex({ seasonId: 1, seasonXp: -1 });
  // Coin store (#25): one curated rotation per month; buyId is the buy idempotency key.
  await db.collection('store_rotation').createIndex({ seasonId: 1 }, { unique: true });
  await db.collection('purchases').createIndex({ buyId: 1 }, { unique: true });
  await db.collection('purchases').createIndex({ userId: 1, createdAt: -1 });
  // Password reset (auth GDD §3.10): lookup by token hash; TTL auto-purges expired.
  await db.collection('passwordResetTokens').createIndex({ tokenHash: 1 });
  await db.collection('passwordResetTokens').createIndex({ expiresAt: 1 }, { expireAfterSeconds: 0 });

  return db;
}

export function getDB(): Db { return db; }

/** Readiness probe (M3-6): true if the DB is connected and answering. */
export async function pingDB(): Promise<boolean> {
  try {
    if (!db) return false;
    await db.command({ ping: 1 });
    return true;
  } catch {
    return false;
  }
}

/**
 * One-time inventory reset, run on server boot and gated by env:
 *   INVENTORY_RESET_KEEP_EMAIL — the account to PRESERVE (keeps all its items).
 *   INVENTORY_RESET_TOKEN      — optional run-key (defaults to the keep email).
 *
 * Resets every OTHER player to the 3-item starter kit. Records the run in a
 * `migrations` doc so it never repeats for the same token (restarts are safe).
 * Aborts without changes if the keep account can't be resolved, so it can
 * never wipe everyone — including you — by accident. Remove the env var (or
 * leave it; it won't re-run) once applied. Change the token to run again.
 */
export async function resetInventoriesOnBoot(): Promise<void> {
  const keepEmail = process.env.INVENTORY_RESET_KEEP_EMAIL?.toLowerCase();
  if (!keepEmail) return; // feature off
  const token = process.env.INVENTORY_RESET_TOKEN ?? keepEmail;

  const migrations = db.collection('migrations');
  const prior = await migrations.findOne({ _id: 'inventory-reset' as never });
  if (prior && prior.token === token) {
    console.log('[reset] inventory reset already applied for this token — skipping');
    return;
  }

  const user = await db.collection('users').findOne({ email: keepEmail });
  if (!user) { console.error(`[reset] keep account ${keepEmail} not found — ABORTING (no changes)`); return; }
  const keepPlayer = await db.collection('players').findOne({ userId: user._id.toString() });
  if (!keepPlayer) { console.error(`[reset] no player for ${keepEmail} — ABORTING (no changes)`); return; }
  const keepId = keepPlayer._id.toString();

  const all = await db.collection('players').find({}).project({ _id: 1 }).toArray();
  const resetObjIds = all.filter((p) => p._id.toString() !== keepId).map((p) => p._id);
  const resetIds = resetObjIds.map((id) => id.toString());

  const now = new Date();
  const starterLoadout: Record<string, string> = {};
  for (const id of STARTER_KIT) { const it = ITEMS[id]; starterLoadout[it.slot] = it.id; }

  if (resetIds.length > 0) {
    await db.collection('inventory').deleteMany({ playerId: { $in: resetIds } });
    const rows = resetIds.flatMap((pid) => STARTER_KIT.map((id) => {
      const it = ITEMS[id];
      return { playerId: pid, itemType: it.slot, itemId: it.id, rarity: it.rarity, equipped: true, obtainedAt: now, source: 'starter' };
    }));
    if (rows.length > 0) await db.collection('inventory').insertMany(rows);
    await db.collection('players').updateMany(
      { _id: { $in: resetObjIds } },
      { $set: { equippedLoadout: starterLoadout, updatedAt: now } },
    );
  }

  await migrations.updateOne(
    { _id: 'inventory-reset' as never },
    { $set: { token, keepEmail, at: now, resetCount: resetIds.length } },
    { upsert: true },
  );
  console.log(`[reset] reset ${resetIds.length} players to the starter kit; kept ${keepEmail}`);
}

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
    const isStandalone =
      err?.code === 20 ||
      err?.codeName === 'IllegalOperation' ||
      /Transaction numbers are only allowed|replica set|not supported/i.test(msg);
    if (isStandalone) {
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

/**
 * GDPR account deletion (auth GDD §3 cascade): purge the user and ALL their
 * data in one transaction — `users`, `players`, `inventory`, `pulls`,
 * `purchases`. Idempotent (deleting an already-gone account is a no-op).
 * `userId` is the string form of `users._id` (= `players.userId`).
 */
export async function deleteAccount(userId: string): Promise<{ deletedUser: boolean }> {
  return withTransaction(async (session) => {
    const player = await db.collection('players').findOne({ userId }, { session });
    const playerId = player?._id.toString();
    if (playerId) {
      await db.collection('inventory').deleteMany({ playerId }, { session });
    }
    await db.collection('players').deleteMany({ userId }, { session });
    await db.collection('pulls').deleteMany({ userId }, { session });
    await db.collection('purchases').deleteMany({ userId }, { session });

    let oid: ObjectId | null = null;
    try { oid = new ObjectId(userId); } catch { /* malformed id — skip user row */ }
    const res = oid ? await db.collection('users').deleteOne({ _id: oid }, { session }) : null;
    return { deletedUser: (res?.deletedCount ?? 0) > 0 };
  });
}

// ─── Password reset (auth GDD §3.10) ────────────────────────────────────────

function hashToken(token: string): string {
  return crypto.createHash('sha256').update(token).digest('hex');
}

/**
 * Begin a password reset: if a PASSWORD account exists for `email`, mint a
 * single-use token (stored hashed, 1-hour expiry) and return the raw token +
 * email so the caller can send the link. Returns null when no eligible account
 * exists (Google-only users have no password) — the caller must still respond
 * 200 to avoid leaking which emails are registered.
 */
export async function createPasswordReset(email: string): Promise<{ token: string; email: string } | null> {
  const user = await findUserByEmail(email);
  if (!user || !user.passwordHash) return null;
  const token = crypto.randomBytes(32).toString('hex');
  const now = new Date();
  await db.collection('passwordResetTokens').insertOne({
    userId: user._id.toString(),
    tokenHash: hashToken(token),
    expiresAt: new Date(now.getTime() + 60 * 60 * 1000), // 1 hour
    used: false,
    createdAt: now,
  });
  return { token, email: user.email };
}

/**
 * Consume a reset token and set the new (already-bcrypt-hashed) password.
 * Validates the token is unexpired + unused, marks it used, and updates the
 * password — all in one transaction. Returns false for an invalid/expired/used
 * token (idempotent: a second use fails cleanly).
 */
export async function resetPasswordWithToken(token: string, passwordHash: string): Promise<boolean> {
  const tokenHash = hashToken(token);
  const now = new Date();
  return withTransaction(async (session) => {
    const doc = await db.collection('passwordResetTokens').findOne(
      { tokenHash, used: false, expiresAt: { $gt: now } },
      { session },
    );
    if (!doc) return false;
    const claim = await db.collection('passwordResetTokens').updateOne(
      { _id: doc._id, used: false },
      { $set: { used: true, usedAt: now } },
      { session },
    );
    if (claim.modifiedCount === 0) return false; // lost the race — already used
    await db.collection('users').updateOne(
      { _id: new ObjectId(doc.userId) },
      { $set: { passwordHash } },
      { session },
    );
    return true;
  });
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
      // Seasonal leaderboard (#23): points within the current UTC-month season.
      seasonId: currentSeasonId(now),
      seasonXp: 0,
      seasonWins: 0,
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

    // Seasonal points (#23): accumulate within the current season; reset to this
    // race's contribution on the first race of a new season (rollover).
    const season = currentSeasonId();
    const sameSeason = player.seasonId === season;
    const newSeasonXp = (sameSeason ? (player.seasonXp ?? 0) : 0) + xp;
    const newSeasonWins = (sameSeason ? (player.seasonWins ?? 0) : 0) + (won ? 1 : 0);

    await players.updateOne(
      { userId },
      {
        $inc: { totalRaces: 1, totalWins: won ? 1 : 0 },
        $set: {
          xp: newXp, coins: player.coins + coins, level: newLevel,
          seasonId: season, seasonXp: newSeasonXp, seasonWins: newSeasonWins,
          updatedAt: new Date(),
        },
      },
      { session }
    );

    return players.findOne({ userId }, { session });
  });
}

/**
 * Top players for the current season, ranked by season XP (then season wins,
 * then username — see `compareLeaderboard`). Only players who scored this
 * season appear. Public, read-only; powers the lobby Leaderboard Wall (#23).
 */
export async function getLeaderboard(limit = 25) {
  const season = currentSeasonId();
  const rows = await db.collection('players')
    .find({ seasonId: season, seasonXp: { $gt: 0 } })
    .sort({ seasonXp: -1, seasonWins: -1, username: 1 })
    .limit(limit)
    .project({ _id: 0, userId: 1, username: 1, seasonXp: 1, seasonWins: 1, level: 1 })
    .toArray();
  return {
    seasonId: season,
    entries: rows.map((r, i) => ({ rank: i + 1, ...r })),
  };
}

/**
 * A single player's standing this season — their rank even when outside the
 * top N (so the wall can show "you're #142"). `rank` is null when the player
 * hasn't scored this season yet. The rank uses the SAME total order as
 * `getLeaderboard` (season XP, then wins, then username), so a player's footer
 * rank always matches their row position on the board.
 */
export async function getPlayerSeasonRank(userId: string) {
  const season = currentSeasonId();
  const players = db.collection('players');
  const me = await players.findOne(
    { userId },
    { projection: { _id: 0, username: 1, seasonId: 1, seasonXp: 1, seasonWins: 1 } },
  );
  const inSeason = !!me && me.seasonId === season;
  const myXp = inSeason ? (me!.seasonXp ?? 0) : 0;
  const myWins = inSeason ? (me!.seasonWins ?? 0) : 0;
  const myName = (me?.username as string) ?? '';
  const totalRanked = await players.countDocuments({ seasonId: season, seasonXp: { $gt: 0 } });

  if (myXp <= 0) {
    return { seasonId: season, rank: null, seasonXp: 0, seasonWins: 0, totalRanked };
  }
  // Count players strictly ahead in the board's order (XP, then wins, then name).
  const ahead = await players.countDocuments({
    seasonId: season,
    $or: [
      { seasonXp: { $gt: myXp } },
      { seasonXp: myXp, seasonWins: { $gt: myWins } },
      { seasonXp: myXp, seasonWins: myWins, username: { $lt: myName } },
    ],
  });
  return { seasonId: season, rank: ahead + 1, seasonXp: myXp, seasonWins: myWins, totalRanked };
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

// ─── Coin Store (#25, roadmap M2-3) ─────────────────────────────────────────
// Admin-curated: 5 cosmetics per UTC month, bought with Crazy Coins. The
// curated list lives in `store_rotation` (one doc per seasonId), set by the
// admin dashboard. Prices are by rarity (shared/store.ts), server-authoritative.

/** A typed error whose `.code` the HTTP layer maps to a client message. */
export class StoreError extends Error {
  constructor(public code: string) { super(code); this.name = 'StoreError'; }
}

/** The raw curated item ids for a season (empty if none set yet). */
export async function getStoreRotation(seasonId: string) {
  const doc = await db.collection('store_rotation').findOne({ seasonId });
  return { seasonId, itemIds: (doc?.itemIds as string[]) ?? [] };
}

/**
 * Set the curated rotation for a season (admin curation). Validates each id is
 * a real, store-eligible catalog item; drops duplicates; caps at STORE_SIZE.
 * Upserts the season's doc. Used by the admin dashboard + tests.
 */
export async function setStoreRotation(seasonId: string, itemIds: string[]) {
  const seen = new Set<string>();
  const clean: string[] = [];
  for (const id of itemIds) {
    if (seen.has(id)) continue;
    const item = ITEMS[id];
    if (!item || !inStorePool(item)) throw new StoreError('INVALID_ITEM');
    seen.add(id);
    clean.push(id);
  }
  if (clean.length > STORE_SIZE) throw new StoreError('TOO_MANY');
  const now = new Date();
  await db.collection('store_rotation').updateOne(
    { seasonId },
    { $set: { itemIds: clean, updatedAt: now }, $setOnInsert: { seasonId, createdAt: now } },
    { upsert: true },
  );
  return { seasonId, itemIds: clean };
}

/** This month's store: the curated items resolved to {id, name, slot, rarity,
 *  price}. Defensively drops any id that became store-ineligible. Public. */
export async function getCurrentStore() {
  const season = currentSeasonId();
  const { itemIds } = await getStoreRotation(season);
  const items = itemIds
    .map((id) => ITEMS[id])
    .filter((it): it is ItemDef => !!it && inStorePool(it))
    .map((it) => ({
      id: it.id, displayName: it.displayName, slot: it.slot,
      rarity: it.rarity, price: storePrice(it),
    }));
  return { seasonId: season, items };
}

/**
 * Buy a store item for coins, atomically and idempotently. Validates the item
 * is store-eligible AND in the current month's curated rotation, then (in one
 * transaction) debits coins, grants the item (unequipped), and records the
 * purchase. Duplicates are allowed (no owned-check). `buyId` is the idempotency
 * key — a retry returns the recorded outcome, never a double-charge.
 */
export async function buyStoreItem(userId: string, itemId: string, buyId: string) {
  const purchases = db.collection('purchases');
  const players = db.collection('players');
  const inv = db.collection('inventory');

  // Fast idempotency path (re-guarded by the unique index in the txn).
  const prior = await purchases.findOne({ buyId });
  if (prior) return { itemId: prior.itemId, price: prior.price, coins: prior.coinsAfter, idempotent: true };

  const item = ITEMS[itemId];
  if (!item || !inStorePool(item)) throw new StoreError('ITEM_NOT_FOUND');

  const season = currentSeasonId();
  const { itemIds } = await getStoreRotation(season);
  if (!itemIds.includes(itemId)) throw new StoreError('NOT_IN_STORE');
  const price = storePrice(item);

  try {
    return await withTransaction(async (session) => {
      const player = await players.findOne({ userId }, { session });
      if (!player) throw new StoreError('NO_PLAYER');
      const coins = player.coins ?? 0;
      if (coins < price) throw new StoreError('INSUFFICIENT_COINS');

      const now = new Date();
      const coinsAfter = coins - price;

      await inv.insertOne({
        playerId: player._id.toString(),
        itemType: item.slot, itemId: item.id, rarity: item.rarity,
        equipped: false, obtainedAt: now, source: 'store',
      }, { session });

      await players.updateOne({ userId }, { $set: { coins: coinsAfter, updatedAt: now } }, { session });

      // Recording the purchase (unique buyId) is the idempotency commit point.
      await purchases.insertOne({
        buyId, userId, itemId, price, coinsAfter, seasonId: season, createdAt: now,
      }, { session });

      return { itemId, price, coins: coinsAfter };
    });
  } catch (e: any) {
    if (e?.code === 11000) {
      const rec = await purchases.findOne({ buyId });
      if (rec) return { itemId: rec.itemId, price: rec.price, coins: rec.coinsAfter, idempotent: true };
    }
    throw e;
  }
}
