import { Room, Client } from 'colyseus';
import { Schema, type } from '@colyseus/schema';

class LobbyState extends Schema {
  @type('number') playerCount = 0;
}

interface LobbyPlayer {
  sessionId: string;
  playerName: string;
  x: number;
  y: number;
  facing: string;
  moving: boolean;
  charKey: string;
}

export class LobbyRoom extends Room<LobbyState> {
  private lobbyPlayers = new Map<string, LobbyPlayer>();

  onCreate(): void {
    this.setState(new LobbyState());

    this.onMessage('move', (client, data: { x: number; y: number; facing: string; moving: boolean }) => {
      const p = this.lobbyPlayers.get(client.sessionId);
      if (!p) return;
      p.x = data.x;
      p.y = data.y;
      p.facing = data.facing;
      p.moving = data.moving;
    });

    // Broadcast positions at 10 ticks/sec
    this.setSimulationInterval(() => {
      const players = Array.from(this.lobbyPlayers.values());
      this.broadcast('lobbyState', { players });
    }, 100);

    console.log('[LobbyRoom] created');
  }

  onJoin(client: Client, options: { playerName?: string; charKey?: string }): void {
    const name = (options?.playerName ?? 'Player').replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 20).trim() || 'Player';
    this.lobbyPlayers.set(client.sessionId, {
      sessionId: client.sessionId,
      playerName: name,
      x: 400,
      y: 360,
      facing: 'SD',
      moving: false,
      charKey: options?.charKey ?? 'male',
    });
    this.state.playerCount = this.lobbyPlayers.size;
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
