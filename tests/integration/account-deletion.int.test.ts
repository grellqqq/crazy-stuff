/**
 * GDPR account deletion integration test (M3-5) — runs the REAL persistence
 * path against mongodb-memory-server, verifying the cascade purges the user
 * and ALL their data (users, players, inventory, pulls, purchases) in one
 * transaction, leaves OTHER users untouched, and is idempotent.
 *
 * Run: npx tsx --test tests/integration/account-deletion.int.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import { ObjectId } from 'mongodb';

let replset: MongoMemoryReplSet;
let mongo: typeof import('../../src/server/src/db/mongo.ts');

before(async () => {
  replset = await MongoMemoryReplSet.create({ replSet: { count: 1 } });
  process.env.MONGODB_URI = replset.getUri();
  mongo = await import('../../src/server/src/db/mongo.ts');
  await mongo.connectDB();
});

after(async () => {
  await mongo?.closeDB();
  await replset?.stop({ doCleanup: true, force: true });
});

/** Create a user row + player + some data; return the userId string. */
async function makeAccount(email: string, name: string): Promise<string> {
  const db = mongo.getDB();
  const u = await db.collection('users').insertOne({
    email, username: name, passwordHash: 'x', googleSub: null, createdAt: new Date(),
  });
  const userId = u.insertedId.toString();
  const player = await mongo.getOrCreatePlayer(userId, name); // creates player + starter inventory
  const playerId = player!._id.toString();
  await db.collection('pulls').insertOne({ pullId: `p-${name}`, userId, results: [], createdAt: new Date() });
  await db.collection('purchases').insertOne({ buyId: `b-${name}`, userId, itemId: 'tshirt_red', price: 500, createdAt: new Date() });
  return userId;
}

async function counts(userId: string) {
  const db = mongo.getDB();
  const player = await db.collection('players').findOne({ userId });
  const playerId = player?._id.toString();
  return {
    users: await db.collection('users').countDocuments({ _id: new ObjectId(userId) }),
    players: await db.collection('players').countDocuments({ userId }),
    inventory: playerId ? await db.collection('inventory').countDocuments({ playerId }) : 0,
    pulls: await db.collection('pulls').countDocuments({ userId }),
    purchases: await db.collection('purchases').countDocuments({ userId }),
  };
}

test('deleteAccount_purgesAllUserData', async () => {
  // Arrange — a populated account + a bystander account.
  const alice = await makeAccount('alice@x.com', 'alice');
  const bob = await makeAccount('bob@x.com', 'bob');
  const before = await counts(alice);
  assert.equal(before.users, 1);
  assert.ok(before.inventory >= 3, 'has starter inventory');
  assert.equal(before.pulls, 1);
  assert.equal(before.purchases, 1);

  // Act
  const res = await mongo.deleteAccount(alice);

  // Assert — every collection purged for alice.
  assert.equal(res.deletedUser, true);
  const after = await counts(alice);
  assert.deepEqual(after, { users: 0, players: 0, inventory: 0, pulls: 0, purchases: 0 });

  // Bob is untouched.
  const bobAfter = await counts(bob);
  assert.equal(bobAfter.users, 1);
  assert.ok(bobAfter.inventory >= 3);
});

test('deleteAccount_isIdempotent', async () => {
  const carol = await makeAccount('carol@x.com', 'carol');
  await mongo.deleteAccount(carol);
  // Second delete of an already-gone account is a harmless no-op.
  const res = await mongo.deleteAccount(carol);
  assert.equal(res.deletedUser, false);
});

test('deleteAccount_malformedUserId_doesNotThrow', async () => {
  const res = await mongo.deleteAccount('not-an-objectid');
  assert.equal(res.deletedUser, false);
});
