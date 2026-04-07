import Phaser from 'phaser';
import { authenticate } from './auth';

export class TitleScene extends Phaser.Scene {
  private started = false;
  private titleLetters: Phaser.GameObjects.Text[] = [];
  private pipeGraphics!: Phaser.GameObjects.Graphics;
  private pressText!: Phaser.GameObjects.Text;
  private bgMusic: Phaser.Sound.BaseSound | null = null;
  private authState: import('./auth').AuthState | null = null;
  private electricTimer: Phaser.Time.TimerEvent | null = null;

  constructor() {
    super({ key: 'TitleScene' });
  }

  preload(): void {
    this.load.audio('title_theme', '/audio/title_theme.mp3');
  }

  async create(): Promise<void> {
    const { width, height } = this.scale;

    this.cameras.main.setBackgroundColor('#0a0a18');

    // Create spark texture
    if (!this.textures.exists('spark')) {
      const gfx = this.make.graphics({ x: 0, y: 0 });
      gfx.fillStyle(0xffffff, 1);
      gfx.fillCircle(4, 4, 4);
      gfx.generateTexture('spark', 8, 8);
      gfx.destroy();
    }

    // Splash click — unlocks browser audio
    await this.waitForClick(width, height);

    // Authenticate
    this.authState = await authenticate();

    // Start music after auth (user gesture from login click unlocks audio)
    this.bgMusic = this.sound.add('title_theme', { loop: true, volume: 0.6 });
    try { this.bgMusic.play(); } catch { /* ignore */ }

    // Phase 1: Draw thick pipe frames + fireworks
    this.pipeGraphics = this.add.graphics();
    const pipeEndTime = this.animatePipeFrame(width, height);

    // Fireworks during pipe phase — inside the frame area
    const fwTimer = this.time.addEvent({
      delay: 300,
      loop: true,
      callback: () => {
        const fx = Phaser.Math.Between(120, width - 120);
        const fy = Phaser.Math.Between(120, height - 120);
        this.emitFirework(fx, fy);
      },
    });

    // Phase 2: Letters enter AFTER all pipes close
    const title = 'CRAZY STUFF';
    const letterSpacing = 52;
    const startX = width / 2 - (title.length * letterSpacing) / 2 + letterSpacing / 2;
    const y = height / 2 - 20;

    for (let i = 0; i < title.length; i++) {
      const letter = this.add.text(startX + i * letterSpacing, y, title[i], {
        fontSize: '72px',
        fontFamily: 'Impact, Arial Black, sans-serif',
        color: '#0a0a18',
        fontStyle: 'bold',
        stroke: '#000',
        strokeThickness: 4,
      }).setOrigin(0.5, 0.5).setAlpha(0);
      this.titleLetters.push(letter);
    }

    const totalLetters = this.titleLetters.length;
    const letterStartDelay = pipeEndTime + 500; // starts after white pipe closes

    // Stop fireworks when letters start
    this.time.delayedCall(letterStartDelay, () => fwTimer.destroy());

    for (let i = 0; i < totalLetters; i++) {
      const letter = this.titleLetters[i]; // LEFT to RIGHT
      const delay = letterStartDelay + i * 350; // another 50% faster

      this.time.delayedCall(delay, () => {
        // Letter slams in from left
        letter.setAlpha(1);
        letter.setX(letter.x - 200);
        letter.setColor('#ffffff');
        letter.setScale(2.5);

        // Slide in + scale down
        this.tweens.add({
          targets: letter,
          x: startX + i * letterSpacing,
          scale: 1.2,
          duration: 400,
          ease: 'Back.easeOut',
        });

        // Color flash sequence: white → bright yellow → biohazard yellow
        this.time.delayedCall(100, () => {
          letter.setColor('#ffff44');
          letter.setShadow(0, 0, '#ffaa00', 20, true, true);
          this.emitSparks(letter.x, letter.y, 15);
          this.screenShake(2);
        });

        this.time.delayedCall(250, () => {
          letter.setColor('#ffcc00');
          letter.setShadow(0, 0, '#ff8800', 14, true, true);
          letter.setStroke('#664400', 3);
        });

        this.time.delayedCall(500, () => {
          letter.setColor('#ffdd22');
          letter.setShadow(0, 0, '#ff6600', 10, true, true);
          // Settle to final size
          this.tweens.add({
            targets: letter,
            scale: 1.0,
            duration: 300,
            ease: 'Sine.easeOut',
          });
        });

        // Random electric arc to a previous letter
        if (i > 0) {
          this.time.delayedCall(200, () => {
            const prevLetter = this.titleLetters[i - 1];
            this.drawElectricArc(prevLetter.x, prevLetter.y, letter.x, letter.y);
          });
        }
      });
    }

    // Phase 3: All letters lit — electric storm + pulse
    const allLettersDelay = letterStartDelay + totalLetters * 350 + 400;

    this.time.delayedCall(allLettersDelay, () => {
      // Big flash
      this.cameras.main.flash(500, 255, 200, 0);
      this.screenShake(5);
      this.emitSparks(width / 2, y, 40);

      // All letters pulse together
      for (const letter of this.titleLetters) {
        this.tweens.add({
          targets: letter,
          scale: 1.08,
          duration: 600,
          yoyo: true,
          repeat: -1,
          ease: 'Sine.easeInOut',
        });
      }

      // Continuous random electric arcs between letters
      this.electricTimer = this.time.addEvent({
        delay: 400,
        loop: true,
        callback: () => {
          const a = Phaser.Math.Between(0, totalLetters - 1);
          let b = Phaser.Math.Between(0, totalLetters - 1);
          if (b === a) b = (a + 1) % totalLetters;
          this.drawElectricArc(
            this.titleLetters[a].x, this.titleLetters[a].y,
            this.titleLetters[b].x, this.titleLetters[b].y
          );
          // Random sparks from pipes
          this.emitSparks(
            Phaser.Math.Between(50, width - 50),
            Phaser.Math.Between(0, 1) === 0 ? 35 : height - 35,
            5
          );
        },
      });
    });

    // Phase 4: "Press any key" appears (3 seconds later)
    this.time.delayedCall(allLettersDelay + 4500, () => {
      this.pressText = this.add.text(width / 2, height / 2 + 70, 'PRESS ANY KEY TO START', {
        fontSize: '20px',
        fontFamily: 'monospace',
        color: '#888888',
      }).setOrigin(0.5, 0.5).setAlpha(0);

      this.tweens.add({ targets: this.pressText, alpha: 1, duration: 600 });
      this.tweens.add({
        targets: this.pressText,
        alpha: 0.3,
        duration: 800,
        yoyo: true,
        repeat: -1,
        delay: 800,
        ease: 'Sine.easeInOut',
      });

      // Accept input
      this.input.keyboard?.on('keydown', () => this.startGame());
      this.input.on('pointerdown', () => this.startGame());
    });
  }

  private waitForClick(width: number, height: number): Promise<void> {
    return new Promise((resolve) => {
      const overlay = document.createElement('div');
      overlay.style.cssText = `
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: #0a0a18; display: flex; align-items: center;
        justify-content: center; z-index: 10000; cursor: pointer;
        font-family: monospace;
      `;
      overlay.innerHTML = `
        <div style="text-align: center;">
          <h1 style="color: #ffdd22; font-size: 28px; margin: 0 0 16px; letter-spacing: 4px;">CRAZY STUFF</h1>
          <p style="color: #666; font-size: 16px; animation: blink 1.5s infinite;">Click anywhere to enter</p>
        </div>
        <style>@keyframes blink { 0%,100% { opacity: 1; } 50% { opacity: 0.3; } }</style>
      `;
      document.body.appendChild(overlay);

      const onClick = () => {
        overlay.remove();
        resolve();
      };
      overlay.addEventListener('click', onClick);
      overlay.addEventListener('touchstart', onClick);
    });
  }

  private startGame(): void {
    if (this.started) return;
    this.started = true;

    if (this.electricTimer) this.electricTimer.destroy();
    this.cameras.main.flash(400, 255, 220, 50);

    this.time.delayedCall(500, () => {
      this.scene.start('IsoScene', { authState: this.authState, bgMusic: this.bgMusic });
    });
  }

  private animatePipeFrame(width: number, height: number): number {
    const g = this.pipeGraphics;
    const redPipes = this.add.graphics();
    const pad = 25;
    const innerPad = 65; // blue pipe thickness + gap
    const whitePad = 105; // red pipe thickness + gap
    const corners = [
      { x: pad, y: pad },
      { x: width - pad, y: pad },
      { x: width - pad, y: height - pad },
      { x: pad, y: height - pad },
    ];
    const innerCorners = [
      { x: innerPad, y: innerPad },
      { x: width - innerPad, y: innerPad },
      { x: width - innerPad, y: height - innerPad },
      { x: innerPad, y: height - innerPad },
    ];

    const segments = [
      { from: corners[0], to: corners[1] },
      { from: corners[1], to: corners[2] },
      { from: corners[2], to: corners[3] },
      { from: corners[3], to: corners[0] },
    ];
    const innerSegments = [
      { from: innerCorners[0], to: innerCorners[1] },
      { from: innerCorners[1], to: innerCorners[2] },
      { from: innerCorners[2], to: innerCorners[3] },
      { from: innerCorners[3], to: innerCorners[0] },
    ];

    // Phase 1: Blue shiny pipes (outer frame)
    segments.forEach((seg, i) => {
      this.time.delayedCall(i * 600, () => {
        // Thick blue pipe (outer glow) — 50% thicker
        g.lineStyle(30, 0x112244, 1);
        g.beginPath();
        g.moveTo(seg.from.x, seg.from.y);
        g.lineTo(seg.to.x, seg.to.y);
        g.strokePath();

        // Blue shiny highlight
        g.lineStyle(16, 0x2266cc, 0.9);
        g.beginPath();
        g.moveTo(seg.from.x, seg.from.y);
        g.lineTo(seg.to.x, seg.to.y);
        g.strokePath();

        // Bright center shine
        g.lineStyle(4, 0x66aaff, 0.8);
        g.beginPath();
        g.moveTo(seg.from.x, seg.from.y);
        g.lineTo(seg.to.x, seg.to.y);
        g.strokePath();

        // Corner bolts
        g.fillStyle(0x3366aa, 1);
        g.fillCircle(seg.to.x, seg.to.y, 14);
        g.fillStyle(0x88bbff, 1);
        g.fillCircle(seg.to.x, seg.to.y, 6);

        this.emitSparks(seg.to.x, seg.to.y, 12);
        this.screenShake(1);
      });
    });

    const whiteCorners = [
      { x: whitePad, y: whitePad },
      { x: width - whitePad, y: whitePad },
      { x: width - whitePad, y: height - whitePad },
      { x: whitePad, y: height - whitePad },
    ];
    const whiteSegments = [
      { from: whiteCorners[0], to: whiteCorners[1] },
      { from: whiteCorners[1], to: whiteCorners[2] },
      { from: whiteCorners[2], to: whiteCorners[3] },
      { from: whiteCorners[3], to: whiteCorners[0] },
    ];

    // Phase 2: Red shiny pipes (inner frame) — starts after blue completes
    const redStart = 4 * 600 + 200;
    const redEnd = redStart + 4 * 500 + 300;

    // Phase 3: White shiny pipes (innermost frame) — starts after red completes
    const whitePipes = this.add.graphics();
    const whiteStart = redEnd;
    const whiteEnd = whiteStart + 4 * 500 + 300;

    whiteSegments.forEach((seg, i) => {
      this.time.delayedCall(whiteStart + i * 500, () => {
        // Thick white pipe (outer glow)
        whitePipes.lineStyle(22, 0x333344, 1);
        whitePipes.beginPath();
        whitePipes.moveTo(seg.from.x, seg.from.y);
        whitePipes.lineTo(seg.to.x, seg.to.y);
        whitePipes.strokePath();

        // White shiny highlight
        whitePipes.lineStyle(12, 0xaaaacc, 0.9);
        whitePipes.beginPath();
        whitePipes.moveTo(seg.from.x, seg.from.y);
        whitePipes.lineTo(seg.to.x, seg.to.y);
        whitePipes.strokePath();

        // Bright center shine
        whitePipes.lineStyle(3, 0xffffff, 0.9);
        whitePipes.beginPath();
        whitePipes.moveTo(seg.from.x, seg.from.y);
        whitePipes.lineTo(seg.to.x, seg.to.y);
        whitePipes.strokePath();

        // Corner bolts
        whitePipes.fillStyle(0x888899, 1);
        whitePipes.fillCircle(seg.to.x, seg.to.y, 10);
        whitePipes.fillStyle(0xffffff, 1);
        whitePipes.fillCircle(seg.to.x, seg.to.y, 4);

        this.emitSparks(seg.to.x, seg.to.y, 8);
        this.screenShake(1);
      });
    });

    // Phase 4: Flash + speed traces after white pipe closes
    this.time.delayedCall(whiteEnd, () => {
      this.cameras.main.flash(300, 255, 255, 255);
      this.screenShake(5);
      this.startSpeedTraces(whitePad + 12, width - whitePad - 12, whitePad + 12, height - whitePad - 12);
    });

    innerSegments.forEach((seg, i) => {
      this.time.delayedCall(redStart + i * 500, () => {
        // Thick red pipe (outer glow) — 50% thicker
        redPipes.lineStyle(22, 0x441111, 1);
        redPipes.beginPath();
        redPipes.moveTo(seg.from.x, seg.from.y);
        redPipes.lineTo(seg.to.x, seg.to.y);
        redPipes.strokePath();

        // Red shiny highlight
        redPipes.lineStyle(12, 0xcc2222, 0.9);
        redPipes.beginPath();
        redPipes.moveTo(seg.from.x, seg.from.y);
        redPipes.lineTo(seg.to.x, seg.to.y);
        redPipes.strokePath();

        // Bright center shine
        redPipes.lineStyle(3, 0xff6644, 0.8);
        redPipes.beginPath();
        redPipes.moveTo(seg.from.x, seg.from.y);
        redPipes.lineTo(seg.to.x, seg.to.y);
        redPipes.strokePath();

        // Corner bolts
        redPipes.fillStyle(0xaa3333, 1);
        redPipes.fillCircle(seg.to.x, seg.to.y, 10);
        redPipes.fillStyle(0xff8866, 1);
        redPipes.fillCircle(seg.to.x, seg.to.y, 4);

        this.emitSparks(seg.to.x, seg.to.y, 8);
        this.screenShake(1);
      });
    });

    return whiteEnd;
  }

  private drawElectricArc(x1: number, y1: number, x2: number, y2: number): void {
    const g = this.add.graphics();
    g.lineStyle(2, 0xffdd44, 0.8);
    g.beginPath();
    g.moveTo(x1, y1);

    // Jagged lightning path
    const steps = 6;
    for (let s = 1; s < steps; s++) {
      const t = s / steps;
      const mx = x1 + (x2 - x1) * t + Phaser.Math.Between(-15, 15);
      const my = y1 + (y2 - y1) * t + Phaser.Math.Between(-15, 15);
      g.lineTo(mx, my);
    }
    g.lineTo(x2, y2);
    g.strokePath();

    // Glow layer
    g.lineStyle(6, 0xffaa00, 0.15);
    g.beginPath();
    g.moveTo(x1, y1);
    g.lineTo(x2, y2);
    g.strokePath();

    // Fade out and destroy
    this.tweens.add({
      targets: g,
      alpha: 0,
      duration: 300,
      onComplete: () => g.destroy(),
    });
  }

  private emitFirework(x: number, y: number): void {
    const colors = [0xff4444, 0x44ff44, 0x4488ff, 0xffdd44, 0xff66ff, 0x44ffff, 0xff8800];
    const color = colors[Phaser.Math.Between(0, colors.length - 1)];
    const count = Phaser.Math.Between(18, 35);

    const emitter = this.add.particles(x, y, 'spark', {
      speed: { min: 90, max: 270 },
      scale: { start: 1.2, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 500, max: 1000 },
      quantity: count,
      tint: [color, 0xffffff],
      emitting: false,
      gravityY: 40,
    });
    emitter.explode(count);
    this.time.delayedCall(900, () => emitter.destroy());
  }

  private emitSparks(x: number, y: number, count = 8): void {
    const emitter = this.add.particles(x, y, 'spark', {
      speed: { min: 40, max: 150 },
      scale: { start: 0.8, end: 0 },
      alpha: { start: 1, end: 0 },
      lifespan: { min: 200, max: 600 },
      quantity: count,
      tint: [0xffdd44, 0xffaa00, 0xffffff, 0xff6600, 0xffcc00],
      emitting: false,
    });
    emitter.explode(count);
    this.time.delayedCall(700, () => emitter.destroy());
  }

  private startSpeedTraces(left: number, right: number, top: number, bottom: number): void {
    // Fast horizontal speed lines moving across the background inside the frame
    this.time.addEvent({
      delay: 80,
      loop: true,
      callback: () => {
        if (this.started) return;

        const g = this.add.graphics();
        const y = Phaser.Math.Between(top, bottom);
        const lineLen = Phaser.Math.Between(60, 250);
        const speed = Phaser.Math.Between(600, 1200);
        const alpha = Phaser.Math.FloatBetween(0.15, 0.4);
        const colors = [0x4488ff, 0xff4444, 0xffdd44, 0xffffff, 0x2266cc, 0xff6600];
        const color = colors[Phaser.Math.Between(0, colors.length - 1)];
        const thickness = Phaser.Math.Between(2, 4);

        g.lineStyle(thickness, color, alpha);
        g.beginPath();
        g.moveTo(left, y);
        g.lineTo(left + lineLen, y);
        g.strokePath();
        g.setDepth(-1);

        // Fly across screen
        this.tweens.add({
          targets: g,
          x: right - left,
          duration: speed,
          ease: 'Linear',
          onComplete: () => g.destroy(),
        });
      },
    });
  }

  private screenShake(intensity: number): void {
    this.cameras.main.shake(150, intensity * 0.002);
  }
}
