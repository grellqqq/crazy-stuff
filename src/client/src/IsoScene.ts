import Phaser from 'phaser';

// ─── Tile constants (GDD spec: design/gdd/crazy-stuff-gdd.md) ─────────────────

/** Tile width in pixels (isometric diamond width). */
export const TILE_W = 32;
/** Tile height in pixels (isometric diamond height). */
export const TILE_H = 16;

const GRID_COLS = 15;
const GRID_ROWS = 15;

const TILE_OUTLINE = 0x000000;
const ORIGIN_COLOR = 0xff6b6b; // red — marks tile (0,0)

// ─── Terrain system (visual only — game logic wired in a later sprint) ─────────

/**
 * Terrain type identifiers. Values are stable — the server will import this
 * module when terrain effects are implemented.
 */
export const Terrain = {
  Normal:  0,
  Slow:    1,
  Slide:   2,
  Crumble: 3,
  Boost:   4,
  Hole:    5,
} as const;

/**
 * Primary and secondary fill colours [A, B] for the checkerboard shading.
 * Indexed by Terrain value. A = even (tx+ty), B = odd.
 */
const TERRAIN_COLORS: [number, number][] = [
  [0x4a7c59, 0x3d6649], // Normal  — muted green
  [0x7a6030, 0x6a5228], // Slow    — mud brown
  [0x88c8e8, 0x76b8d8], // Slide   — ice blue
  [0xc4824a, 0xb0723c], // Crumble — sandy orange
  [0xd4b800, 0xc0a600], // Boost   — gold
  [0x111820, 0x0c1018], // Hole    — near-black void
];

/**
 * Hardcoded race track. Indexed [tileY][tileX].
 * Race flows top-to-bottom: tileX+tileY increases toward the finish.
 *
 *  0 Normal · 1 Slow · 2 Slide · 3 Crumble · 4 Boost · 5 Hole
 */
export const TERRAIN_MAP: number[][] = [
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // row  0 ── START
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // row  1
  [0,0,1,1,0,0,0,0,0,0,1,1,0,0,0], // row  2 ── slow mud flanks centre lane
  [0,0,1,1,1,0,0,0,0,1,1,1,0,0,0], // row  3
  [0,0,0,0,0,4,4,4,4,0,0,0,0,0,0], // row  4 ── first boost corridor
  [0,0,0,0,4,4,0,0,4,4,0,0,0,0,0], // row  5
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // row  6 ── breather
  [0,0,0,2,2,2,2,2,2,2,2,0,0,0,0], // row  7 ── ice / slide zone begins
  [0,0,2,2,2,2,2,2,2,2,2,2,0,0,0], // row  8
  [0,0,2,2,4,2,2,2,2,4,2,2,0,0,0], // row  9 ── boost pads hidden inside ice
  [0,0,0,3,3,3,5,5,3,3,3,0,0,0,0], // row 10 ── crumble bridge with hole pits
  [0,0,3,3,3,3,5,5,3,3,3,3,0,0,0], // row 11
  [0,0,0,3,0,3,0,3,0,3,0,0,0,0,0], // row 12 ── crumble / normal gaps — pick your path
  [0,0,0,0,4,4,4,4,4,4,0,0,0,0,0], // row 13 ── final boost dash
  [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0], // row 14 ── FINISH
];

/** Color assigned to each player slot index. Slot 0 = orange (first joiner). */
const SLOT_COLORS = [0xff8c00, 0x4488ff, 0x44bb44, 0xee44ee, 0xffdd44];

// ─── Reusable isometric math ──────────────────────────────────────────────────

/**
 * Convert isometric tile coordinates to screen pixel offset from the grid origin.
 * Add the scene's originX/Y to get canvas coordinates.
 */
export function tileToScreen(tileX: number, tileY: number): { x: number; y: number } {
  return {
    x: (tileX - tileY) * (TILE_W / 2),
    y: (tileX + tileY) * (TILE_H / 2),
  };
}

/**
 * Isometric depth sort value.
 * Call `gameObject.setDepth(isoDepth(tileX, tileY))` on every object that
 * participates in Y-sort. Single source of truth — never compute depth inline.
 */
export function isoDepth(tileX: number, tileY: number): number {
  return tileX + tileY;
}

// ─── Object records ───────────────────────────────────────────────────────────

interface SortableObject {
  obj: Phaser.GameObjects.GameObject & { setDepth(depth: number): unknown };
  tileX: number;
  tileY: number;
}

interface AvatarGraphics {
  body: Phaser.GameObjects.Graphics;
  hat: Phaser.GameObjects.Graphics;
  label: Phaser.GameObjects.Text;
  tileX: number;
  tileY: number;
  slotIndex: number;
}

// ─── Scene ────────────────────────────────────────────────────────────────────

export class IsoScene extends Phaser.Scene {
  /** Canvas X of tile (0,0). Set in create(). */
  private originX = 0;
  /** Canvas Y of tile (0,0). Set in create(). */
  private originY = 0;

  /** Static demo blocks that participate in the Y-sort pass. */
  private sortables: SortableObject[] = [];

  /** Colyseus session ID assigned on room join. */
  private mySessionId = '';
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private room: any = null;

  /** Facing direction for local player — updated on keypress for arrow drawing. */
  private playerFacing: 'W' | 'A' | 'S' | 'D' = 'S';
  private hatEquipped = true;

  /** All networked player avatars, keyed by slot index (stable across occupant changes). */
  private avatars = new Map<number, AvatarGraphics>();
  /** Slot index of the local player. Set when onAdd fires for our sessionId. */
  private mySlotIndex = -1;

  constructor() {
    super({ key: 'IsoScene' });
  }

  create(): void {
    const { width, height } = this.scale;

    const gridH = (GRID_COLS - 1 + GRID_ROWS - 1) * (TILE_H / 2) + TILE_H;
    this.originX = width / 2;
    this.originY = (height - gridH) / 2;

    this.drawTileGrid();
    this.placeOriginMarker();
    this.addDepthSortDemo();
    this.setupInput();
    this.addHud();
    this.connectToRace().catch(console.error);
  }

  /**
   * Y-sort pass — called every frame.
   * Re-applies isoDepth() to every registered sortable and all network avatars
   * so moving objects always sort correctly without per-system depth logic.
   */
  update(): void {
    for (const { obj, tileX, tileY } of this.sortables) {
      obj.setDepth(isoDepth(tileX, tileY));
    }
    for (const av of this.avatars.values()) {
      const depth = isoDepth(av.tileX, av.tileY);
      av.body.setDepth(depth);
      av.hat.setDepth(depth + 0.05);
      av.label.setDepth(depth + 0.1);
    }
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Draw the full GRID_COLS × GRID_ROWS tile floor using Phaser Graphics. */
  private drawTileGrid(): void {
    const gfx = this.add.graphics();

    for (let ty = 0; ty < GRID_ROWS; ty++) {
      for (let tx = 0; tx < GRID_COLS; tx++) {
        const terrain = TERRAIN_MAP[ty][tx] ?? Terrain.Normal;
        const [colorA, colorB] = TERRAIN_COLORS[terrain];
        const fill = (tx + ty) % 2 === 0 ? colorA : colorB;

        const { x, y } = tileToScreen(tx, ty);
        const sx = this.originX + x;
        const sy = this.originY + y;
        const pts = this.rhombusPoints(sx, sy);

        gfx.fillStyle(fill, 1);
        gfx.fillPoints(pts, true);

        gfx.lineStyle(1, TILE_OUTLINE, 0.12);
        gfx.strokePoints(pts, true);
      }
    }

    gfx.setDepth(-1);
  }

  /** Highlight tile (0,0) in red so the grid origin is immediately identifiable. */
  private placeOriginMarker(): void {
    const { x, y } = tileToScreen(0, 0);
    const sx = this.originX + x;
    const sy = this.originY + y;

    const marker = this.add.graphics();
    marker.fillStyle(ORIGIN_COLOR, 1);
    marker.fillPoints(this.rhombusPoints(sx, sy), true);
    marker.setDepth(isoDepth(0, 0));

    this.add
      .text(sx, sy - 4, '(0,0)', { fontSize: '9px', color: '#ffffff' })
      .setOrigin(0.5, 1)
      .setDepth(isoDepth(0, 0) + 0.1);
  }

  /**
   * Place two colored blocks at different tile positions so the depth sort is
   * visually verifiable without needing networked players.
   */
  private addDepthSortDemo(): void {
    const blockA = this.makeBlock(6, 6, 0x4488ff, 'A');
    const blockB = this.makeBlock(8, 8, 0xffdd44, 'B');
    this.sortables.push(blockA, blockB);
  }

  /** Create a coloured rectangle standing on a tile and register it for Y-sort. */
  private makeBlock(
    tileX: number,
    tileY: number,
    color: number,
    label: string,
  ): SortableObject {
    const { x, y } = tileToScreen(tileX, tileY);
    const sx = this.originX + x;
    const sy = this.originY + y;

    const blockW = 20;
    const blockH = 24;
    const bx = sx;
    const by = sy + TILE_H;

    const gfx = this.add.graphics();
    gfx.fillStyle(color, 1);
    gfx.fillRect(bx - blockW / 2, by - blockH, blockW, blockH);
    gfx.setDepth(isoDepth(tileX, tileY));

    this.add
      .text(bx, by - blockH - 2, label, { fontSize: '10px', color: '#ffffff' })
      .setOrigin(0.5, 1)
      .setDepth(isoDepth(tileX, tileY) + 0.1);

    return { obj: gfx, tileX, tileY };
  }

  /**
   * Wire WASD keys to send move messages to the server.
   * Server is authoritative — no local position update, we wait for state broadcast.
   */
  private setupInput(): void {
    const kb = this.input.keyboard!;
    kb.on('keydown-W', () => { console.log('[input] keydown W'); this.sendMove('W'); });
    kb.on('keydown-S', () => { console.log('[input] keydown S'); this.sendMove('S'); });
    kb.on('keydown-A', () => { console.log('[input] keydown A'); this.sendMove('A'); });
    kb.on('keydown-D', () => { console.log('[input] keydown D'); this.sendMove('D'); });
    kb.on('keydown-H', () => {
      this.hatEquipped = !this.hatEquipped;
      // Immediately redraw local avatar for hat toggle — cosmetic-only, not synced
      const av = this.avatars.get(this.mySlotIndex);
      if (av) this.drawAvatarAt(av, av.tileX, av.tileY, true);
    });
  }

  /**
   * Send a move direction to the server. Update facing immediately for
   * responsive arrow visual, but do not update tile position locally.
   */
  private sendMove(direction: 'W' | 'A' | 'S' | 'D'): void {
    console.log('[sendMove]', direction, 'room:', !!this.room);
    this.playerFacing = direction;
    if (this.room) {
      this.room.send('move', direction);
    }
  }

  /**
   * Called by onAdd (initial state) and slot.onChange (any property change).
   * Creates, updates, or destroys the avatar for this slot based on slot.occupied.
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private handleSlotChange(slot: any, index: number): void {
    if (slot.occupied) {
      if (!this.avatars.has(index)) {
        this.avatars.set(index, this.createAvatar(index));
      }
      if (slot.sessionId === this.mySessionId) {
        this.mySlotIndex = index;
      }
      const av = this.avatars.get(index)!;
      av.tileX = slot.tileX as number;
      av.tileY = slot.tileY as number;
      this.drawAvatarAt(av, av.tileX, av.tileY, slot.sessionId === this.mySessionId);
    } else {
      const av = this.avatars.get(index);
      if (av) {
        av.body.destroy();
        av.hat.destroy();
        av.label.destroy();
        this.avatars.delete(index);
      }
    }
  }

  private createAvatar(slotIndex: number): AvatarGraphics {
    return {
      body: this.add.graphics(),
      hat: this.add.graphics(),
      label: this.add.text(0, 0, '', { fontSize: '10px', color: '#ffffff' }).setOrigin(0.5, 1),
      tileX: 7,
      tileY: 7,
      slotIndex,
    };
  }

  /**
   * Clear and redraw an avatar at the given tile position.
   * Local player gets a direction arrow and optional hat; remote players are plain.
   */
  private drawAvatarAt(
    av: AvatarGraphics,
    tileX: number,
    tileY: number,
    isLocal: boolean,
  ): void {
    const { x, y } = tileToScreen(tileX, tileY);
    const sx = this.originX + x;
    const sy = this.originY + y;

    const blockW = 20;
    const blockH = 28;
    const bx = sx;
    const by = sy + TILE_H; // bottom edge at tile's bottom vertex

    av.body.clear();
    const color = SLOT_COLORS[av.slotIndex % SLOT_COLORS.length];
    av.body.fillStyle(color, 1);
    av.body.fillRect(bx - blockW / 2, by - blockH, blockW, blockH);

    // Direction arrow on local player only
    if (isLocal) {
      const cx = bx;
      const cy = by - blockH / 2;
      const ar = 5;
      av.body.fillStyle(0x000000, 0.65);
      switch (this.playerFacing) {
        case 'W':
          av.body.fillTriangle(cx, cy - ar, cx - ar, cy + ar, cx + ar, cy + ar);
          break;
        case 'S':
          av.body.fillTriangle(cx, cy + ar, cx - ar, cy - ar, cx + ar, cy - ar);
          break;
        case 'A':
          av.body.fillTriangle(cx - ar, cy, cx + ar, cy - ar, cx + ar, cy + ar);
          break;
        case 'D':
          av.body.fillTriangle(cx + ar, cy, cx - ar, cy - ar, cx - ar, cy + ar);
          break;
      }
    }

    av.label.setPosition(bx, by - blockH - 2).setText(`(${tileX},${tileY})`);

    // Hat layer — local player only, toggleable with H key (not synced to server)
    av.hat.clear();
    if (isLocal && this.hatEquipped) {
      const hatW = 18;
      const crownH = 6;
      const brimH = 3;
      const hatTop = by - blockH - crownH - brimH;
      av.hat.fillStyle(0x9b59b6, 1); // purple
      av.hat.fillRect(bx - hatW / 2 + 2, hatTop, hatW - 4, crownH);
      av.hat.fillRect(bx - hatW / 2, hatTop + crownH, hatW, brimH);
    }
  }

  /** Connect to Colyseus RaceRoom and receive state via plain JSON messages. */
  private async connectToRace(): Promise<void> {
    const { Client } = await import('colyseus.js');
    const client = new Client('ws://localhost:3000');
    const room = await client.joinOrCreate('race', { playerName: 'Player' });
    this.room = room;
    this.mySessionId = room.sessionId;

    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    room.onMessage('state', (data: { slots: any[] }) => {
      data.slots.forEach((slot, index) => this.handleSlotChange(slot, index));
    });

    console.log('[IsoScene] connected to RaceRoom:', this.mySessionId);
  }

  /** Fixed HUD — confirms milestone at a glance. */
  private addHud(): void {
    this.add
      .text(8, 8, 'S1-08 ✓  Terrain: green=Normal · brown=Slow · blue=Ice · orange=Crumble · gold=Boost · black=Hole', {
        fontSize: '13px',
        color: '#aabbcc',
        backgroundColor: '#00000055',
        padding: { x: 6, y: 3 },
      })
      .setScrollFactor(0)
      .setDepth(9999);
  }

  /** Four corners of an isometric diamond tile in screen space. */
  private rhombusPoints(sx: number, sy: number): Array<{ x: number; y: number }> {
    return [
      { x: sx, y: sy },                           // top
      { x: sx + TILE_W / 2, y: sy + TILE_H / 2 }, // right
      { x: sx, y: sy + TILE_H },                  // bottom
      { x: sx - TILE_W / 2, y: sy + TILE_H / 2 }, // left
    ];
  }
}
