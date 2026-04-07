import Phaser from 'phaser';
import { type AuthState } from './auth';

const PL_CHAR_KEYS = ['male', 'female', 'male-medium', 'female-medium', 'male-dark', 'female-dark'];
const PL_DIRS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];

const PIXELLAB_DIR_MAP: Record<string, { sheetSuffix: string }> = {
  S:  { sheetSuffix: '_south' },
  SA: { sheetSuffix: '_south-west' },
  A:  { sheetSuffix: '_west' },
  WA: { sheetSuffix: '_north-west' },
  W:  { sheetSuffix: '_north' },
  WD: { sheetSuffix: '_north-east' },
  D:  { sheetSuffix: '_east' },
  SD: { sheetSuffix: '_south-east' },
};

const MOVE_SPEED = 180;
const CHAR_KEY = 'male';
const INTERACT_DIST = 100;

export class LobbyScene extends Phaser.Scene {
  private authState: AuthState | null = null;
  private bgMusic: Phaser.Sound.BaseSound | null = null;

  private player!: Phaser.GameObjects.Sprite;
  private playerX = 0;
  private playerY = 0;
  private playerFacing = 'SD';

  private keys!: Record<string, Phaser.Input.Keyboard.Key>;
  private eKey!: Phaser.Input.Keyboard.Key;

  private buildingX = 0;
  private buildingY = 0;
  private ePrompt!: Phaser.GameObjects.Text;

  private groundBounds = { left: 0, right: 0, top: 0, bottom: 0 };
  private profileHud: HTMLDivElement | null = null;
  private queueOverlay: HTMLDivElement | null = null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private queueRoom: any = null;
  private inQueue = false;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  private lobbyRoom: any = null;
  private otherPlayers = new Map<string, { sprite: Phaser.GameObjects.Sprite; label: Phaser.GameObjects.Text; targetX: number; targetY: number }>();
  private playerLabel!: Phaser.GameObjects.Text;
  private lastSentX = 0;
  private lastSentY = 0;
  private lastSentMoving = false;

  constructor() {
    super({ key: 'LobbyScene' });
  }

  init(data: { authState?: AuthState; bgMusic?: Phaser.Sound.BaseSound }): void {
    this.authState = data.authState ?? null;
    this.bgMusic = data.bgMusic ?? null;
  }

  preload(): void {
    this.load.image('lobby_ground', '/tiles/lobby_ground.png');

    for (const charKey of PL_CHAR_KEYS) {
      for (const dir of PL_DIRS) {
        if (!this.textures.exists(`${charKey}_${dir}`)) {
          this.load.spritesheet(`${charKey}_${dir}`, `/sprites/characters/${charKey}/walk_${dir}.png`, { frameWidth: 92, frameHeight: 92 });
        }
        if (!this.textures.exists(`${charKey}_idle_${dir}`)) {
          this.load.spritesheet(`${charKey}_idle_${dir}`, `/sprites/characters/${charKey}/idle_${dir}.png`, { frameWidth: 92, frameHeight: 92 });
        }
      }
    }
  }

  create(): void {
    const { width, height } = this.scale;
    this.cameras.main.setBackgroundColor('#1a1a2e');

    // Ground — fit to screen, no overflow
    const cx = width / 2;
    const cy = height / 2;

    this.add.image(cx, cy, 'lobby_ground').setDisplaySize(width, height).setDepth(-1);

    this.groundBounds = {
      left: 40,
      right: width - 40,
      top: 40,
      bottom: height - 40,
    };

    // Reduce music volume when entering lobby
    if (this.bgMusic) {
      try { (this.bgMusic as any).setVolume(0.15); } catch { /* ignore */ }
    }

    // Building on the right
    this.buildingX = width - 120;
    this.buildingY = cy;
    this.drawBuilding(this.buildingX, this.buildingY);

    // Register animations
    this.registerAnimations();

    // Player
    this.playerX = width / 3;
    this.playerY = height / 2;
    this.player = this.add.sprite(this.playerX, this.playerY, `${CHAR_KEY}_south-east`)
      .setScale(0.75)
      .setOrigin(0.5, 0.85)
      .setDepth(10);
    this.player.play(`${CHAR_KEY}_idle_SD`);

    // Player name label
    const myName = this.authState?.username ?? 'Player';
    this.playerLabel = this.add.text(this.playerX, this.playerY - 55, myName, {
      fontSize: '13px', fontFamily: 'monospace', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5, 1).setDepth(11);

    // Connect to multiplayer lobby for presence
    this.connectLobby().catch(e => console.error('[LobbyScene] lobby connect failed:', e));

    // E prompt
    this.ePrompt = this.add.text(this.buildingX, this.buildingY - 90, '[E] Enter Race', {
      fontSize: '16px',
      fontFamily: 'monospace',
      color: '#ffdd44',
      backgroundColor: '#000000aa',
      padding: { x: 8, y: 4 },
    }).setOrigin(0.5, 1).setDepth(20).setAlpha(0);

    this.tweens.add({
      targets: this.ePrompt,
      scaleY: 1.08,
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    // Input
    const kb = this.input.keyboard!;
    this.keys = {
      W: kb.addKey(Phaser.Input.Keyboard.KeyCodes.W),
      A: kb.addKey(Phaser.Input.Keyboard.KeyCodes.A),
      S: kb.addKey(Phaser.Input.Keyboard.KeyCodes.S),
      D: kb.addKey(Phaser.Input.Keyboard.KeyCodes.D),
    };
    this.eKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.E);
    this.eKey.on('down', () => {
      const dist = Phaser.Math.Distance.Between(this.playerX, this.playerY, this.buildingX, this.buildingY);
      if (dist <= INTERACT_DIST) this.enterRace();
    });

    // WASD hint
    this.add.text(10, height - 30, 'WASD to move · E to interact', {
      fontSize: '12px', fontFamily: 'monospace', color: '#555',
    }).setScrollFactor(0).setDepth(100);

    // Profile HUD
    const authId = this.authState?.session?.user?.id;
    if (authId) this.createProfileHud(authId).catch(() => {});

    // Cleanup
    this.events.on('shutdown', () => this.cleanupScene());
    this.events.on('destroy', () => this.cleanupScene());
  }

  update(_time: number, delta: number): void {
    const speed = MOVE_SPEED * (delta / 1000);

    const w = this.keys.W.isDown;
    const a = this.keys.A.isDown;
    const s = this.keys.S.isDown;
    const d = this.keys.D.isDown;

    let dx = 0, dy = 0;
    if (w) dy -= 1;
    if (s) dy += 1;
    if (a) dx -= 1;
    if (d) dx += 1;

    const moving = dx !== 0 || dy !== 0;

    if (moving) {
      if (dx !== 0 && dy !== 0) {
        const norm = Math.SQRT2 / 2;
        dx *= norm;
        dy *= norm;
      }

      this.playerX = Phaser.Math.Clamp(this.playerX + dx * speed, this.groundBounds.left, this.groundBounds.right);
      this.playerY = Phaser.Math.Clamp(this.playerY + dy * speed, this.groundBounds.top, this.groundBounds.bottom);
      this.player.setPosition(this.playerX, this.playerY);

      const dir = this.resolveDir(w, a, s, d);
      const walkKey = `${CHAR_KEY}_walk_${dir}`;
      if (dir !== this.playerFacing || !this.player.anims.isPlaying || this.player.anims.currentAnim?.key.includes('idle')) {
        this.playerFacing = dir;
        this.player.play(walkKey, true);
      }
    } else {
      const idleKey = `${CHAR_KEY}_idle_${this.playerFacing}`;
      if (!this.player.anims.currentAnim?.key.includes('idle')) {
        this.player.play(idleKey, true);
      }
    }

    // Update name label position
    this.playerLabel.setPosition(this.playerX, this.playerY - 55);

    // Send position to lobby room — always send on movement state change
    if (this.lobbyRoom) {
      const movedEnough = Math.abs(this.playerX - this.lastSentX) > 2 || Math.abs(this.playerY - this.lastSentY) > 2;
      const stateChanged = moving !== this.lastSentMoving;
      if (movedEnough || stateChanged) {
        this.lobbyRoom.send('move', { x: this.playerX, y: this.playerY, facing: this.playerFacing, moving });
        this.lastSentX = this.playerX;
        this.lastSentY = this.playerY;
        this.lastSentMoving = moving;
      }
    }

    // Lerp other players toward their target positions
    for (const other of this.otherPlayers.values()) {
      other.sprite.x += (other.targetX - other.sprite.x) * 0.15;
      other.sprite.y += (other.targetY - other.sprite.y) * 0.15;
      other.label.setPosition(other.sprite.x, other.sprite.y - 55);
    }

    // E prompt
    const dist = Phaser.Math.Distance.Between(this.playerX, this.playerY, this.buildingX, this.buildingY);
    this.ePrompt.setAlpha(dist <= INTERACT_DIST ? 1 : 0);
  }

  private resolveDir(w: boolean, a: boolean, s: boolean, d: boolean): string {
    if (w && d)  return 'WD';
    if (w && a)  return 'WA';
    if (s && d)  return 'SD';
    if (s && a)  return 'SA';
    if (w)       return 'W';
    if (s)       return 'S';
    if (a)       return 'A';
    if (d)       return 'D';
    return this.playerFacing;
  }

  private drawBuilding(bx: number, by: number): void {
    const g = this.add.graphics().setDepth(5);

    // Shadow
    g.fillStyle(0x000000, 0.3);
    g.fillRect(bx - 55 + 6, by - 80 + 8, 110, 160);

    // Building body
    g.fillStyle(0x2a2a4a, 1);
    g.fillRect(bx - 55, by - 80, 110, 160);

    // Roof
    g.fillStyle(0x3a3a6a, 1);
    g.fillRect(bx - 55, by - 80, 110, 18);

    // Door
    g.fillStyle(0x1a1a3a, 1);
    g.fillRect(bx - 20, by + 20, 40, 60);
    g.fillStyle(0xffcc44, 0.15);
    g.fillRect(bx - 18, by + 22, 36, 56);
    g.fillStyle(0xffcc44, 1);
    g.fillCircle(bx + 12, by + 52, 3);

    // Neon sign
    g.lineStyle(2, 0xff4466, 1);
    g.strokeRect(bx - 45, by - 68, 90, 24);

    this.add.text(bx, by - 56, 'CRAZY RACE', {
      fontSize: '12px', fontFamily: 'monospace', color: '#ff4466', fontStyle: 'bold',
    }).setOrigin(0.5, 0.5).setDepth(6);
  }

  private registerAnimations(): void {
    const allDirs = ['S', 'SA', 'A', 'WA', 'W', 'WD', 'D', 'SD'];
    for (const charKey of PL_CHAR_KEYS) {
      for (const dir of allDirs) {
        const suffix = PIXELLAB_DIR_MAP[dir].sheetSuffix;
        const walkKey = `${charKey}_walk_${dir}`;
        const idleKey = `${charKey}_idle_${dir}`;

        if (!this.anims.exists(walkKey)) {
          this.anims.create({
            key: walkKey,
            frames: this.anims.generateFrameNumbers(`${charKey}${suffix}`, { start: 0, end: 5 }),
            frameRate: 10,
            repeat: -1,
          });
        }
        if (!this.anims.exists(idleKey)) {
          this.anims.create({
            key: idleKey,
            frames: this.anims.generateFrameNumbers(`${charKey}_idle${suffix}`, { start: 0, end: 3 }),
            frameRate: 4,
            repeat: -1,
          });
        }
      }
    }
  }

  private async connectLobby(): Promise<void> {
    const { Client } = await import('colyseus.js');
    const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
    const host = window.location.hostname;
    const port = window.location.port || (protocol === 'wss:' ? '443' : '80');
    const wsPort = (port === '8080' || port === '5173') ? '3000' : port;
    const wsUrl = `${protocol}//${host}:${wsPort}`;
    const client = new Client(wsUrl);

    const playerName = this.authState?.username ?? 'Player';
    this.lobbyRoom = await client.joinOrCreate('lobby', { playerName, charKey: CHAR_KEY });

    this.lobbyRoom.onMessage('lobbyState', (data: { players: { sessionId: string; playerName: string; x: number; y: number; facing: string; moving: boolean; charKey: string }[] }) => {
      const myId = this.lobbyRoom?.sessionId;
      const seen = new Set<string>();

      for (const p of data.players) {
        if (p.sessionId === myId) continue;
        seen.add(p.sessionId);

        let other = this.otherPlayers.get(p.sessionId);
        if (!other) {
          const sprite = this.add.sprite(p.x, p.y, `${p.charKey}_south-east`)
            .setScale(0.75).setOrigin(0.5, 0.85).setDepth(9);
          const label = this.add.text(p.x, p.y - 55, p.playerName, {
            fontSize: '13px', fontFamily: 'monospace', color: '#ffffff', fontStyle: 'bold',
          }).setOrigin(0.5, 1).setDepth(9);
          other = { sprite, label, targetX: p.x, targetY: p.y };
          this.otherPlayers.set(p.sessionId, other);
        }

        other.targetX = p.x;
        other.targetY = p.y;

        // Update animation
        const charKey = p.charKey || 'male';
        if (p.moving) {
          const walkKey = `${charKey}_walk_${p.facing}`;
          if (other.sprite.anims.currentAnim?.key !== walkKey) {
            other.sprite.play(walkKey, true);
          }
        } else {
          const idleKey = `${charKey}_idle_${p.facing}`;
          if (!other.sprite.anims.currentAnim?.key.includes('idle')) {
            other.sprite.play(idleKey, true);
          }
        }
      }

      // Remove disconnected players
      for (const [sid, other] of this.otherPlayers) {
        if (!seen.has(sid)) {
          other.sprite.destroy();
          other.label.destroy();
          this.otherPlayers.delete(sid);
        }
      }
    });

    this.lobbyRoom.onLeave(() => {
      this.lobbyRoom = null;
    });
  }

  private async enterRace(): Promise<void> {
    if (this.inQueue) return;
    this.inQueue = true;

    try {
      const { Client } = await import('colyseus.js');
      const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
      const host = window.location.hostname;
      const port = window.location.port || (protocol === 'wss:' ? '443' : '80');
      const wsPort = (port === '8080' || port === '5173') ? '3000' : port;
      const wsUrl = `${protocol}//${host}:${wsPort}`;
      const client = new Client(wsUrl);

      const authId = this.authState?.session?.user?.id;
      const playerName = this.authState?.username ?? 'Player';
      this.queueRoom = await client.joinOrCreate('queue', { playerName, authId });

      this.showQueueUI();

      this.queueRoom.onMessage('playerList', (players: { sessionId: string; playerName: string; ready: boolean }[]) => {
        this.updateQueueUI(players);
      });

      this.queueRoom.onMessage('countdown', (data: { seconds: number; cancelled?: boolean }) => {
        this.updateQueueCountdown(data.seconds, data.cancelled ?? false);
      });

      this.queueRoom.onMessage('launchRace', () => {
        this.destroyQueueUI();
        this.cameras.main.flash(300, 255, 200, 50);
        this.time.delayedCall(400, () => {
          this.scene.start('IsoScene', { authState: this.authState });
        });
      });

      this.queueRoom.onLeave(() => {
        this.destroyQueueUI();
        this.inQueue = false;
        this.queueRoom = null;
      });
    } catch (e) {
      console.error('[LobbyScene] Failed to join queue:', e);
      this.inQueue = false;
    }
  }

  private showQueueUI(): void {
    if (this.queueOverlay) return;

    const overlay = document.createElement('div');
    overlay.id = 'queue-overlay';
    overlay.style.cssText = `
      position: fixed; top: 0; left: 0; width: 100%; height: 100%;
      background: rgba(0,0,0,0.75); display: flex; align-items: center;
      justify-content: center; z-index: 8000; font-family: monospace;
    `;
    overlay.innerHTML = `
      <div style="background: #1a1a2e; border: 2px solid #444; border-radius: 8px; padding: 28px; width: 380px; color: #eee; text-align: center;">
        <h2 style="margin: 0 0 20px; color: #ff4466; font-size: 22px;">CRAZY RACE</h2>
        <div id="queue-players" style="margin-bottom: 16px; text-align: left; font-size: 14px;"></div>
        <div id="queue-countdown" style="color: #ffdd44; font-size: 18px; margin-bottom: 16px; display: none;"></div>
        <button id="queue-ready-btn" style="padding: 12px 32px; background: #44bb44; border: none; color: #fff; border-radius: 6px; cursor: pointer; font-family: monospace; font-weight: bold; font-size: 16px;">READY</button>
        <br/>
        <button id="queue-leave-btn" style="margin-top: 12px; padding: 8px 24px; background: transparent; border: 1px solid #555; color: #888; border-radius: 4px; cursor: pointer; font-family: monospace; font-size: 12px;">Leave Queue</button>
        <p style="margin: 12px 0 0; font-size: 11px; color: #555;">Need at least 2 players. All must be ready.</p>
      </div>
    `;
    document.body.appendChild(overlay);
    this.queueOverlay = overlay;

    // Stop keyboard from reaching Phaser
    overlay.addEventListener('keydown', (e) => e.stopPropagation());
    overlay.addEventListener('keyup', (e) => e.stopPropagation());

    document.getElementById('queue-ready-btn')!.onclick = () => {
      if (this.queueRoom) this.queueRoom.send('ready');
    };

    document.getElementById('queue-leave-btn')!.onclick = () => {
      if (this.queueRoom) {
        this.queueRoom.leave();
        this.queueRoom = null;
      }
      this.destroyQueueUI();
      this.inQueue = false;
    };
  }

  private updateQueueUI(players: { sessionId: string; playerName: string; ready: boolean }[]): void {
    const el = document.getElementById('queue-players');
    if (!el) return;

    const myId = this.queueRoom?.sessionId;
    el.innerHTML = players.map(p => {
      const isMe = p.sessionId === myId;
      const status = p.ready ? '✓ Ready' : '○ Not Ready';
      const color = p.ready ? '#44ff44' : '#888';
      const name = isMe ? `<b>${p.playerName} (you)</b>` : p.playerName;
      return `<div style="margin: 6px 0; color: ${color};">${status} — ${name}</div>`;
    }).join('');

    // Update ready button text
    const btn = document.getElementById('queue-ready-btn') as HTMLButtonElement;
    const me = players.find(p => p.sessionId === myId);
    if (btn && me) {
      btn.textContent = me.ready ? 'NOT READY' : 'READY';
      btn.style.background = me.ready ? '#aa4444' : '#44bb44';
    }
  }

  private updateQueueCountdown(seconds: number, cancelled: boolean): void {
    const el = document.getElementById('queue-countdown');
    if (!el) return;

    if (cancelled || seconds <= 0) {
      el.style.display = 'none';
      el.textContent = '';
    } else {
      el.style.display = 'block';
      el.textContent = `Starting in ${seconds}...`;
    }
  }

  private destroyQueueUI(): void {
    if (this.queueOverlay) {
      this.queueOverlay.remove();
      this.queueOverlay = null;
    }
  }

  private cleanupScene(): void {
    if (this.profileHud) { this.profileHud.remove(); this.profileHud = null; }
    this.destroyQueueUI();
    if (this.queueRoom) { this.queueRoom.leave(); this.queueRoom = null; }
    if (this.lobbyRoom) { this.lobbyRoom.leave(); this.lobbyRoom = null; }
    for (const other of this.otherPlayers.values()) {
      other.sprite.destroy();
      other.label.destroy();
    }
    this.otherPlayers.clear();
  }

  private async createProfileHud(authId: string): Promise<void> {
    try {
      const protocol = window.location.protocol;
      const host = window.location.hostname;
      const port = window.location.port || (protocol === 'https:' ? '443' : '80');
      const apiPort = (port === '8080' || port === '5173') ? '3000' : port;
      const resp = await fetch(`${protocol}//${host}:${apiPort}/api/player/${authId}`);
      if (!resp.ok) return;
      const player = await resp.json();
      this.renderProfileHud(player);
    } catch { /* skip */ }
  }

  private renderProfileHud(player: { username: string; level: number; xp: number; coins: number }): void {
    if (this.profileHud) this.profileHud.remove();
    const hud = document.createElement('div');
    hud.id = 'profile-hud';
    hud.style.cssText = `
      position: fixed; top: 10px; right: 10px; z-index: 5000;
      background: rgba(0,0,0,0.7); border: 1px solid #444; border-radius: 6px;
      padding: 8px 14px; font-family: monospace; color: #eee; font-size: 13px;
      pointer-events: none;
    `;
    hud.innerHTML = `
      <div style="font-weight: bold; color: #ffdd44; margin-bottom: 4px;">Lv.${player.level} ${player.username}</div>
      <div style="font-size: 11px; color: #aaa;">XP: ${player.xp} &nbsp; Coins: ${player.coins}</div>
    `;
    document.body.appendChild(hud);
    this.profileHud = hud;
  }
}
