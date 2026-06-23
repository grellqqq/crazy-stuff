import { Room, Client, matchMaker } from 'colyseus';
import { Schema, type, ArraySchema } from '@colyseus/schema';
import { verifyToken } from '../auth/jwt';

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

  /** See design/gdd/03-authentication.md §3.7 — guests allowed, but tokens (if supplied) must verify. */
  onAuth(_client: Client, options: { token?: string }): { authId: string | null; username: string | null } | false {
    if (!options?.token) return { authId: null, username: null };
    const payload = verifyToken(options.token);
    if (!payload) return false;
    return { authId: payload.sub, username: payload.username };
  }

  onJoin(client: Client, options: { playerName?: string }, auth?: { authId: string | null; username: string | null }): void {
    const authId = auth?.authId ?? null;

    const player = new QueuePlayer();
    player.sessionId = client.sessionId;
    player.playerName = (options?.playerName ?? auth?.username ?? 'Player').replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 20).trim() || 'Player';
    player.ready = false;
    this.state.players.push(player);

    if (authId) this.authIds.set(client.sessionId, authId);

    this.broadcast('playerList', this.getPlayerList());
    console.log(`[QueueRoom] joined: ${player.playerName} (${this.state.players.length}/${MAX_PLAYERS})`);
  }

  onLeave(client: Client): void {
    const idx = this.state.players.findIndex(p => p.sessionId === client.sessionId);
    if (idx !== -1) {
      const name = this.state.players[idx]?.playerName ?? 'unknown';
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

  private async launchRace(): Promise<void> {
    // Create ONE race room up front and hand every queued client its id, so they
    // all `joinById` the SAME room. Previously each client independently called
    // joinOrCreate('race') at the same instant (same launchRace broadcast), and
    // Colyseus's create race could spin up a second room — splitting a 5-player
    // group into e.g. 3 + 2. Creating the room here removes that race entirely.
    let roomId: string | null = null;
    try {
      const room = await matchMaker.createRoom('race', {});
      roomId = room.roomId;
      console.log(`[QueueRoom] launching race ${roomId} with ${this.state.players.length} players`);
    } catch (e) {
      // Fall back to client-side joinOrCreate if room creation fails — better a
      // possible split than no race at all.
      console.error('[QueueRoom] createRoom failed; clients will fall back to joinOrCreate', e);
    }

    this.broadcast('launchRace', { roomId });

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
