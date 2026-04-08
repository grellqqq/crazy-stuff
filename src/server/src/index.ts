import dotenv from 'dotenv';
import path from 'path';
// Try multiple possible .env locations
dotenv.config({ path: path.resolve(process.cwd(), '.env') });
dotenv.config({ path: path.resolve(__dirname, '../../../.env') });
import http from 'http';
import express from 'express';
import cors from 'cors';
import { Server } from 'colyseus';
import { LobbyRoom } from './rooms/LobbyRoom';
import { QueueRoom } from './rooms/QueueRoom';
import { RaceRoom } from './rooms/RaceRoom';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(cors());
app.use(express.json());

// Serve the built client (production mode)
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Player profile API — creates player record on first access
app.get('/api/player/:authId', async (req, res) => {
  try {
    const { getOrCreatePlayer } = await import('./db/supabase');
    const username = (req.query.username as string) || 'Player';
    console.log(`[API] GET /api/player/${req.params.authId} username=${username}`);
    const player = await getOrCreatePlayer(req.params.authId, username);
    if (!player) {
      console.log('[API] player not found/created');
      return res.status(404).json({ error: 'not found' });
    }
    console.log('[API] player:', player.username, 'level:', player.level);
    res.json(player);
  } catch (e) {
    console.error('[API] player error:', e);
    res.status(500).json({ error: 'db error' });
  }
});

// Equipped character API
app.get('/api/player/:authId/equipped-char', async (req, res) => {
  try {
    const { getEquippedChar } = await import('./db/supabase');
    const charKey = await getEquippedChar(req.params.authId);
    res.json({ charKey });
  } catch (e) {
    res.status(500).json({ error: 'db error' });
  }
});

app.post('/api/player/:authId/equip-char', async (req, res) => {
  try {
    const { charKey } = req.body;
    if (!charKey || typeof charKey !== 'string') {
      return res.status(400).json({ error: 'charKey required' });
    }
    const { equipChar } = await import('./db/supabase');
    const result = await equipChar(req.params.authId, charKey);
    if (!result) return res.status(400).json({ error: 'invalid charKey' });
    res.json({ charKey: result });
  } catch (e) {
    res.status(500).json({ error: 'db error' });
  }
});

// SPA fallback — serve index.html for any non-API route
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const httpServer = http.createServer(app);
const gameServer = new Server({ server: httpServer });

gameServer.define('lobby', LobbyRoom);
gameServer.define('queue', QueueRoom);
gameServer.define('race', RaceRoom);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Running on http://0.0.0.0:${PORT}`);
});
