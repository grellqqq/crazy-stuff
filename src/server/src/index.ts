import http from 'http';
import path from 'path';
import express from 'express';
import { Server } from 'colyseus';
import { LobbyRoom } from './rooms/LobbyRoom';
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

// SPA fallback — serve index.html for any non-API route
app.get('*', (_req, res) => {
  res.sendFile(path.join(clientDist, 'index.html'));
});

const httpServer = http.createServer(app);
const gameServer = new Server({ server: httpServer });

gameServer.define('lobby', LobbyRoom);
gameServer.define('race', RaceRoom);

httpServer.listen(PORT, '0.0.0.0', () => {
  console.log(`[server] Running on http://0.0.0.0:${PORT}`);
});
