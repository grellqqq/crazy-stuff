import Phaser from 'phaser';
import {
  Terrain, GRID_COLS, GRID_ROWS, RacePhase,
  FINISH_X, FINISH_Y_MIN, FINISH_Y_MAX, SPAWN_X, SPAWN_Y,
  ButtonType, PICKUP_NAMES, SLIME_SIZE, STAMINA_MAX,
  type ButtonDef, type PickupDef, type RaceResult,
} from '../../shared/terrain';

// ─── Tile constants (4x scale from the small grid) ──────────────────────────

export const TILE_W = 64;
export const TILE_H = 32;

const TILE_OUTLINE = 0x000000;
const FINISH_COLOR = 0x44ff44;

// ─── Terrain rendering colours ───────────────────────────────────────────────

const TERRAIN_COLORS: [number, number][] = [
  [0x4a7c59, 0x3d6649], // Normal  — muted green
  [0x7a6030, 0x6a5228], // Slow    — mud brown
  [0x88c8e8, 0x76b8d8], // Slide   — ice blue
  [0xc4824a, 0xb0723c], // Crumble — sandy orange
  [0xd4b800, 0xc0a600], // Boost   — gold (unused)
  [0x111820, 0x0c1018], // Hole    — near-black void
  [0x555566, 0x444455], // Wall    — dark stone grey
  [0xdd3388, 0xcc2277], // Button  — bright magenta
];

const SLOT_COLORS = [0xff8c00, 0x4488ff, 0x44bb44, 0xee44ee, 0xffdd44];

// ─── Character definitions ───────────────────────────────────────────────────

/**
 * Each character type defines its sprite key prefix, frame size, and direction mapping.
 * Space suit: single spritesheet (3×4), 80×80 frames, rows = directions.
 * Knight: 4 separate spritesheets (one per direction), 512×512 frames, 3×3 grid each.
 */
interface CharacterDef {
  key: string;
  multiSheet: boolean;
  scale: number;
  framesPerDir: number;
  /** Sprite origin (where the "feet" are within the frame). */
  originX: number;
  originY: number;
  dirMap: Record<string, { sheetSuffix?: string; row?: number; flipX: boolean }>;
}

const CHAR_SPACESUIT: CharacterDef = {
  key: 'spacesuit',
  multiSheet: false,
  scale: 1.0,
  framesPerDir: 3,
  originX: 0.5,
  originY: 0.85,
  dirMap: {
    S: { row: 0, flipX: false },
    A: { row: 1, flipX: false },
    D: { row: 2, flipX: false },
    W: { row: 3, flipX: false },
  },
};

const CHAR_KNIGHT: CharacterDef = {
  key: 'knight',
  multiSheet: true,
  scale: 0.66,
  framesPerDir: 9,
  originX: 0.52,
  originY: 0.50,
  dirMap: {
    S: { sheetSuffix: '_S', flipX: false },
    A: { sheetSuffix: '_A', flipX: false },
    W: { sheetSuffix: '_W', flipX: false },
    D: { sheetSuffix: '_D', flipX: false },
  },
};

/**
 * Player slot → character + tint color.
 * Slot 0: space suit orange, Slot 1: knight blue, Slot 2: space suit green,
 * Slot 3: knight purple, Slot 4: space suit yellow.
 */
const SLOT_CHARACTERS: { char: CharacterDef; tint: number }[] = [
  { char: CHAR_SPACESUIT, tint: 0xff8c00 },  // orange
  { char: CHAR_KNIGHT,    tint: 0x4488ff },  // blue
  { char: CHAR_SPACESUIT, tint: 0x44bb44 },  // green
  { char: CHAR_KNIGHT,    tint: 0xee44ee },  // purple
  { char: CHAR_SPACESUIT, tint: 0xffdd44 },  // yellow
];

// ─── Isometric math ──────────────────────────────────────────────────────────

export function tileToScreen(tileX: number, tileY: number): { x: number; y: number } {
  return {
    x: (tileX - tileY) * (TILE_W / 2),
    y: (tileX + tileY) * (TILE_H / 2),
  };
}

export function isoDepth(tileX: number, tileY: number): number {
  return tileX + tileY;
}

// ─── Types ───────────────────────────────────────────────────────────────────

interface AvatarData {
  sprite: Phaser.GameObjects.Sprite;
  shadow: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  statusLabel: Phaser.GameObjects.Text;
  tileX: number;
  tileY: number;
  displayX: number;
  displayY: number;
  slotIndex: number;
  playerName: string;
  frozen: boolean;
  penalized: boolean;
  currentTerrain: number;
  heldPickup: number | null;
  shieldActive: boolean;
  speedBoosted: boolean;
  stuck: boolean;
  knockbackSlowed: boolean;
  stamina: number;
  sprinting: boolean;
  /** Timestamp of last tile position change — used for animation grace period. */
  lastTileChange: number;
}

// ─── Key-hold constants ──────────────────────────────────────────────────────

const SEND_INTERVAL = 60;

// ─── Scene ───────────────────────────────────────────────────────────────────

export class IsoScene extends Phaser.Scene {
  private originX = 0;
  private originY = 0;

  private mySessionId = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private room: any = null;

  private playerFacing: 'W' | 'A' | 'S' | 'D' = 'S';

  private avatars = new Map<number, AvatarData>();
  private mySlotIndex = -1;

  private localTerrain: number[][] = [];
  private tileGfx!: Phaser.GameObjects.Graphics;
  private finishGfx!: Phaser.GameObjects.Graphics;

  // ─── Race phase HUD ─────────────────────────────────────────────────────
  private currentPhase: number = RacePhase.Waiting;
  private phaseText!: Phaser.GameObjects.Text;
  private resultsText!: Phaser.GameObjects.Text;
  private timerText!: Phaser.GameObjects.Text;
  private announceText!: Phaser.GameObjects.Text;
  private announceTimer: ReturnType<typeof setTimeout> | null = null;
  private raceStartTime = 0;

  // ─── Buttons & pickups ───────────────────────────────────────────────────
  private buttons: ButtonDef[] = [];
  private buttonLabels: Phaser.GameObjects.Text[] = [];
  private pickups: PickupDef[] = [];
  private collectedPickupIds = new Set<number>();
  private pickupGfx!: Phaser.GameObjects.Graphics;
  private pickupHudText!: Phaser.GameObjects.Text;
  private slimeGfx!: Phaser.GameObjects.Graphics;
  private slimeZones: { x: number; y: number; size: number }[] = [];

  // ─── Crumble warnings ────────────────────────────────────────────────────
  private crumbleWarnings = new Map<string, number>();
  private crumbleGfx!: Phaser.GameObjects.Graphics;

  // ─── Minimap ─────────────────────────────────────────────────────────────
  private minimapBg!: Phaser.GameObjects.Graphics;
  private minimapPlayers!: Phaser.GameObjects.Graphics;
  private readonly MINIMAP_SCALE = 3;
  private readonly MINIMAP_PAD = 6;

  // ─── Stamina bar ─────────────────────────────────────────────────────────
  private staminaBarBg!: Phaser.GameObjects.Graphics;
  private staminaBarFill!: Phaser.GameObjects.Graphics;
  private localStamina = 100;

  // ─── Key-hold state ─────────────────────────────────────────────────────
  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private shiftKey!: Phaser.Input.Keyboard.Key;
  private lastSendTime = 0;

  // ─── Inertia ───────────────────────────────────────────────────────────
  private wasSprinting = false;
  private inertiaRemaining = 0;
  private inertiaDir: 'W' | 'A' | 'S' | 'D' | null = null;

  constructor() {
    super({ key: 'IsoScene' });
  }

  // ─── Preload ───────────────────────────────────────────────────────────

  preload(): void {
    // Space suit: single 3×4 spritesheet, 80×80 per frame
    this.load.spritesheet('spacesuit', '/sprites/space_suit.png', {
      frameWidth: 80,
      frameHeight: 80,
    });

    // Knight: separate spritesheet per direction, 3×3 grid, 512×512 per frame
    this.load.spritesheet('knight_S', '/sprites/knight/walk_dir1.png', { frameWidth: 512, frameHeight: 512 });
    this.load.spritesheet('knight_A', '/sprites/knight/walk_dir3.png', { frameWidth: 512, frameHeight: 512 });
    this.load.spritesheet('knight_W', '/sprites/knight/walk_dir5.png', { frameWidth: 512, frameHeight: 512 });
    this.load.spritesheet('knight_D', '/sprites/knight/walk_dir7.png', { frameWidth: 512, frameHeight: 512 });
  }

  // ─── Create ────────────────────────────────────────────────────────────

  create(): void {
    this.initEmptyTerrain();

    // Create walk animations for all character types
    for (const charDef of [CHAR_SPACESUIT, CHAR_KNIGHT]) {
      for (const dir of ['S', 'A', 'W', 'D'] as const) {
        const mapping = charDef.dirMap[dir];
        if (charDef.multiSheet) {
          // Multi-sheet: each direction is a separate texture
          const textureKey = `${charDef.key}${mapping.sheetSuffix}`;
          this.anims.create({
            key: `${charDef.key}_walk_${dir}`,
            frames: this.anims.generateFrameNumbers(textureKey, {
              start: 0,
              end: charDef.framesPerDir - 1,
            }),
            frameRate: 10,
            repeat: -1,
          });
        } else {
          // Single-sheet: directions are rows in one texture
          const startFrame = (mapping.row ?? 0) * charDef.framesPerDir;
          this.anims.create({
            key: `${charDef.key}_walk_${dir}`,
            frames: this.anims.generateFrameNumbers(charDef.key, {
              start: startFrame,
              end: startFrame + charDef.framesPerDir - 1,
            }),
            frameRate: 8,
            repeat: -1,
          });
        }
      }
    }

    const topLeft = tileToScreen(0, GRID_ROWS - 1);
    const topRight = tileToScreen(GRID_COLS - 1, 0);
    const bottomRight = tileToScreen(GRID_COLS - 1, GRID_ROWS - 1);

    const gridMinX = topLeft.x - TILE_W / 2;
    const gridMaxX = topRight.x + TILE_W / 2;
    const gridMinY = 0;
    const gridMaxY = bottomRight.y + TILE_H;

    const gridW = gridMaxX - gridMinX;
    const gridH = gridMaxY - gridMinY;

    const pad = 120;
    this.originX = pad - gridMinX;
    this.originY = pad - gridMinY;

    const worldW = gridW + pad * 2;
    const worldH = gridH + pad * 2;
    this.cameras.main.setBounds(0, 0, worldW, worldH);

    this.drawTileGrid();
    this.drawFinishLine();
    this.crumbleGfx = this.add.graphics().setDepth(-0.3);
    this.pickupGfx = this.add.graphics().setDepth(-0.2);
    this.slimeGfx = this.add.graphics().setDepth(-0.4);
    this.initMinimap();
    this.staminaBarBg = this.add.graphics().setScrollFactor(0).setDepth(9999);
    this.staminaBarFill = this.add.graphics().setScrollFactor(0).setDepth(9999);
    this.setupInput();
    this.addHud();
    this.connectToRace().catch(console.error);
  }

  // ─── Update ────────────────────────────────────────────────────────────

  update(_time: number, _delta: number): void {
    // Smoother lerp for larger tiles — lower exponent = more glide
    const t = 1 - Math.pow(0.00005, _delta / 1000);

    for (const av of this.avatars.values()) {
      const dx = av.tileX - av.displayX;
      const dy = av.tileY - av.displayY;

      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        av.displayX = av.tileX;
        av.displayY = av.tileY;
      } else if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
        av.displayX += dx * t;
        av.displayY += dy * t;
      } else {
        av.displayX = av.tileX;
        av.displayY = av.tileY;
      }

      const depth = isoDepth(av.displayX + 1, av.displayY + 1);
      av.sprite.setDepth(depth);
      av.label.setDepth(depth + 0.1);
      av.statusLabel.setDepth(depth + 0.15);

      this.positionAvatar(av);
      this.updateAvatarVisual(av, av.slotIndex === this.mySlotIndex);
    }

    // Frozen/stuck flash
    const localAv = this.avatars.get(this.mySlotIndex);
    if (localAv && (localAv.frozen || localAv.stuck)) {
      localAv.sprite.setVisible(Math.floor(_time / 500) % 2 === 0);
    } else if (localAv) {
      localAv.sprite.setVisible(true);
    }

    this.updatePickupHud();

    // Camera follow
    if (localAv) {
      const { x, y } = tileToScreen(localAv.displayX, localAv.displayY);
      this.cameras.main.centerOn(this.originX + x, this.originY + y + TILE_H / 2);
    }

    this.renderCrumbleWarnings(_time);
    this.updateMinimapPlayers();

    // Key-hold auto-repeat + inertia
    const anyDirHeld = this.keys.D?.isDown || this.keys.S?.isDown || this.keys.W?.isDown || this.keys.A?.isDown;

    if (this.currentPhase === RacePhase.Racing && Date.now() - this.lastSendTime >= SEND_INTERVAL) {
      if (anyDirHeld) {
        if (this.keys.D?.isDown) this.sendMove('D');
        else if (this.keys.S?.isDown) this.sendMove('S');
        else if (this.keys.W?.isDown) this.sendMove('W');
        else if (this.keys.A?.isDown) this.sendMove('A');
      } else if (this.inertiaRemaining > 0 && this.inertiaDir) {
        this.inertiaRemaining--;
        if (this.room) this.room.send('move', { direction: this.inertiaDir, sprint: false });
        this.lastSendTime = Date.now();
      }
    }

    if (!anyDirHeld && this.wasSprinting) {
      this.wasSprinting = false;
      this.inertiaRemaining = 2;
    }
    if (anyDirHeld) this.inertiaRemaining = 0;

    if (localAv) this.localStamina = localAv.stamina;
    this.renderStaminaBar();

    // Live race timer
    if (this.currentPhase === RacePhase.Racing && this.raceStartTime > 0) {
      const elapsed = (Date.now() - this.raceStartTime) / 1000;
      const mins = Math.floor(elapsed / 60);
      const secs = Math.floor(elapsed % 60);
      this.timerText
        .setText(`${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`)
        .setVisible(true);
    }
  }

  // ─── Terrain grid ──────────────────────────────────────────────────────

  private initEmptyTerrain(): void {
    this.localTerrain = [];
    for (let y = 0; y < GRID_ROWS; y++) {
      this.localTerrain[y] = new Array(GRID_COLS).fill(Terrain.Normal);
    }
  }

  private drawTileGrid(): void {
    this.tileGfx = this.add.graphics();
    this.renderAllTiles();
    this.tileGfx.setDepth(-1);
  }

  private renderAllTiles(): void {
    this.tileGfx.clear();
    for (let ty = 0; ty < GRID_ROWS; ty++) {
      for (let tx = 0; tx < GRID_COLS; tx++) {
        this.renderTile(tx, ty);
      }
    }
  }

  private renderTile(tx: number, ty: number): void {
    const terrain = this.localTerrain[ty]?.[tx] ?? Terrain.Normal;
    const [colorA, colorB] = TERRAIN_COLORS[terrain];
    const fill = (tx + ty) % 2 === 0 ? colorA : colorB;

    const { x, y } = tileToScreen(tx, ty);
    const sx = this.originX + x;
    const sy = this.originY + y;
    const pts = this.rhombusPoints(sx, sy);

    this.tileGfx.fillStyle(fill, 1);
    this.tileGfx.fillPoints(pts, true);

    this.tileGfx.lineStyle(1, TILE_OUTLINE, 0.1);
    this.tileGfx.strokePoints(pts, true);
  }

  private drawFinishLine(): void {
    this.finishGfx = this.add.graphics();
    this.renderFinishLine();
    this.finishGfx.setDepth(-0.5);
  }

  private renderFinishLine(): void {
    this.finishGfx.clear();
    for (let ty = FINISH_Y_MIN; ty <= FINISH_Y_MAX; ty++) {
      for (let tx = FINISH_X; tx < GRID_COLS; tx++) {
        const { x, y } = tileToScreen(tx, ty);
        const sx = this.originX + x;
        const sy = this.originY + y;
        const pts = this.rhombusPoints(sx, sy);
        const isCheck = (tx + ty) % 2 === 0;
        this.finishGfx.fillStyle(isCheck ? FINISH_COLOR : 0xffffff, 0.45);
        this.finishGfx.fillPoints(pts, true);
        this.finishGfx.lineStyle(1, 0xffffff, 0.2);
        this.finishGfx.strokePoints(pts, true);
      }
    }
  }

  // ─── Crumble warning flash ──────────────────────────────────────────────

  private renderCrumbleWarnings(time: number): void {
    this.crumbleGfx.clear();
    for (const [key, start] of this.crumbleWarnings) {
      if (time - start > 1500) this.crumbleWarnings.delete(key);
    }
    if (this.crumbleWarnings.size === 0) return;

    const flash = Math.floor(time / 150) % 2 === 0;
    const alpha = flash ? 0.5 : 0.2;
    for (const [key] of this.crumbleWarnings) {
      const [tx, ty] = key.split(',').map(Number);
      const { x, y } = tileToScreen(tx, ty);
      const pts = this.rhombusPoints(this.originX + x, this.originY + y);
      this.crumbleGfx.fillStyle(0xff3300, alpha);
      this.crumbleGfx.fillPoints(pts, true);
    }
  }

  // ─── Minimap ────────────────────────────────────────────────────────────

  private initMinimap(): void {
    this.minimapBg = this.add.graphics().setScrollFactor(0).setDepth(9998);
    this.minimapPlayers = this.add.graphics().setScrollFactor(0).setDepth(9999);
  }

  private renderMinimap(): void {
    const s = this.MINIMAP_SCALE;
    const p = this.MINIMAP_PAD;
    const mw = GRID_COLS * s;
    const mh = GRID_ROWS * s;
    const { width, height } = this.scale;
    const ox = width - mw - p - 12;
    const oy = height - mh - p - 12;

    this.minimapBg.clear();
    this.minimapBg.fillStyle(0x000000, 0.7);
    this.minimapBg.fillRect(ox - p, oy - p, mw + p * 2, mh + p * 2);

    const terrainMiniColors: Record<number, number> = {
      [Terrain.Normal]: 0x3d6649, [Terrain.Slow]: 0x6a5228, [Terrain.Slide]: 0x76b8d8,
      [Terrain.Crumble]: 0xb0723c, [Terrain.Boost]: 0xc0a600, [Terrain.Hole]: 0x0c1018,
      [Terrain.Wall]: 0x555566, [Terrain.Button]: 0xdd3388,
    };

    for (let ty = 0; ty < GRID_ROWS; ty++) {
      for (let tx = 0; tx < GRID_COLS; tx++) {
        const t = this.localTerrain[ty]?.[tx] ?? 0;
        this.minimapBg.fillStyle(terrainMiniColors[t] ?? 0x3d6649, 1);
        this.minimapBg.fillRect(ox + tx * s, oy + ty * s, s, s);
      }
    }

    this.minimapBg.fillStyle(FINISH_COLOR, 0.5);
    for (let ty = FINISH_Y_MIN; ty <= FINISH_Y_MAX; ty++) {
      for (let tx = FINISH_X; tx < GRID_COLS; tx++) {
        this.minimapBg.fillRect(ox + tx * s, oy + ty * s, s, s);
      }
    }

    this.minimapBg.lineStyle(1, 0xffffff, 0.4);
    this.minimapBg.strokeRect(ox - 1, oy - 1, mw + 2, mh + 2);
  }

  private updateMinimapPlayers(): void {
    const sc = this.MINIMAP_SCALE;
    const p = this.MINIMAP_PAD;
    const mw = GRID_COLS * sc;
    const mh = GRID_ROWS * sc;
    const { width, height } = this.scale;
    const ox = width - mw - p - 12;
    const oy = height - mh - p - 12;

    this.minimapPlayers.clear();
    for (const av of this.avatars.values()) {
      const color = SLOT_COLORS[av.slotIndex % SLOT_COLORS.length];
      const dotSize = av.slotIndex === this.mySlotIndex ? 4 : 3;
      this.minimapPlayers.fillStyle(color, 1);
      this.minimapPlayers.fillRect(
        ox + av.tileX * sc - Math.floor(dotSize / 2),
        oy + av.tileY * sc - Math.floor(dotSize / 2),
        dotSize, dotSize,
      );
    }
  }

  /** Draw type labels on each button. */
  private renderButtonLabels(): void {
    for (const lbl of this.buttonLabels) lbl.destroy();
    this.buttonLabels = [];

    const typeNames: Record<number, string> = {
      [ButtonType.ClosePath]: 'WALL', [ButtonType.OpenHole]: 'HOLE', [ButtonType.TriggerSlide]: 'ICE',
    };

    for (const btn of this.buttons) {
      const { x, y } = tileToScreen(btn.x, btn.y);
      const label = this.add.text(this.originX + x, this.originY + y + TILE_H, typeNames[btn.type] ?? '?', {
        fontSize: '11px', color: '#ffffff', fontStyle: 'bold',
        backgroundColor: '#dd338888', padding: { x: 3, y: 1 },
      }).setOrigin(0.5, 0.5).setDepth(isoDepth(btn.x + 1, btn.y + 1) + 0.2);
      this.buttonLabels.push(label);
    }
  }

  // ─── Input ─────────────────────────────────────────────────────────────

  private setupInput(): void {
    const kb = this.input.keyboard!;
    this.keys = kb.addKeys('W,A,S,D') as Record<string, Phaser.Input.Keyboard.Key>;
    this.shiftKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.SHIFT);

    kb.on('keydown-W', () => this.sendMove('W'));
    kb.on('keydown-S', () => this.sendMove('S'));
    kb.on('keydown-A', () => this.sendMove('A'));
    kb.on('keydown-D', () => this.sendMove('D'));
    kb.on('keydown-E', () => {
      if (this.room && this.currentPhase === RacePhase.Racing) this.room.send('usePickup');
    });
    kb.on('keydown-SPACE', () => {
      if (this.room && this.currentPhase === RacePhase.Racing) this.room.send('jump');
    });
  }

  private sendMove(direction: 'W' | 'A' | 'S' | 'D'): void {
    if (this.currentPhase !== RacePhase.Racing) return;
    this.playerFacing = direction;
    this.lastSendTime = Date.now();
    const sprint = this.shiftKey?.isDown ?? false;
    if (sprint) { this.wasSprinting = true; this.inertiaDir = direction; }
    if (this.room) this.room.send('move', { direction, sprint });
  }

  // ─── Avatar management ─────────────────────────────────────────────────

  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleSlotChange(slot: any, index: number): void {
    if (slot.occupied) {
      const isNew = !this.avatars.has(index);
      if (isNew) this.avatars.set(index, this.createAvatar(index));
      if (slot.sessionId === this.mySessionId) this.mySlotIndex = index;

      const av = this.avatars.get(index)!;
      const newX = slot.tileX as number;
      const newY = slot.tileY as number;
      if (newX !== av.tileX || newY !== av.tileY) {
        av.lastTileChange = performance.now();
      }
      av.tileX = newX;
      av.tileY = newY;
      if (isNew) { av.displayX = av.tileX; av.displayY = av.tileY; }
      av.playerName = slot.playerName ?? '';
      av.frozen = slot.frozen ?? false;
      av.penalized = slot.penalized ?? false;
      av.currentTerrain = slot.currentTerrain ?? Terrain.Normal;
      av.heldPickup = slot.heldPickup ?? null;
      av.shieldActive = slot.shieldActive ?? false;
      av.speedBoosted = slot.speedBoosted ?? false;
      av.stuck = slot.stuck ?? false;
      av.knockbackSlowed = slot.knockbackSlowed ?? false;
      av.stamina = slot.stamina ?? STAMINA_MAX;
      av.sprinting = slot.sprinting ?? false;

      // Update sprite animation & tint
      const isLocal = slot.sessionId === this.mySessionId;
      this.updateAvatarVisual(av, isLocal);
    } else {
      const av = this.avatars.get(index);
      if (av) {
        av.sprite.destroy();
        av.shadow.destroy();
        av.label.destroy();
        av.statusLabel.destroy();
        this.avatars.delete(index);
      }
    }
  }

  private createAvatar(slotIndex: number): AvatarData {
    const config = SLOT_CHARACTERS[slotIndex % SLOT_CHARACTERS.length];
    const charDef = config.char;

    // Pick the initial texture — for multi-sheet chars, use the S direction sheet
    const initialTexture = charDef.multiSheet
      ? `${charDef.key}${charDef.dirMap.S.sheetSuffix}`
      : charDef.key;

    const shadow = this.add.graphics();
    const sprite = this.add.sprite(0, 0, initialTexture, 0);
    sprite.setScale(charDef.scale);
    sprite.setTint(config.tint);

    return {
      sprite,
      shadow,
      label: this.add.text(0, 0, '', { fontSize: '13px', color: '#ffffff', fontStyle: 'bold' }).setOrigin(0.5, 1),
      statusLabel: this.add.text(0, 0, '', {
        fontSize: '10px', color: '#ffffff', fontStyle: 'bold',
        backgroundColor: '#00000088', padding: { x: 3, y: 1 },
      }).setOrigin(0.5, 1),
      tileX: SPAWN_X, tileY: SPAWN_Y,
      displayX: SPAWN_X, displayY: SPAWN_Y,
      slotIndex, playerName: '',
      frozen: false, penalized: false,
      currentTerrain: Terrain.Normal,
      heldPickup: null, shieldActive: false, speedBoosted: false,
      stuck: false, knockbackSlowed: false,
      stamina: STAMINA_MAX, sprinting: false, lastTileChange: 0,
    };
  }

  /** Position the sprite and labels at the lerped display position. */
  private positionAvatar(av: AvatarData): void {
    const { x, y } = tileToScreen(av.displayX, av.displayY);
    const sx = this.originX + x;
    const sy = this.originY + y + TILE_H / 2; // center of single tile

    // Shadow ellipse at feet level
    av.shadow.clear();
    av.shadow.fillStyle(0x000000, 0.3);
    av.shadow.fillEllipse(sx, sy, 30, 12);
    av.shadow.setDepth(isoDepth(av.displayX, av.displayY) - 0.01);

    // Sprite origin per character type
    const charDef = SLOT_CHARACTERS[av.slotIndex % SLOT_CHARACTERS.length].char;
    av.sprite.setOrigin(charDef.originX, charDef.originY);
    av.sprite.setPosition(sx, sy);
    av.label.setPosition(sx, sy - 70).setText(av.playerName || `P${av.slotIndex + 1}`);

    const { text, color } = this.getStatusDisplay(av);
    av.statusLabel.setPosition(sx, sy - 84).setText(text).setColor(color).setVisible(text !== '');
  }

  /** Update sprite animation direction and tint based on state. */
  private updateAvatarVisual(av: AvatarData, isLocal: boolean): void {
    const config = SLOT_CHARACTERS[av.slotIndex % SLOT_CHARACTERS.length];
    const charDef = config.char;
    const dir = isLocal ? this.playerFacing : 'S';
    const animKey = `${charDef.key}_walk_${dir}`;
    const mapping = charDef.dirMap[dir];

    // Moving = lerp in progress OR holding key OR recently sent input OR recently changed tile
    const isLerping = Math.abs(av.tileX - av.displayX) > 0.05 || Math.abs(av.tileY - av.displayY) > 0.05;
    const isHoldingKey = isLocal && (this.keys?.D?.isDown || this.keys?.S?.isDown || this.keys?.W?.isDown || this.keys?.A?.isDown);
    const now = performance.now();
    const recentlyActive = isLocal
      ? (now - av.lastTileChange < 500) || (Date.now() - this.lastSendTime < 500)
      : (now - av.lastTileChange < 500);
    const isMoving = isLerping || isHoldingKey || recentlyActive;

    if (isMoving) {
      // Always force-play the correct direction animation (handles rapid direction switches)
      const currentKey = av.sprite.anims.currentAnim?.key;
      if (currentKey !== animKey || !av.sprite.anims.isPlaying) {
        av.sprite.play(animKey);
      }
      av.sprite.anims.timeScale = (av.sprinting || av.speedBoosted) ? 1.5 : 1.0;
    } else {
      // Truly idle — static frame of current direction
      if (av.sprite.anims.isPlaying) {
        av.sprite.stop();
        if (charDef.multiSheet) {
          av.sprite.setTexture(`${charDef.key}${mapping.sheetSuffix}`, 0);
        } else {
          av.sprite.setFrame((mapping.row ?? 0) * charDef.framesPerDir);
        }
      }
    }

    av.sprite.setFlipX(mapping.flipX);

    // Tint based on state — override slot color during effects
    let tint = config.tint;
    if (isLocal) {
      if (av.frozen || av.stuck)            tint = 0xff2222;
      else if (av.speedBoosted)             tint = 0xffd700;
      else if (av.shieldActive)             tint = 0x44ffff;
      else if (av.penalized || av.knockbackSlowed) tint = 0x88ccff;
    }
    av.sprite.setTint(tint);
  }

  private getStatusDisplay(av: AvatarData): { text: string; color: string } {
    if (av.frozen)           return { text: 'FELL!',   color: '#ff4444' };
    if (av.stuck)            return { text: 'STUCK',   color: '#ff4444' };
    if (av.speedBoosted)     return { text: 'SPEED!',  color: '#ffd700' };
    if (av.shieldActive)     return { text: 'SHIELD',  color: '#44ffff' };
    if (av.sprinting)        return { text: 'SPRINT',  color: '#44ff44' };
    if (av.knockbackSlowed)  return { text: 'SLOWED',  color: '#88ccff' };
    if (av.penalized)        return { text: 'PENALTY', color: '#88ccff' };

    switch (av.currentTerrain) {
      case Terrain.Slow:    return { text: 'SLOW',    color: '#c4a04a' };
      case Terrain.Crumble: return { text: 'CRUMBLE', color: '#e09050' };
      default:              return { text: '',        color: '#ffffff' };
    }
  }

  // ─── Pickup & slime rendering ──────────────────────────────────────────

  private readonly PICKUP_COLORS: Record<number, number> = {
    0: 0x44ff44, 1: 0x44ffff, 2: 0xaaff00, 3: 0xff6644,
  };

  private renderPickups(): void {
    this.pickupGfx.clear();
    for (const p of this.pickups) {
      if (this.collectedPickupIds.has(p.id)) continue;
      const { x, y } = tileToScreen(p.x, p.y);
      const pts = this.rhombusPoints(this.originX + x, this.originY + y);
      this.pickupGfx.fillStyle(this.PICKUP_COLORS[p.type] ?? 0xffffff, 0.7);
      this.pickupGfx.fillPoints(pts, true);
      this.pickupGfx.lineStyle(2, 0xffffff, 0.8);
      this.pickupGfx.strokePoints(pts, true);
    }
  }

  private renderSlimeZones(): void {
    this.slimeGfx.clear();
    for (const zone of this.slimeZones) {
      for (let dy = 0; dy < zone.size; dy++) {
        for (let dx = 0; dx < zone.size; dx++) {
          const { x, y } = tileToScreen(zone.x + dx, zone.y + dy);
          const pts = this.rhombusPoints(this.originX + x, this.originY + y);
          this.slimeGfx.fillStyle(0xaaff00, 0.4);
          this.slimeGfx.fillPoints(pts, true);
        }
      }
    }
  }

  private updatePickupHud(): void {
    const localAv = this.avatars.get(this.mySlotIndex);
    if (!localAv || localAv.heldPickup === null) {
      this.pickupHudText.setVisible(false);
      return;
    }
    const name = PICKUP_NAMES[localAv.heldPickup] ?? '???';
    this.pickupHudText.setText(`[E] ${name}`).setVisible(true);
  }

  // ─── Stamina bar ────────────────────────────────────────────────────────

  private renderStaminaBar(): void {
    const { width } = this.scale;
    const barW = 180;
    const barH = 10;
    const bx = width / 2 - barW / 2;
    const by = 50;

    this.staminaBarBg.clear();
    this.staminaBarFill.clear();
    if (this.currentPhase !== RacePhase.Racing) return;

    this.staminaBarBg.fillStyle(0x000000, 0.5);
    this.staminaBarBg.fillRect(bx - 1, by - 1, barW + 2, barH + 2);

    const pct = Math.max(0, Math.min(1, this.localStamina / STAMINA_MAX));
    this.staminaBarFill.fillStyle(pct > 0.3 ? 0x44cc44 : 0xcc4444, 0.8);
    this.staminaBarFill.fillRect(bx, by, barW * pct, barH);
  }

  // ─── Network ───────────────────────────────────────────────────────────

  private async connectToRace(): Promise<void> {
    const name = window.prompt('Enter your name:', '')?.trim() || 'Player';

    const { Client } = await import('colyseus.js');
    const client = new Client('ws://localhost:3000');
    const room = await client.joinOrCreate('race', { playerName: name });
    this.room = room;
    this.mySessionId = room.sessionId;

    room.onMessage('mapData', (data: { map: number[][]; buttons: ButtonDef[]; pickups: PickupDef[] }) => {
      this.localTerrain = data.map;
      this.buttons = data.buttons;
      this.pickups = data.pickups;
      this.collectedPickupIds.clear();
      this.renderAllTiles();
      this.renderMinimap();
      this.renderButtonLabels();
      this.renderPickups();
    });

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    room.onMessage('state', (data: { phase: number; countdown: number; finishCountdown: number; startTime: number; slots: any[] }) => {
      const prevPhase = this.currentPhase;
      this.currentPhase = data.phase;
      if (data.phase === RacePhase.Racing && prevPhase !== RacePhase.Racing) {
        this.raceStartTime = data.startTime;
      }
      if (data.phase === RacePhase.Waiting && prevPhase === RacePhase.Finished) {
        this.handleRaceReset();
      }
      this.updatePhaseHud(data.phase, data.countdown, data.finishCountdown);
      data.slots.forEach((slot, index) => this.handleSlotChange(slot, index));
    });

    room.onMessage('terrainChange', (data: { tileX: number; tileY: number; terrain: number }) => {
      this.localTerrain[data.tileY][data.tileX] = data.terrain;
      this.renderAllTiles();
      this.renderMinimap();
    });

    room.onMessage('terrainReset', (data: { map: number[][]; buttons: ButtonDef[]; pickups: PickupDef[] }) => {
      this.localTerrain = data.map;
      this.buttons = data.buttons;
      this.pickups = data.pickups;
      this.collectedPickupIds.clear();
      this.slimeZones = [];
      this.renderAllTiles();
      this.renderMinimap();
      this.renderButtonLabels();
      this.renderPickups();
      this.renderSlimeZones();
    });

    room.onMessage('playerFinished', (data: { playerName: string; position: number; timeSeconds: number }) => {
      this.showAnnouncement(`#${data.position} ${data.playerName} finished in ${data.timeSeconds.toFixed(2)}s!`);
    });

    room.onMessage('raceResults', (data: { results: RaceResult[] }) => {
      this.showResults(data.results);
    });

    room.onMessage('crumbleWarning', (data: { tileX: number; tileY: number }) => {
      this.crumbleWarnings.set(`${data.tileX},${data.tileY}`, performance.now());
    });

    room.onMessage('pickupCollected', (data: { id: number }) => {
      this.collectedPickupIds.add(data.id);
      this.renderPickups();
    });

    room.onMessage('slimePlaced', (data: { x: number; y: number; size: number }) => {
      this.slimeZones.push({ x: data.x, y: data.y, size: data.size });
      this.renderSlimeZones();
    });
    room.onMessage('slimeExpired', (data: { x: number; y: number }) => {
      this.slimeZones = this.slimeZones.filter(z => z.x !== data.x || z.y !== data.y);
      this.renderSlimeZones();
    });

    room.onMessage('pickupUsed', () => {});
    room.onMessage('shieldUsed', () => {});
    room.onMessage('playerStuck', () => {});
    room.onMessage('playerJumped', () => {});
    room.onMessage('buttonActivated', () => {});
    room.onMessage('buttonReverted', () => {});

    console.log('[IsoScene] connected to RaceRoom:', this.mySessionId);
  }

  private showAnnouncement(msg: string): void {
    if (this.announceTimer) clearTimeout(this.announceTimer);
    this.announceText.setText(msg).setVisible(true);
    this.announceTimer = setTimeout(() => {
      this.announceText.setVisible(false);
      this.announceTimer = null;
    }, 3000);
  }

  private handleRaceReset(): void {
    this.resultsText.setVisible(false);
    this.timerText.setVisible(false);
    this.announceText.setVisible(false);
    if (this.announceTimer) { clearTimeout(this.announceTimer); this.announceTimer = null; }
    this.raceStartTime = 0;
    this.slimeZones = [];
    this.renderSlimeZones();
  }

  // ─── HUD ───────────────────────────────────────────────────────────────

  private addHud(): void {
    this.add
      .text(10, 10, 'WASD move · SHIFT sprint · SPACE jump · E pickup', {
        fontSize: '14px', color: '#aabbcc', backgroundColor: '#00000066', padding: { x: 8, y: 4 },
      })
      .setScrollFactor(0).setDepth(9999);

    const { width, height } = this.scale;

    this.pickupHudText = this.add
      .text(10, height - 10, '', {
        fontSize: '20px', color: '#ffffff', fontStyle: 'bold',
        backgroundColor: '#00000088', padding: { x: 12, y: 8 },
      })
      .setOrigin(0, 1).setScrollFactor(0).setDepth(9999).setVisible(false);

    this.phaseText = this.add
      .text(width / 2, 10, 'Waiting for players...', {
        fontSize: '22px', color: '#ffffff', backgroundColor: '#00000088', padding: { x: 14, y: 8 },
      })
      .setOrigin(0.5, 0).setScrollFactor(0).setDepth(9999);

    this.timerText = this.add
      .text(width - 20, 10, '00:00', {
        fontSize: '22px', color: '#ffffff', backgroundColor: '#00000088', padding: { x: 12, y: 8 },
      })
      .setOrigin(1, 0).setScrollFactor(0).setDepth(9999).setVisible(false);

    this.announceText = this.add
      .text(width / 2, 65, '', {
        fontSize: '18px', color: '#ffdd44', fontStyle: 'bold',
        backgroundColor: '#000000aa', padding: { x: 14, y: 8 },
      })
      .setOrigin(0.5, 0).setScrollFactor(0).setDepth(9999).setVisible(false);

    this.resultsText = this.add
      .text(width / 2, height / 2, '', {
        fontSize: '16px', color: '#ffffff', backgroundColor: '#000000dd',
        padding: { x: 24, y: 18 }, align: 'left', lineSpacing: 6,
      })
      .setOrigin(0.5, 0.5).setScrollFactor(0).setDepth(10000).setVisible(false);
  }

  private updatePhaseHud(phase: number, countdown: number, finishCountdown?: number): void {
    switch (phase) {
      case RacePhase.Waiting:
        this.phaseText.setText('Waiting for players...').setColor('#aaaaaa');
        this.timerText.setVisible(false);
        break;
      case RacePhase.Countdown:
        this.phaseText.setText(`Starting in ${countdown}...`).setColor('#ffdd44');
        this.timerText.setVisible(false);
        break;
      case RacePhase.Racing:
        if (finishCountdown && finishCountdown > 0) {
          this.phaseText.setText(`Race ends in ${finishCountdown}s!`).setColor('#ff8844');
        } else {
          this.phaseText.setText('Racing!').setColor('#44ff44');
        }
        break;
      case RacePhase.Finished:
        this.phaseText.setText('Race Over — Restarting...').setColor('#ff6666');
        break;
    }
  }

  private showResults(results: RaceResult[]): void {
    const lines: string[] = ['=== RACE RESULTS ===', ''];
    for (const r of results) {
      const pos = r.position > 0 ? `#${r.position}` : 'DNF';
      const time = r.position > 0 ? `${r.timeSeconds.toFixed(2)}s` : '---';
      const bonus = r.bonusPoints > 0 ? ` (+${r.bonusPoints} bonus)` : '';
      lines.push(`${pos}  ${r.playerName}  ${time}  ${r.totalScore}pts${bonus}`);
    }
    this.resultsText.setText(lines.join('\n')).setVisible(true);
  }

  // ─── Geometry ──────────────────────────────────────────────────────────

  private rhombusPoints(sx: number, sy: number): Array<{ x: number; y: number }> {
    return [
      { x: sx, y: sy },
      { x: sx + TILE_W / 2, y: sy + TILE_H / 2 },
      { x: sx, y: sy + TILE_H },
      { x: sx - TILE_W / 2, y: sy + TILE_H / 2 },
    ];
  }
}
