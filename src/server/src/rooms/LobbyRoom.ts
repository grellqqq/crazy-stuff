import { Room, Client } from 'colyseus';
import { Schema, type } from '@colyseus/schema';

class LobbyState extends Schema {
  @type('number') playerCount = 0;
}

export class LobbyRoom extends Room<LobbyState> {
  onCreate(): void {
    this.setState(new LobbyState());
    console.log('[LobbyRoom] created');
  }

  onJoin(client: Client): void {
    this.state.playerCount++;
    console.log(`[LobbyRoom] joined: ${client.sessionId} (total: ${this.state.playerCount})`);
  }

  onLeave(client: Client): void {
    this.state.playerCount--;
    console.log(`[LobbyRoom] left:   ${client.sessionId} (total: ${this.state.playerCount})`);
  }

  onDispose(): void {
    console.log('[LobbyRoom] disposed');
  }
}
