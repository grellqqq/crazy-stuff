import Phaser from 'phaser';

/**
 * On-screen touch controller — a floating left-thumb virtual joystick (8-dir,
 * with an outer-ring sprint) plus configurable right-thumb action buttons.
 * Shared by the race (IsoScene) and the lobby (LobbyScene).
 *
 * INPUT SOURCE: raw DOM touch/mouse events on the game canvas, NOT Phaser's
 * pointer input. Some mobile browsers don't deliver canvas taps to Phaser's
 * pointer system (that's what left players stuck on the title "press any key")
 * yet DOM touch events always fire — the "click to enter" splash proves it. So
 * we read touches directly and map client pixels → the fixed 1280×720 game
 * space (accounting for the Scale.FIT letterbox via the canvas bounding rect).
 * Only touches that land on the CANVAS are handled, so DOM panels (chat,
 * inventory, profile) keep their own taps.
 *
 * VISUALS stay Phaser objects (screen-fixed, scale with the canvas). Created
 * only on touch devices, so desktop is unaffected.
 */

export interface TouchInput {
  /** One of the 8 direction keys (W/A/S/D/WD/WA/SD/SA) or null when centred. */
  dir: string | null;
  /** True while the thumb is pushed to the outer ring (only if enableSprint). */
  sprint: boolean;
  /** Raw joystick vector, screen space (y-down), each component in [-1, 1]. */
  vx: number;
  vy: number;
  /** Vector magnitude in [0, 1]. */
  mag: number;
}

export interface TouchButtonSpec {
  /** Stable id used for setButtonVisible and as the label text. */
  key: string;
  cx: number; cy: number; r: number;
  fill: number; stroke: number;
  action: () => void;
}

// Joystick vector angle → direction key. Sector i (each 45°) measured CLOCKWISE
// from screen-East (y down). SD=East, S=SE, SA=South, A=SW, WA=West, W=NW,
// WD=North, D=NE — matches the race key→screen-compass mapping.
const DIR_BY_SECTOR = ['SD', 'S', 'SA', 'A', 'WA', 'W', 'WD', 'D'] as const;

/** Convert a joystick direction key into the equivalent WASD key booleans, so
 *  free-roam movement code (the lobby) can consume the joystick like the keyboard.
 *  Screen: w=up, s=down, a=left, d=right. */
export function dirToWasd(dir: string | null): { w: boolean; a: boolean; s: boolean; d: boolean } {
  switch (dir) {
    case 'WD': return { w: true,  a: false, s: false, d: false }; // N
    case 'D':  return { w: true,  a: false, s: false, d: true  }; // NE
    case 'SD': return { w: false, a: false, s: false, d: true  }; // E
    case 'S':  return { w: false, a: false, s: true,  d: true  }; // SE
    case 'SA': return { w: false, a: false, s: true,  d: false }; // S
    case 'A':  return { w: false, a: true,  s: true,  d: false }; // SW
    case 'WA': return { w: false, a: true,  s: false, d: false }; // W
    case 'W':  return { w: true,  a: true,  s: false, d: false }; // NW
    default:   return { w: false, a: false, s: false, d: false };
  }
}

const JOY_RADIUS = 95;
const JOY_THUMB_R = 42;
const JOY_DEADZONE = 0.28;
const JOY_SPRINT_AT = 0.92;
const JOY_ZONE_MAX_X = 620;     // left region that grabs the stick (game space)
const JOY_ZONE_MIN_Y = 150;     // keep clear of the top HUD
const JOY_MARGIN = 120;
const BTN_DEPTH = 9000;

const MOUSE_ID = -1; // synthetic touch id for the desktop mouse (?touch testing)

interface Btn {
  spec: TouchButtonSpec;
  circle: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  visible: boolean;
}

export class TouchControls {
  private scene: Phaser.Scene;
  private canvas: HTMLCanvasElement;
  private enableSprint: boolean;

  private dir: string | null = null;
  private sprint = false;
  private vx = 0; private vy = 0; private mag = 0;
  private visible = true;

  private base: Phaser.GameObjects.Arc;
  private thumb: Phaser.GameObjects.Arc;
  private baseX = 0;
  private baseY = 0;
  private stickTouchId: number | null = null;

  private buttons: Btn[] = [];
  private buttonTouches = new Map<number, Btn>();

  // Bound DOM handlers (kept for removal)
  private onTouchStart: (e: TouchEvent) => void;
  private onTouchMove: (e: TouchEvent) => void;
  private onTouchEnd: (e: TouchEvent) => void;
  private onMouseDown: (e: MouseEvent) => void;
  private onMouseMove: (e: MouseEvent) => void;
  private onMouseUp: (e: MouseEvent) => void;

  constructor(scene: Phaser.Scene, opts: { buttons: TouchButtonSpec[]; enableSprint?: boolean }) {
    this.scene = scene;
    this.canvas = scene.game.canvas;
    this.enableSprint = opts.enableSprint ?? false;

    this.base = scene.add.circle(0, 0, JOY_RADIUS, 0x22344a, 0.32)
      .setStrokeStyle(3, 0x4488ff, 0.7).setScrollFactor(0).setDepth(BTN_DEPTH).setVisible(false);
    this.thumb = scene.add.circle(0, 0, JOY_THUMB_R, 0x4488ff, 0.6)
      .setStrokeStyle(2, 0xaaccff, 0.9).setScrollFactor(0).setDepth(BTN_DEPTH + 1).setVisible(false);

    for (const spec of opts.buttons) this.addButton(spec);

    this.onTouchStart = (e) => this.handleStart(e);
    this.onTouchMove = (e) => this.handleMove(e);
    this.onTouchEnd = (e) => this.handleEnd(e);
    this.onMouseDown = (e) => this.mouseDown(e);
    this.onMouseMove = (e) => this.mouseMove(e);
    this.onMouseUp = () => this.mouseUp();

    this.canvas.addEventListener('touchstart', this.onTouchStart, { passive: false });
    this.canvas.addEventListener('touchmove', this.onTouchMove, { passive: false });
    this.canvas.addEventListener('touchend', this.onTouchEnd);
    this.canvas.addEventListener('touchcancel', this.onTouchEnd);
    this.canvas.addEventListener('mousedown', this.onMouseDown);
    window.addEventListener('mousemove', this.onMouseMove);
    window.addEventListener('mouseup', this.onMouseUp);
  }

  private addButton(spec: TouchButtonSpec): void {
    const circle = this.scene.add.circle(spec.cx, spec.cy, spec.r, spec.fill, 0.5)
      .setStrokeStyle(3, spec.stroke, 0.9).setScrollFactor(0).setDepth(BTN_DEPTH);
    const label = this.scene.add.text(spec.cx, spec.cy, spec.key, {
      fontFamily: 'monospace', fontSize: '20px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(BTN_DEPTH + 1);
    this.buttons.push({ spec, circle, label, visible: true });
  }

  getInput(): TouchInput {
    return { dir: this.dir, sprint: this.sprint, vx: this.vx, vy: this.vy, mag: this.mag };
  }

  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    for (const b of this.buttons) {
      const show = v && b.visible;
      b.circle.setVisible(show); b.label.setVisible(show);
    }
    if (!v) this.resetStick();
  }

  /** Context buttons (e.g. lobby INTERACT) can be shown only when relevant. */
  setButtonVisible(key: string, v: boolean): void {
    const b = this.buttons.find((x) => x.spec.key === key);
    if (!b) return;
    b.visible = v;
    const show = v && this.visible;
    b.circle.setVisible(show); b.label.setVisible(show);
  }

  // ─── Coordinate mapping ────────────────────────────────────────────────────

  /** Client pixel → fixed game-space (1280×720) via the canvas rect. */
  private toGame(clientX: number, clientY: number): { x: number; y: number } {
    const r = this.canvas.getBoundingClientRect();
    return {
      x: (clientX - r.left) / r.width * this.scene.scale.width,
      y: (clientY - r.top) / r.height * this.scene.scale.height,
    };
  }

  // ─── DOM event handling ────────────────────────────────────────────────────

  private handleStart(e: TouchEvent): void {
    if (!this.visible) return;
    let claimed = false;
    for (const t of Array.from(e.changedTouches)) {
      if (this.claim(t.identifier, t.clientX, t.clientY)) claimed = true;
    }
    if (claimed) e.preventDefault();
  }

  private handleMove(e: TouchEvent): void {
    let tracked = false;
    for (const t of Array.from(e.changedTouches)) {
      if (t.identifier === this.stickTouchId) {
        const g = this.toGame(t.clientX, t.clientY);
        this.updateStick(g.x, g.y);
        tracked = true;
      }
    }
    if (tracked) e.preventDefault();
  }

  private handleEnd(e: TouchEvent): void {
    for (const t of Array.from(e.changedTouches)) this.release(t.identifier);
  }

  private mouseDown(e: MouseEvent): void {
    if (!this.visible) return;
    if (this.claim(MOUSE_ID, e.clientX, e.clientY)) e.preventDefault();
  }

  private mouseMove(e: MouseEvent): void {
    if (this.stickTouchId !== MOUSE_ID) return;
    const g = this.toGame(e.clientX, e.clientY);
    this.updateStick(g.x, g.y);
  }

  private mouseUp(): void {
    this.release(MOUSE_ID);
  }

  /** Route a new touch to a button or the joystick. Returns true if handled. */
  private claim(id: number, clientX: number, clientY: number): boolean {
    const g = this.toGame(clientX, clientY);

    for (const b of this.buttons) {
      if (!b.visible) continue;
      if (Phaser.Math.Distance.Between(g.x, g.y, b.spec.cx, b.spec.cy) <= b.spec.r) {
        this.buttonTouches.set(id, b);
        b.circle.setScale(0.9).setFillStyle(b.spec.fill, 0.8);
        b.spec.action();
        return true;
      }
    }

    if (this.stickTouchId === null && g.x <= JOY_ZONE_MAX_X && g.y >= JOY_ZONE_MIN_Y) {
      this.stickTouchId = id;
      this.baseX = Phaser.Math.Clamp(g.x, JOY_MARGIN, this.scene.scale.width - JOY_MARGIN);
      this.baseY = Phaser.Math.Clamp(g.y, JOY_MARGIN, this.scene.scale.height - JOY_MARGIN);
      this.base.setPosition(this.baseX, this.baseY).setVisible(true);
      this.thumb.setPosition(this.baseX, this.baseY).setVisible(true);
      this.updateStick(g.x, g.y);
      return true;
    }
    return false;
  }

  private release(id: number): void {
    const b = this.buttonTouches.get(id);
    if (b) {
      b.circle.setScale(1).setFillStyle(b.spec.fill, 0.5);
      this.buttonTouches.delete(id);
    }
    if (id === this.stickTouchId) this.resetStick();
  }

  private updateStick(gx: number, gy: number): void {
    let dx = gx - this.baseX;
    let dy = gy - this.baseY;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, JOY_RADIUS);
    if (dist > JOY_RADIUS) { dx = (dx / dist) * JOY_RADIUS; dy = (dy / dist) * JOY_RADIUS; }
    this.thumb.setPosition(this.baseX + dx, this.baseY + dy);

    this.mag = clamped / JOY_RADIUS;
    if (this.mag < JOY_DEADZONE) {
      this.dir = null; this.sprint = false; this.vx = 0; this.vy = 0;
      this.thumb.setFillStyle(0x4488ff, 0.6);
      return;
    }
    this.vx = dx / JOY_RADIUS;
    this.vy = dy / JOY_RADIUS;
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    this.dir = DIR_BY_SECTOR[Math.round(deg / 45) % 8];
    this.sprint = this.enableSprint && this.mag >= JOY_SPRINT_AT;
    this.thumb.setFillStyle(this.sprint ? 0xffaa33 : 0x4488ff, this.sprint ? 0.85 : 0.6);
  }

  private resetStick(): void {
    this.stickTouchId = null;
    this.dir = null; this.sprint = false; this.vx = 0; this.vy = 0; this.mag = 0;
    this.base.setVisible(false);
    this.thumb.setVisible(false).setFillStyle(0x4488ff, 0.6);
  }

  destroy(): void {
    this.canvas.removeEventListener('touchstart', this.onTouchStart);
    this.canvas.removeEventListener('touchmove', this.onTouchMove);
    this.canvas.removeEventListener('touchend', this.onTouchEnd);
    this.canvas.removeEventListener('touchcancel', this.onTouchEnd);
    this.canvas.removeEventListener('mousedown', this.onMouseDown);
    window.removeEventListener('mousemove', this.onMouseMove);
    window.removeEventListener('mouseup', this.onMouseUp);
    this.base.destroy();
    this.thumb.destroy();
    for (const b of this.buttons) { b.circle.destroy(); b.label.destroy(); }
    this.buttons = [];
    this.buttonTouches.clear();
  }
}
