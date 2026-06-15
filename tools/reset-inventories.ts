/**
 * One-shot inventory reset: give EVERY player the 3-item starter kit, EXCEPT
 * one preserved account (keeps everything it has).
 *
 * Safe by default — runs a DRY RUN (reports, writes nothing) unless --apply is
 * passed, and refuses to do anything if it can't resolve the account to keep
 * (so it can never wipe everyone including you by accident).
 *
 * Usage (run where MONGODB_URI is set — locally with the prod URI in .env, or
 * on the Dokploy host):
 *   npx tsx tools/reset-inventories.ts --keep-email=you@example.com            # dry run
 *   npx tsx tools/reset-inventories.ts --keep-email=you@example.com --apply    # do it
 *
 * You can also keep by player userId:  --keep-user=<users._id string>
 */
import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(process.cwd(), 'src/server/.env') });

import { MongoClient } from 'mongodb';
import { ITEMS } from '../src/shared/items';

const STARTER_KIT_IDS = ['worn_tshirt', 'blue_jeans', 'beatup_sneakers'];

function arg(name: string): string | undefined {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`));
  return hit ? hit.split('=').slice(1).join('=') : undefined;
}

async function main(): Promise<void> {
  const apply = process.argv.includes('--apply');
  const keepEmail = (arg('keep-email') ?? '').toLowerCase() || undefined;
  const keepUser = arg('keep-user') || undefined;

  const uri = process.env.MONGODB_URI;
  if (!uri) { console.error('MONGODB_URI not set (check .env).'); process.exit(1); }
  if (!keepEmail && !keepUser) {
    console.error('Refusing to run: pass --keep-email=<email> or --keep-user=<userId> to choose the account to preserve.');
    process.exit(1);
  }

  const client = new MongoClient(uri);
  await client.connect();
  const db = client.db('crazystuff');
  const users = db.collection('users');
  const players = db.collection('players');
  const inventory = db.collection('inventory');

  // Resolve the account to keep → its player _id.
  let keepUserId = keepUser;
  if (!keepUserId && keepEmail) {
    const u = await users.findOne({ email: keepEmail });
    if (!u) { console.error(`No user found with email ${keepEmail}. Aborting (nothing changed).`); await client.close(); process.exit(1); }
    keepUserId = u._id.toString();
  }
  const keepPlayer = await players.findOne({ userId: keepUserId });
  if (!keepPlayer) { console.error(`No player found for userId ${keepUserId}. Aborting (nothing changed).`); await client.close(); process.exit(1); }
  const keepPlayerId = keepPlayer._id.toString();
  const keepItemCount = await inventory.countDocuments({ playerId: keepPlayerId });

  const allPlayers = await players.find({}).project({ _id: 1, username: 1 }).toArray();
  const resetPlayers = allPlayers.filter((p) => p._id.toString() !== keepPlayerId);
  const resetIds = resetPlayers.map((p) => p._id.toString());
  const toDelete = await inventory.countDocuments({ playerId: { $in: resetIds } });

  console.log('─'.repeat(60));
  console.log(`KEEP account : ${keepPlayer.username} (userId ${keepUserId}) — ${keepItemCount} items, untouched`);
  console.log(`RESET        : ${resetPlayers.length} other players → 3-item starter kit`);
  console.log(`Inventory rows to delete from reset players: ${toDelete}`);
  console.log(`Mode         : ${apply ? 'APPLY (writing)' : 'DRY RUN (no writes) — re-run with --apply to execute'}`);
  console.log('─'.repeat(60));

  if (!apply) { await client.close(); return; }

  const now = new Date();
  const starterLoadout: Record<string, string> = {};
  const starterRowsFor = (playerId: string) => STARTER_KIT_IDS.map((id) => {
    const it = ITEMS[id];
    starterLoadout[it.slot] = it.id;
    return { playerId, itemType: it.slot, itemId: it.id, rarity: it.rarity, equipped: true, obtainedAt: now, source: 'starter' };
  });

  // Wipe + re-grant in bulk.
  if (resetIds.length > 0) {
    await inventory.deleteMany({ playerId: { $in: resetIds } });
    const rows = resetIds.flatMap((pid) => starterRowsFor(pid));
    if (rows.length > 0) await inventory.insertMany(rows);
    await players.updateMany(
      { _id: { $in: resetPlayers.map((p) => p._id) } },
      { $set: { equippedLoadout: starterLoadout, updatedAt: now } },
    );
  }

  console.log(`Done. ${resetPlayers.length} players reset to the starter kit; ${keepPlayer.username} kept ${keepItemCount} items.`);
  await client.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
