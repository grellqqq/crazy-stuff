import { Room, Client } from 'colyseus';
import { Schema, ArraySchema, type } from '@colyseus/schema';
import { awardPostRace, getOrCreatePlayer, getLoadout, getEquippedChar } from '../db/mongo';
import {
  Terrain, generateTerrainMap, generateButtons, generatePickups,
  GRID_COL_MAX, GRID_ROW_MAX, SPAWN_X, SPAWN_Y,
  RacePhase, FINISH_X, FINISH_Y_MIN, FINISH_Y_MAX,
  MIN_PLAYERS_TO_START, COUNTDOWN_SECONDS, FINISH_COUNTDOWN_SECONDS,
  ButtonType, BUTTON_COOLDOWN_MS,
  PickupType, PICKUP_SPEED_COOLDOWN, PICKUP_SPEED_DURATION,
  SLIME_SIZE, SLIME_PERSIST_MS, SLIME_STUCK_MS,
  KNOCKBACK_RADIUS, KNOCKBACK_DISTANCE, KNOCKBACK_SLOW_MS, KNOCKBACK_SLOW_CD,
  SPRINT_COOLDOWN, STAMINA_MAX, STAMINA_DRAIN, STAMINA_REGEN_RATE, STAMINA_MIN_TO_SPRINT,
  JUMP_DISTANCE, JUMP_COOLDOWN_MS,
  POSITION_POINTS, DNF_POINTS,
  BONUS_BUTTON_ACTIVATED, BONUS_FAST_FINISH, BONUS_GOOD_FINISH,
  FAST_FINISH_THRESHOLD, GOOD_FINISH_THRESHOLD,
  REMATCH_VOTE_TIMEOUT_MS,
  type ButtonDef, type PickupDef, type RaceResult,
} from '../../../shared/terrain';

// ─── Schema ──────────────────────────────────────────────────────────────────

class PlayerSlot extends Schema {
  @type('string') sessionId = '';
  @type('string') playerName = '';
  @type('number') tileX = SPAWN_X;
  @type('number') tileY = SPAWN_Y;
  @type('boolean') occupied = false;
}

class RaceState extends Schema {
  @type([PlayerSlot]) slots = new ArraySchema<PlayerSlot>(
    new PlayerSlot(), new PlayerSlot(), new PlayerSlot(),
    new PlayerSlot(), new PlayerSlot(),
  );
}

// ─── Movement ────────────────────────────────────────────────────────────────

/** 8-direction movement: 4 diagonals (single keys) + 4 cardinals (key combos). */
const MOVE_DELTAS: Record<string, [number, number]> = {
  W: [-1, -1], S: [1, 1], A: [-1, 1], D: [1, -1],     // diagonals
  WD: [0, -1], WA: [-1, 0], SD: [1, 0], SA: [0, 1],    // cardinals
};
const MOVE_MAX_X = GRID_COL_MAX;
const MOVE_MAX_Y = GRID_ROW_MAX;

// ─── Timing (ms) ─────────────────────────────────────────────────────────────

const DEFAULT_COOLDOWN = 100;
const SLOW_COOLDOWN    = 350;
const HOLE_RESPAWN_MS  = 2000;
const HOLE_PENALTY_MS  = 1000;
const HOLE_PENALTY_CD  = 450;
const CRUMBLE_DELAY_MS = 1500;
const SLIDE_EXTRA_TILES = 1;
const PUSH_STUN_MS = 200;

// ─── Per-player state ────────────────────────────────────────────────────────

interface PlayerState {
  lastMoveTime: number;
  currentCooldown: number;
  boostCharges: number;
  frozen: boolean;
  holeTimer: ReturnType<typeof setTimeout> | null;
  penaltyTimer: ReturnType<typeof setTimeout> | null;
  penalized: boolean;
  /** Immune to holes/traps until this timestamp (post-respawn). */
  immuneUntil: number;
  finished: boolean;
  buttonsActivated: number;
  // Pickup state
  heldPickup: number | null;    // PickupType value or null
  shieldActive: boolean;
  speedBoostUntil: number;      // timestamp
  speedBoostTimer: ReturnType<typeof setTimeout> | null;
  stuckUntil: number;           // timestamp (slime effect)
  knockbackSlowUntil: number;   // timestamp
  knockbackSlowTimer: ReturnType<typeof setTimeout> | null;
  // Sprint & stamina
  stamina: number;
  lastStaminaRegen: number;     // timestamp of last regen tick
  sprinting: boolean;
  // Jump
  lastJumpTime: number;
  // Last safe position (before falling in a hole)
  lastSafeX: number;
  lastSafeY: number;
}

function newPlayerState(): PlayerState {
  return {
    lastMoveTime: 0,
    currentCooldown: DEFAULT_COOLDOWN,
    boostCharges: 0,
    frozen: false,
    holeTimer: null,
    penaltyTimer: null,
    penalized: false,
    immuneUntil: 0,
    finished: false,
    buttonsActivated: 0,
    heldPickup: null,
    shieldActive: false,
    speedBoostUntil: 0,
    speedBoostTimer: null,
    stuckUntil: 0,
    knockbackSlowUntil: 0,
    knockbackSlowTimer: null,
    stamina: STAMINA_MAX,
    lastStaminaRegen: 0,
    sprinting: false,
    lastJumpTime: 0,
    lastSafeX: SPAWN_X,
    lastSafeY: SPAWN_Y,
  };
}

// ─── Finish record ───────────────────────────────────────────────────────────

interface FinishRecord {
  sessionId: string;
  playerName: string;
  timeSeconds: number;
}

// ─── Slime zone ──────────────────────────────────────────────────────────────

interface SlimeZone {
  x: number; y: number;
  ownerId: string;
  timer: ReturnType<typeof setTimeout>;
}

// ─── RaceRoom ────────────────────────────────────────────────────────────────

export class RaceRoom extends Room<RaceState> {
  maxClients = 5;

  private players = new Map<string, PlayerState>();
  private authIds = new Map<string, string>(); // sessionId → authId
  private terrainGrid: number[][] = [];
  private crumbleTimers = new Map<string, ReturnType<typeof setTimeout>>();

  // Buttons
  private buttons: ButtonDef[] = [];
  private buttonCooldowns = new Map<number, number>();
  private activeEffects = new Map<number, {
    original: Map<string, number>;
    timer: ReturnType<typeof setTimeout>;
    activatorId: string;
  }>();

  // Pickups
  private pickups: PickupDef[] = [];
  /** IDs of pickups that have been collected (gone for this race). */
  private collectedPickups = new Set<number>();
  /** Active slime zones on the map. */
  private slimeZones: SlimeZone[] = [];
  /** Last movement direction per player (for jump). */
  private lastDirection = new Map<string, string>();

  // Race phase
  private phase: number = RacePhase.Waiting;
  private countdown = 0;
  private countdownTimer: ReturnType<typeof setInterval> | null = null;
  private startTime = 0;

  // Finish tracking
  private finishOrder: FinishRecord[] = [];
  private finishCountdown = 0;
  private finishCountdownTimer: ReturnType<typeof setInterval> | null = null;

  // Equipment loadouts (cached on join, frozen during race)
  private playerLoadouts = new Map<string, { charKey: string; loadout: Record<string, string> }>();

  // Rematch vote
  private rematchVotes = new Set<string>();
  private rematchTimer: ReturnType<typeof setTimeout> | null = null;

  onCreate(): void {
    this.setState(new RaceState());
    this.generateMap();

    this.onMessage('move', (client, data: { direction: string; sprint?: boolean }) => {
      const dir = typeof data === 'string' ? data : data.direction;
      const sprint = typeof data === 'object' && !!data.sprint;
      this.handleMove(client.sessionId, dir, sprint);
    });

    this.onMessage('usePickup', (client) => {
      this.handleUsePickup(client.sessionId);
    });

    this.onMessage('jump', (client) => {
      this.handleJump(client.sessionId);
    });

    this.onMessage('rematchVote', (client) => {
      this.handleRematchVote(client.sessionId);
    });

    this.onMessage('refreshLoadout', (client) => {
      const authId = this.authIds.get(client.sessionId);
      if (!authId) return;
      const slot = this.state.slots.findIndex(s => s.sessionId === client.sessionId);
      if (slot < 0) return;
      this.fetchAndBroadcastLoadout(client.sessionId, authId, slot).catch(
        e => console.error('[RaceRoom] refreshLoadout error:', e)
      );
    });

    console.log(`[RaceRoom] created — ${this.buttons.length} buttons, ${this.pickups.length} pickups`);
  }

  private generateMap(): void {
    this.terrainGrid = generateTerrainMap();
    this.buttons = generateButtons(this.terrainGrid);
    this.pickups = generatePickups(this.terrainGrid);
    this.collectedPickups.clear();
  }

  onJoin(client: Client, options: { playerName?: string; authId?: string }): void {
    // Prevent duplicate sessions from the same auth account
    if (options?.authId) {
      for (const [sid, aid] of this.authIds) {
        if (aid === options.authId) {
          client.send('error', { message: 'Already in this room from another tab' });
          client.leave();
          return;
        }
      }
    }

    const slot = this.state.slots.find(s => !s.occupied);
    if (!slot) { client.leave(); return; }

    const idx = this.state.slots.indexOf(slot);
    const spawnY = SPAWN_Y - 4 + idx * 2; // 5 players spaced 1 tile apart

    slot.sessionId = client.sessionId;
    const rawName = (options?.playerName ?? 'Player').replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 20).trim();
    slot.playerName = rawName || 'Player';
    if (options?.authId) this.authIds.set(client.sessionId, options.authId);
    slot.tileX = SPAWN_X;
    slot.tileY = spawnY;
    slot.occupied = true;

    const ps = newPlayerState();
    ps.lastSafeX = SPAWN_X;
    ps.lastSafeY = spawnY;
    this.players.set(client.sessionId, ps);

    client.send('mapData', {
      map: this.terrainGrid,
      buttons: this.buttons,
      pickups: this.pickups,
    });

    console.log(`[RaceRoom] joined: ${client.sessionId} as "${slot.playerName}" in slot ${idx}`);
    this.broadcastState();

    // Fetch and broadcast equipment loadout (async, non-blocking)
    if (options?.authId) {
      this.fetchAndBroadcastLoadout(client.sessionId, options.authId, idx).catch(
        e => console.error('[RaceRoom] loadout fetch error:', e)
      );
    }

    this.checkStartCondition();
  }

  onLeave(client: Client): void {
    const slot = this.state.slots.find(s => s.sessionId === client.sessionId);
    if (!slot) return;

    const idx = this.state.slots.indexOf(slot);
    slot.sessionId = '';
    slot.playerName = '';
    slot.tileX = SPAWN_X;
    slot.tileY = SPAWN_Y;
    slot.occupied = false;

    this.clearPlayerTimers(client.sessionId);
    this.players.delete(client.sessionId);
    this.lastDirection.delete(client.sessionId);
    this.playerLoadouts.delete(client.sessionId);

    console.log(`[RaceRoom] left: ${client.sessionId} freed slot ${idx}`);
    this.broadcastState();

    if (this.phase === RacePhase.Countdown && this.occupiedCount() < MIN_PLAYERS_TO_START) {
      this.cancelCountdown();
    }
    if (this.phase === RacePhase.Racing && this.finishCountdown > 0) {
      this.checkAllFinished();
    }
    // Recheck rematch majority when a player leaves during vote
    if (this.phase === RacePhase.Finished) {
      this.rematchVotes.delete(client.sessionId);
      const needed = this.rematchMajority();
      this.broadcast('rematchVoteUpdate', { votes: this.rematchVotes.size, needed });
      if (this.rematchVotes.size >= needed && needed > 0) {
        if (this.rematchTimer) { clearTimeout(this.rematchTimer); this.rematchTimer = null; }
        this.resetRace();
      }
    }
  }

  onDispose(): void {
    if (this.countdownTimer) clearInterval(this.countdownTimer);
    if (this.finishCountdownTimer) clearInterval(this.finishCountdownTimer);
    if (this.rematchTimer) clearTimeout(this.rematchTimer);
    for (const timer of this.crumbleTimers.values()) clearTimeout(timer);
    for (const e of this.activeEffects.values()) clearTimeout(e.timer);
    for (const sz of this.slimeZones) clearTimeout(sz.timer);
    for (const [sid] of this.players) this.clearPlayerTimers(sid);
    console.log('[RaceRoom] disposed');
  }

  // ─── Race phase management ─────────────────────────────────────────────

  private occupiedCount(): number {
    return this.state.slots.filter(s => s.occupied).length;
  }

  private checkStartCondition(): void {
    if (this.phase !== RacePhase.Waiting) return;
    if (this.occupiedCount() >= MIN_PLAYERS_TO_START) this.startCountdown();
  }

  private startCountdown(): void {
    this.phase = RacePhase.Countdown;
    this.countdown = COUNTDOWN_SECONDS;
    this.broadcastState();
    this.countdownTimer = setInterval(() => {
      this.countdown--;
      if (this.countdown <= 0) {
        if (this.countdownTimer) clearInterval(this.countdownTimer);
        this.countdownTimer = null;
        this.beginRace();
      } else { this.broadcastState(); }
    }, 1000);
  }

  private cancelCountdown(): void {
    if (this.countdownTimer) { clearInterval(this.countdownTimer); this.countdownTimer = null; }
    this.phase = RacePhase.Waiting;
    this.countdown = 0;
    this.broadcastState();
  }

  private beginRace(): void {
    this.phase = RacePhase.Racing;
    this.startTime = Date.now();
    this.finishOrder = [];
    this.finishCountdown = 0;
    this.broadcastState();
  }

  // ─── Finish line ──────────────────────────────────────────────────────

  private checkFinishLine(sessionId: string, slot: PlayerSlot): void {
    if (this.phase !== RacePhase.Racing) return;
    const ps = this.players.get(sessionId);
    if (!ps || ps.finished) return;

    if (slot.tileX >= FINISH_X && slot.tileY >= FINISH_Y_MIN && slot.tileY <= FINISH_Y_MAX) {
      this.playerFinished(sessionId, slot, ps);
    }
  }

  private playerFinished(sessionId: string, slot: PlayerSlot, ps: PlayerState): void {
    ps.finished = true;
    const timeSeconds = parseFloat(((Date.now() - this.startTime) / 1000).toFixed(2));
    this.finishOrder.push({ sessionId, playerName: slot.playerName, timeSeconds });
    const position = this.finishOrder.length;

    this.broadcast('playerFinished', { playerName: slot.playerName, position, timeSeconds });
    if (position === 1) this.startFinishCountdown();
    this.checkAllFinished();
  }

  private startFinishCountdown(): void {
    this.finishCountdown = FINISH_COUNTDOWN_SECONDS;
    this.broadcastState();
    this.finishCountdownTimer = setInterval(() => {
      this.finishCountdown--;
      if (this.finishCountdown <= 0) {
        if (this.finishCountdownTimer) clearInterval(this.finishCountdownTimer);
        this.finishCountdownTimer = null;
        this.endRace();
      } else { this.broadcastState(); }
    }, 1000);
  }

  private checkAllFinished(): void {
    const occupied = this.state.slots.filter(s => s.occupied);
    if (occupied.every(s => this.players.get(s.sessionId)?.finished) && this.finishOrder.length > 0) {
      if (this.finishCountdownTimer) clearInterval(this.finishCountdownTimer);
      this.finishCountdownTimer = null;
      this.finishCountdown = 0;
      this.endRace();
    }
  }

  private endRace(): void {
    if (this.phase === RacePhase.Finished) return;
    this.phase = RacePhase.Finished;

    const results: RaceResult[] = [];
    const finishedIds = new Set(this.finishOrder.map(f => f.sessionId));

    for (let i = 0; i < this.finishOrder.length; i++) {
      const f = this.finishOrder[i];
      const ps = this.players.get(f.sessionId);
      const positionPoints = POSITION_POINTS[i] ?? DNF_POINTS;
      let bonusPoints = 0;
      if (ps) bonusPoints += ps.buttonsActivated * BONUS_BUTTON_ACTIVATED;
      if (f.timeSeconds < FAST_FINISH_THRESHOLD) bonusPoints += BONUS_FAST_FINISH;
      else if (f.timeSeconds < GOOD_FINISH_THRESHOLD) bonusPoints += BONUS_GOOD_FINISH;
      results.push({
        sessionId: f.sessionId, playerName: f.playerName,
        position: i + 1, timeSeconds: f.timeSeconds,
        positionPoints, bonusPoints, totalScore: positionPoints + bonusPoints,
      });
    }

    for (const slot of this.state.slots) {
      if (!slot.occupied || finishedIds.has(slot.sessionId)) continue;
      const ps = this.players.get(slot.sessionId);
      let bonusPoints = 0;
      if (ps) bonusPoints += ps.buttonsActivated * BONUS_BUTTON_ACTIVATED;
      results.push({
        sessionId: slot.sessionId, playerName: slot.playerName,
        position: 0, timeSeconds: 0,
        positionPoints: DNF_POINTS, bonusPoints, totalScore: DNF_POINTS + bonusPoints,
      });
    }

    this.broadcast('raceResults', { results });
    this.broadcastState();
    this.startRematchVoteTimer();

    // Award XP and coins to authenticated players
    this.awardPlayers(results).catch(e => console.error('[RaceRoom] award error:', e));
  }

  /** Start the rematch vote window. Auto-resets after timeout if no majority. */
  private async awardPlayers(results: RaceResult[]): Promise<void> {
    try {
      // awardPostRace and getOrCreatePlayer imported at top of file
      for (const r of results) {
        const authId = this.authIds.get(r.sessionId);
        if (!authId) continue; // guest player, skip
        await getOrCreatePlayer(authId, r.playerName);
        const xp = r.totalScore;
        const coins = Math.floor(r.totalScore / 2);
        await awardPostRace(authId, xp, coins, r.position === 1);
        console.log(`[RaceRoom] awarded ${r.playerName}: ${xp}xp, ${coins}coins`);
      }
    } catch (e) {
      console.error('[RaceRoom] DB not available, skipping awards:', e);
    }
  }

  private startRematchVoteTimer(): void {
    this.rematchVotes.clear();
    this.broadcast('rematchVoteUpdate', { votes: 0, needed: this.rematchMajority() });
    this.rematchTimer = setTimeout(() => {
      this.rematchTimer = null;
      this.resetRace();
    }, REMATCH_VOTE_TIMEOUT_MS);
  }

  private rematchMajority(): number {
    const count = this.occupiedCount();
    if (count <= 1) return 1;
    // Require more than half — with 2 players both must vote, with 3 need 2, etc.
    return Math.floor(count / 2) + 1;
  }

  private handleRematchVote(sessionId: string): void {
    if (this.phase !== RacePhase.Finished) return;
    this.rematchVotes.add(sessionId);
    const needed = this.rematchMajority();
    this.broadcast('rematchVoteUpdate', {
      votes: this.rematchVotes.size,
      needed,
    });
    if (this.rematchVotes.size >= needed) {
      if (this.rematchTimer) { clearTimeout(this.rematchTimer); this.rematchTimer = null; }
      this.resetRace();
    }
  }

  private resetRace(): void {
    for (const timer of this.crumbleTimers.values()) clearTimeout(timer);
    this.crumbleTimers.clear();
    for (const e of this.activeEffects.values()) clearTimeout(e.timer);
    this.activeEffects.clear();
    this.buttonCooldowns.clear();
    for (const sz of this.slimeZones) clearTimeout(sz.timer);
    this.slimeZones = [];

    this.generateMap();
    this.broadcast('terrainReset', {
      map: this.terrainGrid,
      buttons: this.buttons,
      pickups: this.pickups,
    });

    for (const slot of this.state.slots) {
      if (!slot || !slot.occupied) continue;
      const idx = this.state.slots.indexOf(slot);
      const spawnY = SPAWN_Y - 4 + idx * 2;
      slot.tileX = SPAWN_X;
      slot.tileY = spawnY;
      this.clearPlayerTimers(slot.sessionId);
      const ps = newPlayerState();
      ps.lastSafeX = SPAWN_X;
      ps.lastSafeY = spawnY;
      this.players.set(slot.sessionId, ps);
    }

    this.phase = RacePhase.Waiting;
    this.countdown = 0;
    this.finishCountdown = 0;
    this.finishOrder = [];
    this.startTime = 0;
    this.rematchVotes.clear();
    if (this.rematchTimer) { clearTimeout(this.rematchTimer); this.rematchTimer = null; }
    this.broadcastState();
    this.checkStartCondition();
  }

  // ─── Movement ──────────────────────────────────────────────────────────

  private handleMove(sessionId: string, direction: string, sprint = false): void {
    if (this.phase !== RacePhase.Racing && this.phase !== RacePhase.Waiting) return;

    const slot = this.state.slots.find(s => s.sessionId === sessionId);
    const ps = this.players.get(sessionId);
    if (!slot || !ps || ps.finished) return;

    const delta = MOVE_DELTAS[direction];
    if (!delta || ps.frozen) return;

    // Stuck from slime?
    if (ps.stuckUntil > Date.now()) return;

    const now = Date.now();

    // Stamina regen (when not sprinting)
    if (ps.lastStaminaRegen > 0 && !ps.sprinting) {
      const elapsed = (now - ps.lastStaminaRegen) / 1000;
      ps.stamina = Math.min(STAMINA_MAX, ps.stamina + elapsed * STAMINA_REGEN_RATE);
    }
    ps.lastStaminaRegen = now;

    // Determine if actually sprinting
    const wantsSprint = sprint && ps.stamina >= STAMINA_MIN_TO_SPRINT;
    ps.sprinting = wantsSprint;

    // Determine active cooldown — priority: speed pickup > sprint > knockback slow > penalty > terrain
    let activeCooldown: number;
    if (ps.speedBoostUntil > now) {
      activeCooldown = PICKUP_SPEED_COOLDOWN;
    } else if (wantsSprint) {
      activeCooldown = SPRINT_COOLDOWN;
    } else if (ps.knockbackSlowUntil > now) {
      activeCooldown = KNOCKBACK_SLOW_CD;
    } else if (ps.penalized) {
      activeCooldown = HOLE_PENALTY_CD;
    } else {
      activeCooldown = ps.currentCooldown;
    }

    if (ps.boostCharges > 0) {
      ps.boostCharges--;
    } else if (now - ps.lastMoveTime < activeCooldown) {
      return;
    }

    // Drain stamina on sprint move
    if (wantsSprint) {
      ps.stamina = Math.max(0, ps.stamina - STAMINA_DRAIN);
    }

    const newX = Math.max(0, Math.min(MOVE_MAX_X, slot.tileX + delta[0]));
    const newY = Math.max(0, Math.min(MOVE_MAX_Y, slot.tileY + delta[1]));
    if (newX === slot.tileX && newY === slot.tileY) return;
    if (this.isWall(newX, newY)) return;

    // Player collision — push other player if tile is occupied
    const blocker = this.state.slots.find(s =>
      s.occupied && s.sessionId !== sessionId && s.tileX === newX && s.tileY === newY
    );
    if (blocker) {
      this.pushPlayer(blocker, delta, wantsSprint ? 2 : 1, sessionId);
    }

    // Save current position as last safe spot
    ps.lastSafeX = slot.tileX;
    ps.lastSafeY = slot.tileY;

    slot.tileX = newX;
    slot.tileY = newY;
    ps.lastMoveTime = now;
    this.lastDirection.set(sessionId, direction);

    this.applyTerrainAt(sessionId, slot, ps, direction);
    this.tryActivateButton(sessionId, slot.tileX, slot.tileY);
    this.checkPickupCollection(sessionId, slot, ps);
    this.checkSlimeZones(sessionId, slot, ps);
    this.checkFinishLine(sessionId, slot);
    this.broadcastState();
  }

  // ─── Jump ──────────────────────────────────────────────────────────────

  private handleJump(sessionId: string): void {
    if (this.phase !== RacePhase.Racing && this.phase !== RacePhase.Waiting) return;

    const slot = this.state.slots.find(s => s.sessionId === sessionId);
    const ps = this.players.get(sessionId);
    if (!slot || !ps || ps.finished || ps.frozen) return;
    if (ps.stuckUntil > Date.now()) return;

    const now = Date.now();
    if (now - ps.lastJumpTime < JUMP_COOLDOWN_MS) return;

    const delta = MOVE_DELTAS[this.lastDirection.get(sessionId) ?? 'D'];
    if (!delta) return;

    // Jump JUMP_DISTANCE tiles in facing direction, skipping middle tile effects
    let landX = slot.tileX;
    let landY = slot.tileY;

    for (let step = 0; step < JUMP_DISTANCE; step++) {
      const nx = Math.max(0, Math.min(MOVE_MAX_X, landX + delta[0]));
      const ny = Math.max(0, Math.min(MOVE_MAX_Y, landY + delta[1]));
      if (nx === landX && ny === landY) break;
      if (this.isWall(nx, ny)) break;
      landX = nx;
      landY = ny;
    }

    // Must have actually moved
    if (landX === slot.tileX && landY === slot.tileY) return;

    ps.lastJumpTime = now;
    ps.lastMoveTime = now;
    slot.tileX = landX;
    slot.tileY = landY;

    // Only apply terrain effects at landing position (skipped middle tiles)
    this.applyTerrainAt(sessionId, slot, ps, this.lastDirection.get(sessionId) ?? 'D');
    this.checkPickupCollection(sessionId, slot, ps);
    this.checkSlimeZones(sessionId, slot, ps);
    this.checkFinishLine(sessionId, slot);

    this.broadcast('playerJumped', { sessionId });
    this.broadcastState();
  }

  // ─── Player collision (push) ────────────────────────────────────────────

  /** Push a player in the given direction by `distance` tiles. */
  private pushPlayer(
    slot: PlayerSlot, delta: [number, number], distance: number, pusherId: string,
  ): void {
    const ps = this.players.get(slot.sessionId);
    if (!ps || ps.frozen || ps.finished) return;

    let finalX = slot.tileX;
    let finalY = slot.tileY;

    for (let step = 0; step < distance; step++) {
      const nx = Math.max(0, Math.min(MOVE_MAX_X, finalX + delta[0]));
      const ny = Math.max(0, Math.min(MOVE_MAX_Y, finalY + delta[1]));
      if (nx === finalX && ny === finalY) break;
      if (this.isWall(nx, ny)) break;
      // Don't push into another player
      const blocked = this.state.slots.find(s =>
        s.occupied && s.sessionId !== slot.sessionId && s.sessionId !== pusherId
        && s.tileX === nx && s.tileY === ny
      );
      if (blocked) break;
      finalX = nx;
      finalY = ny;
    }

    if (finalX !== slot.tileX || finalY !== slot.tileY) {
      ps.lastSafeX = slot.tileX;
      ps.lastSafeY = slot.tileY;
      slot.tileX = finalX;
      slot.tileY = finalY;

      // Brief stun — can't move for PUSH_STUN_MS
      ps.stuckUntil = Math.max(ps.stuckUntil, Date.now() + PUSH_STUN_MS);

      // Apply terrain at landing
      this.applyTerrainAt(slot.sessionId, slot, ps, 'S');

      this.broadcast('playerPushed', {
        sessionId: slot.sessionId,
        pusherId,
        x: finalX,
        y: finalY,
      });
    }
  }

  // ─── Single-tile terrain effects ────────────────────────────────────────

  private applyTerrainAt(
    sessionId: string, slot: PlayerSlot, ps: PlayerState, direction: string,
  ): void {
    const t = this.terrainAtMut(slot.tileX, slot.tileY);

    ps.currentCooldown = ps.penalized ? HOLE_PENALTY_CD : DEFAULT_COOLDOWN;

    switch (t) {
      case Terrain.Hole:
        if (ps.immuneUntil > Date.now()) break; // immune after respawn
        if (ps.shieldActive) {
          ps.shieldActive = false;
          this.broadcast('shieldUsed', { sessionId });
        } else {
          this.handleHole(sessionId, slot, ps);
        }
        return;
      case Terrain.Slide:
        this.handleSlide(sessionId, slot, ps, direction);
        return;
      case Terrain.Crumble:
        this.handleCrumble(slot.tileX, slot.tileY);
        break;
      case Terrain.Slow:
        ps.currentCooldown = SLOW_COOLDOWN;
        break;
      case Terrain.Button:
        // Button activation handled separately in handleMove (proximity-based)
        break;
    }
  }

  private handleHole(sessionId: string, slot: PlayerSlot, ps: PlayerState): void {
    ps.frozen = true;
    ps.boostCharges = 0;
    ps.holeTimer = setTimeout(() => {
      const s = this.state.slots.find(sl => sl.sessionId === sessionId);
      const p = this.players.get(sessionId);
      if (!s || !p) return;
      s.tileX = p.lastSafeX; s.tileY = p.lastSafeY;
      p.frozen = false; p.holeTimer = null;
      p.immuneUntil = Date.now() + 2000; // 2s immunity after respawn
      p.currentCooldown = DEFAULT_COOLDOWN;
      this.broadcastState();
    }, HOLE_RESPAWN_MS);
  }

  private handleSlide(
    sessionId: string, slot: PlayerSlot, ps: PlayerState, direction: string,
  ): void {
    const delta = MOVE_DELTAS[direction];
    if (!delta) return;

    for (let i = 0; i < SLIDE_EXTRA_TILES; i++) {
      const nx = Math.max(0, Math.min(MOVE_MAX_X, slot.tileX + delta[0]));
      const ny = Math.max(0, Math.min(MOVE_MAX_Y, slot.tileY + delta[1]));
      if (nx === slot.tileX && ny === slot.tileY) break;
      if (this.terrainAtMut(nx, ny) === Terrain.Wall) break;

      ps.lastSafeX = slot.tileX;
      ps.lastSafeY = slot.tileY;
      slot.tileX = nx;
      slot.tileY = ny;

      const t = this.terrainAtMut(nx, ny);
      if (t === Terrain.Hole) {
        if (ps.shieldActive) { ps.shieldActive = false; this.broadcast('shieldUsed', { sessionId }); }
        else { this.handleHole(sessionId, slot, ps); return; }
      }
      if (t === Terrain.Crumble) this.handleCrumble(nx, ny);
      if (t !== Terrain.Slide) break; // stop sliding when leaving ice
    }

    // Apply terrain effect at final landing position
    const finalT = this.terrainAtMut(slot.tileX, slot.tileY);
    if (finalT === Terrain.Slow) ps.currentCooldown = SLOW_COOLDOWN;
  }

  private handleCrumble(tileX: number, tileY: number): void {
    const key = `${tileX},${tileY}`;
    if (this.crumbleTimers.has(key)) return;
    this.broadcast('crumbleWarning', { tileX, tileY });
    this.crumbleTimers.set(key, setTimeout(() => {
      this.terrainGrid[tileY][tileX] = Terrain.Hole;
      this.crumbleTimers.delete(key);

      // Check if any player is standing on this tile
      for (const slot of this.state.slots) {
        if (!slot.occupied || slot.tileX !== tileX || slot.tileY !== tileY) continue;
        const ps = this.players.get(slot.sessionId);
        if (ps && !ps.frozen) {
          if (ps.shieldActive) { ps.shieldActive = false; this.broadcast('shieldUsed', { sessionId: slot.sessionId }); }
          else this.handleHole(slot.sessionId, slot, ps);
        }
      }

      this.broadcast('terrainChange', { tileX, tileY, terrain: Terrain.Hole });
      this.broadcastState();
    }, CRUMBLE_DELAY_MS));
  }

  // ─── Pickup collection & activation ────────────────────────────────────

  private checkPickupCollection(sessionId: string, slot: PlayerSlot, ps: PlayerState): void {
    if (ps.heldPickup !== null) return; // already holding one

    for (const pickup of this.pickups) {
      if (this.collectedPickups.has(pickup.id)) continue;

      // Collect if within 1 tile distance (accounts for diagonal movement)
      if (Math.abs(slot.tileX - pickup.x) > 1 || Math.abs(slot.tileY - pickup.y) > 1) continue;

      // Collect it
      ps.heldPickup = pickup.type;
      this.collectedPickups.add(pickup.id);
      this.broadcast('pickupCollected', { id: pickup.id, sessionId });
      return;
    }
  }

  private handleUsePickup(sessionId: string): void {
    if (this.phase !== RacePhase.Racing) return;
    const slot = this.state.slots.find(s => s.sessionId === sessionId);
    const ps = this.players.get(sessionId);
    if (!slot || !ps || ps.finished || ps.frozen) return;
    if (ps.heldPickup === null) return;

    const type = ps.heldPickup;
    ps.heldPickup = null;

    switch (type) {
      case PickupType.SpeedBoost:
        this.activateSpeedBoost(sessionId, ps);
        break;
      case PickupType.Shield:
        ps.shieldActive = true;
        // Shield expires after 8 seconds if not consumed
        setTimeout(() => { if (ps.shieldActive) { ps.shieldActive = false; this.broadcastState(); } }, 4000);
        break;
      case PickupType.SlimeBomb:
        this.activateSlimeBomb(sessionId, slot);
        break;
      case PickupType.Knockback:
        this.activateKnockback(sessionId, slot);
        this.broadcast('knockbackBlast', { x: slot.tileX, y: slot.tileY });
        break;
    }

    this.broadcast('pickupUsed', { sessionId, type });
    this.broadcastState();
  }

  private activateSpeedBoost(sessionId: string, ps: PlayerState): void {
    ps.speedBoostUntil = Date.now() + PICKUP_SPEED_DURATION;
    if (ps.speedBoostTimer) clearTimeout(ps.speedBoostTimer);
    ps.speedBoostTimer = setTimeout(() => {
      const p = this.players.get(sessionId);
      if (p) { p.speedBoostUntil = 0; p.speedBoostTimer = null; }
      this.broadcastState();
    }, PICKUP_SPEED_DURATION);
  }

  private activateSlimeBomb(sessionId: string, slot: PlayerSlot): void {
    const sx = slot.tileX;
    const sy = slot.tileY;

    // Place slime zone centered on player
    const zone: SlimeZone = {
      x: sx, y: sy,
      ownerId: sessionId,
      timer: setTimeout(() => {
        this.slimeZones = this.slimeZones.filter(z => z !== zone);
        this.broadcast('slimeExpired', { x: sx, y: sy });
      }, SLIME_PERSIST_MS),
    };
    this.slimeZones.push(zone);
    this.broadcast('slimePlaced', { x: sx, y: sy, size: SLIME_SIZE, ownerId: sessionId });
  }

  private activateKnockback(sessionId: string, slot: PlayerSlot): void {
    const cx = slot.tileX + 0.5;
    const cy = slot.tileY + 0.5;

    for (const otherSlot of this.state.slots) {
      if (!otherSlot.occupied || otherSlot.sessionId === sessionId) continue;
      const otherPs = this.players.get(otherSlot.sessionId);
      if (!otherPs || otherPs.frozen || otherPs.finished) continue;

      const ox = otherSlot.tileX + 0.5;
      const oy = otherSlot.tileY + 0.5;
      const dist = Math.sqrt((ox - cx) ** 2 + (oy - cy) ** 2);

      if (dist > KNOCKBACK_RADIUS) continue;

      // Push direction (away from activator)
      const angle = Math.atan2(oy - cy, ox - cx);
      const pushX = Math.round(Math.cos(angle) * KNOCKBACK_DISTANCE);
      const pushY = Math.round(Math.sin(angle) * KNOCKBACK_DISTANCE);

      let newX = Math.max(0, Math.min(MOVE_MAX_X, otherSlot.tileX + pushX));
      let newY = Math.max(0, Math.min(MOVE_MAX_Y, otherSlot.tileY + pushY));

      // Step toward target, stopping at walls
      const steps = Math.max(Math.abs(pushX), Math.abs(pushY));
      const stepDx = pushX === 0 ? 0 : pushX / Math.abs(pushX);
      const stepDy = pushY === 0 ? 0 : pushY / Math.abs(pushY);
      let finalX = otherSlot.tileX;
      let finalY = otherSlot.tileY;

      for (let s = 0; s < steps; s++) {
        const nx = Math.max(0, Math.min(MOVE_MAX_X, finalX + stepDx));
        const ny = Math.max(0, Math.min(MOVE_MAX_Y, finalY + stepDy));
        if (this.isWall(nx, ny)) break;
        finalX = nx;
        finalY = ny;
      }

      otherSlot.tileX = finalX;
      otherSlot.tileY = finalY;

      // Apply slow
      otherPs.knockbackSlowUntil = Date.now() + KNOCKBACK_SLOW_MS;
      if (otherPs.knockbackSlowTimer) clearTimeout(otherPs.knockbackSlowTimer);
      otherPs.knockbackSlowTimer = setTimeout(() => {
        const p = this.players.get(otherSlot.sessionId);
        if (p) { p.knockbackSlowUntil = 0; p.knockbackSlowTimer = null; }
        this.broadcastState();
      }, KNOCKBACK_SLOW_MS);
    }
  }

  private checkSlimeZones(sessionId: string, slot: PlayerSlot, ps: PlayerState): void {
    if (ps.stuckUntil > Date.now()) return;

    for (const zone of this.slimeZones) {
      if (zone.ownerId === sessionId) continue; // don't get stuck by own slime

      // Check if player tile is within slime zone
      const overlapX = slot.tileX >= zone.x && slot.tileX < zone.x + SLIME_SIZE;
      const overlapY = slot.tileY >= zone.y && slot.tileY < zone.y + SLIME_SIZE;

      if (overlapX && overlapY) {
        if (ps.shieldActive) {
          ps.shieldActive = false;
          this.broadcast('shieldUsed', { sessionId });
          return;
        }
        ps.stuckUntil = Date.now() + SLIME_STUCK_MS;
        this.broadcast('playerStuck', { sessionId });
        return;
      }
    }
  }

  // ─── Button activation ────────────────────────────────────────────────

  private tryActivateButton(sessionId: string, px: number, py: number): void {
    const now = Date.now();
    for (const btn of this.buttons) {
      // Activate if player is within 1 tile (handles diagonal movement skipping exact tile)
      if (Math.abs(px - btn.x) > 1 || Math.abs(py - btn.y) > 1) continue;
      if ((this.buttonCooldowns.get(btn.id) ?? 0) > now) continue;
      if (this.activeEffects.has(btn.id)) continue;
      this.activateButton(btn, sessionId);
      return;
    }
  }

  private activateButton(btn: ButtonDef, activatorId: string): void {
    let fillTerrain: number;
    switch (btn.type) {
      case ButtonType.ClosePath:    fillTerrain = Terrain.Wall; break;
      case ButtonType.OpenHole:     fillTerrain = Terrain.Hole; break;
      case ButtonType.TriggerSlide: fillTerrain = Terrain.Slide; break;
      default: return;
    }

    const original = new Map<string, number>();
    const changes: { tileX: number; tileY: number; terrain: number }[] = [];
    for (let dy = 0; dy < btn.targetH; dy++) {
      for (let dx = 0; dx < btn.targetW; dx++) {
        const tx = btn.targetX + dx;
        const ty = btn.targetY + dy;
        if (ty < 0 || ty > GRID_ROW_MAX || tx < 0 || tx > GRID_COL_MAX) continue;
        const orig = this.terrainGrid[ty][tx];
        if (orig === Terrain.Wall || orig === Terrain.Button) continue;
        original.set(`${tx},${ty}`, orig);
        this.terrainGrid[ty][tx] = fillTerrain;
        changes.push({ tileX: tx, tileY: ty, terrain: fillTerrain });
      }
    }
    if (original.size === 0) return;

    // Single batched broadcast instead of per-tile
    this.broadcast('terrainChangeBatch', changes);
    this.buttonCooldowns.set(btn.id, Date.now() + BUTTON_COOLDOWN_MS);
    this.broadcast('buttonActivated', { id: btn.id, type: btn.type });

    const timer = setTimeout(() => this.revertButtonEffect(btn.id, original), BUTTON_COOLDOWN_MS);
    this.activeEffects.set(btn.id, { original, timer, activatorId });

    const ps = this.players.get(activatorId);
    if (ps) ps.buttonsActivated++;

    if (fillTerrain === Terrain.Hole) {
      for (const slot of this.state.slots) {
        if (!slot.occupied) continue;
        if (this.terrainAtMut(slot.tileX, slot.tileY) === Terrain.Hole) {
          const pps = this.players.get(slot.sessionId);
          if (pps && !pps.frozen) this.handleHole(slot.sessionId, slot, pps);
        }
      }
    }
    this.broadcastState();
  }

  private revertButtonEffect(buttonId: number, original: Map<string, number>): void {
    this.activeEffects.delete(buttonId);
    const changes: { tileX: number; tileY: number; terrain: number }[] = [];
    for (const [key, origTerrain] of original) {
      const [tx, ty] = key.split(',').map(Number);
      this.terrainGrid[ty][tx] = origTerrain;
      changes.push({ tileX: tx, tileY: ty, terrain: origTerrain });
    }
    this.broadcast('terrainChangeBatch', changes);
    this.broadcast('buttonReverted', { id: buttonId });
    this.broadcastState();
  }

  // ─── Helpers ───────────────────────────────────────────────────────────

  private isWall(x: number, y: number): boolean {
    return this.terrainAtMut(x, y) === Terrain.Wall;
  }

  private terrainAtMut(tileX: number, tileY: number): number {
    if (tileX < 0 || tileX > GRID_COL_MAX || tileY < 0 || tileY > GRID_ROW_MAX) return Terrain.Normal;
    return this.terrainGrid[tileY]?.[tileX] ?? Terrain.Normal;
  }

  private clearPlayerTimers(sessionId: string): void {
    const ps = this.players.get(sessionId);
    if (!ps) return;
    if (ps.holeTimer) clearTimeout(ps.holeTimer);
    if (ps.penaltyTimer) clearTimeout(ps.penaltyTimer);
    if (ps.speedBoostTimer) clearTimeout(ps.speedBoostTimer);
    if (ps.knockbackSlowTimer) clearTimeout(ps.knockbackSlowTimer);
  }

  private terrainAtPlayer(tileX: number, tileY: number): number {
    return this.terrainAtMut(tileX, tileY);
  }

  // ─── State broadcast ──────────────────────────────────────────────────

  /** Fetch a player's loadout from DB and broadcast to all clients. */
  private async fetchAndBroadcastLoadout(sessionId: string, authId: string, slotIndex: number): Promise<void> {
    const [charKey, loadout] = await Promise.all([
      getEquippedChar(authId),
      getLoadout(authId),
    ]);
    this.playerLoadouts.set(sessionId, { charKey, loadout });
    // Send this player's loadout to all clients
    this.broadcast('playerLoadout', { slotIndex, charKey, loadout });
    // Send all existing loadouts to the new client
    const client = this.clients.find(c => c.sessionId === sessionId);
    if (client) {
      for (const [sid, data] of this.playerLoadouts) {
        const slot = this.state.slots.findIndex(s => s.sessionId === sid);
        if (slot >= 0 && sid !== sessionId) {
          client.send('playerLoadout', { slotIndex: slot, charKey: data.charKey, loadout: data.loadout });
        }
      }
    }
  }

  private broadcastState(): void {
    const now = Date.now();
    this.broadcast('state', {
      phase: this.phase,
      countdown: this.countdown,
      finishCountdown: this.finishCountdown,
      startTime: this.startTime,
      slots: this.state.slots.map(s => {
        const ps = this.players.get(s.sessionId);
        return {
          sessionId: s.sessionId,
          playerName: s.playerName,
          tileX: s.tileX,
          tileY: s.tileY,
          occupied: s.occupied,
          frozen: ps?.frozen ?? false,
          penalized: ps?.penalized ?? false,
          boosted: false, // boost terrain removed
          finished: ps?.finished ?? false,
          currentTerrain: s.occupied ? this.terrainAtPlayer(s.tileX, s.tileY) : Terrain.Normal,
          heldPickup: ps?.heldPickup ?? null,
          shieldActive: ps?.shieldActive ?? false,
          speedBoosted: ps ? ps.speedBoostUntil > now : false,
          stuck: ps ? ps.stuckUntil > now : false,
          knockbackSlowed: ps ? ps.knockbackSlowUntil > now : false,
          stamina: ps?.stamina ?? STAMINA_MAX,
          sprinting: ps?.sprinting ?? false,
          immune: ps ? ps.immuneUntil > now : false,
        };
      }),
    });
  }
}

function ordSuffix(n: number): string {
  if (n % 100 >= 11 && n % 100 <= 13) return 'th';
  switch (n % 10) { case 1: return 'st'; case 2: return 'nd'; case 3: return 'rd'; default: return 'th'; }
}
