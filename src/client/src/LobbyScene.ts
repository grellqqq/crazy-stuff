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
const DEFAULT_CHAR_KEY = 'male';
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
  private charKey = DEFAULT_CHAR_KEY;
  private profilePanel: HTMLDivElement | null = null;
  private profileBtn: HTMLButtonElement | null = null;
  private inventoryPanel: HTMLDivElement | null = null;
  private chatBox: HTMLDivElement | null = null;
  private chatMessages: { name: string; msg: string; time: string }[] = [];
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

  private autoQueue = false;

  init(data: { authState?: AuthState; bgMusic?: Phaser.Sound.BaseSound; autoQueue?: boolean }): void {
    this.authState = data.authState ?? null;
    this.bgMusic = data.bgMusic ?? null;
    this.autoQueue = data.autoQueue ?? false;
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
    this.player = this.add.sprite(this.playerX, this.playerY, `${this.charKey}_south-east`)
      .setScale(0.75)
      .setOrigin(0.5, 0.85)
      .setDepth(10);
    this.player.play(`${this.charKey}_idle_SD`);

    // Player name label
    const myName = this.authState?.username ?? 'Player';
    this.playerLabel = this.add.text(this.playerX, this.playerY - 55, myName, {
      fontSize: '13px', fontFamily: 'monospace', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5, 1).setDepth(11);

    // Connect to multiplayer lobby for presence
    this.connectLobby().then(() => {
      // Auto-open queue if returning from a race with "Play Again"
      if (this.autoQueue) {
        this.autoQueue = false;
        this.enterRace();
      }
    }).catch(e => console.error('[LobbyScene] lobby connect failed:', e));

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

    const iKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.I);
    iKey.on('down', () => this.toggleInventory());

    const enterKey = kb.addKey(Phaser.Input.Keyboard.KeyCodes.ENTER);
    enterKey.on('down', () => {
      const input = document.getElementById('chat-input') as HTMLInputElement | null;
      if (input) input.focus();
    });

    // WASD hint
    this.add.text(10, height - 30, 'WASD move · E interact · P profile · I inventory · Enter chat', {
      fontSize: '12px', fontFamily: 'monospace', color: '#555',
    }).setScrollFactor(0).setDepth(100);

    // Chat box (always visible)
    this.createChatBox();

    // Load equipped character from server and create profile button
    const authId = this.authState?.session?.user?.id;
    if (authId) this.loadEquippedChar(authId).catch(() => {});
    this.createProfileButton();

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
      const walkKey = `${this.charKey}_walk_${dir}`;
      if (dir !== this.playerFacing || !this.player.anims.isPlaying || this.player.anims.currentAnim?.key.includes('idle')) {
        this.playerFacing = dir;
        this.player.play(walkKey, true);
      }
    } else {
      const idleKey = `${this.charKey}_idle_${this.playerFacing}`;
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
    this.lobbyRoom = await client.joinOrCreate('lobby', { playerName, charKey: this.charKey });

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

    this.lobbyRoom.onMessage('chat', (data: { playerName: string; message: string; timestamp: string; sessionId: string }) => {
      this.addChatMessage(data.playerName, data.message, data.timestamp);
      this.showSpeechBubble(data.sessionId, data.message);
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
    if (this.profilePanel) { this.profilePanel.remove(); this.profilePanel = null; }
    const hudBtns = document.getElementById('hud-buttons');
    if (hudBtns) hudBtns.remove();
    this.profileBtn = null;
    this.inventoryBtn = null;
    if (this.inventoryPanel) { this.inventoryPanel.remove(); this.inventoryPanel = null; }
    if (this.chatBox) { this.chatBox.remove(); this.chatBox = null; }
    this.destroyQueueUI();
    if (this.queueRoom) { this.queueRoom.leave(); this.queueRoom = null; }
    if (this.lobbyRoom) { this.lobbyRoom.leave(); this.lobbyRoom = null; }
    for (const other of this.otherPlayers.values()) {
      other.sprite.destroy();
      other.label.destroy();
    }
    this.otherPlayers.clear();
  }

  /** Build the API base URL for REST calls. */
  private apiBase(): string {
    const protocol = window.location.protocol;
    const host = window.location.hostname;
    const port = window.location.port || (protocol === 'https:' ? '443' : '80');
    const apiPort = (port === '8080' || port === '5173') ? '3000' : port;
    return `${protocol}//${host}:${apiPort}`;
  }

  /** Load the player's equipped character from the server on scene start. */
  private async loadEquippedChar(authId: string): Promise<void> {
    try {
      const resp = await fetch(`${this.apiBase()}/api/player/${authId}/equipped-char`);
      if (!resp.ok) return;
      const { charKey } = await resp.json();
      if (charKey && PL_CHAR_KEYS.includes(charKey)) {
        this.charKey = charKey;
        // Update the player sprite to use the loaded character
        this.player.play(`${this.charKey}_idle_${this.playerFacing}`, true);
      }
    } catch { /* DB not available, use default */ }
  }

  /** Persist character selection to the server and notify the lobby room. */
  private async equipCharOnServer(charKey: string): Promise<boolean> {
    const authId = this.authState?.session?.user?.id;
    if (!authId) return false;
    try {
      const resp = await fetch(`${this.apiBase()}/api/player/${authId}/equip-char`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ charKey }),
      });
      return resp.ok;
    } catch {
      return false;
    }
  }

  /** Switch the local player's character and broadcast the change. */
  private switchCharacter(charKey: string): void {
    if (charKey === this.charKey) return;
    this.charKey = charKey;

    // Update local sprite animation
    this.player.play(`${this.charKey}_idle_${this.playerFacing}`, true);

    // Tell the lobby room so other players see the change
    if (this.lobbyRoom) {
      this.lobbyRoom.send('changeChar', { charKey });
    }

    // Persist to DB (fire-and-forget)
    this.equipCharOnServer(charKey);
  }

  /** Create the Profile + Inventory buttons in the top-right corner. */
  private inventoryBtn: HTMLButtonElement | null = null;

  private createProfileButton(): void {
    if (this.profileBtn) return;

    const container = document.createElement('div');
    container.id = 'hud-buttons';
    container.style.cssText = `
      position: fixed; top: 10px; right: 10px; z-index: 5000;
      display: flex; gap: 8px;
    `;

    const btnStyle = `
      background: rgba(0,0,0,0.75); border: 1px solid #555; border-radius: 6px;
      padding: 8px 18px; font-family: monospace; font-size: 14px;
      font-weight: bold; cursor: pointer;
    `;

    const profBtn = document.createElement('button');
    profBtn.textContent = '👤 Profile';
    profBtn.style.cssText = btnStyle + 'color: #ffdd44;';
    profBtn.onmouseenter = () => { profBtn.style.borderColor = '#ffdd44'; };
    profBtn.onmouseleave = () => { profBtn.style.borderColor = '#555'; };
    profBtn.onclick = () => this.toggleProfilePanel();
    container.appendChild(profBtn);
    this.profileBtn = profBtn;

    const invBtn = document.createElement('button');
    invBtn.textContent = '🎒 Inventory';
    invBtn.style.cssText = btnStyle + 'color: #88ccff;';
    invBtn.onmouseenter = () => { invBtn.style.borderColor = '#88ccff'; };
    invBtn.onmouseleave = () => { invBtn.style.borderColor = '#555'; };
    invBtn.onclick = () => this.toggleInventory();
    container.appendChild(invBtn);
    this.inventoryBtn = invBtn;

    document.body.appendChild(container);
  }

  /** Toggle the Profile panel open/closed. */
  private toggleProfilePanel(): void {
    if (this.profilePanel) {
      this.profilePanel.remove();
      this.profilePanel = null;
      return;
    }
    this.openProfilePanel();
  }

  /** Open the Profile panel with Stats and Character tabs. */
  private async openProfilePanel(): Promise<void> {
    if (this.profilePanel) { this.profilePanel.remove(); this.profilePanel = null; }

    const panel = document.createElement('div');
    panel.id = 'profile-panel';
    panel.style.cssText = `
      position: fixed; top: 50px; right: 10px; z-index: 6000;
      background: #1a1a2e; border: 2px solid #444; border-radius: 8px;
      width: 340px; font-family: monospace; color: #eee;
      box-shadow: 0 4px 24px rgba(0,0,0,0.6);
    `;

    // Stop keyboard events from reaching Phaser
    panel.addEventListener('keydown', (e) => e.stopPropagation());
    panel.addEventListener('keyup', (e) => e.stopPropagation());

    // Tab bar
    const tabBar = document.createElement('div');
    tabBar.style.cssText = 'display: flex; border-bottom: 1px solid #333;';

    const tabStats = document.createElement('button');
    tabStats.textContent = 'Stats';
    tabStats.style.cssText = this.tabStyle(true);

    const tabChar = document.createElement('button');
    tabChar.textContent = 'Character';
    tabChar.style.cssText = this.tabStyle(false);

    tabBar.appendChild(tabStats);
    tabBar.appendChild(tabChar);
    panel.appendChild(tabBar);

    // Content area
    const content = document.createElement('div');
    content.id = 'profile-content';
    content.style.cssText = 'padding: 16px;';
    panel.appendChild(content);

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'X';
    closeBtn.style.cssText = `
      position: absolute; top: 6px; right: 10px; background: none;
      border: none; color: #888; font-family: monospace; font-size: 16px;
      cursor: pointer; font-weight: bold;
    `;
    closeBtn.onmouseenter = () => { closeBtn.style.color = '#fff'; };
    closeBtn.onmouseleave = () => { closeBtn.style.color = '#888'; };
    closeBtn.onclick = () => { this.profilePanel?.remove(); this.profilePanel = null; };
    panel.appendChild(closeBtn);

    document.body.appendChild(panel);
    this.profilePanel = panel;

    // Tab click handlers
    const showTab = (tab: 'stats' | 'char') => {
      tabStats.style.cssText = this.tabStyle(tab === 'stats');
      tabChar.style.cssText = this.tabStyle(tab === 'char');
      if (tab === 'stats') {
        this.renderStatsTab(content);
      } else {
        this.renderCharacterTab(content);
      }
    };

    tabStats.onclick = () => showTab('stats');
    tabChar.onclick = () => showTab('char');

    // Default: show stats
    showTab('stats');
  }

  /** Return inline CSS for a tab button. */
  private tabStyle(active: boolean): string {
    return `
      flex: 1; padding: 10px; background: ${active ? '#2a2a4a' : 'transparent'};
      border: none; color: ${active ? '#ffdd44' : '#888'}; font-family: monospace;
      font-size: 14px; font-weight: bold; cursor: pointer;
      border-bottom: 2px solid ${active ? '#ffdd44' : 'transparent'};
    `;
  }

  /** Render the Stats tab content. */
  private async renderStatsTab(container: HTMLElement): Promise<void> {
    container.innerHTML = '<div style="color: #555; text-align: center;">Loading...</div>';
    const authId = this.authState?.session?.user?.id;
    if (!authId) {
      container.innerHTML = '<div style="color: #888; text-align: center;">Not logged in</div>';
      return;
    }

    try {
      const username = encodeURIComponent(this.authState?.username ?? 'Player');
      const resp = await fetch(`${this.apiBase()}/api/player/${authId}?username=${username}`);
      if (!resp.ok) {
        container.innerHTML = '<div style="color: #888; text-align: center;">Could not load profile</div>';
        return;
      }
      const p = await resp.json();
      container.innerHTML = `
        <div style="text-align: center; margin-bottom: 16px;">
          <div style="font-size: 20px; font-weight: bold; color: #ffdd44;">Lv.${p.level} ${p.username}</div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 13px;">
          <div style="background: #222; border-radius: 4px; padding: 10px; text-align: center;">
            <div style="color: #888; font-size: 11px;">XP</div>
            <div style="color: #4488ff; font-weight: bold;">${p.xp}</div>
          </div>
          <div style="background: #222; border-radius: 4px; padding: 10px; text-align: center;">
            <div style="color: #888; font-size: 11px;">Coins</div>
            <div style="color: #ffcc44; font-weight: bold;">${p.coins}</div>
          </div>
          <div style="background: #222; border-radius: 4px; padding: 10px; text-align: center;">
            <div style="color: #888; font-size: 11px;">Races</div>
            <div style="color: #eee; font-weight: bold;">${p.total_races ?? 0}</div>
          </div>
          <div style="background: #222; border-radius: 4px; padding: 10px; text-align: center;">
            <div style="color: #888; font-size: 11px;">Wins</div>
            <div style="color: #44bb44; font-weight: bold;">${p.total_wins ?? 0}</div>
          </div>
        </div>
      `;
    } catch {
      container.innerHTML = '<div style="color: #888; text-align: center;">Could not load profile</div>';
    }
  }

  /** Character display names for the select grid. */
  private static readonly CHAR_LABELS: Record<string, string> = {
    'male': 'Male Light',
    'female': 'Female Light',
    'male-medium': 'Male Medium',
    'female-medium': 'Female Medium',
    'male-dark': 'Male Dark',
    'female-dark': 'Female Dark',
  };

  /** Render the Character Select tab content. */
  private renderCharacterTab(container: HTMLElement): void {
    container.innerHTML = '';

    const heading = document.createElement('div');
    heading.style.cssText = 'text-align: center; margin-bottom: 12px; color: #aaa; font-size: 12px;';
    heading.textContent = 'Select your character';
    container.appendChild(heading);

    const grid = document.createElement('div');
    grid.style.cssText = 'display: grid; grid-template-columns: 1fr 1fr; gap: 8px;';

    for (const key of PL_CHAR_KEYS) {
      const isSelected = key === this.charKey;
      const card = document.createElement('button');
      card.dataset.charKey = key;
      card.style.cssText = `
        background: ${isSelected ? '#2a2a4a' : '#181828'};
        border: 2px solid ${isSelected ? '#ffdd44' : '#333'};
        border-radius: 6px; padding: 12px 8px; cursor: pointer;
        color: #eee; font-family: monospace; font-size: 12px;
        text-align: center; transition: border-color 0.15s;
      `;
      card.onmouseenter = () => { if (key !== this.charKey) card.style.borderColor = '#666'; };
      card.onmouseleave = () => { card.style.borderColor = key === this.charKey ? '#ffdd44' : '#333'; };

      // Character preview — use a canvas to render the first idle frame
      const preview = document.createElement('canvas');
      preview.width = 64;
      preview.height = 64;
      preview.style.cssText = 'display: block; margin: 0 auto 6px; image-rendering: pixelated;';
      this.drawCharPreview(preview, key);
      card.appendChild(preview);

      const label = document.createElement('div');
      label.textContent = LobbyScene.CHAR_LABELS[key] ?? key;
      label.style.cssText = `font-weight: ${isSelected ? 'bold' : 'normal'}; color: ${isSelected ? '#ffdd44' : '#ccc'};`;
      card.appendChild(label);

      if (isSelected) {
        const badge = document.createElement('div');
        badge.textContent = 'EQUIPPED';
        badge.style.cssText = 'font-size: 10px; color: #44bb44; margin-top: 4px;';
        card.appendChild(badge);
      }

      card.onclick = () => {
        this.switchCharacter(key);
        // Re-render tab to update selection state
        this.renderCharacterTab(container);
      };

      grid.appendChild(card);
    }

    container.appendChild(grid);
  }

  /** Draw a small preview of a character's idle south-east frame onto a canvas. */
  private drawCharPreview(canvas: HTMLCanvasElement, charKey: string): void {
    try {
      const textureKey = `${charKey}_idle_south-east`;
      const tex = this.textures.get(textureKey);
      if (!tex || tex.key === '__MISSING') return;
      const frame = tex.get(0);
      if (!frame) return;
      const source = frame.source.image as HTMLImageElement | HTMLCanvasElement;
      const ctx = canvas.getContext('2d');
      if (!ctx) return;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      // Draw first frame of the idle spritesheet, scaled to fit
      ctx.drawImage(
        source,
        frame.cutX, frame.cutY, frame.cutWidth, frame.cutHeight,
        (canvas.width - 56) / 2, (canvas.height - 56) / 2, 56, 56,
      );
    } catch { /* texture not loaded yet, leave blank */ }
  }

  // ─── Chat ───────────────────────────────────────────────────────────────

  private createChatBox(): void {
    const box = document.createElement('div');
    box.id = 'chat-box';
    box.style.cssText = `
      position: fixed; bottom: 50px; left: 10px; width: 320px; z-index: 6000;
      font-family: monospace; pointer-events: auto;
    `;
    box.innerHTML = `
      <div id="chat-messages" style="
        height: 160px; overflow-y: auto; background: rgba(0,0,0,0.6);
        border: 1px solid #333; border-bottom: none; border-radius: 4px 4px 0 0;
        padding: 6px 8px; font-size: 12px; color: #ccc;
      "></div>
      <div style="display: flex;">
        <input id="chat-input" type="text" placeholder="Press Enter to chat..." maxlength="100"
          style="flex: 1; padding: 8px; background: #111; border: 1px solid #333;
          color: #fff; font-family: monospace; font-size: 12px; outline: none;
          border-radius: 0 0 0 4px;" />
        <button id="chat-send" style="padding: 8px 12px; background: #333; border: 1px solid #333;
          color: #aaa; cursor: pointer; font-family: monospace; border-radius: 0 0 4px 0;">Send</button>
      </div>
    `;
    document.body.appendChild(box);
    this.chatBox = box;

    const input = document.getElementById('chat-input') as HTMLInputElement;
    const sendBtn = document.getElementById('chat-send') as HTMLButtonElement;

    // Stop keyboard events from reaching Phaser
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (e.key === 'Enter' && input.value.trim()) {
        this.sendChat(input.value.trim());
        input.value = '';
        input.blur(); // unfocus so player can move again
      } else if (e.key === 'Escape') {
        input.blur();
      }
    });
    input.addEventListener('keyup', (e) => e.stopPropagation());
    input.addEventListener('keypress', (e) => e.stopPropagation());

    sendBtn.onclick = () => {
      if (input.value.trim()) {
        this.sendChat(input.value.trim());
        input.value = '';
      }
    };
  }

  private sendChat(message: string): void {
    if (!this.lobbyRoom) return;
    this.lobbyRoom.send('chat', { message: message.slice(0, 100) });
  }

  private showSpeechBubble(sessionId: string, message: string): void {
    const truncated = message.length > 40 ? message.slice(0, 40) + '...' : message;

    // Find the sprite — either local player or other player
    const myId = this.lobbyRoom?.sessionId;
    let x: number, y: number;

    if (sessionId === myId) {
      x = this.playerX;
      y = this.playerY - 70;
    } else {
      const other = this.otherPlayers.get(sessionId);
      if (!other) return;
      x = other.sprite.x;
      y = other.sprite.y - 70;
    }

    const bubble = this.add.text(x, y, truncated, {
      fontSize: '11px',
      fontFamily: 'monospace',
      color: '#ffffff',
      backgroundColor: '#000000cc',
      padding: { x: 6, y: 3 },
    }).setOrigin(0.5, 1).setDepth(50);

    // Fade out after 3 seconds
    this.tweens.add({
      targets: bubble,
      alpha: 0,
      y: y - 20,
      duration: 3000,
      delay: 2000,
      onComplete: () => bubble.destroy(),
    });
  }

  private addChatMessage(name: string, msg: string, time: string): void {
    this.chatMessages.push({ name, msg, time });
    if (this.chatMessages.length > 50) this.chatMessages.shift();

    const el = document.getElementById('chat-messages');
    if (!el) return;

    const div = document.createElement('div');
    div.style.cssText = 'margin: 3px 0;';
    div.innerHTML = `<span style="color: #ffdd44; font-weight: bold;">${name}:</span> <span style="color: #ccc;">${msg}</span>`;
    el.appendChild(div);
    el.scrollTop = el.scrollHeight;
  }

  // ─── Inventory ──────────────────────────────────────────────────────────

  /** Equipment slot display metadata. */
  private static readonly SLOT_META: Record<string, { label: string; icon: string }> = {
    head_accessory:  { label: 'Head',  icon: '🎩' },
    hair:            { label: 'Hair',  icon: '💇' },
    face_accessory:  { label: 'Face',  icon: '🎭' },
    eyes_accessory:  { label: 'Eyes',  icon: '👓' },
    mouth_accessory: { label: 'Mouth', icon: '👄' },
    upper_body:      { label: 'Upper', icon: '👕' },
    lower_body:      { label: 'Lower', icon: '👖' },
    feet:            { label: 'Feet',  icon: '👟' },
    back:            { label: 'Back',  icon: '🎒' },
    hand_1h:         { label: 'Hand',  icon: '🗡' },
    air_space:       { label: 'Aura',  icon: '✨' },
    skin:            { label: 'Skin',  icon: '🧬' },
  };

  /** Rarity color map used across the inventory UI. */
  private static readonly RARITY_COLORS: Record<string, string> = {
    common: '#888', uncommon: '#44bb44', rare: '#4488ff',
    epic: '#aa44ff', legendary: '#ffaa00', crazy: '#ff44ff',
  };

  private toggleInventory(): void {
    if (this.inventoryPanel) {
      this.inventoryPanel.remove();
      this.inventoryPanel = null;
      return;
    }
    this.openInventory();
  }

  private async openInventory(): Promise<void> {
    if (this.inventoryPanel) { this.inventoryPanel.remove(); this.inventoryPanel = null; }

    const panel = document.createElement('div');
    panel.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: #1a1a2e; border: 2px solid #444; border-radius: 8px;
      padding: 24px; width: 620px; max-height: 80vh; overflow-y: auto;
      z-index: 9000; font-family: monospace; color: #eee;
      box-shadow: 0 8px 32px rgba(0,0,0,0.7);
    `;
    panel.addEventListener('keydown', (e) => e.stopPropagation());
    panel.addEventListener('keyup', (e) => e.stopPropagation());

    // Close button
    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'X';
    closeBtn.style.cssText = `
      position: absolute; top: 8px; right: 12px; background: none; border: none;
      color: #888; font-size: 18px; cursor: pointer; font-family: monospace; font-weight: bold;
    `;
    closeBtn.onmouseenter = () => { closeBtn.style.color = '#fff'; };
    closeBtn.onmouseleave = () => { closeBtn.style.color = '#888'; };
    closeBtn.onclick = () => { this.inventoryPanel?.remove(); this.inventoryPanel = null; };
    panel.appendChild(closeBtn);

    // Title
    const title = document.createElement('h2');
    title.textContent = 'INVENTORY';
    title.style.cssText = 'margin: 0 0 16px; text-align: center; color: #ffdd44; font-size: 18px;';
    panel.appendChild(title);

    // Content container (filled by renderInventoryContent)
    const content = document.createElement('div');
    content.id = 'inventory-content';
    panel.appendChild(content);

    document.body.appendChild(panel);
    this.inventoryPanel = panel;

    await this.renderInventoryContent(content);
  }

  /**
   * Fetch inventory and render both equipment slots and bag grid into the container.
   */
  private async renderInventoryContent(container: HTMLElement): Promise<void> {
    container.innerHTML = '<div style="text-align: center; color: #555; padding: 40px 0;">Loading...</div>';

    const authId = this.authState?.session?.user?.id;
    if (!authId) {
      container.innerHTML = '<div style="text-align: center; color: #666; padding: 40px 0;">Not logged in</div>';
      return;
    }

    let items: any[];
    try {
      const resp = await fetch(`${this.apiBase()}/api/player/${authId}/inventory`);
      if (!resp.ok) throw new Error('fetch failed');
      items = await resp.json();
    } catch {
      container.innerHTML = '<div style="text-align: center; color: #666; padding: 40px 0;">Could not load inventory</div>';
      return;
    }

    container.innerHTML = '';

    // ─── Equipment Slots (top section) ────────────────────────────────
    const equippedSection = document.createElement('div');
    equippedSection.style.cssText = 'margin-bottom: 20px;';

    const equippedHeading = document.createElement('div');
    equippedHeading.textContent = 'EQUIPMENT';
    equippedHeading.style.cssText = 'font-size: 12px; color: #888; margin-bottom: 8px; letter-spacing: 2px;';
    equippedSection.appendChild(equippedHeading);

    // Build a map: item_type -> equipped item
    const equippedBySlot = new Map<string, any>();
    for (const item of (items ?? [])) {
      if (item.equipped) {
        equippedBySlot.set(item.item_type, item);
      }
    }

    // Character preview on the left, slots on the right
    const equipRow = document.createElement('div');
    equipRow.style.cssText = 'display: flex; gap: 16px; align-items: flex-start;';

    // Character preview
    const previewWrap = document.createElement('div');
    previewWrap.style.cssText = `
      flex-shrink: 0; width: 120px; text-align: center;
      background: #111; border: 1px solid #333; border-radius: 6px; padding: 12px 8px;
    `;
    const previewCanvas = document.createElement('canvas');
    previewCanvas.width = 92;
    previewCanvas.height = 92;
    previewCanvas.style.cssText = 'display: block; margin: 0 auto 8px; image-rendering: pixelated;';
    this.drawCharPreview(previewCanvas, this.charKey);
    previewWrap.appendChild(previewCanvas);

    const charLabel = document.createElement('div');
    charLabel.textContent = LobbyScene.CHAR_LABELS[this.charKey] ?? this.charKey;
    charLabel.style.cssText = 'font-size: 11px; color: #aaa;';
    previewWrap.appendChild(charLabel);
    equipRow.appendChild(previewWrap);

    // Slot grid (4 columns)
    const slotGrid = document.createElement('div');
    slotGrid.style.cssText = 'display: grid; grid-template-columns: repeat(4, 1fr); gap: 6px; flex: 1;';

    const slotKeys = Object.keys(LobbyScene.SLOT_META);
    for (const slotKey of slotKeys) {
      const meta = LobbyScene.SLOT_META[slotKey];
      const equipped = equippedBySlot.get(slotKey);

      const slot = document.createElement('div');
      const borderColor = equipped ? (LobbyScene.RARITY_COLORS[equipped.rarity] ?? '#555') : '#2a2a3a';
      slot.style.cssText = `
        background: ${equipped ? '#1e1e30' : '#131320'}; border: 2px solid ${borderColor};
        border-radius: 6px; padding: 6px 4px; text-align: center; cursor: ${equipped ? 'pointer' : 'default'};
        min-height: 60px; display: flex; flex-direction: column; align-items: center; justify-content: center;
      `;

      if (equipped) {
        slot.innerHTML = `
          <div style="font-size: 16px; margin-bottom: 2px;">${meta.icon}</div>
          <div style="font-size: 10px; color: #eee; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; max-width: 90px;">${equipped.item_id}</div>
          <div style="font-size: 9px; color: ${borderColor}; text-transform: capitalize;">${equipped.rarity}</div>
        `;
        slot.title = `${meta.label}: ${equipped.item_id} (${equipped.rarity}) - Click to unequip`;
        slot.onmouseenter = () => { slot.style.borderColor = '#ffdd44'; };
        slot.onmouseleave = () => { slot.style.borderColor = borderColor; };
        slot.onclick = () => this.toggleEquipItem(equipped.id, false, container);
      } else {
        slot.innerHTML = `
          <div style="font-size: 16px; opacity: 0.3; margin-bottom: 2px;">${meta.icon}</div>
          <div style="font-size: 9px; color: #444;">${meta.label}</div>
        `;
        slot.title = `${meta.label}: empty`;
      }

      slotGrid.appendChild(slot);
    }

    equipRow.appendChild(slotGrid);
    equippedSection.appendChild(equipRow);
    container.appendChild(equippedSection);

    // ─── Bag / All Items (bottom section) ─────────────────────────────
    const bagSection = document.createElement('div');

    const bagHeading = document.createElement('div');
    bagHeading.textContent = `BAG (${items?.length ?? 0} items)`;
    bagHeading.style.cssText = 'font-size: 12px; color: #888; margin-bottom: 8px; letter-spacing: 2px; border-top: 1px solid #333; padding-top: 12px;';
    bagSection.appendChild(bagHeading);

    if (!items || items.length === 0) {
      const empty = document.createElement('div');
      empty.style.cssText = 'text-align: center; color: #555; padding: 30px 0;';
      empty.innerHTML = `
        <div style="font-size: 28px; margin-bottom: 8px;">...</div>
        <div>No items yet</div>
        <div style="font-size: 11px; margin-top: 6px; color: #444;">Win races and visit the store to earn items!</div>
      `;
      bagSection.appendChild(empty);
    } else {
      const bagGrid = document.createElement('div');
      bagGrid.style.cssText = 'display: grid; grid-template-columns: repeat(5, 1fr); gap: 8px;';

      for (const item of items) {
        const card = document.createElement('div');
        const borderColor = LobbyScene.RARITY_COLORS[item.rarity] ?? '#444';
        const isEquipped = !!item.equipped;
        card.style.cssText = `
          background: ${isEquipped ? '#1e1e30' : '#181828'}; border: 2px solid ${borderColor};
          border-radius: 6px; padding: 8px 4px; text-align: center; cursor: pointer; position: relative;
        `;

        const slotMeta = LobbyScene.SLOT_META[item.item_type];
        const slotIcon = slotMeta?.icon ?? '?';
        const slotLabel = slotMeta?.label ?? item.item_type;

        card.innerHTML = `
          <div style="width: 36px; height: 36px; background: ${borderColor}22; border-radius: 4px;
            margin: 0 auto 4px; display: flex; align-items: center; justify-content: center;
            font-size: 18px;">${slotIcon}</div>
          <div style="font-size: 10px; color: #eee; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${item.item_id}</div>
          <div style="font-size: 9px; color: ${borderColor}; text-transform: capitalize;">${item.rarity}</div>
          <div style="font-size: 9px; color: #555; margin-top: 2px;">${slotLabel}</div>
          ${isEquipped ? '<div style="font-size: 9px; color: #ffdd44; margin-top: 2px; font-weight: bold;">EQUIPPED</div>' : ''}
        `;

        card.title = isEquipped
          ? `${item.item_id} (${item.rarity} ${slotLabel}) - Click to unequip`
          : `${item.item_id} (${item.rarity} ${slotLabel}) - Click to equip`;

        card.onmouseenter = () => { card.style.borderColor = '#ffdd44'; };
        card.onmouseleave = () => { card.style.borderColor = borderColor; };
        card.onclick = () => this.toggleEquipItem(item.id, !isEquipped, container);
        bagGrid.appendChild(card);
      }

      bagSection.appendChild(bagGrid);
    }

    container.appendChild(bagSection);
  }

  /**
   * Equip or unequip an item, then re-render inventory content in place.
   */
  private async toggleEquipItem(itemId: string, equip: boolean, contentContainer?: HTMLElement): Promise<void> {
    const authId = this.authState?.session?.user?.id;
    if (!authId) return;
    try {
      await fetch(`${this.apiBase()}/api/player/${authId}/equip`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ inventoryItemId: itemId, equipped: equip }),
      });
      // Re-fetch and re-render in place if we have the container
      if (contentContainer) {
        await this.renderInventoryContent(contentContainer);
      } else {
        // Fallback: reopen the whole panel
        this.openInventory();
      }
    } catch { /* ignore */ }
  }
}
