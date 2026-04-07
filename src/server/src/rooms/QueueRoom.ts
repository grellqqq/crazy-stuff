import { Room, Client } from 'colyseus';
import { Schema, type, ArraySchema } from '@colyseus/schema';

class QueuePlayer extends Schema {
  @type('string') sessionId = '';
  @type('string') playerName = '';
  @type('boolean') ready = false;
}

class QueueState extends Schema {
  @type([QueuePlayer]) players = new ArraySchema<QueuePlayer>();
  @type('boolean') starting = false;
  @type('number') countdown = 0;
}

const MAX_PLAYERS = 5;
const COUNTDOWN_SECONDS = 5;

export class QueueRoom extends Room<QueueState> {
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private authIds = new Map<string, string>(); // sessionId → authId

  onCreate(): void {
    this.setState(new QueueState());
    this.maxClients = MAX_PLAYERS;

    this.onMessage('ready', (client) => {
      const player = this.state.players.find(p => p.sessionId === client.sessionId);
      if (player) {
        player.ready = !player.ready; // toggle
        this.checkAllReady();
      }
    });

    console.log('[QueueRoom] created');
  }

  onJoin(client: Client, options: { playerName?: string; authId?: string }): void {
    const player = new QueuePlayer();
    player.sessionId = client.sessionId;
    player.playerName = (options?.playerName ?? 'Player').replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 20).trim() || 'Player';
    player.ready = false;
    this.state.players.push(player);

    if (options?.authId) this.authIds.set(client.sessionId, options.authId);

    this.broadcast('playerList', this.getPlayerList());
    console.log(`[QueueRoom] joined: ${player.playerName} (${this.state.players.length}/${MAX_PLAYERS})`);
  }

  onLeave(client: Client): void {
    const idx = this.state.players.findIndex(p => p.sessionId === client.sessionId);
    if (idx !== -1) {
      const name = this.state.players[idx].playerName;
      this.state.players.splice(idx, 1);
      this.authIds.delete(client.sessionId);
      console.log(`[QueueRoom] left: ${name} (${this.state.players.length}/${MAX_PLAYERS})`);
    }

    // Cancel countdown if someone leaves
    if (this.state.starting) {
      this.cancelCountdown();
    }

    this.broadcast('playerList', this.getPlayerList());
  }

  onDispose(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    console.log('[QueueRoom] disposed');
  }

  private checkAllReady(): void {
    this.broadcast('playerList', this.getPlayerList());

    const allReady = this.state.players.length >= 2 && this.state.players.every(p => p.ready);

    if (allReady && !this.state.starting) {
      this.startCountdown();
    } else if (!allReady && this.state.starting) {
      this.cancelCountdown();
    }
  }

  private startCountdown(): void {
    this.state.starting = true;
    this.state.countdown = COUNTDOWN_SECONDS;
    this.broadcast('countdown', { seconds: this.state.countdown });

    this.countdownTimer = setInterval(() => {
      this.state.countdown--;
      this.broadcast('countdown', { seconds: this.state.countdown });

      if (this.state.countdown <= 0) {
        if (this.countdownTimer) clearInterval(this.countdownTimer);
        this.countdownTimer = null;
        this.launchRace();
      }
    }, 1000);
  }

  private cancelCountdown(): void {
    this.state.starting = false;
    this.state.countdown = 0;
    if (this.countdownTimer) {
      clearInterval(this.countdownTimer);
      this.countdownTimer = null;
    }
    this.broadcast('countdown', { seconds: 0, cancelled: true });
  }

  private launchRace(): void {
    // Send launch signal with player info
    const players = this.state.players.map(p => ({
      sessionId: p.sessionId,
      playerName: p.playerName,
      authId: this.authIds.get(p.sessionId) ?? null,
    }));
    this.broadcast('launchRace', { players });
    console.log(`[QueueRoom] launching race with ${players.length} players`);

    // Disconnect all clients after a brief delay (they'll join the RaceRoom)
    setTimeout(() => {
      this.disconnect();
    }, 1000);
  }

  private getPlayerList(): { sessionId: string; playerName: string; ready: boolean }[] {
    return this.state.players.map(p => ({
      sessionId: p.sessionId,
      playerName: p.playerName,
      ready: p.ready,
    }));
  }
}
