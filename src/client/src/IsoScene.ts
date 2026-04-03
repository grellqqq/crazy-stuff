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
    S:  { row: 0, flipX: false },  // SE
    SA: { row: 0, flipX: false },  // S → nearest is SE
    A:  { row: 1, flipX: false },  // SW
    WA: { row: 1, flipX: false },  // W → nearest is SW
    W:  { row: 3, flipX: false },  // NW
    WD: { row: 3, flipX: false },  // N → nearest is NW
    D:  { row: 2, flipX: false },  // NE
    SD: { row: 2, flipX: false },  // E → nearest is NE
  },
};

const CHAR_KNIGHT: CharacterDef = {
  key: 'knight',
  multiSheet: true,
  scale: 0.75,
  framesPerDir: 9,
  originX: 0.52,
  originY: 0.50,
  dirMap: {
    S:  { sheetSuffix: '_S',  flipX: false },  // SE (dir1)
    SA: { sheetSuffix: '_SA', flipX: false },  // S  (dir2)
    A:  { sheetSuffix: '_A',  flipX: false },  // SW (dir3)
    WA: { sheetSuffix: '_WA', flipX: false },  // W  (dir4)
    W:  { sheetSuffix: '_W',  flipX: false },  // NW (dir5)
    WD: { sheetSuffix: '_WD', flipX: false },  // N  (dir6)
    D:  { sheetSuffix: '_D',  flipX: false },  // NE (dir7)
    SD: { sheetSuffix: '_SD', flipX: false },  // E  (dir8)
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
  immune: boolean;
  lastTileChange: number;
  /** Vertical offset for jump animation — applied on top of normal position. */
  jumpOffset: number;
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

  private playerFacing = 'S';

  private avatars = new Map<number, AvatarData>();
  private mySlotIndex = -1;
  private slotBySession = new Map<string, number>();

  private localTerrain: number[][] = [];
  private tileGfx!: Phaser.GameObjects.Graphics;
  private finishGfx!: Phaser.GameObjects.Graphics;
  /** Tile sprite images — 2D array [ty][tx] for texture-based rendering. */
  private tileImages: (Phaser.GameObjects.Image | null)[][] = [];
  /** Processed tile texture keys per terrain type. */
  private tileTextureReady = false;

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
  private buttonGfx!: Phaser.GameObjects.Graphics;
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
  private inertiaDir: string | null = null;

  // ─── Particles & Sound ──────────────────────────────────────────────────
  private audioCtx: AudioContext | null = null;

  constructor() {
    super({ key: 'IsoScene' });
  }

  // ─── Preload ───────────────────────────────────────────────────────────

  preload(): void {
    // Character sprites
    this.load.spritesheet('spacesuit', '/sprites/space_suit.png', { frameWidth: 80, frameHeight: 80 });
    // Knight: 8 directions (dir1=SE, dir2=S, dir3=SW, dir4=W, dir5=NW, dir6=N, dir7=NE, dir8=E)
    this.load.spritesheet('knight_S',  '/sprites/knight/walk_dir1.png', { frameWidth: 512, frameHeight: 512 });
    this.load.spritesheet('knight_SA', '/sprites/knight/walk_dir2.png', { frameWidth: 512, frameHeight: 512 });
    this.load.spritesheet('knight_A',  '/sprites/knight/walk_dir3.png', { frameWidth: 512, frameHeight: 512 });
    this.load.spritesheet('knight_WA', '/sprites/knight/walk_dir4.png', { frameWidth: 512, frameHeight: 512 });
    this.load.spritesheet('knight_W',  '/sprites/knight/walk_dir5.png', { frameWidth: 512, frameHeight: 512 });
    this.load.spritesheet('knight_WD', '/sprites/knight/walk_dir6.png', { frameWidth: 512, frameHeight: 512 });
    this.load.spritesheet('knight_D',  '/sprites/knight/walk_dir7.png', { frameWidth: 512, frameHeight: 512 });
    this.load.spritesheet('knight_SD', '/sprites/knight/walk_dir8.png', { frameWidth: 512, frameHeight: 512 });

    // Tile textures (SBS 128×64 isometric tiles, 3×6 grid per sheet)
    this.load.image('tiles_grass', '/tiles/grass.png');
    this.load.image('tiles_dry', '/tiles/dry.png');
    this.load.image('tiles_ice', '/tiles/ice.png');
    this.load.image('tiles_rocky', '/tiles/rocky.png');
    this.load.image('tiles_elements', '/tiles/elements.png');
    this.load.image('tiles_stones', '/tiles/stones.png');
    this.load.image('tiles_metal', '/tiles/metal.png');
    this.load.image('tiles_wood_src', '/tiles/wood.png');

    // Object sprites
    this.load.spritesheet('wall_crates', '/sprites/wall_crates.png', { frameWidth: 177, frameHeight: 181 });
    this.load.image('button_plate', '/sprites/button_plate.png');
    this.load.spritesheet('bonfire', '/sprites/bonfire.png', { frameWidth: 105, frameHeight: 137 });
    this.load.spritesheet('crate_wood', '/sprites/crates_wood.png', { frameWidth: 128, frameHeight: 128 });
  }

  // ─── Create ────────────────────────────────────────────────────────────

  create(): void {
    this.initEmptyTerrain();

    // Create walk animations for all character types (8 directions)
    const allDirs = ['S', 'SA', 'A', 'WA', 'W', 'WD', 'D', 'SD'];
    for (const charDef of [CHAR_SPACESUIT, CHAR_KNIGHT]) {
      for (const dir of allDirs) {
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

    // Generate a simple circle particle texture
    const particleGfx = this.make.graphics({ x: 0, y: 0 });
    particleGfx.fillStyle(0xffffff, 1);
    particleGfx.fillCircle(4, 4, 4);
    particleGfx.generateTexture('particle', 8, 8);
    particleGfx.destroy();

    // Process tile textures: remove magenta background → transparent, create spritesheets
    try {
      this.processTileTextures();
    } catch (e) {
      console.error('[IsoScene] tile texture processing failed, using fallback colors:', e);
      this.tileTextureReady = false;
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
    this.buttonGfx = this.add.graphics().setDepth(-0.2);
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
    // Base lerp factor — frame-rate independent
    const tNormal = 1 - Math.pow(0.00005, _delta / 1000);
    // Slower lerp for slow terrain — spreads movement over more frames (less jerky)
    const tSlow = 1 - Math.pow(0.0003, _delta / 1000);

    for (const av of this.avatars.values()) {
      const dx = av.tileX - av.displayX;
      const dy = av.tileY - av.displayY;
      const lerpT = (av.currentTerrain === Terrain.Slow || av.penalized || av.knockbackSlowed) ? tSlow : tNormal;

      if (Math.abs(dx) > 8 || Math.abs(dy) > 8) {
        av.displayX = av.tileX;
        av.displayY = av.tileY;
      } else if (Math.abs(dx) > 0.01 || Math.abs(dy) > 0.01) {
        av.displayX += dx * lerpT;
        av.displayY += dy * lerpT;
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
      localAv.sprite.setAlpha(1);
    } else if (localAv && localAv.immune) {
      localAv.sprite.setVisible(true);
      localAv.sprite.setAlpha(0.5 + Math.sin(_time / 100) * 0.2); // pulsing ghost
    } else if (localAv) {
      localAv.sprite.setVisible(true);
      localAv.sprite.setAlpha(1);
    }

    this.updatePickupHud();

    // Camera follow
    if (localAv) {
      const { x, y } = tileToScreen(localAv.displayX, localAv.displayY);
      this.cameras.main.centerOn(this.originX + x, this.originY + y + TILE_H / 2);
    }

    this.renderCrumbleWarnings(_time);
    this.renderPickupGlow(_time);
    this.renderButtonGlow(_time);
    this.updateMinimapPlayers();

    // 8-direction key detection + auto-repeat + inertia
    const w = this.keys.W?.isDown;
    const a = this.keys.A?.isDown;
    const s = this.keys.S?.isDown;
    const d = this.keys.D?.isDown;
    const anyDirHeld = w || a || s || d;

    // Determine combined direction from held keys
    let heldDir: string | null = null;
    if (w && d)      heldDir = 'WD';  // North
    else if (w && a) heldDir = 'WA';  // West
    else if (s && d) heldDir = 'SD';  // East
    else if (s && a) heldDir = 'SA';  // South
    else if (d)      heldDir = 'D';   // NE
    else if (s)      heldDir = 'S';   // SE
    else if (w)      heldDir = 'W';   // NW
    else if (a)      heldDir = 'A';   // SW

    if (this.currentPhase === RacePhase.Racing && Date.now() - this.lastSendTime >= SEND_INTERVAL) {
      if (heldDir) {
        this.sendMove(heldDir);
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

    // Destroy old tile images
    for (const row of this.tileImages) {
      if (!row) continue;
      for (const img of row) if (img) img.destroy();
    }
    this.tileImages = [];

    for (let ty = 0; ty < GRID_ROWS; ty++) {
      this.tileImages[ty] = [];
      for (let tx = 0; tx < GRID_COLS; tx++) {
        this.tileImages[ty][tx] = this.renderTile(tx, ty);
      }
    }
  }

  /** Re-render only specific tiles (avoids full re-render for terrain changes). */
  private renderTilesAt(tiles: { tileX: number; tileY: number }[]): void {
    for (const { tileX, tileY } of tiles) {
      const old = this.tileImages[tileY]?.[tileX];
      if (old) old.destroy();
      if (this.tileImages[tileY]) {
        this.tileImages[tileY][tileX] = this.renderTile(tileX, tileY);
      }
    }
  }

  /**
   * Terrain type → tile texture key + frame index.
   * Frame index picks a variant from the 3×6 grid (18 variants per sheet).
   */
  private readonly TERRAIN_TILE_MAP: Record<number, { src: string; key: string; frames: number[] }> = {
    [Terrain.Slow]:    { src: 'tiles_dry',      key: 'tf_dry',      frames: [0] },
    [Terrain.Slide]:   { src: 'tiles_ice',      key: 'tf_ice',      frames: [0] },
    [Terrain.Crumble]: { src: 'tiles_rocky',    key: 'tf_rocky',    frames: [0] },
  };

  /** Remove magenta (#FF00FF) background from tile textures and create spritesheets. */
  private processTileTextures(): void {
    const tileW = 128;
    const tileH = 64;
    const processed = new Set<string>();

    for (const terrainDef of Object.values(this.TERRAIN_TILE_MAP)) {
      // Skip if we already processed this key (e.g. Boost shares grass)
      if (processed.has(terrainDef.key)) continue;
      processed.add(terrainDef.key);

      const srcTexture = this.textures.get(terrainDef.src);
      const srcImage = srcTexture.getSourceImage() as HTMLImageElement;

      const canvas = document.createElement('canvas');
      canvas.width = srcImage.width;
      canvas.height = srcImage.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(srcImage, 0, 0);

      // Replace magenta pixels with transparent
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const data = imageData.data;
      for (let i = 0; i < data.length; i += 4) {
        if (data[i] >= 240 && data[i + 1] <= 15 && data[i + 2] >= 240) {
          data[i + 3] = 0;
        }
      }
      ctx.putImageData(imageData, 0, 0);

      // Add as a new canvas texture, then create spritesheet frames
      const canvasTexture = this.textures.addCanvas(terrainDef.key, canvas)!;
      const cols = Math.floor(canvas.width / tileW);
      const rows = Math.floor(canvas.height / tileH);
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          const frameIdx = r * cols + c;
          canvasTexture.add(frameIdx, 0, c * tileW, r * tileH, tileW, tileH);
        }
      }
    }

    // Extract wood floor tile (frame 0 from spritesheet)
    // The spritesheet has overlapping isometric tiles, so we clip to a diamond
    // mask and crop to the diamond bounds (192×96) to avoid transparent overlap.
    try {
      const woodSrc = this.textures.get('tiles_wood_src').getSourceImage() as HTMLImageElement;
      // First pass: clip diamond on full-size canvas to find content
      const tmpCanvas = document.createElement('canvas');
      tmpCanvas.width = 192; tmpCanvas.height = 192;
      const tmpCtx = tmpCanvas.getContext('2d')!;
      const cx = 96, cy = 66, hw = 95, hh = 48;
      tmpCtx.beginPath();
      tmpCtx.moveTo(cx, cy - hh); tmpCtx.lineTo(cx + hw, cy);
      tmpCtx.lineTo(cx, cy + hh); tmpCtx.lineTo(cx - hw, cy);
      tmpCtx.closePath(); tmpCtx.clip();
      tmpCtx.drawImage(woodSrc, 0, 0, 192, 192, 0, 0, 192, 192);
      // Crop to diamond bounds (y: 18..112 = 95px tall, full width)
      const cropY = 18, cropH = 95;
      const woodCanvas = document.createElement('canvas');
      woodCanvas.width = 192; woodCanvas.height = cropH;
      const woodCtx = woodCanvas.getContext('2d')!;
      woodCtx.drawImage(tmpCanvas, 0, cropY, 192, cropH, 0, 0, 192, cropH);
      this.textures.addCanvas('tiles_wood', woodCanvas);
    } catch (e) {
      console.warn('[processTileTextures] wood extraction failed:', e);
    }

    // Process sprites with black backgrounds → transparent
    this.removeBlackBg('wall_crates', 177, 181, 4, 1);
    this.removeBlackBg('crate_wood', 128, 128, 6, 4);
    this.removeBlackBg('bonfire', 105, 137, 4, 1);

    this.tileTextureReady = true;
  }

  /** Remove black background from a spritesheet and recreate with frames. */
  private removeBlackBg(key: string, frameW: number, frameH: number, cols: number, rows: number): void {
    try {
      const src = this.textures.get(key).getSourceImage() as HTMLImageElement;
      const canvas = document.createElement('canvas');
      canvas.width = src.width;
      canvas.height = src.height;
      const ctx = canvas.getContext('2d', { willReadFrequently: true })!;
      ctx.drawImage(src, 0, 0);
      const imageData = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const d = imageData.data;
      for (let i = 0; i < d.length; i += 4) {
        if (d[i] <= 12 && d[i + 1] <= 12 && d[i + 2] <= 12) d[i + 3] = 0;
      }
      ctx.putImageData(imageData, 0, 0);
      this.textures.remove(key);
      const tex = this.textures.addCanvas(key, canvas)!;
      for (let r = 0; r < rows; r++) {
        for (let c = 0; c < cols; c++) {
          tex.add(r * cols + c, 0, c * frameW, r * frameH, frameW, frameH);
        }
      }
    } catch (e) {
      console.warn(`[removeBlackBg] ${key} failed:`, e);
    }
  }

  private renderTile(tx: number, ty: number): Phaser.GameObjects.Image | null {
    const terrain = this.localTerrain[ty]?.[tx] ?? Terrain.Normal;
    const { x, y } = tileToScreen(tx, ty);
    const sx = this.originX + x;
    const sy = this.originY + y;
    const tileDepth = isoDepth(tx, ty);

    // Hole: dark void with layered depth effect
    if (terrain === Terrain.Hole) {
      const pts = this.rhombusPoints(sx, sy);
      // Outer dark fill
      this.tileGfx.fillStyle(0x050810, 1);
      this.tileGfx.fillPoints(pts, true);
      // Inner slightly lighter area (depth gradient illusion)
      const inner = [
        { x: sx, y: sy + 4 },
        { x: sx + TILE_W / 2 - 6, y: sy + TILE_H / 2 },
        { x: sx, y: sy + TILE_H - 4 },
        { x: sx - TILE_W / 2 + 6, y: sy + TILE_H / 2 },
      ];
      this.tileGfx.fillStyle(0x0a1520, 1);
      this.tileGfx.fillPoints(inner, true);
      // Outer rim
      this.tileGfx.lineStyle(2, 0x000000, 0.9);
      this.tileGfx.strokePoints(pts, true);
      // Top edge highlight (lip of the hole)
      this.tileGfx.lineStyle(2, 0x556677, 0.5);
      this.tileGfx.beginPath();
      this.tileGfx.moveTo(pts[3].x + 4, pts[3].y);
      this.tileGfx.lineTo(pts[0].x, pts[0].y + 3);
      this.tileGfx.lineTo(pts[1].x - 4, pts[1].y);
      this.tileGfx.strokePath();
      return null;
    }

    // Wall: wood floor tile + tall crate on top
    if (terrain === Terrain.Wall) {
      // Floor underneath
      const wallFloor = this.add.image(sx, sy + TILE_H / 2, 'tiles_wood');
      wallFloor.setScale(TILE_W / 192);
      wallFloor.setDepth(-1);
      // Crate block on top
      const frame = (tx + ty) % 4;
      const wallSprite = this.add.sprite(sx, sy + TILE_H / 2, 'wall_crates', frame);
      wallSprite.setScale(0.38);
      wallSprite.setOrigin(0.5, 0.78);
      wallSprite.setDepth(tileDepth + 0.5);
      return wallSprite as unknown as Phaser.GameObjects.Image;
    }

    // Button: bonfire barrel sitting on a normal ground tile
    if (terrain === Terrain.Button) {
      // Draw the same wood ground as Normal terrain
      const floor = this.add.image(sx, sy + TILE_H / 2, 'tiles_wood');
      floor.setScale(TILE_W / 192);
      floor.setDepth(tileDepth);
      // Bonfire barrel — sits on tile surface
      const frame = (tx + ty) % 4;
      const fire = this.add.sprite(sx, sy + TILE_H, 'bonfire', frame);
      fire.setScale(0.32);
      fire.setOrigin(0.5, 1.0);
      fire.setDepth(tileDepth + 0.1);
      return fire as unknown as Phaser.GameObjects.Image;
    }

    // Normal terrain: wood floor
    if (terrain === Terrain.Normal) {
      const img = this.add.image(sx, sy + TILE_H / 2, 'tiles_wood');
      img.setScale(TILE_W / 192); // 192px native → 64px tile width
      img.setDepth(-1);
      this.drawTerrainBorders(tx, ty, terrain, sx, sy);
      return img;
    }

    // Textured floor tile (non-Normal terrain)
    if (this.tileTextureReady) {
      const tileDef = this.TERRAIN_TILE_MAP[terrain];
      if (tileDef) {
        const frameIdx = tileDef.frames[(tx + ty * 3) % tileDef.frames.length];
        const img = this.add.image(sx, sy + TILE_H / 2, tileDef.key, frameIdx);
        img.setScale(0.5);
        img.setDepth(-1);
        this.drawTerrainBorders(tx, ty, terrain, sx, sy);
        return img;
      }
    }

    // Fallback: wood floor (same as Normal)
    const fallback = this.add.image(sx, sy + TILE_H / 2, 'tiles_wood');
    fallback.setScale(TILE_W / 192);
    fallback.setDepth(-1);
    this.drawTerrainBorders(tx, ty, terrain, sx, sy);
    return fallback;
  }

  /** Draw border edges where terrain type changes between adjacent tiles. */
  private drawTerrainBorders(tx: number, ty: number, terrain: number, sx: number, sy: number): void {
    // Check each neighbor — if different terrain, draw a border edge
    const neighbors: [number, number, { x: number; y: number }, { x: number; y: number }][] = [
      [tx + 1, ty, { x: sx + TILE_W / 2, y: sy + TILE_H / 2 }, { x: sx, y: sy + TILE_H }],  // right edge
      [tx - 1, ty, { x: sx, y: sy }, { x: sx - TILE_W / 2, y: sy + TILE_H / 2 }],              // left edge (top)
      [tx, ty + 1, { x: sx, y: sy + TILE_H }, { x: sx - TILE_W / 2, y: sy + TILE_H / 2 }],    // bottom-left
      [tx, ty - 1, { x: sx + TILE_W / 2, y: sy + TILE_H / 2 }, { x: sx, y: sy }],              // top-right
    ];

    for (const [nx, ny, p1, p2] of neighbors) {
      const nt = this.localTerrain[ny]?.[nx] ?? -1;
      if (nt !== terrain && nt !== -1) {
        this.tileGfx.lineStyle(1, 0x000000, 0.35);
        this.tileGfx.beginPath();
        this.tileGfx.moveTo(p1.x, p1.y);
        this.tileGfx.lineTo(p2.x, p2.y);
        this.tileGfx.strokePath();
      }
    }
  }

  /** Draw a 3D isometric wall block using pure Graphics — fits the tile diamond exactly. */
  private drawWallBlock(sx: number, sy: number): void {
    const wallH = 18;
    const hw = TILE_W / 2; // 32
    const hh = TILE_H / 2; // 16

    // Top face (diamond) — lighter stone
    this.tileGfx.fillStyle(0x667788, 1);
    this.tileGfx.beginPath();
    this.tileGfx.moveTo(sx, sy);            // top
    this.tileGfx.lineTo(sx + hw, sy + hh);  // right
    this.tileGfx.lineTo(sx, sy + TILE_H);   // bottom
    this.tileGfx.lineTo(sx - hw, sy + hh);  // left
    this.tileGfx.closePath();
    this.tileGfx.fillPath();

    // Top face highlight edges
    this.tileGfx.lineStyle(1, 0x8899aa, 0.7);
    this.tileGfx.beginPath();
    this.tileGfx.moveTo(sx - hw, sy + hh);
    this.tileGfx.lineTo(sx, sy);
    this.tileGfx.lineTo(sx + hw, sy + hh);
    this.tileGfx.strokePath();

    // Right face (darker)
    this.tileGfx.fillStyle(0x3a3a4e, 1);
    this.tileGfx.beginPath();
    this.tileGfx.moveTo(sx + hw, sy + hh);          // top-right of diamond
    this.tileGfx.lineTo(sx, sy + TILE_H);             // bottom of diamond
    this.tileGfx.lineTo(sx, sy + TILE_H + wallH);     // bottom extruded
    this.tileGfx.lineTo(sx + hw, sy + hh + wallH);    // right extruded
    this.tileGfx.closePath();
    this.tileGfx.fillPath();

    // Left face (slightly lighter)
    this.tileGfx.fillStyle(0x4a4a5e, 1);
    this.tileGfx.beginPath();
    this.tileGfx.moveTo(sx - hw, sy + hh);            // top-left of diamond
    this.tileGfx.lineTo(sx, sy + TILE_H);             // bottom of diamond
    this.tileGfx.lineTo(sx, sy + TILE_H + wallH);     // bottom extruded
    this.tileGfx.lineTo(sx - hw, sy + hh + wallH);    // left extruded
    this.tileGfx.closePath();
    this.tileGfx.fillPath();

    // Edge outlines
    this.tileGfx.lineStyle(1, 0x222233, 0.6);
    // Right face outline
    this.tileGfx.beginPath();
    this.tileGfx.moveTo(sx + hw, sy + hh);
    this.tileGfx.lineTo(sx + hw, sy + hh + wallH);
    this.tileGfx.lineTo(sx, sy + TILE_H + wallH);
    this.tileGfx.strokePath();
    // Left face outline
    this.tileGfx.beginPath();
    this.tileGfx.moveTo(sx - hw, sy + hh);
    this.tileGfx.lineTo(sx - hw, sy + hh + wallH);
    this.tileGfx.lineTo(sx, sy + TILE_H + wallH);
    this.tileGfx.strokePath();
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

    // First keydown detects combos for immediate response
    kb.on('keydown-W', () => this.sendMove(this.keys.D?.isDown ? 'WD' : this.keys.A?.isDown ? 'WA' : 'W'));
    kb.on('keydown-S', () => this.sendMove(this.keys.D?.isDown ? 'SD' : this.keys.A?.isDown ? 'SA' : 'S'));
    kb.on('keydown-A', () => this.sendMove(this.keys.W?.isDown ? 'WA' : this.keys.S?.isDown ? 'SA' : 'A'));
    kb.on('keydown-D', () => this.sendMove(this.keys.W?.isDown ? 'WD' : this.keys.S?.isDown ? 'SD' : 'D'));
    kb.on('keydown-E', () => {
      if (this.room && this.currentPhase === RacePhase.Racing) this.room.send('usePickup');
    });
    kb.on('keydown-SPACE', () => {
      if (this.room && this.currentPhase === RacePhase.Racing) this.room.send('jump');
    });
  }

  private sendMove(direction: string): void {
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
      if (slot.sessionId) this.slotBySession.set(slot.sessionId, index);

      const av = this.avatars.get(index)!;
      const newX = slot.tileX as number;
      const newY = slot.tileY as number;
      if (newX !== av.tileX || newY !== av.tileY) {
        av.lastTileChange = performance.now();
      }
      av.tileX = newX;
      av.tileY = newY;
      if (isNew) {
        av.displayX = newX;
        av.displayY = newY;
      }
      av.playerName = slot.playerName ?? '';

      // Detect hole fall (frozen transition) for sound/particles
      const newFrozen = slot.frozen ?? false;
      if (newFrozen && !av.frozen && slot.sessionId === this.mySessionId) {
        this.sfxHoleFall();
        this.emitAtPlayer(0xff2222, 15);
      }
      av.frozen = newFrozen;
      av.penalized = slot.penalized ?? false;
      av.currentTerrain = slot.currentTerrain ?? Terrain.Normal;
      av.heldPickup = slot.heldPickup ?? null;
      av.shieldActive = slot.shieldActive ?? false;
      av.speedBoosted = slot.speedBoosted ?? false;
      av.stuck = slot.stuck ?? false;
      av.knockbackSlowed = slot.knockbackSlowed ?? false;
      av.stamina = slot.stamina ?? STAMINA_MAX;
      av.sprinting = slot.sprinting ?? false;
      av.immune = slot.immune ?? false;

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
      stamina: STAMINA_MAX, sprinting: false, immune: false, lastTileChange: 0, jumpOffset: 0,
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

    // Sprite origin per character type — jumpOffset lifts sprite during jump
    const charDef = SLOT_CHARACTERS[av.slotIndex % SLOT_CHARACTERS.length].char;
    av.sprite.setOrigin(charDef.originX, charDef.originY);
    av.sprite.setPosition(sx, sy + av.jumpOffset);
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
      // Animation speed: faster when sprinting, slower on slow tiles
      if (av.sprinting || av.speedBoosted) {
        av.sprite.anims.timeScale = 2.0;
      } else if (av.currentTerrain === Terrain.Slow) {
        av.sprite.anims.timeScale = 0.5;
      } else {
        av.sprite.anims.timeScale = 1.0;
      }
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
    if (av.immune)           return { text: 'IMMUNE',  color: '#ffffff' };
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

  private pickupSprites: Phaser.GameObjects.Image[] = [];

  /** Render a pulsing glow under each uncollected pickup. */
  private renderPickupGlow(time: number): void {
    this.pickupGfx.clear();
    const pulse = 0.25 + Math.sin(time / 300) * 0.15; // alpha oscillates 0.10–0.40

    for (const p of this.pickups) {
      if (this.collectedPickupIds.has(p.id)) continue;
      const { x, y } = tileToScreen(p.x, p.y);
      const sx = this.originX + x;
      const sy = this.originY + y + TILE_H / 2;
      const color = this.PICKUP_COLORS[p.type] ?? 0xffffff;

      this.pickupGfx.fillStyle(color, pulse);
      this.pickupGfx.fillEllipse(sx, sy, 28, 14);
    }
  }

  /** Render a pulsing magenta glow under each button to signal interactivity. */
  private renderButtonGlow(time: number): void {
    this.buttonGfx.clear();
    const pulse = 0.2 + Math.sin(time / 400) * 0.15;

    for (const btn of this.buttons) {
      const { x, y } = tileToScreen(btn.x, btn.y);
      const sx = this.originX + x;
      const sy = this.originY + y + TILE_H / 2;

      this.buttonGfx.fillStyle(0xff4488, pulse);
      this.buttonGfx.fillEllipse(sx, sy, 30, 15);
    }
  }

  private renderPickups(): void {
    for (const s of this.pickupSprites) s.destroy();
    this.pickupSprites = [];
    this.pickupGfx.clear();

    const PICKUP_CRATE: Record<number, { frame: number; tint: number }> = {
      0: { frame: 0, tint: 0x44ff44 },  // Speed — green
      1: { frame: 6, tint: 0x44ffff },  // Shield — cyan
      2: { frame: 12, tint: 0xaaff00 }, // Slime — lime
      3: { frame: 18, tint: 0xff6644 }, // Knockback — red
    };

    for (const p of this.pickups) {
      if (this.collectedPickupIds.has(p.id)) continue;
      const { x, y } = tileToScreen(p.x, p.y);
      const sx = this.originX + x;
      const sy = this.originY + y;
      const cfg = PICKUP_CRATE[p.type] ?? { frame: 0, tint: 0xffffff };
      const crate = this.add.image(sx, sy, 'crate_wood', cfg.frame);
      crate.setScale(0.36);
      crate.setTint(cfg.tint);
      crate.setDepth(isoDepth(p.x, p.y) + 0.05);
      this.pickupSprites.push(crate);

      // Gentle floating bob animation
      this.tweens.add({
        targets: crate,
        y: sy - 4,
        duration: 800,
        yoyo: true,
        repeat: -1,
        ease: 'Sine.easeInOut',
      });
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
    // Dynamic WebSocket URL — works on localhost, LAN, tunnels, and production
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    const port = window.location.port || (protocol === 'wss:' ? '443' : '80');
    // In dev mode (Vite on 8080/5173), connect to server on 3000. In prod, same port.
    const wsPort = (port === '8080' || port === '5173') ? '3000' : port;
    const wsUrl = `${protocol}//${host}:${wsPort}`;
    const client = new Client(wsUrl);
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
        this.sfxRaceStart();
      }
      if (data.phase === RacePhase.Countdown && data.countdown > 0 && data.countdown <= 3) {
        this.sfxCountdownBeep();
      }
      this.updatePhaseHud(data.phase, data.countdown, data.finishCountdown);
      data.slots.forEach((slot, index) => this.handleSlotChange(slot, index));

      // Phase transitions that trigger UI reset
      if ((data.phase === RacePhase.Waiting || data.phase === RacePhase.Countdown) && prevPhase === RacePhase.Finished) {
        this.handleRaceReset();
      }
    });

    room.onMessage('terrainChange', (data: { tileX: number; tileY: number; terrain: number }) => {
      this.localTerrain[data.tileY][data.tileX] = data.terrain;
      this.renderAllTiles();
      this.renderMinimap();
    });

    room.onMessage('terrainChangeBatch', (changes: { tileX: number; tileY: number; terrain: number }[]) => {
      for (const c of changes) {
        this.localTerrain[c.tileY][c.tileX] = c.terrain;
      }
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

      // Force-snap ALL avatars after a short delay
      // (ensures the state message with spawn positions has been processed)
      setTimeout(() => {
        for (const av of this.avatars.values()) {
          av.displayX = av.tileX;
          av.displayY = av.tileY;
        }
        this.handleRaceReset();
      }, 100);
    });

    room.onMessage('playerFinished', (data: { playerName: string; position: number; timeSeconds: number }) => {
      this.showAnnouncement(`#${data.position} ${data.playerName} finished in ${data.timeSeconds.toFixed(2)}s!`);
      this.sfxFinish();
    });

    room.onMessage('raceResults', (data: { results: RaceResult[] }) => {
      this.showResults(data.results);
    });

    room.onMessage('crumbleWarning', (data: { tileX: number; tileY: number }) => {
      this.crumbleWarnings.set(`${data.tileX},${data.tileY}`, performance.now());
      this.sfxCrumble();
      this.emitAtTile(data.tileX, data.tileY, 0xc4824a, 6);
    });

    room.onMessage('pickupCollected', (data: { id: number; sessionId: string }) => {
      this.collectedPickupIds.add(data.id);
      this.renderPickups();
      if (data.sessionId === this.mySessionId) {
        this.sfxPickupCollect();
        this.emitAtPlayer(0x44ff44, 8);
      }
    });

    room.onMessage('slimePlaced', (data: { x: number; y: number; size: number }) => {
      this.slimeZones.push({ x: data.x, y: data.y, size: data.size });
      this.renderSlimeZones();
      this.sfxSlime();
      this.emitAtTile(data.x + 1, data.y + 1, 0xaaff00, 15);
    });
    room.onMessage('slimeExpired', (data: { x: number; y: number }) => {
      this.slimeZones = this.slimeZones.filter(z => z.x !== data.x || z.y !== data.y);
      this.renderSlimeZones();
    });

    room.onMessage('pickupUsed', (data: { sessionId: string; type: number }) => {
      if (data.sessionId === this.mySessionId) {
        this.sfxPickupUse();
        this.emitAtPlayer(0xffd700, 10);
      }
    });
    room.onMessage('shieldUsed', (data: { sessionId: string }) => {
      if (data.sessionId === this.mySessionId) {
        this.playTone(300, 0.15, 'sine', 0.1);
        this.emitAtPlayer(0x44ffff, 15);
      }
    });
    room.onMessage('playerStuck', (data: { sessionId: string }) => {
      if (data.sessionId === this.mySessionId) {
        this.sfxSlime();
        this.emitAtPlayer(0xaaff00, 8);
      }
    });
    room.onMessage('playerPushed', (data: { sessionId: string }) => {
      // Small bump effect on pushed player
      const pushSlot = this.slotBySession.get(data.sessionId);
      if (pushSlot !== undefined) {
        const av = this.avatars.get(pushSlot);
        if (av) this.emitParticles(av.sprite.x, av.sprite.y, 0xffaa44, 6, 40);
      }
      if (data.sessionId === this.mySessionId) this.playTone(250, 0.08, 'square', 0.06);
    });

    room.onMessage('knockbackBlast', (data: { x: number; y: number }) => {
      this.sfxKnockback();
      const { x, y } = tileToScreen(data.x, data.y);
      const wx = this.originX + x;
      const wy = this.originY + y + TILE_H / 2;
      // Expanding ring effect
      const ring = this.add.graphics().setDepth(10000);
      let radius = 10;
      const expandTimer = this.time.addEvent({
        delay: 16,
        repeat: 20,
        callback: () => {
          ring.clear();
          radius += 8;
          const alpha = 1 - (radius / 180);
          ring.lineStyle(3, 0xff6644, Math.max(0, alpha));
          ring.strokeCircle(wx, wy, radius);
        },
      });
      this.time.delayedCall(400, () => { ring.destroy(); });
    });

    room.onMessage('playerJumped', (data: { sessionId: string }) => {
      if (data.sessionId === this.mySessionId) this.sfxJump();
      const jumpSlot = this.slotBySession.get(data.sessionId);
      if (jumpSlot !== undefined) {
        const av = this.avatars.get(jumpSlot);
        if (av) {
          // Animate jumpOffset: 0 → -16 → 0 (smooth arc applied on top of normal position)
          av.jumpOffset = 0;
          this.tweens.add({
            targets: av,
            jumpOffset: -16,
            duration: 180,
            yoyo: true,
            ease: 'Quad.easeOut',
          });
        }
      }
    });
    room.onMessage('buttonActivated', (data: { id: number }) => {
      this.sfxButtonPress();
      const btn = this.buttons.find(b => b.id === data.id);
      if (btn) this.emitAtTile(btn.x, btn.y, 0xdd3388, 12);
    });
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

    // Force all avatars back to spawn area (server also resets positions)
    for (const av of this.avatars.values()) {
      av.displayX = av.tileX;
      av.displayY = av.tileY;
      // Force position update immediately
      this.positionAvatar(av);
    }
  }

  // ─── HUD ───────────────────────────────────────────────────────────────

  private addHud(): void {
    this.add
      .text(10, 10, 'WASD · SHIFT sprint · SPACE jump · E pickup', {
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

  // ─── Particles ─────────────────────────────────────────────────────────

  /** Emit a burst of colored particles at a world position. */
  private emitParticles(wx: number, wy: number, color: number, count = 10, speed = 60): void {
    const emitter = this.add.particles(wx, wy, 'particle', {
      speed: { min: speed / 2, max: speed },
      scale: { start: 0.8, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: 400,
      tint: color,
      quantity: count,
      emitting: false,
    });
    emitter.setDepth(10000);
    emitter.explode(count);
    this.time.delayedCall(600, () => emitter.destroy());
  }

  /** Emit particles at a tile position. */
  private emitAtTile(tx: number, ty: number, color: number, count = 10): void {
    const { x, y } = tileToScreen(tx, ty);
    this.emitParticles(this.originX + x, this.originY + y + TILE_H / 2, color, count);
  }

  /** Emit particles at the local player's position. */
  private emitAtPlayer(color: number, count = 12): void {
    const av = this.avatars.get(this.mySlotIndex);
    if (!av) return;
    const { x, y } = tileToScreen(av.displayX, av.displayY);
    this.emitParticles(this.originX + x, this.originY + y + TILE_H / 2, color, count);
  }

  // ─── Sound (Web Audio API) ────────────────────────────────────────────

  private getAudioCtx(): AudioContext {
    if (!this.audioCtx) this.audioCtx = new AudioContext();
    return this.audioCtx;
  }

  /** Play a simple tone. */
  private playTone(freq: number, duration: number, type: OscillatorType = 'square', volume = 0.1): void {
    try {
      const ctx = this.getAudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = type;
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + duration);
    } catch { /* ignore audio errors */ }
  }

  /** Play a noise burst (for impacts, crumble). */
  private playNoise(duration: number, volume = 0.08): void {
    try {
      const ctx = this.getAudioCtx();
      const bufferSize = Math.floor(ctx.sampleRate * duration);
      const buffer = ctx.createBuffer(1, bufferSize, ctx.sampleRate);
      const data = buffer.getChannelData(0);
      for (let i = 0; i < bufferSize; i++) data[i] = Math.random() * 2 - 1;
      const source = ctx.createBufferSource();
      source.buffer = buffer;
      const gain = ctx.createGain();
      gain.gain.setValueAtTime(volume, ctx.currentTime);
      gain.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + duration);
      source.connect(gain);
      gain.connect(ctx.destination);
      source.start();
    } catch { /* ignore */ }
  }

  private sfxPickupCollect(): void   { this.playTone(880, 0.1, 'sine', 0.12); this.playTone(1100, 0.1, 'sine', 0.08); }
  private sfxPickupUse(): void       { this.playTone(660, 0.15, 'square', 0.08); this.playTone(880, 0.12, 'square', 0.06); }
  private sfxHoleFall(): void        { this.playTone(200, 0.3, 'sawtooth', 0.1); this.playTone(100, 0.4, 'sawtooth', 0.08); }
  private sfxButtonPress(): void     { this.playTone(440, 0.08, 'square', 0.1); this.playTone(550, 0.08, 'square', 0.08); }
  private sfxCountdownBeep(): void   { this.playTone(600, 0.15, 'sine', 0.12); }
  private sfxRaceStart(): void       { this.playTone(800, 0.1, 'sine', 0.15); this.playTone(1000, 0.15, 'sine', 0.12); this.playTone(1200, 0.2, 'sine', 0.1); }
  private sfxFinish(): void          { this.playTone(523, 0.15, 'sine', 0.12); this.playTone(659, 0.15, 'sine', 0.1); this.playTone(784, 0.2, 'sine', 0.12); this.playTone(1047, 0.3, 'sine', 0.1); }
  private sfxCrumble(): void         { this.playNoise(0.2, 0.06); }
  private sfxJump(): void            { this.playTone(300, 0.05, 'sine', 0.08); this.playTone(500, 0.1, 'sine', 0.06); }
  private sfxSlime(): void           { this.playTone(150, 0.2, 'sawtooth', 0.06); }
  private sfxKnockback(): void       { this.playNoise(0.15, 0.1); this.playTone(200, 0.1, 'square', 0.08); }

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
