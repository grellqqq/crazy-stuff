import Phaser from 'phaser';

// ─── Tile constants (GDD spec: design/gdd/crazy-stuff-gdd.md) ─────────────────

/** Tile width in pixels (isometric diamond width). */
export const TILE_W = 32;
/** Tile height in pixels (isometric diamond height). */
export const TILE_H = 16;

const GRID_COLS = 15;
const GRID_ROWS = 15;

const TILE_COLOR_A = 0x4a7c59; // muted green
const TILE_COLOR_B = 0x3d6649; // slightly darker green
const TILE_OUTLINE = 0x000000;
const ORIGIN_COLOR = 0xff6b6b; // red — marks tile (0,0)

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
 * Higher value = rendered in front of lower values.
 *
 * Call `gameObject.setDepth(isoDepth(tileX, tileY))` on every object that
 * participates in Y-sort. This function is the single source of truth —
 * never compute depth inline.
 */
export function isoDepth(tileX: number, tileY: number): number {
  return tileX + tileY;
}

// ─── Sortable object record ───────────────────────────────────────────────────

interface SortableObject {
  obj: Phaser.GameObjects.GameObject & { setDepth(depth: number): unknown };
  tileX: number;
  tileY: number;
}

// ─── Scene ────────────────────────────────────────────────────────────────────

export class IsoScene extends Phaser.Scene {
  /** Canvas X of tile (0,0). Set in create(). */
  private originX = 0;
  /** Canvas Y of tile (0,0). Set in create(). */
  private originY = 0;

  /** All objects that participate in the Y-sort pass every frame. */
  private sortables: SortableObject[] = [];

  /** Player tile position — integers, updated on each move. */
  private playerTileX = 7;
  private playerTileY = 7;
  /** Direction the player is facing, shown as an arrow on the block. */
  private playerFacing: 'W' | 'A' | 'S' | 'D' = 'S';
  private playerGfx!: Phaser.GameObjects.Graphics;
  /** Second sprite layer — hat. Separate Graphics so it depth-sorts above the body. */
  private hatGfx!: Phaser.GameObjects.Graphics;
  /** Whether the hat is currently equipped. Toggled with H. */
  private hatEquipped = true;
  private playerCoordLabel!: Phaser.GameObjects.Text;

  constructor() {
    super({ key: 'IsoScene' });
  }

  create(): void {
    const { width, height } = this.scale;

    // Grid screen extents:
    //   X spans: -(GRID_COLS-1)*TILE_W/2  …  +(GRID_ROWS-1)*TILE_W/2
    //   Y spans: 0  …  (GRID_COLS-1 + GRID_ROWS-1)*TILE_H/2 + TILE_H
    const gridH = (GRID_COLS - 1 + GRID_ROWS - 1) * (TILE_H / 2) + TILE_H;
    this.originX = width / 2;
    this.originY = (height - gridH) / 2;

    this.drawTileGrid();
    this.placeOriginMarker();
    this.addDepthSortDemo();
    this.addPlayer();
    this.setupInput();
    this.addHud();
    this.connectToLobby().catch(console.error);
  }

  /**
   * Y-sort pass — called every frame.
   * Re-applies isoDepth() to every registered sortable so moving objects always
   * sort correctly without per-system depth logic.
   */
  update(): void {
    for (const { obj, tileX, tileY } of this.sortables) {
      obj.setDepth(isoDepth(tileX, tileY));
    }
    const depth = isoDepth(this.playerTileX, this.playerTileY);
    this.playerGfx.setDepth(depth);
    this.hatGfx.setDepth(depth + 0.05);
    this.playerCoordLabel
      .setDepth(depth + 0.1)
      .setText(`(${this.playerTileX},${this.playerTileY})`);
  }

  // ─── Private helpers ───────────────────────────────────────────────────────

  /** Draw the full GRID_COLS × GRID_ROWS tile floor using Phaser Graphics. */
  private drawTileGrid(): void {
    const gfx = this.add.graphics();

    for (let ty = 0; ty < GRID_ROWS; ty++) {
      for (let tx = 0; tx < GRID_COLS; tx++) {
        const { x, y } = tileToScreen(tx, ty);
        const sx = this.originX + x;
        const sy = this.originY + y;
        const fill = (tx + ty) % 2 === 0 ? TILE_COLOR_A : TILE_COLOR_B;

        const pts = this.rhombusPoints(sx, sy);

        gfx.fillStyle(fill, 1);
        gfx.fillPoints(pts, true);

        gfx.lineStyle(1, TILE_OUTLINE, 0.12);
        gfx.strokePoints(pts, true);
      }
    }

    // Tiles are always below every game object
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
   * visually verifiable.
   *
   *   Block A → tile (6,6) → depth 12   (behind player)
   *   Block B → tile (8,8) → depth 16   (in front of player)
   *   Player  → tile (7,7) → depth 14   (between A and B)
   *
   * All three share the same screen X (tx === ty) and are 16px apart in screen Y,
   * so they overlap in a chain and the depth sort result is obvious.
   */
  private addDepthSortDemo(): void {
    const blockA = this.makeBlock(6, 6, 0x4488ff, 'A');
    const blockB = this.makeBlock(8, 8, 0xffdd44, 'B');

    // Register for the per-frame sort pass
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

    // Block: 20 × 24px, bottom edge sits at the tile's bottom vertex
    const blockW = 20;
    const blockH = 24;
    const bx = sx;
    const by = sy + TILE_H; // bottom of the block = bottom vertex of the tile

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

  /** Create player graphics and label, then draw at starting tile. */
  private addPlayer(): void {
    this.playerGfx = this.add.graphics();
    this.hatGfx = this.add.graphics();
    this.playerCoordLabel = this.add
      .text(0, 0, '', { fontSize: '10px', color: '#ffffff' })
      .setOrigin(0.5, 1);
    this.redrawPlayer();
  }

  /**
   * Clear and redraw playerGfx at the current tile position with a direction
   * arrow, and reposition the coord label. Called after every move.
   *
   * Iso directions map to screen-space axes exactly:
   *   W (-1,-1) → screen up    S (+1,+1) → screen down
   *   A (-1,+1) → screen left  D (+1,-1) → screen right
   */
  private redrawPlayer(): void {
    const { x, y } = tileToScreen(this.playerTileX, this.playerTileY);
    const sx = this.originX + x;
    const sy = this.originY + y;

    const blockW = 20;
    const blockH = 28;
    const bx = sx;
    const by = sy + TILE_H; // bottom edge at tile's bottom vertex

    this.playerGfx.clear();

    // Body
    this.playerGfx.fillStyle(0xff8c00, 1); // orange
    this.playerGfx.fillRect(bx - blockW / 2, by - blockH, blockW, blockH);

    // Direction arrow — small dark triangle on the block face
    const cx = bx;
    const cy = by - blockH / 2; // vertical center of block
    const ar = 5; // arrow half-size in px
    this.playerGfx.fillStyle(0x000000, 0.65);
    switch (this.playerFacing) {
      case 'W': // up
        this.playerGfx.fillTriangle(cx, cy - ar, cx - ar, cy + ar, cx + ar, cy + ar);
        break;
      case 'S': // down
        this.playerGfx.fillTriangle(cx, cy + ar, cx - ar, cy - ar, cx + ar, cy - ar);
        break;
      case 'A': // left
        this.playerGfx.fillTriangle(cx - ar, cy, cx + ar, cy - ar, cx + ar, cy + ar);
        break;
      case 'D': // right
        this.playerGfx.fillTriangle(cx + ar, cy, cx - ar, cy - ar, cx - ar, cy + ar);
        break;
    }

    this.playerCoordLabel.setPosition(bx, by - blockH - 2);

    // Hat layer — drawn on separate Graphics so depth can be set between body and label
    this.hatGfx.clear();
    if (this.hatEquipped) {
      const hatW = 18;
      const crownH = 6;
      const brimH = 3;
      const hatTop = by - blockH - crownH - brimH;
      this.hatGfx.fillStyle(0x9b59b6, 1); // purple
      // Crown
      this.hatGfx.fillRect(bx - hatW / 2 + 2, hatTop, hatW - 4, crownH);
      // Brim (wider, at the base of the crown)
      this.hatGfx.fillRect(bx - hatW / 2, hatTop + crownH, hatW, brimH);
    }
  }

  /**
   * Wire WASD keys to one-tile isometric movement.
   * One keypress = one tile. Bounds-clamped to 0–(GRID_SIZE-1).
   */
  private setupInput(): void {
    const kb = this.input.keyboard!;
    kb.on('keydown-W', () => this.tryMove(-1, -1, 'W'));
    kb.on('keydown-S', () => this.tryMove(1, 1, 'S'));
    kb.on('keydown-A', () => this.tryMove(-1, 1, 'A'));
    kb.on('keydown-D', () => this.tryMove(1, -1, 'D'));
    kb.on('keydown-H', () => { this.hatEquipped = !this.hatEquipped; this.redrawPlayer(); });
  }

  /** Attempt to move by (dtx, dty). Clamps to grid; always updates facing. */
  private tryMove(dtx: number, dty: number, facing: 'W' | 'A' | 'S' | 'D'): void {
    this.playerFacing = facing;
    this.playerTileX = Phaser.Math.Clamp(this.playerTileX + dtx, 0, GRID_COLS - 1);
    this.playerTileY = Phaser.Math.Clamp(this.playerTileY + dty, 0, GRID_ROWS - 1);
    this.redrawPlayer();
  }

  /** Connect to Colyseus LobbyRoom on startup. */
  private async connectToLobby(): Promise<void> {
    const { Client } = await import('colyseus.js');
    const client = new Client('ws://localhost:3000');
    await client.joinOrCreate('lobby');
    console.log('[S1-06] connected to lobby');
  }

  /** Fixed HUD line — confirms milestone and tile spec at a glance. */
  private addHud(): void {
    this.add
      .text(8, 8, 'S1-06 ✓  WASD to move · H=hat · depth-sorted · Colyseus connected', {
        fontSize: '13px',
        color: '#aabbcc',
        backgroundColor: '#00000055',
        padding: { x: 6, y: 3 },
      })
      .setScrollFactor(0)
      .setDepth(9999);
  }

  /** Four corners of an isometric diamond tile in screen space. */
  private rhombusPoints(
    sx: number,
    sy: number,
  ): Array<{ x: number; y: number }> {
    return [
      { x: sx, y: sy },                           // top
      { x: sx + TILE_W / 2, y: sy + TILE_H / 2 }, // right
      { x: sx, y: sy + TILE_H },                  // bottom
      { x: sx - TILE_W / 2, y: sy + TILE_H / 2 }, // left
    ];
  }
}
