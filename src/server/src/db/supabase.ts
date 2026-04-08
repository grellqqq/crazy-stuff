import { createClient, SupabaseClient } from '@supabase/supabase-js';

const SUPABASE_URL = process.env.SUPABASE_URL ?? '';
const SUPABASE_SERVICE_KEY = process.env.SUPABASE_SERVICE_KEY ?? '';

if (!SUPABASE_URL || !SUPABASE_SERVICE_KEY) {
  console.warn('[DB] SUPABASE_URL or SUPABASE_SERVICE_KEY not set — database features disabled');
}

/** Server-side Supabase client using service role key (bypasses RLS). */
export const supabase: SupabaseClient = createClient(SUPABASE_URL, SUPABASE_SERVICE_KEY);

/** Create or get a player record by auth_id. */
export async function getOrCreatePlayer(authId: string, username: string) {
  // Try to find existing player
  const { data: existing } = await supabase
    .from('players')
    .select('*')
    .eq('auth_id', authId)
    .single();

  if (existing) return existing;

  // Create new player
  const { data: created, error } = await supabase
    .from('players')
    .insert({ auth_id: authId, username })
    .select()
    .single();

  if (error) {
    console.error('[DB] Failed to create player:', error);
    return null;
  }

  return created;
}

/** Award XP and coins after a race. */
export async function awardPostRace(authId: string, xp: number, coins: number, won: boolean) {
  const { data: player } = await supabase
    .from('players')
    .select('id, xp, coins, total_races, total_wins, level')
    .eq('auth_id', authId)
    .single();

  if (!player) return null;

  const newXp = player.xp + xp;
  const newCoins = player.coins + coins;
  const newLevel = Math.floor(newXp / 500) + 1; // Level up every 500 XP

  const { data: updated, error } = await supabase
    .from('players')
    .update({
      xp: newXp,
      coins: newCoins,
      level: newLevel,
      total_races: player.total_races + 1,
      total_wins: player.total_wins + (won ? 1 : 0),
      updated_at: new Date().toISOString(),
    })
    .eq('id', player.id)
    .select()
    .single();

  if (error) console.error('[DB] Failed to award post-race:', error);
  return updated;
}

/** Get player profile. */
export async function getPlayer(authId: string) {
  const { data } = await supabase
    .from('players')
    .select('*')
    .eq('auth_id', authId)
    .single();
  return data;
}

/** Get the player's equipped character key. */
export async function getEquippedChar(authId: string): Promise<string> {
  const { data } = await supabase
    .from('players')
    .select('equipped_char')
    .eq('auth_id', authId)
    .single();
  return data?.equipped_char ?? 'male';
}

/** Set the player's equipped character key. Returns the new value or null on failure. */
export async function equipChar(authId: string, charKey: string): Promise<string | null> {
  const allowed = ['male', 'female', 'male-medium', 'female-medium', 'male-dark', 'female-dark'];
  if (!allowed.includes(charKey)) return null;

  const { data, error } = await supabase
    .from('players')
    .update({ equipped_char: charKey, updated_at: new Date().toISOString() })
    .eq('auth_id', authId)
    .select('equipped_char')
    .single();

  if (error) {
    console.error('[DB] Failed to equip char:', error);
    return null;
  }
  return data?.equipped_char ?? null;
}

/** Get player inventory. */
export async function getInventory(authId: string) {
  const { data: player } = await supabase
    .from('players')
    .select('id')
    .eq('auth_id', authId)
    .single();

  if (!player) return [];

  const { data } = await supabase
    .from('inventory')
    .select('*')
    .eq('player_id', player.id)
    .order('obtained_at', { ascending: false });

  return data ?? [];
}

/** Add item to inventory. */
export async function addItem(authId: string, itemType: string, itemId: string, rarity: string) {
  const { data: player } = await supabase
    .from('players')
    .select('id')
    .eq('auth_id', authId)
    .single();

  if (!player) return null;

  const { data, error } = await supabase
    .from('inventory')
    .insert({ player_id: player.id, item_type: itemType, item_id: itemId, rarity })
    .select()
    .single();

  if (error) console.error('[DB] Failed to add item:', error);
  return data;
}
