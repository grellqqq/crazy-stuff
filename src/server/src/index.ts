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
import { connectDB } from './db/mongo';
import {
  getOrCreatePlayer, getPlayer, getEquippedChar, equipChar,
  getInventory, equipItem, unequipItem,
} from './db/mongo';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json());

// Auth routes
app.use('/auth', authRouter);

// Serve the built client (production mode)
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
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
connectDB().then(() => {
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
