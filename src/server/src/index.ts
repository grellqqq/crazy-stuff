import 'dotenv/config';
import http from 'http';
import path from 'path';
import express from 'express';
import { Server } from 'colyseus';
import { LobbyRoom } from './rooms/LobbyRoom';
import { QueueRoom } from './rooms/QueueRoom';
import { RaceRoom } from './rooms/RaceRoom';

const app = express();
const PORT = Number(process.env.PORT ?? 3000);

app.use(express.json());

// Serve the built client (production mode)
const clientDist = path.resolve(__dirname, '../../client/dist');
app.use(express.static(clientDist));

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

// Player profile API
app.get('/api/player/:authId', async (req, res) => {
  try {
    const { getPlayer } = await import('./db/supabase');
    const player = await getPlayer(req.params.authId);
    if (!player) return res.status(404).json({ error: 'not found' });
    res.json(player);
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
