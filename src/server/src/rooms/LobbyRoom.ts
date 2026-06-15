import { Room, Client } from 'colyseus';
import { Schema, type } from '@colyseus/schema';
import { verifyToken } from '../auth/jwt';
import { getLoadout } from '../db/mongo';

class LobbyState extends Schema {
  @type('number') playerCount = 0;
}

interface LobbyPlayer {
  sessionId: string;
  authId: string | null;
  playerName: string;
  x: number;
  y: number;
  facing: string;
  moving: boolean;
  charKey: string;
  /** Equipped slot → itemId, so other players render this player's gear. */
  loadout: Record<string, string>;
}

const ALLOWED_CHARS = ['male', 'female', 'male-medium', 'female-medium', 'male-dark', 'female-dark'];

export class LobbyRoom extends Room<LobbyState> {
  private lobbyPlayers = new Map<string, LobbyPlayer>();

  private broadcastLobby(): void {
    this.broadcast('lobbyState', { players: Array.from(this.lobbyPlayers.values()) });
  }

  onCreate(): void {
    this.setState(new LobbyState());
    // One shared lobby instance for everyone (raise if it ever needs sharding).
    this.maxClients = 50;

    this.onMessage('move', (client, data: { x: number; y: number; facing: string; moving: boolean }) => {
      const p = this.lobbyPlayers.get(client.sessionId);
      if (!p) return;
      // Validate: finite numbers within a sane world bound (anti-teleport/NaN).
      if (!Number.isFinite(data.x) || !Number.isFinite(data.y)) return;
      p.x = Math.max(-100, Math.min(4000, data.x));
      p.y = Math.max(-100, Math.min(4000, data.y));
      p.facing = typeof data.facing === 'string' ? data.facing : p.facing;
      p.moving = !!data.moving;
    });

    this.onMessage('changeChar', (client, data: { charKey: string }) => {
      if (!data?.charKey || !ALLOWED_CHARS.includes(data.charKey)) return;
      const p = this.lobbyPlayers.get(client.sessionId);
      if (!p) return;
      p.charKey = data.charKey;
      this.broadcastLobby(); // everyone sees the change right away
    });

    // Re-fetch loadout after the player equips/unequips, so others see the change.
    this.onMessage('refreshLoadout', (client) => {
      const p = this.lobbyPlayers.get(client.sessionId);
      if (!p || !p.authId) return;
      getLoadout(p.authId)
        .then((loadout) => { p.loadout = loadout ?? {}; this.broadcastLobby(); })
        .catch(() => {});
    });

    this.onMessage('chat', (client, data: { message?: string }) => {
      const p = this.lobbyPlayers.get(client.sessionId);
      if (!p || !data?.message) return;
      const message = data.message.slice(0, 100).trim();
      if (!message) return;
      this.broadcast('chat', {
        sessionId: client.sessionId,
        playerName: p.playerName,
        message,
        timestamp: new Date().toISOString(),
      });
    });

    // Broadcast positions at 10 ticks/sec
    this.setSimulationInterval(() => {
      const players = Array.from(this.lobbyPlayers.values());
      this.broadcast('lobbyState', { players });
    }, 100);

    console.log('[LobbyRoom] created');
  }

  /** See design/gdd/03-authentication.md §3.7 — lobby is guest-friendly; token (if supplied) must verify. */
  onAuth(_client: Client, options: { token?: string }): { authId: string | null; username: string | null } | false {
    if (!options?.token) return { authId: null, username: null };
    const payload = verifyToken(options.token);
    if (!payload) return false;
    return { authId: payload.sub, username: payload.username };
  }

  async onJoin(client: Client, options: { playerName?: string; charKey?: string }, auth?: { authId: string | null; username: string | null }): Promise<void> {
    const name = (options?.playerName ?? auth?.username ?? 'Player').replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 20).trim() || 'Player';
    const authId = auth?.authId ?? null;
    // Pull the player's equipped loadout so others render their gear, not a bare body.
    let loadout: Record<string, string> = {};
    if (authId) {
      try { loadout = (await getLoadout(authId)) ?? {}; } catch { /* DB down → bare body */ }
    }
    this.lobbyPlayers.set(client.sessionId, {
      sessionId: client.sessionId,
      authId,
      playerName: name,
      x: 400,
      y: 360,
      facing: 'SD',
      moving: false,
      charKey: options?.charKey ?? 'male',
      loadout,
    });
    this.state.playerCount = this.lobbyPlayers.size;
    // Immediate snapshot so existing players see the newcomer (and vice versa)
    // without waiting up to 100ms for the next tick.
    this.broadcastLobby();
    console.log(`[LobbyRoom] joined: ${name} (total: ${this.state.playerCount})`);
  }

  onLeave(client: Client): void {
    this.lobbyPlayers.delete(client.sessionId);
    this.state.playerCount = this.lobbyPlayers.size;
    console.log(`[LobbyRoom] left: ${client.sessionId} (total: ${this.state.playerCount})`);
  }

  onDispose(): void {
    console.log('[LobbyRoom] disposed');
  }
}
