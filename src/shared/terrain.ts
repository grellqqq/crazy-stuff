/**
 * Shared terrain data — imported by both client and server.
 * Keep this file free of Phaser / Colyseus / Node dependencies.
 */

// ─── Race phase ──────────────────────────────────────────────────────────────

export const RacePhase = {
  Waiting:   0,
  Countdown: 1,
  Racing:    2,
  Finished:  3,
} as const;

export type RacePhaseType = (typeof RacePhase)[keyof typeof RacePhase];

// ─── Terrain types ───────────────────────────────────────────────────────────

export const Terrain = {
  Normal:  0,
  Slow:    1,
  Slide:   2,
  Crumble: 3,
  Boost:   4, // kept for index stability — no longer generated as terrain
  Hole:    5,
  Wall:    6,
  Button:  7,
} as const;

export type TerrainType = (typeof Terrain)[keyof typeof Terrain];

// ─── Interactive buttons ─────────────────────────────────────────────────────

export const ButtonType = {
  ClosePath:    0,
  OpenHole:     1,
  TriggerSlide: 2,
} as const;

export interface ButtonDef {
  id: number;
  type: number;
  x: number;
  y: number;
  targetX: number;
  targetY: number;
  targetW: number;
  targetH: number;
}

export const BUTTON_COOLDOWN_MS = 10_000;

// ─── Pickups ─────────────────────────────────────────────────────────────────

export const PickupType = {
  SpeedBoost: 0,
  Shield:     1,
  SlimeBomb:  2,
  Knockback:  3,
} as const;

export type PickupTypeValue = (typeof PickupType)[keyof typeof PickupType];

export interface PickupDef {
  id: number;
  type: number;  // PickupType value
  x: number;     // tile position
  y: number;
}

/** Speed boost: reduce cooldown to this value (ms) for the duration. */
export const PICKUP_SPEED_COOLDOWN = 60;
export const PICKUP_SPEED_DURATION = 4000;

/** Slime zone size (tiles). */
export const SLIME_SIZE = 3;
/** Duration slime persists on map (ms). */
export const SLIME_PERSIST_MS = 10_000;
/** Duration a player is stuck when stepping on slime (ms). */
export const SLIME_STUCK_MS = 2000;

/** Knockback: push radius (tiles from player center). */
export const KNOCKBACK_RADIUS = 6;
/** Knockback: push distance (tiles). */
export const KNOCKBACK_DISTANCE = 4;
/** Knockback: slow duration (ms). */
export const KNOCKBACK_SLOW_MS = 3000;
/** Knockback: slow cooldown (ms). */
export const KNOCKBACK_SLOW_CD = 400;

// ─── Sprint & stamina ────────────────────────────────────────────────────────

export const SPRINT_COOLDOWN      = 50;   // ms between moves while sprinting
export const STAMINA_MAX          = 100;
export const STAMINA_DRAIN        = 8;    // per sprint move
export const STAMINA_REGEN_RATE   = 20;   // per second when not sprinting
export const STAMINA_MIN_TO_SPRINT = 10;  // minimum stamina to start/continue sprinting

// ─── Jump ────────────────────────────────────────────────────────────────────

export const JUMP_DISTANCE        = 3;    // tiles to leap forward
export const JUMP_COOLDOWN_MS     = 1500; // ms between jumps

export const PICKUP_NAMES: Record<number, string> = {
  [PickupType.SpeedBoost]: 'SPEED',
  [PickupType.Shield]:     'SHIELD',
  [PickupType.SlimeBomb]:  'SLIME',
  [PickupType.Knockback]:  'KNOCKBACK',
};

// ─── Grid dimensions ─────────────────────────────────────────────────────────

export const GRID_COLS    = 180;
export const GRID_ROWS    = 30;
export const GRID_COL_MAX = 179;
export const GRID_ROW_MAX = 29;

/** Player occupies a single tile. */
export const FOOTPRINT = 1;

// ─── Spawn & finish ──────────────────────────────────────────────────────────

export const SPAWN_X = 2;
export const SPAWN_Y = 14;

export const FINISH_X     = 176;
export const FINISH_Y_MIN = 4;
export const FINISH_Y_MAX = 25;

// ─── Timing ──────────────────────────────────────────────────────────────────

export const MIN_PLAYERS_TO_START    = 2;
export const COUNTDOWN_SECONDS      = 3;
export const FINISH_COUNTDOWN_SECONDS = 10;
export const RESET_DELAY_MS         = 5000;

// ─── Scoring ─────────────────────────────────────────────────────────────────

export const POSITION_POINTS = [100, 75, 55, 35, 20];
export const DNF_POINTS = 5;

export const BONUS_BUTTON_ACTIVATED = 10;
export const BONUS_FAST_FINISH      = 25;
export const BONUS_GOOD_FINISH      = 10;
export const FAST_FINISH_THRESHOLD  = 120;
export const GOOD_FINISH_THRESHOLD  = 150;

export interface RaceResult {
  sessionId: string;
  playerName: string;
  position: number;
  timeSeconds: number;
  positionPoints: number;
  bonusPoints: number;
  totalScore: number;
}

// ─── Procedural terrain generation ──────────────────────────────────────────

function randomInt(min: number, max: number): number {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}

function placeOrganicBlob(
  map: number[][], terrain: number,
  xMin: number, xMax: number, yMin: number, yMax: number,
  size: number,
): void {
  const cx = randomInt(xMin, xMax);
  const cy = randomInt(yMin, yMax);
  const cells: [number, number][] = [[cx, cy]];
  const visited = new Set<string>([`${cx},${cy}`]);
  const dirs: [number, number][] = [[0, 1], [0, -1], [1, 0], [-1, 0]];

  for (let i = 0; i < size && cells.length > 0; i++) {
    const [bx, by] = cells[randomInt(0, cells.length - 1)];
    const [dx, dy] = dirs[randomInt(0, 3)];
    const nx = bx + dx;
    const ny = by + dy;
    const key = `${nx},${ny}`;
    if (nx >= xMin && nx <= xMax && ny >= yMin && ny <= yMax && !visited.has(key)) {
      cells.push([nx, ny]);
      visited.add(key);
    }
  }

  for (const [bx, by] of cells) {
    if (map[by][bx] === Terrain.Normal) map[by][bx] = terrain;
  }
}

function clearRect(
  map: number[][], xMin: number, xMax: number, yMin: number, yMax: number,
): void {
  for (let y = Math.max(0, yMin); y <= Math.min(GRID_ROW_MAX, yMax); y++) {
    for (let x = Math.max(0, xMin); x <= Math.min(GRID_COL_MAX, xMax); x++) {
      map[y][x] = Terrain.Normal;
    }
  }
}

function placeWallSegments(
  map: number[][], xMin: number, xMax: number, yMin: number, yMax: number, count: number,
): void {
  let placed = 0;
  let attempts = 0;
  while (placed < count && attempts < count * 40) {
    attempts++;
    const horizontal = Math.random() < 0.6;
    const length = randomInt(3, 6);
    if (horizontal) {
      const x = randomInt(xMin, xMax - length);
      const y = randomInt(yMin, yMax);
      for (let dx = 0; dx < length; dx++) map[y][x + dx] = Terrain.Wall;
    } else {
      const x = randomInt(xMin, xMax);
      const y = randomInt(yMin, yMax - length);
      for (let dy = 0; dy < length; dy++) map[y + dy][x] = Terrain.Wall;
    }
    placed++;
  }
}

function ensurePassable(map: number[][], trackTop: number, trackBot: number): void {
  const minGap = 3;
  for (let x = 0; x < GRID_COLS; x++) {
    let bestGapLen = 0;
    let gapStart = -1;
    let gapLen = 0;
    for (let y = trackTop; y <= trackBot; y++) {
      const blocked = map[y][x] === Terrain.Wall ||
        (x + 1 < GRID_COLS && map[y][x + 1] === Terrain.Wall);
      if (!blocked) {
        if (gapStart < 0) gapStart = y;
        gapLen++;
        if (gapLen > bestGapLen) bestGapLen = gapLen;
      } else { gapStart = -1; gapLen = 0; }
    }
    if (bestGapLen < minGap) {
      const mid = Math.floor((trackTop + trackBot) / 2);
      for (let y = mid - 1; y <= mid + 1; y++) {
        if (map[y][x] === Terrain.Wall) map[y][x] = Terrain.Normal;
        if (x + 1 < GRID_COLS && map[y][x + 1] === Terrain.Wall) map[y][x + 1] = Terrain.Normal;
      }
    }
  }
}

/**
 * Generate a fresh procedural race track (180 cols × 30 rows).
 *
 * Zone layout (by column):
 *   0-8     Start area (Normal)
 *   9-25    Mud field (Slow)
 *  26-40    Open corridor (pickups)
 *  41-70    Ice arena (Slide)
 *  71-80    Recovery
 *  81-110   Crumble bridge (Crumble + Holes)
 * 111-120   Recovery
 * 121-145   Gauntlet (mixed Slow + Crumble + Hole)
 * 146-155   Sprint corridor (pickups)
 * 156-170   Second ice section
 * 171-175   Final sprint
 * 176-179   Finish zone
 */
export function generateTerrainMap(): number[][] {
  const map: number[][] = [];
  for (let y = 0; y < GRID_ROWS; y++) {
    map[y] = new Array(GRID_COLS).fill(Terrain.Normal);
  }

  const tTop = 4;
  const tBot = 25;

  // ── Side walls with hole gaps ─────────────────────────────────────────
  // Row 3 (top border) and row 26 (bottom border) = walls
  // Rows 2 and 27 = holes (fall off the edge)
  for (let x = 0; x < GRID_COLS; x++) {
    map[3][x] = Terrain.Wall;
    map[26][x] = Terrain.Wall;
    map[2][x] = Terrain.Hole;
    map[27][x] = Terrain.Hole;
  }
  // Random gaps in the side walls (every 8-15 tiles, 2-3 tiles wide)
  for (let x = 10; x < GRID_COLS - 10; x += randomInt(8, 15)) {
    const gapW = randomInt(2, 3);
    for (let dx = 0; dx < gapW; dx++) {
      if (x + dx < GRID_COLS) {
        map[3][x + dx] = Terrain.Normal;   // gap in top wall
        map[26][x + dx] = Terrain.Normal;  // gap in bottom wall
      }
    }
  }

  // ── Zone 1: Mud field ─────────────────────────────────────────────────
  for (let i = 0; i < 15; i++) {
    placeOrganicBlob(map, Terrain.Slow, 9, 25, tTop, tBot, randomInt(5, 14));
  }

  // ── Zone 2: First ice arena ───────────────────────────────────────────
  for (let i = 0; i < 20; i++) {
    placeOrganicBlob(map, Terrain.Slide, 41, 70, tTop, tBot, randomInt(6, 16));
  }
  // Ice-to-hazard connections
  for (let y = tTop; y <= tBot; y++) {
    for (let x = 67; x <= 70; x++) {
      if (map[y][x] === Terrain.Slide && x + 1 < GRID_COLS && map[y][x + 1] === Terrain.Normal) {
        if (Math.random() < 0.2) map[y][x + 1] = Math.random() < 0.5 ? Terrain.Hole : Terrain.Crumble;
      }
    }
  }

  // ── Zone 3: Crumble bridge ────────────────────────────────────────────
  for (let i = 0; i < 20; i++) {
    placeOrganicBlob(map, Terrain.Crumble, 81, 110, tTop, tBot, randomInt(5, 14));
  }
  for (let i = 0; i < 10; i++) {
    placeOrganicBlob(map, Terrain.Hole, 86, 108, tTop + 2, tBot - 2, randomInt(2, 6));
  }

  // ── Zone 4: Gauntlet ──────────────────────────────────────────────────
  for (let i = 0; i < 10; i++) {
    placeOrganicBlob(map, Terrain.Slow, 121, 135, tTop, tBot, randomInt(4, 10));
  }
  for (let i = 0; i < 12; i++) {
    placeOrganicBlob(map, Terrain.Crumble, 128, 145, tTop, tBot, randomInt(4, 12));
  }
  for (let i = 0; i < 6; i++) {
    placeOrganicBlob(map, Terrain.Hole, 132, 145, tTop + 3, tBot - 3, randomInt(2, 5));
  }

  // ── Zone 5: Second ice section ────────────────────────────────────────
  for (let i = 0; i < 12; i++) {
    placeOrganicBlob(map, Terrain.Slide, 156, 170, tTop, tBot, randomInt(5, 12));
  }

  // ── Interior walls ────────────────────────────────────────────────────
  placeWallSegments(map, 14, 24, tTop, tBot, 4);
  placeWallSegments(map, 35, 40, tTop, tBot, 3);
  placeWallSegments(map, 50, 65, tTop, tBot, 5);
  placeWallSegments(map, 75, 80, tTop, tBot, 2);
  placeWallSegments(map, 90, 108, tTop, tBot, 5);
  placeWallSegments(map, 115, 120, tTop, tBot, 2);
  placeWallSegments(map, 130, 145, tTop, tBot, 4);
  placeWallSegments(map, 150, 155, tTop, tBot, 2);
  placeWallSegments(map, 160, 170, tTop, tBot, 3);

  // ── Safety clears ─────────────────────────────────────────────────────
  clearRect(map, 0, 8, SPAWN_Y - 4, SPAWN_Y + 4);    // spawn area
  clearRect(map, 0, 8, 3, 3);                          // clear top wall at spawn
  clearRect(map, 0, 8, 26, 26);                        // clear bottom wall at spawn
  clearRect(map, FINISH_X, GRID_COL_MAX, tTop, tBot);  // finish zone
  clearRect(map, FINISH_X, GRID_COL_MAX, 3, 3);        // clear top wall at finish
  clearRect(map, FINISH_X, GRID_COL_MAX, 26, 26);      // clear bottom wall at finish

  ensurePassable(map, tTop, tBot);

  return map;
}

// ─── Button generation ──────────────────────────────────────────────────────

const BUTTON_TARGET: Record<number, { w: number; h: number }> = {
  [ButtonType.ClosePath]:    { w: 2, h: 6 },
  [ButtonType.OpenHole]:     { w: 3, h: 3 },
  [ButtonType.TriggerSlide]: { w: 5, h: 4 },
};

const BUTTON_SLOTS: { xMin: number; xMax: number; targetAhead: number }[] = [
  { xMin: 15, xMax: 24, targetAhead: 8 },
  { xMin: 35, xMax: 40, targetAhead: 8 },
  { xMin: 55, xMax: 65, targetAhead: 6 },
  { xMin: 75, xMax: 80, targetAhead: 8 },
  { xMin: 95, xMax: 108, targetAhead: 6 },
  { xMin: 115, xMax: 120, targetAhead: 8 },
  { xMin: 135, xMax: 145, targetAhead: 6 },
  { xMin: 150, xMax: 155, targetAhead: 6 },
  { xMin: 162, xMax: 170, targetAhead: 5 },
];

export function generateButtons(map: number[][]): ButtonDef[] {
  const buttons: ButtonDef[] = [];
  const tTop = 4;
  const tBot = 25;
  const types = [ButtonType.ClosePath, ButtonType.OpenHole, ButtonType.TriggerSlide];

  for (let slotIdx = 0; slotIdx < BUTTON_SLOTS.length; slotIdx++) {
    const slot = BUTTON_SLOTS[slotIdx];
    const type = types[slotIdx % types.length];
    const target = BUTTON_TARGET[type];

    let placed = false;
    for (let attempt = 0; attempt < 30 && !placed; attempt++) {
      const bx = randomInt(slot.xMin, slot.xMax);
      const by = randomInt(tTop + 2, tBot - 2);

      // Single tile check
      const existing = map[by]?.[bx];
      if (existing === Terrain.Wall || existing === Terrain.Hole || existing === Terrain.Button) continue;

      const tx = bx + slot.targetAhead;
      const ty = by - Math.floor(target.h / 2);
      if (tx + target.w > GRID_COL_MAX || ty < tTop || ty + target.h > tBot) continue;

      // Place as single tile
      map[by][bx] = Terrain.Button;

      buttons.push({
        id: buttons.length, type,
        x: bx, y: by,
        targetX: tx, targetY: ty, targetW: target.w, targetH: target.h,
      });
      placed = true;
    }
  }

  return buttons;
}

// ─── Pickup generation ──────────────────────────────────────────────────────

/**
 * Pickup placement zones — spread across the map.
 * Each zone spawns 1-2 pickups on Normal terrain.
 */
const PICKUP_ZONES: { xMin: number; xMax: number; count: number }[] = [
  { xMin: 10, xMax: 24, count: 2 },
  { xMin: 26, xMax: 40, count: 2 },
  { xMin: 45, xMax: 68, count: 3 },
  { xMin: 71, xMax: 80, count: 2 },
  { xMin: 85, xMax: 108, count: 3 },
  { xMin: 111, xMax: 120, count: 2 },
  { xMin: 125, xMax: 145, count: 3 },
  { xMin: 146, xMax: 155, count: 2 },
  { xMin: 158, xMax: 170, count: 2 },
];

/**
 * Generate pickup spawn points on Normal terrain.
 * Returns PickupDef array. Does NOT modify the terrain map — pickups are an overlay.
 */
export function generatePickups(map: number[][]): PickupDef[] {
  const pickups: PickupDef[] = [];
  const tTop = 4;
  const tBot = 25;
  const allTypes = [PickupType.SpeedBoost, PickupType.Shield, PickupType.SlimeBomb, PickupType.Knockback];

  for (const zone of PICKUP_ZONES) {
    for (let i = 0; i < zone.count; i++) {
      let placed = false;
      for (let attempt = 0; attempt < 40 && !placed; attempt++) {
        const x = randomInt(zone.xMin, zone.xMax);
        const y = randomInt(tTop + 1, tBot - 1);

        // Must be on Normal terrain, not adjacent to walls, and not overlap another pickup
        if (map[y][x] !== Terrain.Normal) continue;
        // Check wider area for walls/buttons (avoid visual overlap with 3D objects)
        let nearBlocking = false;
        for (let dy = -2; dy <= 2; dy++) {
          for (let dx = -2; dx <= 2; dx++) {
            const t = map[y + dy]?.[x + dx] ?? 0;
            if (t === Terrain.Wall || t === Terrain.Button) nearBlocking = true;
          }
        }
        if (nearBlocking) continue;
        if (pickups.some(p => Math.abs(p.x - x) < 3 && Math.abs(p.y - y) < 3)) continue;

        pickups.push({
          id: pickups.length,
          type: allTypes[randomInt(0, allTypes.length - 1)],
          x, y,
        });
        placed = true;
      }
    }
  }

  return pickups;
}
