import Phaser from 'phaser';

/**
 * On-screen touch controller for the race (mobile).
 *
 * A floating left-thumb virtual joystick drives the 8 isometric directions and
 * doubles as sprint (push the thumb to the outer ring). Two right-thumb buttons
 * fire Jump and Use-pickup. Everything is screen-fixed (setScrollFactor(0)) so it
 * lives in the fixed 1280×720 design space and scales with the FIT canvas.
 *
 * The controller only PRODUCES input — the scene polls `getInput()` each frame
 * and routes it through the same `sendMove()` path as the keyboard, so touch
 * movement gets client-side prediction for free. It never talks to the server.
 *
 * Created only on touch devices (see mobile.ts / IsoScene), so desktop is
 * completely unaffected.
 */

export interface TouchInput {
  /** One of the 8 direction keys (W/A/S/D/WD/WA/SD/SA) or null when centred. */
  dir: string | null;
  /** True while the thumb is pushed to the outer ring. */
  sprint: boolean;
}

// Joystick vector angle → direction key. Sector i (each 45°) measured CLOCKWISE
// from screen-East (y points down). MUST match IsoScene's key→screen-compass
// mapping: SD=East, S=SE, SA=South, A=SW, WA=West, W=NW, WD=North, D=NE.
const DIR_BY_SECTOR = ['SD', 'S', 'SA', 'A', 'WA', 'W', 'WD', 'D'] as const;

// Design-space (1280×720) layout + tuning. All screen-fixed.
const JOY_RADIUS = 95;          // max thumb travel from base centre
const JOY_THUMB_R = 42;
const JOY_DEADZONE = 0.28;      // fraction of radius below which dir = null
const JOY_SPRINT_AT = 0.92;     // fraction of radius at/above which sprint engages
const JOY_ZONE_MAX_X = 620;     // left region that grabs the stick
const JOY_ZONE_MIN_Y = 150;     // keep clear of the top HUD (timer/stamina)
const JOY_MARGIN = 120;         // clamp the floating base this far from screen edges

const BTN_DEPTH = 9000;

interface Btn {
  circle: Phaser.GameObjects.Arc;
  label: Phaser.GameObjects.Text;
  cx: number; cy: number; r: number;
  action: () => void;
}

export class TouchControls {
  private scene: Phaser.Scene;
  private dir: string | null = null;
  private sprint = false;
  private visible = true;

  // Joystick (floating — base appears where the thumb lands)
  private base: Phaser.GameObjects.Arc;
  private thumb: Phaser.GameObjects.Arc;
  private baseX = 0;
  private baseY = 0;
  private stickPointerId: number | null = null;

  private buttons: Btn[] = [];
  private btnPointers = new Map<number, Btn>();

  private onDownBound: (p: Phaser.Input.Pointer) => void;
  private onMoveBound: (p: Phaser.Input.Pointer) => void;
  private onUpBound: (p: Phaser.Input.Pointer) => void;

  constructor(scene: Phaser.Scene, opts: { onJump: () => void; onUse: () => void }) {
    this.scene = scene;

    // Enough concurrent pointers for stick + both buttons at once.
    scene.input.addPointer(3);

    this.base = scene.add.circle(0, 0, JOY_RADIUS, 0x22344a, 0.32)
      .setStrokeStyle(3, 0x4488ff, 0.7).setScrollFactor(0).setDepth(BTN_DEPTH).setVisible(false);
    this.thumb = scene.add.circle(0, 0, JOY_THUMB_R, 0x4488ff, 0.6)
      .setStrokeStyle(2, 0xaaccff, 0.9).setScrollFactor(0).setDepth(BTN_DEPTH + 1).setVisible(false);

    // Stacked on the right edge, ABOVE the minimap panel (which fills the bottom
    // strip below y≈606 in the 1280×720 design space) and clear of the top HUD.
    this.addButton(1195, 400, 60, 'JUMP', 0x2a6a2a, 0x66cc66, opts.onJump);
    this.addButton(1195, 530, 50, 'USE', 0x553388, 0xaa66ff, opts.onUse);

    this.onDownBound = (p) => this.onDown(p);
    this.onMoveBound = (p) => this.onMove(p);
    this.onUpBound = (p) => this.onUp(p);
    scene.input.on('pointerdown', this.onDownBound);
    scene.input.on('pointermove', this.onMoveBound);
    scene.input.on('pointerup', this.onUpBound);
    scene.input.on('pointerupoutside', this.onUpBound);
  }

  private addButton(cx: number, cy: number, r: number, text: string, fill: number, stroke: number, action: () => void): void {
    const circle = this.scene.add.circle(cx, cy, r, fill, 0.5)
      .setStrokeStyle(3, stroke, 0.9).setScrollFactor(0).setDepth(BTN_DEPTH);
    const label = this.scene.add.text(cx, cy, text, {
      fontFamily: 'monospace', fontSize: '20px', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5).setScrollFactor(0).setDepth(BTN_DEPTH + 1);
    this.buttons.push({ circle, label, cx, cy, r, action });
  }

  /** Current movement intent. Polled by the scene each frame. */
  getInput(): TouchInput {
    return { dir: this.dir, sprint: this.sprint };
  }

  setVisible(v: boolean): void {
    if (this.visible === v) return;
    this.visible = v;
    for (const b of this.buttons) { b.circle.setVisible(v); b.label.setVisible(v); }
    if (!v) this.resetStick();
  }

  // ─── Pointer handling ─────────────────────────────────────────────────────

  private onDown(p: Phaser.Input.Pointer): void {
    if (!this.visible) return;

    // Button hit-test first (right side, disjoint from the stick zone).
    for (const b of this.buttons) {
      if (Phaser.Math.Distance.Between(p.x, p.y, b.cx, b.cy) <= b.r) {
        this.btnPointers.set(p.id, b);
        b.circle.setScale(0.9).setFillStyle(b.circle.fillColor, 0.8);
        b.action();
        return;
      }
    }

    // Otherwise, grab the floating stick if the touch is in the left zone.
    if (this.stickPointerId === null && p.x <= JOY_ZONE_MAX_X && p.y >= JOY_ZONE_MIN_Y) {
      this.stickPointerId = p.id;
      this.baseX = Phaser.Math.Clamp(p.x, JOY_MARGIN, 1280 - JOY_MARGIN);
      this.baseY = Phaser.Math.Clamp(p.y, JOY_MARGIN, 720 - JOY_MARGIN);
      this.base.setPosition(this.baseX, this.baseY).setVisible(true);
      this.thumb.setPosition(this.baseX, this.baseY).setVisible(true);
      this.updateStick(p);
    }
  }

  private onMove(p: Phaser.Input.Pointer): void {
    if (p.id === this.stickPointerId) this.updateStick(p);
  }

  private onUp(p: Phaser.Input.Pointer): void {
    const b = this.btnPointers.get(p.id);
    if (b) {
      b.circle.setScale(1).setFillStyle(b.circle.fillColor, 0.5);
      this.btnPointers.delete(p.id);
    }
    if (p.id === this.stickPointerId) this.resetStick();
  }

  private updateStick(p: Phaser.Input.Pointer): void {
    let dx = p.x - this.baseX;
    let dy = p.y - this.baseY;
    const dist = Math.hypot(dx, dy);
    const clamped = Math.min(dist, JOY_RADIUS);
    if (dist > JOY_RADIUS) { dx = (dx / dist) * JOY_RADIUS; dy = (dy / dist) * JOY_RADIUS; }
    this.thumb.setPosition(this.baseX + dx, this.baseY + dy);

    const mag = clamped / JOY_RADIUS;
    if (mag < JOY_DEADZONE) {
      this.dir = null;
      this.sprint = false;
      this.thumb.setFillStyle(0x4488ff, 0.6);
      return;
    }
    let deg = (Math.atan2(dy, dx) * 180) / Math.PI;
    if (deg < 0) deg += 360;
    const sector = Math.round(deg / 45) % 8;
    this.dir = DIR_BY_SECTOR[sector];
    this.sprint = mag >= JOY_SPRINT_AT;
    this.thumb.setFillStyle(this.sprint ? 0xffaa33 : 0x4488ff, this.sprint ? 0.85 : 0.6);
  }

  private resetStick(): void {
    this.stickPointerId = null;
    this.dir = null;
    this.sprint = false;
    this.base.setVisible(false);
    this.thumb.setVisible(false).setFillStyle(0x4488ff, 0.6);
  }

  destroy(): void {
    this.scene.input.off('pointerdown', this.onDownBound);
    this.scene.input.off('pointermove', this.onMoveBound);
    this.scene.input.off('pointerup', this.onUpBound);
    this.scene.input.off('pointerupoutside', this.onUpBound);
    this.base.destroy();
    this.thumb.destroy();
    for (const b of this.buttons) { b.circle.destroy(); b.label.destroy(); }
    this.buttons = [];
    this.btnPointers.clear();
  }
}
