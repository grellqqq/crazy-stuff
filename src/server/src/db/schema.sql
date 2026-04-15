-- Players table — stores account data, XP, coins
CREATE TABLE IF NOT EXISTS players (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  auth_id UUID UNIQUE,                              -- legacy Supabase auth ID (kept for migration)
  email TEXT UNIQUE,                                 -- email/password login
  password_hash TEXT,                                -- bcrypt hash (null for Google-only accounts)
  google_sub TEXT UNIQUE,                            -- Google OAuth subject ID
  username TEXT UNIQUE NOT NULL,
  xp INTEGER NOT NULL DEFAULT 0,
  level INTEGER NOT NULL DEFAULT 1,
  coins INTEGER NOT NULL DEFAULT 0,
  total_races INTEGER NOT NULL DEFAULT 0,
  total_wins INTEGER NOT NULL DEFAULT 0,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  equipped_char TEXT NOT NULL DEFAULT 'male'
);

-- Inventory table — items owned by players
CREATE TABLE IF NOT EXISTS inventory (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  player_id UUID NOT NULL REFERENCES players(id) ON DELETE CASCADE,
  item_type TEXT NOT NULL,        -- 'skin', 'hair', 'hat', 'upper_body', etc.
  item_id TEXT NOT NULL,          -- specific item identifier
  rarity TEXT NOT NULL DEFAULT 'common',  -- common, uncommon, rare, epic, legendary, crazy
  equipped BOOLEAN NOT NULL DEFAULT false,
  obtained_at TIMESTAMPTZ NOT NULL DEFAULT now()
);

-- Indexes
CREATE INDEX IF NOT EXISTS idx_inventory_player ON inventory(player_id);
CREATE INDEX IF NOT EXISTS idx_players_auth ON players(auth_id);
CREATE INDEX IF NOT EXISTS idx_players_email ON players(email);
CREATE INDEX IF NOT EXISTS idx_players_google_sub ON players(google_sub);
CREATE INDEX IF NOT EXISTS idx_players_username ON players(username);
