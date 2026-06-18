import dotenv from 'dotenv';
import path from 'path';
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
import http from 'http';
import express from 'express';
import cors from 'cors';
import { Server } from 'colyseus';
import { LobbyRoom } from './rooms/LobbyRoom';
import { QueueRoom } from './rooms/QueueRoom';
import { RaceRoom } from './rooms/RaceRoom';
import { authRouter } from './auth/routes';
import { rateLimit } from './rate-limit';
import { requireOwnership } from './auth/middleware';
import { connectDB, resetInventoriesOnBoot } from './db/mongo';
import {
  getOrCreatePlayer, getPlayer, getEquippedChar, equipChar,
  getInventory, equipItem, unequipItem,
  getGachaOdds, getGachaStatus, executePull, devGrantCredits, GachaError,
  getLeaderboard, getPlayerSeasonRank,
} from './db/mongo';

const app = express();
// Behind one reverse proxy (Dokploy) — trust the first hop so req.ip is the real client IP.
app.set('trust proxy', 1);
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json());

// Auth routes — throttled per-IP against credential-stuffing / brute-force (M3-2).
app.use('/auth', rateLimit({ windowMs: 5 * 60_000, max: 30, message: 'Too many auth attempts — slow down and try again shortly.' }), authRouter);

// Serve the built client (production mode)
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Public gacha odds disclosure (no auth — catalog-derived, shown on the pull
// screen). Gacha GDD §3.1 / AC10.
app.get('/api/gacha/odds', (_req, res) => {
  try {
    res.json(getGachaOdds());
  } catch (e) {
    console.error('[API] gacha odds error:', e);
    res.status(500).json({ error: 'db error' });
  }
});

// Map a GachaError code → HTTP status + safe client message.
const GACHA_HTTP: Record<string, { status: number; message: string }> = {
  BAD_COUNT: { status: 400, message: 'Pull count must be 1, 5, or 10.' },
  FREE_PULL_USED: { status: 409, message: 'Daily free pull already used. Come back tomorrow.' },
  PAID_DISABLED: { status: 403, message: 'Paid pulls are not available yet.' },
  INSUFFICIENT_CREDITS: { status: 402, message: 'Not enough pull credits.' },
  NO_PLAYER: { status: 404, message: 'Player not found.' },
  DEV_DISABLED: { status: 403, message: 'Dev grant disabled.' },
  POOL_EMPTY: { status: 503, message: 'The gacha pool is empty.' },
};

function sendGachaError(res: express.Response, e: unknown): void {
  const code = e instanceof GachaError ? e.code
    : (e instanceof Error && e.message === 'POOL_EMPTY') ? 'POOL_EMPTY' : null;
  if (code && GACHA_HTTP[code]) {
    res.status(GACHA_HTTP[code].status).json({ error: code, message: GACHA_HTTP[code].message });
  } else {
    console.error('[API] gacha error:', e);
    res.status(500).json({ error: 'db error' });
  }
}

// Public seasonal leaderboard (#23) — top players by season XP. No auth: it's
// a public board (like gacha odds). `limit` is clamped to [1, 100].
app.get('/api/leaderboard', async (req, res) => {
  try {
    const raw = Number(req.query.limit);
    const limit = Number.isFinite(raw) ? Math.min(100, Math.max(1, Math.floor(raw))) : 25;
    res.json(await getLeaderboard(limit));
  } catch (e) {
    console.error('[API] leaderboard error:', e);
    res.status(500).json({ error: 'db error' });
  }
});

// All /api/player/:userId/* routes require a valid JWT whose subject matches :userId.
// See design/gdd/03-authentication.md §3.7 for the contract.
app.use('/api/player/:userId', requireOwnership);

// The requesting player's own season standing (rank even when outside the top N).
app.get('/api/player/:userId/rank', async (req, res) => {
  try {
    res.json(await getPlayerSeasonRank(req.params.userId));
  } catch (e) {
    console.error('[API] rank error:', e);
    res.status(500).json({ error: 'db error' });
  }
});

// Player profile API
app.get('/api/player/:userId', async (req, res) => {
  try {
    const username = (req.query.username as string) || 'Player';
    const player = await getOrCreatePlayer(req.params.userId, username);
    if (!player) return res.status(404).json({ error: 'not found' });
    res.json(player);
  } catch (e) {
    console.error('[API] player error:', e);
    res.status(500).json({ error: 'db error' });
  }
});

// Equipped character API
app.get('/api/player/:userId/equipped-char', async (req, res) => {
  try {
    const charKey = await getEquippedChar(req.params.userId);
    res.json({ charKey });
  } catch (e) {
    res.status(500).json({ error: 'db error' });
  }
});

app.post('/api/player/:userId/equip-char', async (req, res) => {
  try {
    const { charKey } = req.body;
    if (!charKey || typeof charKey !== 'string') {
      return res.status(400).json({ error: 'charKey required' });
    }
    const result = await equipChar(req.params.userId, charKey);
    if (!result) return res.status(400).json({ error: 'invalid charKey' });
    res.json({ charKey: result });
  } catch (e) {
    res.status(500).json({ error: 'db error' });
  }
});

// Inventory API
app.get('/api/player/:userId/inventory', async (req, res) => {
  try {
    const items = await getInventory(req.params.userId);
    res.json(items);
  } catch (e) {
    res.status(500).json({ error: 'db error' });
  }
});

app.post('/api/player/:userId/equip', async (req, res) => {
  try {
    const { inventoryItemId, equipped } = req.body;
    if (!inventoryItemId) return res.status(400).json({ error: 'inventoryItemId required' });

    if (equipped) {
      const result = await equipItem(req.params.userId, inventoryItemId);
      if (!result) return res.status(400).json({ error: 'could not equip item' });
    } else {
      const result = await unequipItem(req.params.userId, inventoryItemId);
      if (!result) return res.status(400).json({ error: 'could not unequip item' });
    }

    res.json({ ok: true });
  } catch (e) {
    res.status(500).json({ error: 'db error' });
  }
});

// Gacha — per-player machine state (free availability, pity, credits).
app.get('/api/player/:userId/gacha', async (req, res) => {
  try {
    res.json(await getGachaStatus(req.params.userId));
  } catch (e) {
    sendGachaError(res, e);
  }
});

// Gacha — execute a pull. Body: { pullId: string, count?: 1|5|10, paid?: bool }.
// Free single when paid is falsy; paid batch otherwise.
app.post('/api/player/:userId/gacha/pull', async (req, res) => {
  try {
    const { pullId, count, paid } = req.body ?? {};
    if (!pullId || typeof pullId !== 'string') {
      return res.status(400).json({ error: 'pullId required' });
    }
    const result = await executePull(req.params.userId, pullId, {
      count: typeof count === 'number' ? count : 1,
      paid: Boolean(paid),
    });
    res.json(result);
  } catch (e) {
    sendGachaError(res, e);
  }
});

// DEV ONLY (env GACHA_DEV=1): grant pull credits to exercise multi-pull before
// Payment Integration exists. 404s in production so it's invisible.
app.post('/api/player/:userId/gacha/dev-credits', async (req, res) => {
  if (process.env.GACHA_DEV !== '1') return res.status(404).json({ error: 'not found' });
  try {
    const amount = Number(req.body?.amount ?? 10);
    const credits = await devGrantCredits(req.params.userId, amount);
    res.json({ pullCredits: credits });
  } catch (e) {
    sendGachaError(res, e);
  }
});

// SPA fallback
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const httpServer = http.createServer(app);
const gameServer = new Server({ server: httpServer });

gameServer.define('lobby', LobbyRoom);
gameServer.define('queue', QueueRoom);
gameServer.define('race', RaceRoom);

// Connect to MongoDB then start server (graceful fallback for local dev without DB)
connectDB().then(async () => {
  // One-time, env-gated inventory reset (no-op unless INVENTORY_RESET_KEEP_EMAIL
  // is set; safe to leave configured — it won't repeat for the same token).
  await resetInventoriesOnBoot().catch((e) => console.error('[reset] failed:', e));
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] Running on http://0.0.0.0:${PORT}`);
  });
}).catch((e) => {
  console.error('[server] Failed to connect to MongoDB:', e);
  console.warn('[server] Starting WITHOUT database — auth and persistence disabled (dev mode)');
  httpServer.listen(PORT, '0.0.0.0', () => {
    console.log(`[server] Running on http://0.0.0.0:${PORT} (no database)`);
  });
});
