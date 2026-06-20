/**
 * Password-reset integration test (M3-3, auth GDD §3.10) — real persistence
 * path against mongodb-memory-server. Covers token mint + consume, single-use,
 * wrong/expired token rejection, Google-only accounts (no password) yielding no
 * token, and that the password actually changes.
 *
 * Run: npx tsx --test tests/integration/password-reset.int.test.ts
 */
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { MongoMemoryReplSet } from 'mongodb-memory-server';
import bcrypt from 'bcryptjs';

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

async function makePasswordUser(email: string, name: string, pw: string): Promise<void> {
  await mongo.getDB().collection('users').insertOne({
    email: email.toLowerCase(), username: name, passwordHash: await bcrypt.hash(pw, 10),
    googleSub: null, createdAt: new Date(),
  });
}

test('reset_fullFlow_changesPassword', async () => {
  // Arrange
  await makePasswordUser('alice@x.com', 'alice', 'oldpass');
  // Act — request a reset, then consume the token with a new password.
  const minted = await mongo.createPasswordReset('alice@x.com');
  assert.ok(minted, 'token minted for a password account');
  const newHash = await bcrypt.hash('newpass123', 10);
  const ok = await mongo.resetPasswordWithToken(minted!.token, newHash);
  assert.equal(ok, true);
  // Assert — the stored password is now the new one.
  const user = await mongo.getDB().collection('users').findOne({ email: 'alice@x.com' });
  assert.equal(await bcrypt.compare('newpass123', user!.passwordHash), true);
  assert.equal(await bcrypt.compare('oldpass', user!.passwordHash), false);
});

test('reset_tokenIsSingleUse', async () => {
  await makePasswordUser('bob@x.com', 'bob', 'oldpass');
  const minted = await mongo.createPasswordReset('bob@x.com');
  const h1 = await bcrypt.hash('first123', 10);
  assert.equal(await mongo.resetPasswordWithToken(minted!.token, h1), true);
  // Second use of the same token must fail.
  const h2 = await bcrypt.hash('second123', 10);
  assert.equal(await mongo.resetPasswordWithToken(minted!.token, h2), false);
});

test('reset_wrongToken_rejected', async () => {
  const ok = await mongo.resetPasswordWithToken('deadbeef'.repeat(8), await bcrypt.hash('whatever', 10));
  assert.equal(ok, false);
});

test('reset_expiredToken_rejected', async () => {
  await makePasswordUser('carol@x.com', 'carol', 'oldpass');
  const minted = await mongo.createPasswordReset('carol@x.com');
  // Force the token to be expired.
  const crypto = await import('crypto');
  const tokenHash = crypto.createHash('sha256').update(minted!.token).digest('hex');
  await mongo.getDB().collection('passwordResetTokens').updateOne(
    { tokenHash }, { $set: { expiresAt: new Date(Date.now() - 1000) } },
  );
  const ok = await mongo.resetPasswordWithToken(minted!.token, await bcrypt.hash('newpass123', 10));
  assert.equal(ok, false);
});

test('reset_unknownEmail_mintsNoToken', async () => {
  const minted = await mongo.createPasswordReset('nobody@x.com');
  assert.equal(minted, null);
});

test('reset_googleOnlyAccount_mintsNoToken', async () => {
  await mongo.getDB().collection('users').insertOne({
    email: 'goog@x.com', username: 'goog', passwordHash: null, googleSub: 'sub-1', createdAt: new Date(),
  });
  const minted = await mongo.createPasswordReset('goog@x.com');
  assert.equal(minted, null, 'Google-only accounts have no password to reset');
});
