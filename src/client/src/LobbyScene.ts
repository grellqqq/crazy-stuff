import Phaser from 'phaser';
import { type AuthState } from './auth';
import { ITEMS, equipmentBodyKey } from '../../shared/items';
import { buildEquipSlot, buildBagCard, SLOT_META as ITEM_SLOT_META, drawItemThumbnail, RARITY_COLORS } from './itemDisplay';

// East-side direction suffixes the body actually renders (west mirrors east
// via flipX). Equipment overlays load the same five and mirror identically.
const EQUIP_SUFFIXES = ['south', 'south-east', 'east', 'north-east', 'north'];
// Paste order for equipment layers over the body (back-most first).
const LOBBY_LAYER_ORDER = [
  'back', 'lower_body', 'feet', 'upper_body', 'hand_1h',
  'face_accessory', 'eyes_accessory', 'mouth_accessory', 'hair',
  'head_accessory', 'air_space',
];

interface OtherPlayer {
  sprite: Phaser.GameObjects.Sprite;
  label: Phaser.GameObjects.Text;
  targetX: number;
  targetY: number;
  bubble?: Phaser.GameObjects.Text;
  charKey: string;
  facing: string;
  moving: boolean;
  loadout: Record<string, string>;
  equip: Map<string, Phaser.GameObjects.Sprite>;
  equipSig: string;
}

const PL_CHAR_KEYS = ['male', 'female', 'male-medium', 'female-medium', 'male-dark', 'female-dark'];
const PL_DIRS = ['south', 'south-east', 'east', 'north-east', 'north', 'north-west', 'west', 'south-west'];

// West-facing directions reuse east textures with flipX=true (matches IsoScene).
// PixelLab generates west frames inconsistently, so mirroring east is more reliable.
const PIXELLAB_DIR_MAP: Record<string, { sheetSuffix: string; flipX: boolean }> = {
  S:  { sheetSuffix: '_south',       flipX: false },
  SA: { sheetSuffix: '_south-east',  flipX: true  },
  A:  { sheetSuffix: '_east',        flipX: true  },
  WA: { sheetSuffix: '_north-east',  flipX: true  },
  W:  { sheetSuffix: '_north',       flipX: false },
  WD: { sheetSuffix: '_north-east',  flipX: false },
  D:  { sheetSuffix: '_east',        flipX: false },
  SD: { sheetSuffix: '_south-east',  flipX: false },
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

  private gachaX = 0;
  private gachaY = 0;
  private gachaPrompt!: Phaser.GameObjects.Text;
  private gachaPanel: HTMLDivElement | null = null;

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
  private otherPlayers = new Map<string, OtherPlayer>();
  private localBubble?: Phaser.GameObjects.Text;
  private playerLabel!: Phaser.GameObjects.Text;

  // Local player's equipment layers (mirror the body sprite).
  private myLoadout: Record<string, string> = {};
  private myEquip = new Map<string, Phaser.GameObjects.Sprite>();
  private myEquipSig = '';
  private loadedEquip = new Set<string>();
  private loadingEquip = new Set<string>();
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

    // Gacha machine on the left
    this.gachaX = 120;
    this.gachaY = cy;
    this.drawGachaMachine(this.gachaX, this.gachaY);

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

    // Gacha machine interact prompt
    this.gachaPrompt = this.add.text(this.gachaX, this.gachaY - 70, '[E] Gacha', {
      fontSize: '16px',
      fontFamily: 'monospace',
      color: '#ffdd44',
      backgroundColor: '#000000aa',
      padding: { x: 8, y: 4 },
    }).setOrigin(0.5, 1).setDepth(20).setAlpha(0);

    this.tweens.add({
      targets: this.gachaPrompt,
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
      // Gacha machine takes priority when in range (it's the nearer object on its side).
      const dGacha = Phaser.Math.Distance.Between(this.playerX, this.playerY, this.gachaX, this.gachaY);
      if (dGacha <= INTERACT_DIST) { this.toggleGacha(); return; }
      const dRace = Phaser.Math.Distance.Between(this.playerX, this.playerY, this.buildingX, this.buildingY);
      if (dRace <= INTERACT_DIST) this.enterRace();
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
      this.player.setFlipX(PIXELLAB_DIR_MAP[dir].flipX);
    } else {
      const idleKey = `${this.charKey}_idle_${this.playerFacing}`;
      if (!this.player.anims.currentAnim?.key.includes('idle')) {
        this.player.play(idleKey, true);
      }
      this.player.setFlipX(PIXELLAB_DIR_MAP[this.playerFacing].flipX);
    }

    // Update name label + speech bubble position
    this.playerLabel.setPosition(this.playerX, this.playerY - 55);
    this.localBubble?.setPosition(this.playerX, this.playerY - 70);
    // Keep our equipment layers glued to the body.
    this.syncEquip(this.myEquip, this.playerX, this.playerY, this.playerFacing, moving, 10);

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
      other.bubble?.setPosition(other.sprite.x, other.sprite.y - 70);
      this.syncEquip(other.equip, other.sprite.x, other.sprite.y, other.facing, other.moving, 9);
    }

    // E prompts (race building + gacha machine)
    const dist = Phaser.Math.Distance.Between(this.playerX, this.playerY, this.buildingX, this.buildingY);
    this.ePrompt.setAlpha(dist <= INTERACT_DIST ? 1 : 0);
    const dGacha = Phaser.Math.Distance.Between(this.playerX, this.playerY, this.gachaX, this.gachaY);
    this.gachaPrompt.setAlpha(dGacha <= INTERACT_DIST ? 1 : 0);
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

  /** Draw a capsule-toy ("gachapon") machine. Placeholder art until real
   *  pixel-art lands — see gacha GDD §24. */
  private drawGachaMachine(gx: number, gy: number): void {
    const g = this.add.graphics().setDepth(5);

    // Ground shadow
    g.fillStyle(0x000000, 0.3);
    g.fillEllipse(gx, gy + 80, 86, 20);

    // Machine body (rounded) + darker base
    g.fillStyle(0xcc2244, 1);
    g.fillRoundedRect(gx - 38, gy - 28, 76, 106, 12);
    g.fillStyle(0x88142e, 1);
    g.fillRoundedRect(gx - 38, gy + 42, 76, 36, 12);

    // Capsule chamber: dark backing + translucent glass dome
    g.fillStyle(0x1a2433, 1);
    g.fillCircle(gx, gy - 18, 33);
    g.fillStyle(0x88ccee, 0.35);
    g.fillCircle(gx, gy - 18, 29);

    // Capsules inside the dome
    const caps: Array<[number, number, number]> = [
      [0xffdd44, -12, -8], [0x44bb44, 11, -2], [0xff66aa, -4, 6],
      [0x66aaff, 14, -14], [0xaa66ff, 0, -16],
    ];
    for (const [c, ox, oy] of caps) {
      g.fillStyle(c, 1);
      g.fillCircle(gx + ox, gy - 18 + oy, 7);
    }

    // Dispenser slot + turn knob
    g.fillStyle(0x141414, 1);
    g.fillRoundedRect(gx - 16, gy + 50, 32, 18, 4);
    g.fillStyle(0xffdd44, 1);
    g.fillCircle(gx + 24, gy + 30, 5);

    // Label
    this.add.text(gx, gy + 14, 'GACHA', {
      fontSize: '13px', fontFamily: 'monospace', color: '#ffffff', fontStyle: 'bold',
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

  // ─── Equipment layers (walk + idle; mirrors IsoScene, degrades gracefully) ──

  /** 8-way direction key → body's east-side suffix + flipX. */
  private equipDir(dir: string): { suffix: string; flip: boolean } {
    const m = PIXELLAB_DIR_MAP[dir] ?? PIXELLAB_DIR_MAP['SD'];
    return { suffix: m.sheetSuffix.slice(1), flip: m.flipX };
  }

  /** Body-specific texture/anim key for an item, or null if not layerable. */
  private eqKeyFor(itemId: string, charKey: string): string | null {
    const def = ITEMS[itemId];
    if (!def || def.slot === 'skin') return null;
    return `${itemId}_${equipmentBodyKey(itemId, charKey)}`;
  }

  /** Stable string that changes whenever the visible outfit/body changes. */
  private equipSignature(loadout: Record<string, string>, charKey: string): string {
    return charKey + '|' + LOBBY_LAYER_ORDER.map((sl) => loadout[sl] ?? '').join(',');
  }

  /** Load walk+idle sheets for every item in `loadout`, then run onReady. A
   *  missing file just means that layer is skipped (body still shows). */
  private ensureEquipLoaded(loadout: Record<string, string>, charKey: string, onReady: () => void): void {
    const toLoad: Array<{ itemId: string; slot: string; eqKey: string }> = [];
    for (const itemId of Object.values(loadout)) {
      const eqKey = this.eqKeyFor(itemId, charKey);
      if (!eqKey) continue;
      if (this.loadedEquip.has(eqKey) || this.loadingEquip.has(eqKey)) continue;
      toLoad.push({ itemId, slot: ITEMS[itemId].slot, eqKey });
    }
    if (toLoad.length === 0) { onReady(); return; }
    const bust = new URLSearchParams(window.location.search).has('dev') ? `?v=${Date.now()}` : '';
    for (const { itemId, slot, eqKey } of toLoad) {
      this.loadingEquip.add(eqKey);
      const eqBody = eqKey.slice(itemId.length + 1);
      const fs = ITEMS[itemId]?.frameSize ?? 92;
      for (const suf of EQUIP_SUFFIXES) {
        const base = `/sprites/equipment/${slot}/${itemId}/${eqBody}`;
        this.load.spritesheet(`equip_${eqKey}_walk_${suf}`, `${base}/walk_${suf}.png${bust}`, { frameWidth: fs, frameHeight: fs });
        this.load.spritesheet(`equip_${eqKey}_idle_${suf}`, `${base}/idle_${suf}.png${bust}`, { frameWidth: fs, frameHeight: fs });
      }
    }
    this.load.once('complete', () => {
      for (const { eqKey } of toLoad) {
        this.loadingEquip.delete(eqKey);
        this.loadedEquip.add(eqKey);
        this.registerEquipAnims(eqKey);
      }
      onReady();
    });
    this.load.start();
  }

  private registerEquipAnims(eqKey: string): void {
    for (const suf of EQUIP_SUFFIXES) {
      const w = `equip_${eqKey}_walk_${suf}`;
      if (this.textures.exists(w) && !this.anims.exists(`a_${w}`)) {
        this.anims.create({ key: `a_${w}`, frames: this.anims.generateFrameNumbers(w, { start: 0, end: 5 }), frameRate: 10, repeat: -1 });
      }
      const i = `equip_${eqKey}_idle_${suf}`;
      if (this.textures.exists(i) && !this.anims.exists(`a_${i}`)) {
        this.anims.create({ key: `a_${i}`, frames: this.anims.generateFrameNumbers(i, { start: 0, end: 3 }), frameRate: 4, repeat: -1 });
      }
    }
  }

  /** Destroy and recreate a player's equipment layer sprites from their loadout. */
  private rebuildEquip(target: Map<string, Phaser.GameObjects.Sprite>, loadout: Record<string, string>, charKey: string, baseDepth: number): void {
    for (const [, s] of target) s.destroy();
    target.clear();
    let idx = 1;
    for (const slot of LOBBY_LAYER_ORDER) {
      const itemId = loadout[slot];
      if (!itemId) continue;
      const eqKey = this.eqKeyFor(itemId, charKey);
      if (!eqKey) continue;
      const tex = `equip_${eqKey}_idle_south`;
      if (!this.textures.exists(tex)) continue; // not loaded / file missing
      const fs = ITEMS[itemId]?.frameSize ?? 92;
      const sprite = this.add.sprite(0, 0, tex, 0)
        .setScale(0.75 * (92 / fs)).setOrigin(0.5, 0.85).setDepth(baseDepth + 0.001 * idx);
      sprite.setData('eqKey', eqKey);
      target.set(slot, sprite);
      idx++;
    }
  }

  /** Glue equipment layers to a body's position and play the matching anim. */
  private syncEquip(target: Map<string, Phaser.GameObjects.Sprite>, x: number, y: number, dir: string, moving: boolean, baseDepth: number): void {
    if (target.size === 0) return;
    const { suffix, flip } = this.equipDir(dir);
    let idx = 1;
    for (const [, s] of target) {
      s.setPosition(x, y);
      s.setFlipX(flip);
      s.setDepth(baseDepth + 0.001 * idx);
      const eqKey = s.getData('eqKey');
      const animKey = `a_equip_${eqKey}_${moving ? 'walk' : 'idle'}_${suffix}`;
      if (this.anims.exists(animKey) && s.anims.currentAnim?.key !== animKey) s.play(animKey, true);
      idx++;
    }
  }

  /** Rebuild the local player's equipment layers after a loadout/char change. */
  private refreshMyEquip(): void {
    const sig = this.equipSignature(this.myLoadout, this.charKey);
    if (sig === this.myEquipSig && (this.myEquip.size > 0 || Object.keys(this.myLoadout).length === 0)) return;
    this.ensureEquipLoaded(this.myLoadout, this.charKey, () => {
      this.rebuildEquip(this.myEquip, this.myLoadout, this.charKey, 10);
      this.myEquipSig = this.equipSignature(this.myLoadout, this.charKey);
    });
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
    const token = this.authState?.session?.access_token;
    this.lobbyRoom = await client.joinOrCreate('lobby', { playerName, charKey: this.charKey, token });
    console.log(`[LobbyScene] connected to lobby room ${this.lobbyRoom.roomId}, sessionId=${this.lobbyRoom.sessionId}`);
    // Re-assert our character on connect in case loadEquippedChar already
    // resolved before the room finished connecting.
    this.lobbyRoom.send('changeChar', { charKey: this.charKey });

    this.lobbyRoom.onMessage('lobbyState', (data: { players: { sessionId: string; playerName: string; x: number; y: number; facing: string; moving: boolean; charKey: string; loadout?: Record<string, string> }[] }) => {
      const myId = this.lobbyRoom?.sessionId;
      const seen = new Set<string>();

      for (const p of data.players) {
        if (p.sessionId === myId) {
          // Our own loadout is server-authoritative — keep local layers in sync.
          this.myLoadout = p.loadout ?? {};
          this.refreshMyEquip();
          continue;
        }
        seen.add(p.sessionId);

        const charKey = p.charKey || 'male';
        const facing = p.facing || 'SD';
        const loadout = p.loadout ?? {};

        let other = this.otherPlayers.get(p.sessionId);
        if (!other) {
          const sprite = this.add.sprite(p.x, p.y, `${charKey}_south-east`)
            .setScale(0.75).setOrigin(0.5, 0.85).setDepth(9);
          const label = this.add.text(p.x, p.y - 55, p.playerName, {
            fontSize: '13px', fontFamily: 'monospace', color: '#ffffff', fontStyle: 'bold',
          }).setOrigin(0.5, 1).setDepth(9);
          other = {
            sprite, label, targetX: p.x, targetY: p.y,
            charKey, facing, moving: !!p.moving, loadout, equip: new Map(), equipSig: '',
          };
          this.otherPlayers.set(p.sessionId, other);
        }

        other.targetX = p.x;
        other.targetY = p.y;
        other.charKey = charKey;
        other.facing = facing;
        other.moving = !!p.moving;
        other.loadout = loadout;

        // Body animation
        const flip = PIXELLAB_DIR_MAP[facing]?.flipX ?? false;
        if (p.moving) {
          const walkKey = `${charKey}_walk_${facing}`;
          if (other.sprite.anims.currentAnim?.key !== walkKey) other.sprite.play(walkKey, true);
        } else {
          const idleKey = `${charKey}_idle_${facing}`;
          if (!other.sprite.anims.currentAnim?.key.includes('idle')) other.sprite.play(idleKey, true);
        }
        other.sprite.setFlipX(flip);

        // Rebuild this player's equipment layers when their outfit/body changes.
        const sig = this.equipSignature(loadout, charKey);
        if (sig !== other.equipSig) {
          const o = other;
          this.ensureEquipLoaded(loadout, charKey, () => {
            this.rebuildEquip(o.equip, o.loadout, o.charKey, 9);
            o.equipSig = this.equipSignature(o.loadout, o.charKey);
          });
        }
      }

      // Remove disconnected players
      for (const [sid, other] of this.otherPlayers) {
        if (!seen.has(sid)) {
          other.sprite.destroy();
          other.label.destroy();
          other.bubble?.destroy();
          for (const [, s] of other.equip) s.destroy();
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

      const playerName = this.authState?.username ?? 'Player';
      const token = this.authState?.session?.access_token;
      this.queueRoom = await client.joinOrCreate('queue', { playerName, token });

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
    // Build with textContent — p.playerName is player-controlled (XSS-unsafe via innerHTML).
    el.replaceChildren(...players.map(p => {
      const isMe = p.sessionId === myId;
      const status = p.ready ? '✓ Ready' : '○ Not Ready';
      const color = p.ready ? '#44ff44' : '#888';
      const row = document.createElement('div');
      row.style.cssText = `margin: 6px 0; color: ${color};`;
      let nameNode: Node;
      if (isMe) {
        const b = document.createElement('b');
        b.textContent = `${p.playerName} (you)`;
        nameNode = b;
      } else {
        nameNode = document.createTextNode(p.playerName);
      }
      row.append(`${status} — `, nameNode);
      return row;
    }));

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
    if (this.gachaPanel) { this.gachaPanel.remove(); this.gachaPanel = null; }
    if (this.chatBox) { this.chatBox.remove(); this.chatBox = null; }
    this.destroyQueueUI();
    if (this.queueRoom) { this.queueRoom.leave(); this.queueRoom = null; }
    if (this.lobbyRoom) { this.lobbyRoom.leave(); this.lobbyRoom = null; }
    for (const other of this.otherPlayers.values()) {
      other.sprite.destroy();
      other.label.destroy();
      other.bubble?.destroy();
      for (const [, s] of other.equip) s.destroy();
    }
    this.otherPlayers.clear();
    for (const [, s] of this.myEquip) s.destroy();
    this.myEquip.clear();
  }

  /** Build the API base URL for REST calls. */
  private apiBase(): string {
    const protocol = window.location.protocol;
    const host = window.location.hostname;
    const port = window.location.port || (protocol === 'https:' ? '443' : '80');
    const apiPort = (port === '8080' || port === '5173') ? '3000' : port;
    return `${protocol}//${host}:${apiPort}`;
  }

  private authHeader(): Record<string, string> {
    const token = this.authState?.session?.access_token;
    return token ? { Authorization: `Bearer ${token}` } : {};
  }

  /** Load the player's equipped character from the server on scene start. */
  private async loadEquippedChar(authId: string): Promise<void> {
    try {
      const resp = await fetch(`${this.apiBase()}/api/player/${authId}/equipped-char`, {
        headers: this.authHeader(),
      });
      if (!resp.ok) return;
      const { charKey } = await resp.json();
      if (charKey && PL_CHAR_KEYS.includes(charKey)) {
        this.charKey = charKey;
        // Update the player sprite to use the loaded character
        this.player.play(`${this.charKey}_idle_${this.playerFacing}`, true);
        // Tell the lobby so other players see our real character, not the
        // default 'male' we joined with (loadEquippedChar can resolve after
        // connectLobby; connectLobby also re-sends on join to cover the
        // opposite ordering).
        if (this.lobbyRoom) this.lobbyRoom.send('changeChar', { charKey });
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
        headers: { 'Content-Type': 'application/json', ...this.authHeader() },
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
    // Equipment is body-keyed (male vs female overlays) — re-key our layers.
    this.refreshMyEquip();

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

    const logoutBtn = document.createElement('button');
    logoutBtn.textContent = '🚪 Logout';
    logoutBtn.style.cssText = btnStyle + 'color: #ff6666;';
    logoutBtn.onmouseenter = () => { logoutBtn.style.borderColor = '#ff6666'; };
    logoutBtn.onmouseleave = () => { logoutBtn.style.borderColor = '#555'; };
    logoutBtn.onclick = () => {
      localStorage.clear();
      window.location.reload();
    };
    container.appendChild(logoutBtn);

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
      const resp = await fetch(`${this.apiBase()}/api/player/${authId}?username=${username}`, {
        headers: this.authHeader(),
      });
      if (!resp.ok) {
        container.innerHTML = '<div style="color: #888; text-align: center;">Could not load profile</div>';
        return;
      }
      const p = await resp.json();
      // Numbers are coerced (so a malicious non-numeric value can't inject markup),
      // and the username goes through textContent below — never interpolated into innerHTML.
      const lv = Number(p.level) || 1;
      const xp = Number(p.xp) || 0;
      const coins = Number(p.coins) || 0;
      const races = Number(p.totalRaces) || 0;
      const wins = Number(p.totalWins) || 0;
      container.innerHTML = `
        <div style="text-align: center; margin-bottom: 16px;">
          <div id="stats-name" style="font-size: 20px; font-weight: bold; color: #ffdd44;"></div>
        </div>
        <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px; font-size: 13px;">
          <div style="background: #222; border-radius: 4px; padding: 10px; text-align: center;">
            <div style="color: #888; font-size: 11px;">XP</div>
            <div style="color: #4488ff; font-weight: bold;">${xp}</div>
          </div>
          <div style="background: #222; border-radius: 4px; padding: 10px; text-align: center;">
            <div style="color: #888; font-size: 11px;">Coins</div>
            <div style="color: #ffcc44; font-weight: bold;">${coins}</div>
          </div>
          <div style="background: #222; border-radius: 4px; padding: 10px; text-align: center;">
            <div style="color: #888; font-size: 11px;">Races</div>
            <div style="color: #eee; font-weight: bold;">${races}</div>
          </div>
          <div style="background: #222; border-radius: 4px; padding: 10px; text-align: center;">
            <div style="color: #888; font-size: 11px;">Wins</div>
            <div style="color: #44bb44; font-weight: bold;">${wins}</div>
          </div>
        </div>
      `;
      const nameEl = container.querySelector('#stats-name');
      if (nameEl) nameEl.textContent = `Lv.${lv} ${p.username ?? 'Player'}`;
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
    const myId = this.lobbyRoom?.sessionId;
    const isLocal = sessionId === myId;

    // Destroy previous bubble for this player
    if (isLocal) {
      this.localBubble?.destroy();
    } else {
      const other = this.otherPlayers.get(sessionId);
      if (!other) return;
      other.bubble?.destroy();
    }

    const x = isLocal ? this.playerX : this.otherPlayers.get(sessionId)!.sprite.x;
    const y = isLocal ? this.playerY - 70 : this.otherPlayers.get(sessionId)!.sprite.y - 70;

    const bubble = this.add.text(x, y, truncated, {
      fontSize: '11px',
      fontFamily: 'monospace',
      color: '#ffffff',
      backgroundColor: '#000000cc',
      padding: { x: 6, y: 3 },
    }).setOrigin(0.5, 1).setDepth(50);

    // Store reference so update() can track position
    if (isLocal) {
      this.localBubble = bubble;
    } else {
      this.otherPlayers.get(sessionId)!.bubble = bubble;
    }

    // Fade out after 3 seconds
    this.tweens.add({
      targets: bubble,
      alpha: 0,
      duration: 3000,
      delay: 2000,
      onComplete: () => {
        bubble.destroy();
        if (isLocal && this.localBubble === bubble) this.localBubble = undefined;
        else {
          const o = this.otherPlayers.get(sessionId);
          if (o?.bubble === bubble) o.bubble = undefined;
        }
      },
    });
  }

  private addChatMessage(name: string, msg: string, time: string): void {
    this.chatMessages.push({ name, msg, time });
    if (this.chatMessages.length > 50) this.chatMessages.shift();

    const el = document.getElementById('chat-messages');
    if (!el) return;

    const div = document.createElement('div');
    div.style.cssText = 'margin: 3px 0;';
    // textContent (never innerHTML) — name and msg are player-controlled; an
    // innerHTML interpolation here is a stored-XSS account-takeover vector.
    const nameSpan = document.createElement('span');
    nameSpan.style.cssText = 'color: #ffdd44; font-weight: bold;';
    nameSpan.textContent = `${name}:`;
    const msgSpan = document.createElement('span');
    msgSpan.style.cssText = 'color: #ccc;';
    msgSpan.textContent = msg;
    div.append(nameSpan, ' ', msgSpan);
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
      const resp = await fetch(`${this.apiBase()}/api/player/${authId}/inventory`, {
        headers: this.authHeader(),
      });
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

    for (const slotKey of Object.keys(ITEM_SLOT_META)) {
      slotGrid.appendChild(buildEquipSlot(
        slotKey, equippedBySlot.get(slotKey) ?? null, this.charKey,
        (id) => this.toggleEquipItem(id, false, container),
      ));
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
        bagGrid.appendChild(buildBagCard(
          item, this.charKey,
          (id, equip) => this.toggleEquipItem(id, equip, container),
        ));
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
        headers: { 'Content-Type': 'application/json', ...this.authHeader() },
        body: JSON.stringify({ inventoryItemId: itemId, equipped: equip }),
      });
      // Tell the lobby to re-fetch our loadout so other players see the change
      // once lobby equipment-layer rendering lands (server already broadcasts it).
      this.lobbyRoom?.send('refreshLoadout');
      // Re-fetch and re-render in place if we have the container
      if (contentContainer) {
        await this.renderInventoryContent(contentContainer);
      } else {
        // Fallback: reopen the whole panel
        this.openInventory();
      }
    } catch { /* ignore */ }
  }

  // ─── Gacha (gacha GDD §24; walk-up machine, ceremony deferred to Economy UI) ──

  private toggleGacha(): void {
    if (this.gachaPanel) { this.gachaPanel.remove(); this.gachaPanel = null; return; }
    this.openGacha();
  }

  private async openGacha(): Promise<void> {
    if (this.gachaPanel) { this.gachaPanel.remove(); this.gachaPanel = null; }
    const panel = document.createElement('div');
    panel.style.cssText = `
      position: fixed; top: 50%; left: 50%; transform: translate(-50%, -50%);
      background: #1a1a2e; border: 2px solid #ffdd44; border-radius: 8px;
      padding: 24px; width: 420px; max-height: 80vh; overflow-y: auto;
      z-index: 9000; font-family: monospace; color: #eee;
      box-shadow: 0 8px 32px rgba(0,0,0,0.7);
    `;
    panel.addEventListener('keydown', (e) => e.stopPropagation());
    panel.addEventListener('keyup', (e) => e.stopPropagation());

    const closeBtn = document.createElement('button');
    closeBtn.textContent = 'X';
    closeBtn.style.cssText = `
      position: absolute; top: 8px; right: 12px; background: none; border: none;
      color: #888; font-size: 18px; cursor: pointer; font-family: monospace; font-weight: bold;
    `;
    closeBtn.onclick = () => { this.gachaPanel?.remove(); this.gachaPanel = null; };
    panel.appendChild(closeBtn);

    const title = document.createElement('h2');
    title.textContent = '\u{1F3B0} GACHA MACHINE';
    title.style.cssText = 'margin: 0 0 16px; text-align: center; color: #ffdd44; font-size: 18px;';
    panel.appendChild(title);

    const content = document.createElement('div');
    content.id = 'gacha-content';
    panel.appendChild(content);

    document.body.appendChild(panel);
    this.gachaPanel = panel;
    await this.renderGachaContent(content);
  }

  private async renderGachaContent(content: HTMLDivElement): Promise<void> {
    const authId = this.authState?.session?.user?.id;
    if (!authId) { content.innerHTML = '<p style="text-align:center;color:#888">Log in to pull.</p>'; return; }
    content.innerHTML = '<p style="text-align:center;color:#888">Loading…</p>';
    try {
      const [statusRes, oddsRes] = await Promise.all([
        fetch(`${this.apiBase()}/api/player/${authId}/gacha`, { headers: this.authHeader() }),
        fetch(`${this.apiBase()}/api/gacha/odds`),
      ]);
      const status = await statusRes.json();
      const odds = await oddsRes.json();
      content.innerHTML = '';

      // Odds table (only non-empty tiers, matching what the server discloses).
      const oddsBox = document.createElement('div');
      oddsBox.style.cssText = 'background:#12121e;border-radius:6px;padding:10px 14px;margin-bottom:14px;font-size:12px;';
      oddsBox.innerHTML = '<div style="color:#aaa;margin-bottom:6px;">Current odds</div>' +
        odds.tiers.filter((t: any) => t.count > 0).map((t: any) => {
          const c = LobbyScene.RARITY_COLORS[t.rarity] ?? '#888';
          return `<div style="display:flex;justify-content:space-between;">
            <span style="color:${c};text-transform:capitalize;">${t.rarity} <span style="color:#666">(${t.count})</span></span>
            <span>${(t.probability * 100).toFixed(2)}%</span></div>`;
        }).join('');
      content.appendChild(oddsBox);

      // Pity meter.
      const pity = document.createElement('div');
      pity.style.cssText = 'font-size:12px;color:#aaa;margin-bottom:14px;text-align:center;';
      pity.textContent = `Pity: ${status.pityCounter}/${status.pityThreshold} until guaranteed Epic+`;
      content.appendChild(pity);

      // Free pull button (the shippable path).
      const freeBtn = document.createElement('button');
      const setBtn = (b: HTMLButtonElement, enabled: boolean, label: string, color: string) => {
        b.textContent = label;
        b.disabled = !enabled;
        b.style.cssText = `display:block;width:100%;margin:6px 0;padding:12px;border-radius:6px;
          font-family:monospace;font-size:15px;font-weight:bold;cursor:${enabled ? 'pointer' : 'not-allowed'};
          border:1px solid ${enabled ? color : '#444'};background:${enabled ? 'rgba(255,221,68,0.12)' : '#222'};
          color:${enabled ? color : '#666'};`;
      };
      if (status.freeAvailable) {
        setBtn(freeBtn, true, '\u{1F381} FREE DAILY PULL', '#ffdd44');
      } else {
        const when = status.nextFreeAt ? new Date(status.nextFreeAt).toUTCString().replace(/ GMT$/, ' UTC') : 'tomorrow';
        setBtn(freeBtn, false, `Next free pull: ${when}`, '#ffdd44');
      }
      freeBtn.onclick = () => this.doPull(content, 1, false);
      content.appendChild(freeBtn);

      // Paid pulls — only when enabled (Payment Integration) or dev credits exist.
      if (status.paidEnabled || status.pullCredits > 0) {
        const credits = document.createElement('div');
        credits.style.cssText = 'font-size:12px;color:#aaa;text-align:center;margin:10px 0 4px;';
        credits.textContent = `Pull credits: ${status.pullCredits}`;
        content.appendChild(credits);
        for (const n of [1, 5, 10]) {
          const b = document.createElement('button');
          setBtn(b, status.pullCredits >= n, `Pull ×${n} (${n} credit${n > 1 ? 's' : ''})`, '#88ccff');
          b.onclick = () => this.doPull(content, n, true);
          content.appendChild(b);
        }
      }
    } catch {
      content.innerHTML = '<p style="text-align:center;color:#f88">Could not reach the gacha machine.</p>';
    }
  }

  private async doPull(content: HTMLDivElement, count: number, paid: boolean): Promise<void> {
    const authId = this.authState?.session?.user?.id;
    if (!authId) return;
    content.querySelectorAll('button').forEach((b) => ((b as HTMLButtonElement).disabled = true));
    try {
      const resp = await fetch(`${this.apiBase()}/api/player/${authId}/gacha/pull`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...this.authHeader() },
        body: JSON.stringify({ pullId: crypto.randomUUID(), count, paid }),
      });
      const data = await resp.json();
      if (!resp.ok) {
        const banner = document.createElement('div');
        banner.style.cssText = 'background:#3a1a1a;color:#f88;padding:10px;border-radius:6px;margin-bottom:12px;text-align:center;font-size:13px;';
        banner.textContent = data.message ?? 'Pull failed.';
        content.prepend(banner);
        await this.renderGachaContent(content);
        return;
      }
      // Play the slot-machine reel, then reveal the result card(s).
      this.playGachaReveal(content, data.results, () => this.showPullResults(content, data.results));
      // Reflect new items immediately if the inventory panel is open.
      if (this.inventoryPanel) {
        const invContent = document.getElementById('inventory-content') as HTMLDivElement | null;
        if (invContent) await this.renderInventoryContent(invContent);
      }
    } catch {
      await this.renderGachaContent(content);
    }
  }

  /**
   * Slot-machine reveal: a strip of real item thumbnails scrolls fast under a
   * center marker, decelerates (ease-out), and lands on the rarest item pulled,
   * then flashes its rarity colour. Click to skip. Ceremony per gacha GDD §2.
   */
  private playGachaReveal(content: HTMLDivElement, results: Array<{ itemId: string; rarity: string }>, onDone: () => void): void {
    const RANK = ['common', 'uncommon', 'rare', 'epic', 'legendary', 'crazy'];
    const headline = [...results].sort((a, b) => RANK.indexOf(b.rarity) - RANK.indexOf(a.rarity))[0];
    if (!headline) { onDone(); return; }

    content.innerHTML = '';
    const pool = Object.keys(ITEMS);
    const cellW = 84;            // per-cell pitch (cell 80 + gap 4)
    const targetIndex = 28;      // where the won item sits in the reel
    const totalCells = targetIndex + 6;

    const vp = document.createElement('div');
    vp.style.cssText = 'position:relative;width:100%;height:104px;overflow:hidden;border-radius:8px;background:#0d0d16;margin-bottom:14px;cursor:pointer;';
    const strip = document.createElement('div');
    strip.style.cssText = 'position:absolute;top:8px;left:0;display:flex;gap:4px;will-change:transform;';
    for (let i = 0; i < totalCells; i++) {
      let cellItem: string, cellRarity: string;
      if (i === targetIndex) {
        cellItem = headline.itemId; cellRarity = headline.rarity;
      } else {
        cellItem = pool[Math.floor(Math.random() * pool.length)];
        cellRarity = ITEMS[cellItem]?.rarity ?? 'common';
      }
      const color = RARITY_COLORS[cellRarity] ?? '#888';
      const cell = document.createElement('div');
      cell.style.cssText = `width:${cellW - 4}px;height:88px;flex:0 0 auto;border:2px solid ${color};border-radius:6px;background:#12121e;display:flex;align-items:center;justify-content:center;`;
      const cv = document.createElement('canvas');
      cv.width = 60; cv.height = 60; cv.style.cssText = 'image-rendering:pixelated;';
      void drawItemThumbnail(cv, cellItem, this.charKey);
      cell.appendChild(cv);
      strip.appendChild(cell);
    }
    const marker = document.createElement('div');
    marker.style.cssText = 'position:absolute;left:50%;top:0;bottom:0;width:2px;background:#ffdd44;transform:translateX(-1px);z-index:2;box-shadow:0 0 8px #ffdd44;';
    vp.append(strip, marker);
    content.appendChild(vp);

    const viewportW = vp.clientWidth || 372;
    const finalX = viewportW / 2 - (targetIndex * cellW + (cellW - 4) / 2);
    const dur = 2400;
    const t0 = performance.now();
    const ease = (t: number) => 1 - Math.pow(1 - t, 3); // easeOutCubic — slot settling
    let finished = false;
    const finish = () => {
      if (finished) return;
      finished = true;
      strip.style.transform = `translateX(${finalX}px)`;
      const color = RARITY_COLORS[headline.rarity] ?? '#888';
      vp.style.boxShadow = `inset 0 0 0 3px ${color}, 0 0 24px ${color}`;
      setTimeout(onDone, 600);
    };
    vp.onclick = finish; // click to skip
    const stepFn = (now: number) => {
      if (finished) return;
      const t = Math.min(1, (now - t0) / dur);
      strip.style.transform = `translateX(${finalX * ease(t)}px)`;
      if (t < 1) requestAnimationFrame(stepFn);
      else finish();
    };
    requestAnimationFrame(stepFn);
  }

  private showPullResults(content: HTMLDivElement, results: Array<{ itemId: string; rarity: string }>): void {
    content.innerHTML = '';
    const reveal = document.createElement('div');
    reveal.style.cssText = 'display:flex;flex-wrap:wrap;gap:8px;justify-content:center;margin-bottom:16px;';
    for (const r of results) {
      const color = LobbyScene.RARITY_COLORS[r.rarity] ?? '#888';
      const name = ITEMS[r.itemId]?.displayName ?? r.itemId;
      const card = document.createElement('div');
      card.style.cssText = `border:2px solid ${color};border-radius:8px;padding:12px 10px;min-width:120px;text-align:center;background:#12121e;`;
      // textContent (not innerHTML) for the data-derived rarity/name strings.
      const tier = document.createElement('div');
      tier.style.cssText = `color:${color};font-size:11px;text-transform:uppercase;font-weight:bold;`;
      tier.textContent = r.rarity;
      const label = document.createElement('div');
      label.style.cssText = 'margin-top:6px;font-size:13px;';
      label.textContent = name;
      card.append(tier, label);
      reveal.appendChild(card);
    }
    content.appendChild(reveal);
    const again = document.createElement('button');
    again.textContent = '← Back';
    again.style.cssText = `display:block;width:100%;padding:12px;border-radius:6px;font-family:monospace;
      font-size:15px;font-weight:bold;cursor:pointer;border:1px solid #ffdd44;background:rgba(255,221,68,0.12);color:#ffdd44;`;
    again.onclick = () => this.renderGachaContent(content);
    content.appendChild(again);
  }
}
