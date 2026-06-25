import Phaser from 'phaser';
import { type AuthState } from './auth';
import { ITEMS, equipmentBodyKey } from '../../shared/items';
import { seasonLabel } from '../../shared/season';
import { buildEquipSlot, buildBagCard, SLOT_META as ITEM_SLOT_META, drawItemThumbnail, RARITY_COLORS, preloadThumbnails } from './itemDisplay';
import { gachaTick, gachaReveal } from './gachaSfx';

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

// Ambient NPC (reuses the player avatar sprites/anims + equipment layers).
interface WanderNpc {
  sprite: Phaser.GameObjects.Sprite;
  charKey: string;
  facing: string;
  tx: number;          // wander target
  ty: number;
  pauseUntil: number;  // scene-time ms to idle until before picking a new target
  stuckMs: number;     // accumulates when barely moving → forces a retarget
  moving: boolean;
  isCrowd: boolean;    // crowd members stand still facing the stage
  loadout: Record<string, string>;
  equip: Map<string, Phaser.GameObjects.Sprite>;
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

// 8-direction key for a movement vector, by octant (screen space, +y down).
const DIRS_BY_OCTANT = ['D', 'SD', 'S', 'SA', 'A', 'WA', 'W', 'WD'];
const NPC_SPEED = 75;     // ambient wanderers amble slower than the player
const NPC_COUNT = 6;

// Gatchaman — the cyborg cowboy drag queen NPC who hawks the gacha machine.
// Square frame size of the idle spritesheet (set from the PixelLab export).
const GATCHAMAN_FRAME = 128;
// He stands beside the machine and cycles these barks in a bubble over his head.
const GATCHAMAN_LINES = [
  'Try your luck in the Gacha Machine, buddy!',
  'You can get all sorts of stuff here, crazy stuff!',
  'Just roll it, Motherf...!',
];

// Melvin — the Crazy Race host by the garage door.
const MELVIN_LINES = [
  'Join the CRAZY RACE, Bro!',
  'This race is only for the craziest! NO cap!',
  'Here you can win some coins and get yourself some drip.',
];

// The drunk/stoner clown loitering left of the store with his balloons.
const CLOWN_LINES = [
  'Wanna buy some stuff?',
  '[Burp!]',
  'F... you!',
];

// Square frame size of the band-member spritesheets (PixelLab standard 64px → 92 canvas).
const BAND_FRAME = 92;

// Depth bands for Y-sorting. Ground-standing entities (players, NPCs, buildings,
// band, tall props, the sign rig) use their feet-Y directly as depth so whoever
// is lower on screen draws in front. Flat floors sit behind; atmosphere + UI on top.
const D_GROUND = -10000;      // lobby ground image
const D_STAGE_FLOOR = -9000;  // band-stage platform (walked on)
const D_FX = 20000;           // spotlight beams + smoke (atmosphere over the scene)
const D_LABEL = 30000;        // name labels
const D_BUBBLE = 31000;       // speech bubbles
const D_PROMPT = 32000;       // [E] prompts / hints

// Subtle cool-dark multiply tint so the bright pixel buildings settle into the
// moody painted map instead of popping out.
const BUILDING_TINT = 0xaab0c2;

// Depth for buildings that must ALWAYS render behind player avatars (below the
// minimum walkable player Y, ~300). Their labels sit just above.
const BEHIND_PLAYERS = 200;
// Mounted building signs render ABOVE players (above any walkable Y) so players
// pass behind them instead of walking over them like a carpet.
const ABOVE_PLAYERS = 9000;

// Walkable arena floor polygon (marked in the ?edit layout editor). The player's
// feet are kept inside this shape.
const LOBBY_WALKABLE: Array<[number, number]> = [
  [8,516],[147,580],[161,573],[86,481],[96,478],[95,467],[107,458],[107,449],[130,432],
  [166,424],[234,390],[257,390],[328,429],[418,386],[435,376],[428,358],[428,342],[442,346],
  [494,329],[498,313],[510,312],[509,337],[510,343],[615,343],[616,355],[674,358],[676,342],
  [782,340],[783,311],[853,332],[848,371],[833,366],[820,381],[816,396],[818,401],[844,407],
  [858,404],[910,415],[917,424],[934,426],[948,423],[1020,390],[1066,414],[1100,410],[1174,449],
  [1269,480],[1277,479],[1274,503],[1259,512],[1242,508],[1227,513],[1216,517],[1204,517],
  [1191,530],[1186,543],[1192,550],[1201,552],[1208,564],[1226,570],[1235,564],[1248,570],
  [1255,582],[1262,592],[1270,596],[1275,600],[1276,643],[1225,657],[1119,593],[1106,581],
  [1090,573],[1070,587],[1053,598],[1057,610],[1108,644],[1094,653],[965,716],[944,712],
  [956,704],[964,687],[929,667],[919,658],[851,710],[847,717],[151,714],[103,687],
];

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

  private gatchamanX = 0;
  private gatchamanY = 0;
  private gatchaman?: Phaser.GameObjects.Sprite;
  private gatchamanBubble?: Phaser.GameObjects.Text;
  /** Active bark bubbles for the generic chatter system, keyed by NPC id. */
  private chatBubbles = new Map<string, Phaser.GameObjects.Text>();
  private melvin?: Phaser.GameObjects.Sprite;
  private clown?: Phaser.GameObjects.Sprite;

  private boardX = 0;
  private boardY = 0;
  private boardPrompt!: Phaser.GameObjects.Text;
  private leaderboardPanel: HTMLDivElement | null = null;

  private shopX = 0;
  private shopY = 0;
  private shopPrompt!: Phaser.GameObjects.Text;
  private shopPanel: HTMLDivElement | null = null;

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
  // Per idle texture: the index of its fullest (most complete) frame. Idle
  // overlays are pinned to this so broken back/side idle frames can't flash.
  private bestIdleFrame = new Map<string, number>();
  private lastSentX = 0;
  private lastSentY = 0;
  private lastSentMoving = false;

  // Tight collision: each solid obstacle's silhouette is rasterised into a
  // bitmap; the player's feet are blocked from entering any solid pixel.
  private solids: Phaser.GameObjects.Image[] = [];
  private collision: Uint8Array | null = null;
  private collisionW = 0;
  private collisionH = 0;

  // In-lobby layout editor (?lobby&edit) — drag/rotate/mirror buildings, mark
  // the walkable polygon + collision rects, export the layout JSON.
  private editMode = false;
  private bandStageParts: Phaser.GameObjects.GameObject[] = [];
  private editorPanel: HTMLDivElement | null = null;
  private npcs: WanderNpc[] = [];
  private releasedBySlot: Record<string, string[]> | null = null;

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
    // PostApo-Lands wasteland map (Szadi art): a single pre-composed 1280x720
    // ground — varied dirt + central stone plaza + baked decals/props.
    this.load.image('lobby_map', '/sprites/lobby/lobby_map.png');
    // Animated gacha machine (industrial reactor): 4-frame orange-glow pulse.
    this.load.spritesheet('gacha_machine', '/sprites/lobby/gacha_machine.png', { frameWidth: 97, frameHeight: 120 });
    // Gatchaman NPC — cyborg cowboy drag queen, south-facing breathing idle.
    this.load.spritesheet('gatchaman_idle', '/sprites/lobby/gatchaman_idle.png', { frameWidth: GATCHAMAN_FRAME, frameHeight: GATCHAMAN_FRAME });
    // Melvin — the Crazy Race host (standard PixelLab char, 92px frames).
    this.load.spritesheet('melvin_idle', '/sprites/lobby/melvin_idle.png', { frameWidth: 92, frameHeight: 92 });
    this.load.spritesheet('clown_idle', '/sprites/lobby/clown_idle.png', { frameWidth: 92, frameHeight: 92 });
    // Rock band stage centerpiece: stage platform, neon CRAZY STUFF sign, and
    // three south-facing "playing" band members (singer/guitarist/bassist).
    this.load.image('band_stage', '/sprites/lobby/band_stage.png');
    // The kick drum + riser front, cut from the stage, drawn ABOVE the drummer
    // so his lower half sits behind the kit. Same canvas size as band_stage.
    this.load.image('stage_drumkit', '/sprites/lobby/stage_drumkit.png');
    this.load.image('crazy_sign', '/sprites/lobby/crazy_stuff_sign.png');
    this.load.image('mic_stand', '/sprites/lobby/mic_stand.png');
    for (const m of ['singer', 'guitarist', 'bassist', 'drummer']) {
      this.load.spritesheet(`band_${m}`, `/sprites/lobby/band_${m}.png`, { frameWidth: BAND_FRAME, frameHeight: BAND_FRAME });
    }
    // Store storefront building.
    this.load.image('store_building', '/sprites/lobby/store_building.png');
    // Leaderboard billboard + race garage.
    this.load.image('leaderboard_board', '/sprites/lobby/leaderboard_board.png');
    this.load.image('race_building', '/sprites/lobby/race_building.png');
    // Iso cyberpunk buildings (match the painted map), used in place of the
    // legacy placeholders above when present.
    this.load.image('race_garage', '/sprites/lobby/race_garage.png');
    this.load.image('store_iso', '/sprites/lobby/store_iso.png');
    this.load.image('leaderboard_iso', '/sprites/lobby/leaderboard_iso.png');
    // Neon building signs (blend with the lobby's neon style).
    this.load.image('gacha_sign', '/sprites/lobby/gacha_sign.png');
    this.load.image('crazy_race_sign', '/sprites/lobby/crazy_race_sign.png');
    this.load.image('rankings_sign', '/sprites/lobby/rankings_sign.png');

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

    // Ground — the pre-composed wasteland map (dirt + stone plaza + props),
    // sized to the game canvas. Buildings + player render on top.
    const cy = height / 2;

    // The whole environment is one cohesive isometric scene (iso floor, walls,
    // neon skyline, debris, haze — all baked). Interactive objects sit on top.
    this.add.image(0, 0, 'lobby_map').setOrigin(0, 0).setDepth(D_GROUND);

    // Walkable = the central arena floor of the map (inside the perimeter).
    this.groundBounds = {
      left: 235,
      right: width - 225,
      top: 280,
      bottom: height - 95,
    };

    // Reduce music volume when entering lobby
    if (this.bgMusic) {
      try { (this.bgMusic as any).setVolume(0.15); } catch { /* ignore */ }
    }

    // Layout positions exported from the in-lobby editor (?lobby&edit).
    // Crazy Race garage (right).
    this.buildingX = 913;
    this.buildingY = 369;
    this.drawBuilding(this.buildingX, this.buildingY);
    // Melvin, the race host, idles by the garage door.
    this.createMelvin(905, 452);

    // Gacha machine (lower-left).
    this.gachaX = 467;
    this.gachaY = 593;
    this.createGachaMachine(this.gachaX, this.gachaY);

    // Gatchaman NPC (placed independently).
    this.gatchamanX = 537;
    this.gatchamanY = 583;
    this.createGatchaman(this.gatchamanX, this.gatchamanY);

    // Store (left).
    this.shopX = 352;
    this.shopY = 400;
    this.drawCoinShop(this.shopX, this.shopY);
    // Drunk clown loiters in the gap between the store's left wall and the fence.
    this.createClown(282, 460);

    // Leaderboard (right).
    this.boardX = 1155;
    this.boardY = 410;
    this.drawLeaderboardWall(this.boardX, this.boardY);

    // Rock band stage — back-center of the arena.
    this.createBandStage(647, 266);

    // (Debris/props are baked into the scene image now.)

    // Build the tight collision bitmap from every solid obstacle just placed.
    this.buildCollisionMask(width, height);

    // Register animations
    this.registerAnimations();

    // Ambient life: a crowd cheering at the stage + wandering NPCs. Skipped in
    // the layout editor so they don't clutter it.
    if (!new URLSearchParams(window.location.search).has('edit')) {
      this.createCrowd(648, 415, 198, 78);
      this.createNpcs(NPC_COUNT);
    }

    // Player — spawn on the open arena floor (inside the walkable polygon).
    this.playerX = 650;
    this.playerY = 540;
    this.player = this.add.sprite(this.playerX, this.playerY, `${this.charKey}_south-east`)
      .setScale(0.75)
      .setOrigin(0.5, 0.85)
      .setDepth(this.playerY);
    this.player.play(`${this.charKey}_idle_SD`);

    // Player name label
    const myName = this.authState?.username ?? 'Player';
    this.playerLabel = this.add.text(this.playerX, this.playerY - 55, myName, {
      fontSize: '13px', fontFamily: 'monospace', color: '#ffffff', fontStyle: 'bold',
    }).setOrigin(0.5, 1).setDepth(D_LABEL);

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
    }).setOrigin(0.5, 1).setDepth(D_PROMPT).setAlpha(0);

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
    }).setOrigin(0.5, 1).setDepth(D_PROMPT).setAlpha(0);

    this.tweens.add({
      targets: this.gachaPrompt,
      scaleY: 1.08,
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    // Leaderboard wall interact prompt
    this.boardPrompt = this.add.text(this.boardX, this.boardY - 64, '[E] Leaderboard', {
      fontSize: '16px',
      fontFamily: 'monospace',
      color: '#ffdd44',
      backgroundColor: '#000000aa',
      padding: { x: 8, y: 4 },
    }).setOrigin(0.5, 1).setDepth(D_PROMPT).setAlpha(0);

    this.tweens.add({
      targets: this.boardPrompt,
      scaleY: 1.08,
      duration: 500,
      yoyo: true,
      repeat: -1,
      ease: 'Sine.easeInOut',
    });

    // Coin shop interact prompt
    this.shopPrompt = this.add.text(this.shopX, this.shopY - 64, '[E] Store', {
      fontSize: '16px',
      fontFamily: 'monospace',
      color: '#ffdd44',
      backgroundColor: '#000000aa',
      padding: { x: 8, y: 4 },
    }).setOrigin(0.5, 1).setDepth(D_PROMPT).setAlpha(0);

    this.tweens.add({
      targets: this.shopPrompt,
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
      const dBoard = Phaser.Math.Distance.Between(this.playerX, this.playerY, this.boardX, this.boardY);
      if (dBoard <= INTERACT_DIST) { this.toggleLeaderboard(); return; }
      const dShop = Phaser.Math.Distance.Between(this.playerX, this.playerY, this.shopX, this.shopY);
      if (dShop <= INTERACT_DIST) { this.toggleShop(); return; }
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
    }).setScrollFactor(0).setDepth(D_PROMPT);

    // Chat box (always visible)
    this.createChatBox();

    // Load equipped character from server and create profile button
    const authId = this.authState?.session?.user?.id;
    if (authId) this.loadEquippedChar(authId).catch(() => {});
    this.createProfileButton();

    // Layout editor (?edit): drag/rotate/mirror buildings, mark areas, export.
    if (new URLSearchParams(window.location.search).has('edit')) {
      this.editMode = true;
      this.setupEditor();
    }

    // Cleanup
    this.events.on('shutdown', () => this.cleanupScene());
    this.events.on('destroy', () => this.cleanupScene());
  }

  update(_time: number, delta: number): void {
    if (this.editMode) return; // editor drives objects directly; no player sim
    this.updateNpcs(delta);
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

      const nx = this.playerX + dx * speed;
      const ny = this.playerY + dy * speed;
      // Axis-separated: only move if the feet stay inside the walkable polygon
      // and out of any solid obstacle (so the player slides along edges).
      if (this.inWalkable(nx, this.playerY) && !this.solidAt(nx, this.playerY)) this.playerX = nx;
      if (this.inWalkable(this.playerX, ny) && !this.solidAt(this.playerX, ny)) this.playerY = ny;
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

    // Y-sort the player by feet so they walk in front of / behind everything.
    this.player.setDepth(this.playerY);
    // Update name label + speech bubble position
    this.playerLabel.setPosition(this.playerX, this.playerY - 55);
    this.localBubble?.setPosition(this.playerX, this.playerY - 70);
    // Keep our equipment layers glued to the body (Y-sorted with it).
    this.syncEquip(this.myEquip, this.playerX, this.playerY, this.playerFacing, moving, this.playerY, this.player);

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
      other.sprite.setDepth(other.sprite.y); // Y-sort
      other.label.setPosition(other.sprite.x, other.sprite.y - 55);
      other.bubble?.setPosition(other.sprite.x, other.sprite.y - 70);
      this.syncEquip(other.equip, other.sprite.x, other.sprite.y, other.facing, other.moving, other.sprite.y, other.sprite);
    }

    // E prompts (race building + gacha machine)
    const dist = Phaser.Math.Distance.Between(this.playerX, this.playerY, this.buildingX, this.buildingY);
    this.ePrompt.setAlpha(dist <= INTERACT_DIST ? 1 : 0);
    const dGacha = Phaser.Math.Distance.Between(this.playerX, this.playerY, this.gachaX, this.gachaY);
    this.gachaPrompt.setAlpha(dGacha <= INTERACT_DIST ? 1 : 0);
    const dBoard = Phaser.Math.Distance.Between(this.playerX, this.playerY, this.boardX, this.boardY);
    this.boardPrompt.setAlpha(dBoard <= INTERACT_DIST ? 1 : 0);
    const dShop = Phaser.Math.Distance.Between(this.playerX, this.playerY, this.shopX, this.shopY);
    this.shopPrompt.setAlpha(dShop <= INTERACT_DIST ? 1 : 0);
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

  /** The Crazy Race entrance — a cyberpunk garage/hangar with a neon arch. */
  private drawBuilding(bx: number, by: number): void {
    const tex = this.textures.exists('race_garage') ? 'race_garage' : 'race_building';
    const b = this.add.image(bx, by + 55, tex)
      .setOrigin(0.5, 1).setScale(0.72).setDepth(BEHIND_PLAYERS)
      .setFlipX(tex === 'race_garage') // entrance faces left (toward the plaza)
      .setTint(BUILDING_TINT);
    b.setData('ename', 'race');
    this.solids.push(b);
    this.placeBuildingSign('crazy_race_sign', bx + 6, b.getTopCenter().y + 58, 145);
  }

  /** Mount a glowing neon sign above a building, scaled to width, with a pulse.
   *  If `label`/`color` are given, the text is drawn in code (exact casing) over
   *  a blank panel — PixelLab can't render reliable capitals. */
  private placeBuildingSign(texKey: string, x: number, bottomY: number, targetWidth: number, label?: string, color?: string): void {
    if (!this.textures.exists(texKey)) return;
    const sign = this.add.image(x, bottomY, texKey).setOrigin(0.5, 1).setDepth(ABOVE_PLAYERS);
    sign.setScale(targetWidth / sign.width);
    const pulse = (t: Phaser.GameObjects.GameObject): void => {
      this.tweens.add({ targets: t, alpha: { from: 1, to: 0.85 }, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    };
    pulse(sign);
    if (label && color) {
      const cyText = bottomY - sign.displayHeight * 0.52;
      const txt = this.add.text(x, cyText, label, {
        fontSize: '26px', fontFamily: 'monospace', fontStyle: 'bold', color,
      }).setOrigin(0.5, 0.5).setDepth(ABOVE_PLAYERS + 0.1);
      txt.setShadow(0, 0, color, 10, true, true); // neon glow
      txt.setScale(Math.min(1, (targetWidth * 0.74) / txt.width)); // fit inside the panel
      pulse(txt);
    }
  }

  /** Draw a capsule-toy ("gachapon") machine. Placeholder art until real
   *  pixel-art lands — see gacha GDD §24. */
  /** Animated industrial gacha reactor — orange-glow pulse + green antenna
   *  flash (the "ready" light). Replaces the old drawn capsule machine. */
  private createGachaMachine(gx: number, gy: number): void {
    if (!this.anims.exists('gacha_idle')) {
      this.anims.create({
        key: 'gacha_idle',
        frames: this.anims.generateFrameNumbers('gacha_machine', { start: 0, end: 3 }),
        frameRate: 6,
        repeat: -1,
      });
    }
    const machine = this.add.sprite(gx, gy + 12, 'gacha_machine')
      .setOrigin(0.5, 1).setDepth(BEHIND_PLAYERS).setTint(BUILDING_TINT);
    machine.play('gacha_idle');
    machine.setData('ename', 'gacha');
    this.solids.push(machine);

    // Green antenna flash — a glowing dot at the antenna tip that pulses, then
    // blinks bright every few seconds (the "pull me" status light).
    const fw = machine.width, fh = machine.height; // frame 97x120
    const tipX = gx + (80 - fw / 2);            // antenna tip ~x80 in the frame
    const tipY = (gy + 12) - fh + 1;            // ~y1 (top), bottom-origin
    const glow = this.add.circle(tipX, tipY, 4, 0x66ff66, 1).setDepth(BEHIND_PLAYERS + 0.05);
    glow.setBlendMode(Phaser.BlendModes.ADD);
    this.tweens.add({ targets: glow, alpha: 0.25, scale: 0.7, duration: 700, yoyo: true, repeat: -1, ease: 'Sine.easeInOut' });
    // periodic bright flash
    this.tweens.add({
      targets: glow, scale: 2.2, alpha: 1, duration: 140, yoyo: true,
      repeat: -1, repeatDelay: 2600, ease: 'Quad.easeOut',
    });

    // Label above the machine (sprite top sits at ~gy-108).
    this.placeBuildingSign('gacha_sign', gx - 6, machine.getTopCenter().y + 6, 70, 'GACHA', '#62ffb0');
  }

  /** Gatchaman — the cyborg cowboy drag queen NPC beside the gacha machine.
   *  Plays a looping breathing idle and chatters barks in a bubble overhead. */
  private createGatchaman(gx: number, gy: number): void {
    if (!this.textures.exists('gatchaman_idle')) return; // sprite not shipped yet
    if (!this.anims.exists('gatchaman_idle')) {
      const tex = this.textures.get('gatchaman_idle');
      const frameCount = tex.frameTotal - 1; // Phaser appends a __BASE frame
      this.anims.create({
        key: 'gatchaman_idle',
        frames: this.anims.generateFrameNumbers('gatchaman_idle', { start: 0, end: Math.max(0, frameCount - 1) }),
        frameRate: 3,
        repeat: -1,
      });
    }
    // Scale his 128px frame down to roughly player size (a touch taller).
    this.gatchaman = this.add.sprite(gx, gy, 'gatchaman_idle')
      .setScale(0.66).setOrigin(0.5, 0.9).setDepth(gy);
    this.gatchaman.setData('ename', 'gatchaman');
    this.addNpcName('Gatchaman', gx, gy - 72);
    this.gatchaman.play('gatchaman_idle');
    this.startGatchamanChatter();
  }

  /** Yellow floating name above a named/interactive NPC (players use white). */
  private addNpcName(name: string, x: number, y: number): void {
    this.add.text(x, y, name, {
      fontSize: '13px', fontFamily: 'monospace', color: '#ffe04a', fontStyle: 'bold',
      stroke: '#1a1408', strokeThickness: 3,
    }).setOrigin(0.5, 1).setDepth(D_LABEL);
  }

  /** Melvin — the Crazy Race host. Stands idle by the garage door with a name. */
  private createMelvin(x: number, y: number): void {
    if (!this.textures.exists('melvin_idle')) return;
    if (!this.anims.exists('melvin_idle')) {
      const frameCount = this.textures.get('melvin_idle').frameTotal - 1;
      this.anims.create({
        key: 'melvin_idle',
        frames: this.anims.generateFrameNumbers('melvin_idle', { start: 0, end: Math.max(0, frameCount - 1) }),
        frameRate: 5, repeat: -1,
      });
    }
    this.melvin = this.add.sprite(x, y, 'melvin_idle')
      .setScale(0.75).setOrigin(0.5, 0.85).setDepth(y);
    this.melvin.play('melvin_idle');
    this.addNpcName('Melvin', x, y - 60);
    this.startNpcChatter('melvin', x, y - 72, MELVIN_LINES, '#bff4ff', '#02141acc',
      () => !!this.melvin?.active);
  }

  /** The drunk/stoner clown loitering left of the store, hawking balloons. */
  private createClown(x: number, y: number): void {
    if (!this.textures.exists('clown_idle')) return; // sprite not shipped yet
    if (!this.anims.exists('clown_idle')) {
      const frameCount = this.textures.get('clown_idle').frameTotal - 1;
      this.anims.create({
        key: 'clown_idle',
        frames: this.anims.generateFrameNumbers('clown_idle', { start: 0, end: Math.max(0, frameCount - 1) }),
        frameRate: 4, repeat: -1,
      });
    }
    this.clown = this.add.sprite(x, y, 'clown_idle')
      .setScale(0.75).setOrigin(0.5, 0.9).setDepth(y);
    this.clown.play('clown_idle');
    this.addNpcName('The Clown', x, y - 62);
    this.startNpcChatter('clown', x, y - 74, CLOWN_LINES, '#ffd2f4', '#1a0014cc',
      () => !!this.clown?.active);
  }

  /** Generic self-scheduling bark cycler for an idle NPC. Desynced from the
   *  others via a random start delay + per-cycle jitter so bubbles never line up. */
  private startNpcChatter(
    id: string, ax: number, ay: number, lines: string[],
    color: string, bg: string, isAlive: () => boolean,
  ): void {
    let i = Phaser.Math.Between(0, lines.length - 1); // random first line
    const say = (): void => {
      if (!isAlive()) return;
      this.showNpcBubble(id, ax, ay, lines[i % lines.length], color, bg);
      i++;
      this.time.delayedCall(8500 + Phaser.Math.Between(0, 3500), say);
    };
    this.time.delayedCall(1200 + Phaser.Math.Between(0, 6000), say);
  }

  /** A wrapped speech bubble over a chattering NPC, fades after a few seconds. */
  private showNpcBubble(id: string, x: number, y: number, text: string, color: string, bg: string): void {
    this.chatBubbles.get(id)?.destroy();
    const bubble = this.add.text(x, y, text, {
      fontSize: '11px', fontFamily: 'monospace', color,
      backgroundColor: bg, padding: { x: 7, y: 4 },
      align: 'center', wordWrap: { width: 160 },
    }).setOrigin(0.5, 1).setDepth(D_BUBBLE);
    this.chatBubbles.set(id, bubble);
    this.tweens.add({
      targets: bubble, alpha: 0, duration: 800, delay: 3500,
      onComplete: () => {
        bubble.destroy();
        if (this.chatBubbles.get(id) === bubble) this.chatBubbles.delete(id);
      },
    });
  }

  /** Cycle Gatchaman's barks: a bubble shows for ~4s, then ~5s of silence
   *  before the next one. Self-scheduling so the gap stays consistent. */
  private startGatchamanChatter(): void {
    let i = 0;
    const say = (): void => {
      if (!this.gatchaman?.active) return;
      this.showGatchamanBubble(GATCHAMAN_LINES[i % GATCHAMAN_LINES.length]);
      i++;
      this.time.delayedCall(9300, say); // ~4.3s visible + ~5s gap
    };
    this.time.delayedCall(1800, say);
  }

  /** A wrapped speech bubble over Gatchaman's head that fades after a few sec. */
  private showGatchamanBubble(text: string): void {
    if (!this.gatchaman) return;
    this.gatchamanBubble?.destroy();
    const bubble = this.add.text(this.gatchamanX, this.gatchamanY - 84, text, {
      fontSize: '11px', fontFamily: 'monospace', color: '#ffe6ff',
      backgroundColor: '#1a001acc', padding: { x: 7, y: 4 },
      align: 'center', wordWrap: { width: 160 },
    }).setOrigin(0.5, 1).setDepth(D_BUBBLE);
    this.gatchamanBubble = bubble;
    this.tweens.add({
      targets: bubble, alpha: 0, duration: 800, delay: 3500,
      onComplete: () => {
        bubble.destroy();
        if (this.gatchamanBubble === bubble) this.gatchamanBubble = undefined;
      },
    });
  }


  /** Rasterise every solid obstacle's silhouette into a collision bitmap, at
   *  its exact placed transform — so collision follows each asset's real shape. */
  private buildCollisionMask(width: number, height: number): void {
    const cv = document.createElement('canvas');
    cv.width = width; cv.height = height;
    const ctx = cv.getContext('2d');
    if (!ctx) return;
    for (const obj of this.solids) {
      const src = obj.texture.getSourceImage() as CanvasImageSource;
      const fr = obj.frame;
      const dw = fr.cutWidth * obj.scaleX;
      const dh = fr.cutHeight * obj.scaleY;
      const dx = obj.x - obj.originX * dw;
      const dy = obj.y - obj.originY * dh;
      try {
        if (obj.flipX) {
          ctx.save();
          ctx.translate(dx + dw, dy);
          ctx.scale(-1, 1);
          ctx.drawImage(src, fr.cutX, fr.cutY, fr.cutWidth, fr.cutHeight, 0, 0, dw, dh);
          ctx.restore();
        } else {
          ctx.drawImage(src, fr.cutX, fr.cutY, fr.cutWidth, fr.cutHeight, dx, dy, dw, dh);
        }
      } catch { /* ignore a stray draw */ }
    }
    const data = ctx.getImageData(0, 0, width, height).data;
    const mask = new Uint8Array(width * height);
    for (let i = 0; i < width * height; i++) {
      if (data[i * 4 + 3] > 150) mask[i] = 1; // only near-opaque core = solid (ignores glow/shadow)
    }
    this.collision = mask; this.collisionW = width; this.collisionH = height;
  }

  /** True if the player's feet (a small span) would sit on a solid pixel. */
  private solidAt(x: number, y: number): boolean {
    if (!this.collision) return false;
    const W = this.collisionW, H = this.collisionH;
    const probes: Array<[number, number]> = [[x - 8, y + 6], [x, y + 6], [x + 8, y + 6]];
    for (const [px, py] of probes) {
      const ix = px | 0, iy = py | 0;
      if (ix < 0 || iy < 0 || ix >= W || iy >= H) continue;
      if (this.collision[iy * W + ix]) return true;
    }
    return false;
  }

  /** True if the player's feet at (x,y) are inside the walkable arena polygon. */
  private inWalkable(x: number, y: number): boolean {
    const py = y + 8; // test the feet, not the sprite centre
    const poly = LOBBY_WALKABLE;
    let inside = false;
    for (let i = 0, j = poly.length - 1; i < poly.length; j = i++) {
      const xi = poly[i][0], yi = poly[i][1], xj = poly[j][0], yj = poly[j][1];
      if (((yi > py) !== (yj > py)) && x < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
  }

  // ─── Ambient NPCs (wanderers + stage crowd; reuse player avatar art) ────────

  /** A random walkable, non-solid point for an NPC to amble toward. */
  private randomWalkablePoint(): { x: number; y: number } {
    // Sample the interior of the floor (not the extreme edges) so wanderers
    // don't aim at the perimeter and wedge against it.
    for (let i = 0; i < 60; i++) {
      const x = Phaser.Math.Between(290, 1010);
      const y = Phaser.Math.Between(430, 660);
      if (this.inWalkable(x, y) && !this.solidAt(x, y)) return { x, y };
    }
    return { x: 650, y: 540 }; // known-inside fallback
  }

  private pickNpcTarget(npc: WanderNpc): void {
    const p = this.randomWalkablePoint();
    npc.tx = p.x; npc.ty = p.y;
    npc.stuckMs = 0;
  }

  /** Released items grouped by slot (for random NPC outfits), cached.
   *  Hats/head accessories are intentionally excluded (the wizard hat is the
   *  only released one and it sits off the body). */
  private releasedItemsBySlot(): Record<string, string[]> {
    if (this.releasedBySlot) return this.releasedBySlot;
    const SLOTS = ['upper_body', 'lower_body', 'feet'];
    const bySlot: Record<string, string[]> = {};
    for (const [id, def] of Object.entries(ITEMS)) {
      if ((def as { released?: boolean }).released === false) continue;
      const slot = (def as { slot?: string }).slot;
      if (slot && SLOTS.includes(slot)) (bySlot[slot] ??= []).push(id);
    }
    this.releasedBySlot = bySlot;
    return bySlot;
  }

  /** A random outfit: always a top + bottom (fully clothed, no hat), random shoes. */
  private randomLoadout(): Record<string, string> {
    const bySlot = this.releasedItemsBySlot();
    const loadout: Record<string, string> = {};
    const rnd = (a: string[]): string => a[Math.floor(Math.random() * a.length)];
    // Always 3 pieces: a tshirt, pants, and sneakers.
    if (bySlot.upper_body?.length) loadout.upper_body = rnd(bySlot.upper_body);
    if (bySlot.lower_body?.length) loadout.lower_body = rnd(bySlot.lower_body);
    if (bySlot.feet?.length) loadout.feet = rnd(bySlot.feet);
    return loadout;
  }

  /** Give an NPC a random outfit and build its equipment layers. */
  private dressNpc(npc: WanderNpc): void {
    npc.loadout = this.randomLoadout();
    this.ensureEquipLoaded(npc.loadout, npc.charKey, () => {
      if (!npc.sprite.active) return;
      this.rebuildEquip(npc.equip, npc.loadout, npc.charKey, npc.sprite.y);
    });
  }

  /** Spawn ambient NPCs that wander between random walkable points, dressed. */
  private createNpcs(count: number): void {
    for (let i = 0; i < count; i++) {
      const charKey = PL_CHAR_KEYS[i % PL_CHAR_KEYS.length];
      const { x, y } = this.randomWalkablePoint();
      const sprite = this.add.sprite(x, y, `${charKey}_south-east`)
        .setScale(0.75).setOrigin(0.5, 0.85).setDepth(y);
      sprite.play(`${charKey}_idle_SD`);
      const npc: WanderNpc = {
        sprite, charKey, facing: 'SD', tx: x, ty: y, pauseUntil: 0,
        stuckMs: 0, moving: false, isCrowd: false, loadout: {}, equip: new Map(),
      };
      this.pickNpcTarget(npc);
      this.dressNpc(npc);
      this.npcs.push(npc);
    }
  }

  /** Move + animate the NPCs each frame (wanderers roam; crowd stands cheering). */
  private updateNpcs(delta: number): void {
    const step = NPC_SPEED * (delta / 1000);
    const now = this.time.now;
    for (const npc of this.npcs) {
      const s = npc.sprite;
      if (npc.isCrowd) { // stationary, facing the stage
        npc.moving = false;
        this.syncEquip(npc.equip, s.x, s.y, npc.facing, false, s.depth, s);
        continue;
      }
      if (now >= npc.pauseUntil) {
        const dx = npc.tx - s.x, dy = npc.ty - s.y;
        const dist = Math.hypot(dx, dy);
        if (dist < 5) { // arrived → idle a moment, then a new spot
          npc.pauseUntil = now + Phaser.Math.Between(1200, 3500);
          npc.moving = false;
          this.pickNpcTarget(npc);
        } else {
          const ux = dx / dist, uy = dy / dist;
          const ox = s.x, oy = s.y;
          if (this.inWalkable(s.x + ux * step, s.y) && !this.solidAt(s.x + ux * step, s.y)) s.x += ux * step;
          if (this.inWalkable(s.x, s.y + uy * step) && !this.solidAt(s.x, s.y + uy * step)) s.y += uy * step;
          const advanced = Math.hypot(s.x - ox, s.y - oy);
          npc.stuckMs = advanced < step * 0.5 ? npc.stuckMs + delta : 0;
          if (npc.stuckMs > 500) this.pickNpcTarget(npc); // wedged on an edge → retarget
          npc.moving = advanced > 0.1;
          if (npc.moving) {
            const oct = ((Math.round(Math.atan2(uy, ux) / (Math.PI / 4)) % 8) + 8) % 8;
            npc.facing = DIRS_BY_OCTANT[oct];
            s.setFlipX(PIXELLAB_DIR_MAP[npc.facing].flipX);
          }
        }
      } else {
        npc.moving = false;
      }
      const animKey = npc.moving ? `${npc.charKey}_walk_${npc.facing}` : `${npc.charKey}_idle_${npc.facing}`;
      if (s.anims.currentAnim?.key !== animKey) s.play(animKey, true);
      s.setDepth(s.y);
      this.syncEquip(npc.equip, s.x, s.y, npc.facing, npc.moving, s.y, s);
    }
  }

  /** A dense, evenly-scrambled crowd in front of the band stage, all facing it.
   *  Members keep a minimum spacing so they touch/overlap a little, not heavily. */
  private createCrowd(cx: number, cy: number, rx: number, ry: number): void {
    const placedPts: Array<[number, number]> = [];
    const minDist = 15, spacing = 23; // jittered grid → even fill, no big gaps
    for (let gy = cy - ry; gy <= cy + ry; gy += spacing) {
      for (let gx = cx - rx; gx <= cx + rx; gx += spacing) {
      const x = Math.round(gx + Phaser.Math.Between(-7, 7));
      const y = Math.round(gy + Phaser.Math.Between(-6, 6));
      const ex = (x - cx) / rx, ey = (y - cy) / ry;
      if (ex * ex + ey * ey > 1) continue;                 // keep inside the oval
      if (x > 812) continue;                               // clear of the Crazy Race building (right)
      if (!this.inWalkable(x, y) || this.solidAt(x, y)) continue;
      if (placedPts.some(([px, py]) => Math.hypot(px - x, py - y) < minDist)) continue;
      placedPts.push([x, y]);
      const charKey = PL_CHAR_KEYS[Phaser.Math.Between(0, PL_CHAR_KEYS.length - 1)];
      const sprite = this.add.sprite(x, y, `${charKey}_north`)
        .setScale(0.72).setOrigin(0.5, 0.85).setDepth(y);
      sprite.setFlipX(PIXELLAB_DIR_MAP['W'].flipX);
      sprite.play(`${charKey}_idle_W`); // 'W' = facing north, toward the stage
      // Cheering bounce — staggered so the crowd ripples (equip follows via sync).
      this.tweens.add({
        targets: sprite, y: y - Phaser.Math.Between(3, 7),
        duration: Phaser.Math.Between(320, 600), yoyo: true, repeat: -1,
        ease: 'Sine.easeInOut', delay: Phaser.Math.Between(0, 600),
      });
      const npc: WanderNpc = {
        sprite, charKey, facing: 'W', tx: x, ty: y, pauseUntil: 0,
        stuckMs: 0, moving: false, isCrowd: true, loadout: {}, equip: new Map(),
      };
      this.dressNpc(npc);
      this.npcs.push(npc);
      }
    }
  }

  // ─── Layout editor (?lobby&edit) ────────────────────────────────────────
  /** Drag/rotate/mirror/scale the buildings, click out a walkable polygon and
   *  collision rectangles, then export the whole layout as JSON to bake in. */
  private setupEditor(): void {
    type Img = Phaser.GameObjects.Image;
    const items = ([...this.solids, this.gatchaman].filter(Boolean) as Img[]);
    let mode: 'move' | 'walk' | 'collide' = 'move';
    let selected: Img | null = null;
    const walk: { x: number; y: number }[] = [];        // walkable polygon
    const collPolys: { x: number; y: number }[][] = []; // finished collision shapes
    let curColl: { x: number; y: number }[] = [];       // collision shape being drawn

    const gfx = this.add.graphics().setDepth(D_PROMPT - 1);
    const redraw = (): void => {
      gfx.clear();
      if (walk.length) {
        gfx.fillStyle(0x33ff66, 0.12); gfx.lineStyle(2, 0x33ff66, 1);
        gfx.beginPath(); gfx.moveTo(walk[0].x, walk[0].y);
        for (let i = 1; i < walk.length; i++) gfx.lineTo(walk[i].x, walk[i].y);
        gfx.closePath(); gfx.fillPath(); gfx.strokePath();
        gfx.fillStyle(0x33ff66, 1);
        for (const p of walk) gfx.fillCircle(p.x, p.y, 4);
      }
      const drawPoly = (pts: { x: number; y: number }[], closed: boolean): void => {
        if (!pts.length) return;
        gfx.beginPath(); gfx.moveTo(pts[0].x, pts[0].y);
        for (let i = 1; i < pts.length; i++) gfx.lineTo(pts[i].x, pts[i].y);
        if (closed) { gfx.closePath(); gfx.fillPath(); }
        gfx.strokePath();
        for (const p of pts) gfx.fillCircle(p.x, p.y, 3);
      };
      gfx.fillStyle(0xff4488, 0.18); gfx.lineStyle(2, 0xff4488, 1);
      for (const poly of collPolys) drawPoly(poly, true);
      drawPoly(curColl, false);
      if (selected) {
        const b = selected.getBounds();
        gfx.lineStyle(2, 0xffe000, 1); gfx.strokeRect(b.x, b.y, b.width, b.height);
      }
    };

    for (const o of items) o.setInteractive({ draggable: true });

    this.input.on('drag', (_p: Phaser.Input.Pointer, obj: Img, dx: number, dy: number) => {
      if (mode !== 'move') return;
      if (obj.getData('ename') === 'bandstage') {
        const ddx = dx - obj.x, ddy = dy - obj.y;
        for (const part of this.bandStageParts) {
          const p = part as unknown as { x: number; y: number };
          if (typeof p.x === 'number') { p.x += ddx; p.y += ddy; }
        }
      }
      obj.x = Math.round(dx); obj.y = Math.round(dy);
      if (obj.getData('ename') !== 'bandstage') obj.setDepth(obj.y);
      selected = obj; this.updateEditorPanel(selected, mode); redraw();
    });
    this.input.on('gameobjectdown', (_p: Phaser.Input.Pointer, obj: Img) => {
      if (mode === 'move') { selected = obj; this.updateEditorPanel(selected, mode); redraw(); }
    });
    this.input.on('pointerdown', (p: Phaser.Input.Pointer) => {
      const pt = { x: Math.round(p.worldX), y: Math.round(p.worldY) };
      if (mode === 'walk') { walk.push(pt); redraw(); }
      else if (mode === 'collide') { curColl.push(pt); redraw(); }
    });

    this.input.keyboard!.on('keydown', (e: KeyboardEvent) => {
      if (mode !== 'move' || !selected) return;
      const o = selected; let used = true;
      const k = e.key.toLowerCase();
      if (k === 'f') o.toggleFlipX();
      else if (k === '[') o.angle -= 5;
      else if (k === ']') o.angle += 5;
      else if (k === '+' || k === '=') o.setScale(o.scaleX * 1.05);
      else if (k === '-' || k === '_') o.setScale(o.scaleX * 0.95);
      else if (k === 'arrowup') { o.y -= 1; o.setDepth(o.y); }
      else if (k === 'arrowdown') { o.y += 1; o.setDepth(o.y); }
      else if (k === 'arrowleft') o.x -= 1;
      else if (k === 'arrowright') o.x += 1;
      else used = false;
      if (used) { e.preventDefault(); this.updateEditorPanel(o, mode); redraw(); }
    });

    // Build the editor panel (DOM).
    const panel = document.createElement('div');
    panel.style.cssText = `position:fixed;top:8px;left:8px;width:250px;background:#0d0d18ee;
      border:1px solid #4af;border-radius:6px;padding:10px;z-index:9500;font-family:monospace;
      color:#cde;font-size:11px;line-height:1.5;`;
    panel.addEventListener('keydown', (e) => e.stopPropagation());
    panel.addEventListener('pointerdown', (e) => e.stopPropagation());
    const setMode = (m: 'move' | 'walk' | 'collide'): void => { mode = m; this.updateEditorPanel(selected, mode); };
    const exportLayout = (): void => {
      const layout = {
        buildings: items.map((o) => ({
          name: o.getData('ename'), x: Math.round(o.x), y: Math.round(o.y),
          scale: +o.scaleX.toFixed(3), angle: Math.round(o.angle), flipX: o.flipX,
        })),
        walkable: walk,
        collision: curColl.length > 2 ? [...collPolys, curColl] : collPolys,
      };
      const json = JSON.stringify(layout, null, 2);
      const ta = panel.querySelector('#ed-out') as HTMLTextAreaElement;
      ta.value = json;
      try { void navigator.clipboard.writeText(json); } catch { /* ignore */ }
    };
    panel.innerHTML = `
      <div style="color:#4af;font-weight:bold;margin-bottom:4px;">LAYOUT EDITOR</div>
      <div id="ed-info" style="color:#8fa;min-height:30px;"></div>
      <div style="margin:6px 0;">Mode:
        <button id="ed-move">Move</button>
        <button id="ed-walk">Walkable</button>
        <button id="ed-coll">Collision</button>
      </div>
      <div style="margin:6px 0;">Selected:
        <button id="ed-flip">Flip</button>
        <button id="ed-rotl">Rot&minus;</button>
        <button id="ed-rotr">Rot+</button>
        <button id="ed-big">Big+</button>
        <button id="ed-small">Big&minus;</button>
      </div>
      <div style="color:#9ab;">Click a building, then use the buttons above.<br>
        Drag to move · arrows nudge<br>
        Walkable/Collision: click points to draw a free shape</div>
      <div style="margin:6px 0;">
        <button id="ed-close">Close shape</button>
        <button id="ed-undo">Undo pt</button>
        <button id="ed-clear">Clear marks</button>
      </div>
      <button id="ed-export" style="width:100%;padding:5px;background:#4af;color:#012;border:none;border-radius:4px;font-weight:bold;cursor:pointer;">EXPORT (copies to clipboard)</button>
      <textarea id="ed-out" style="width:100%;height:120px;margin-top:6px;background:#02030a;color:#7fd;border:1px solid #345;font-size:9px;" readonly></textarea>`;
    document.body.appendChild(panel);
    this.editorPanel = panel;
    (panel.querySelector('#ed-move') as HTMLButtonElement).onclick = () => setMode('move');
    (panel.querySelector('#ed-walk') as HTMLButtonElement).onclick = () => setMode('walk');
    (panel.querySelector('#ed-coll') as HTMLButtonElement).onclick = () => setMode('collide');
    // Transform the selected object via buttons (reliable even after the panel
    // takes keyboard focus). The band stage flips/scales as a group.
    const tf = (fn: (o: Img) => void): void => {
      if (!selected) return;
      fn(selected);
      if (selected.getData('ename') !== 'bandstage') selected.setDepth(selected.y);
      this.updateEditorPanel(selected, mode); redraw();
    };
    (panel.querySelector('#ed-flip') as HTMLButtonElement).onclick = () => tf((o) => o.toggleFlipX());
    (panel.querySelector('#ed-rotl') as HTMLButtonElement).onclick = () => tf((o) => { o.angle -= 5; });
    (panel.querySelector('#ed-rotr') as HTMLButtonElement).onclick = () => tf((o) => { o.angle += 5; });
    (panel.querySelector('#ed-big') as HTMLButtonElement).onclick = () => tf((o) => o.setScale(o.scaleX * 1.05));
    (panel.querySelector('#ed-small') as HTMLButtonElement).onclick = () => tf((o) => o.setScale(o.scaleX * 0.95));
    (panel.querySelector('#ed-close') as HTMLButtonElement).onclick = () => {
      if (curColl.length > 2) { collPolys.push(curColl); curColl = []; redraw(); }
    };
    (panel.querySelector('#ed-undo') as HTMLButtonElement).onclick = () => {
      if (mode === 'walk') walk.pop();
      else if (mode === 'collide') { if (curColl.length) curColl.pop(); else collPolys.pop(); }
      redraw();
    };
    (panel.querySelector('#ed-clear') as HTMLButtonElement).onclick = () => {
      walk.length = 0; collPolys.length = 0; curColl = []; redraw();
    };
    (panel.querySelector('#ed-export') as HTMLButtonElement).onclick = exportLayout;
    this.updateEditorPanel(null, mode);
  }

  /** Refresh the editor panel's selected-object readout. */
  private updateEditorPanel(sel: Phaser.GameObjects.Image | null, mode: string): void {
    const info = this.editorPanel?.querySelector('#ed-info');
    if (!info) return;
    const m = `Mode: <b style="color:#4af">${mode}</b><br>`;
    info.innerHTML = sel
      ? `${m}<b>${sel.getData('ename')}</b><br>x:${Math.round(sel.x)} y:${Math.round(sel.y)} ` +
        `scale:${sel.scaleX.toFixed(2)} angle:${Math.round(sel.angle)} flip:${sel.flipX}`
      : `${m}<i>click a building to select</i>`;
  }

  /** Rock band stage centerpiece: the stage platform, a flashing neon
   *  CRAZY STUFF sign mounted above it, and three headbanging band members.
   *  Every asset is guarded so a not-yet-shipped sprite is simply skipped. */
  private createBandStage(cx: number, cy: number): void {
    const _partsStart = this.children.list.length; // capture stage parts for the editor
    let stageTopY = cy - 110;
    // The stage platform (depth below the band + players).
    if (this.textures.exists('band_stage')) {
      const stage = this.add.image(cx, cy, 'band_stage')
        .setOrigin(0.5, 0.5).setDepth(D_STAGE_FLOOR);
      stage.setData('ename', 'bandstage');
      stageTopY = stage.getTopCenter().y;
      this.solids.push(stage);
    }

    // Band members on the stage. Drummer first (back-center on the riser) so
    // the front row (guitarist / singer / bassist) renders over him.
    const members: Array<{ key: string; dx: number; dy: number }> = [
      { key: 'band_drummer',   dx: 0,   dy: -38 },
      { key: 'band_guitarist', dx: -50, dy: 30 },
      { key: 'band_singer',    dx: 0,   dy: 40 },
      { key: 'band_bassist',   dx: 50,  dy: 30 },
    ];
    for (const m of members) this.addBandMember(m.key, cx + m.dx, cy + m.dy);

    // Kick drum + riser front, redrawn just in front of the drummer (his feet
    // are at cy-38) so his lower body is hidden behind the kit.
    if (this.textures.exists('stage_drumkit')) {
      this.add.image(cx, cy, 'stage_drumkit').setOrigin(0.5, 0.5).setDepth(cy - 37.5);
    }

    // Mic stand in front of the singer — its base (cy+66) is below the singer's
    // feet (cy+40), so Y-sort puts it in front of him without covering his face.
    if (this.textures.exists('mic_stand')) {
      this.add.image(cx, cy + 66, 'mic_stand')
        .setOrigin(0.5, 1).setScale(0.40).setDepth(cy + 66);
    }

    // Stage lighting + smoke FX (purely code; no art needed).
    this.createStageFX(cx, cy, stageTopY);

    // Neon CRAZY STUFF sign mounted above the stage, flashing like real neon.
    if (this.textures.exists('crazy_sign')) {
      const sign = this.add.image(cx, stageTopY - 14, 'crazy_sign')
        .setOrigin(0.5, 1);
      // Scale the sign to mount above the stage (about half the stage width).
      const target = 150 / sign.width;
      sign.setScale(target);

      // Metal truss rig so the sign reads as mounted, not floating: a top beam
      // it hangs from, plus two legs running down onto the stage. The rig's feet
      // (legBot) are at the back of the stage, so it Y-sorts as a tall structure
      // there — players/band in front of it draw over it.
      const b = sign.getBounds();
      const beamY = b.y - 7;
      const legBot = stageTopY + 18;
      const lX = b.x + 18, rX = b.right - 18;
      sign.setDepth(legBot - 0.5);
      const truss = this.add.graphics().setDepth(legBot - 1);
      this.drawTrussSegment(truss, b.x - 12, beamY, b.right + 12, beamY); // top beam
      this.drawTrussSegment(truss, lX, beamY, lX, legBot);                // left leg
      this.drawTrussSegment(truss, rX, beamY, rX, legBot);                // right leg
      truss.fillStyle(0x3a3d45, 1);                                       // base feet
      truss.fillRect(lX - 8, legBot - 2, 16, 4);
      truss.fillRect(rX - 8, legBot - 2, 16, 4);
      sign.setBlendMode(Phaser.BlendModes.NORMAL);
      // Gentle neon glow pulse...
      this.tweens.add({
        targets: sign, alpha: { from: 1, to: 0.86 },
        duration: 520, yoyo: true, repeat: -1, ease: 'Sine.easeInOut',
      });
      // ...with an occasional sharp "buzz" flicker.
      this.tweens.add({
        targets: sign, alpha: 0.5, duration: 70, yoyo: true,
        repeat: -1, repeatDelay: 3200, ease: 'Quad.easeIn',
      });
    }
    // All objects added during this method = the stage group (for the editor).
    this.bandStageParts = this.children.list.slice(_partsStart);
  }

  /** Add one band member sprite playing its looping "play" animation. */
  private addBandMember(texKey: string, x: number, y: number): void {
    if (!this.textures.exists(texKey)) return; // sprite not shipped yet
    const animKey = `${texKey}_play`;
    if (!this.anims.exists(animKey)) {
      const frameCount = this.textures.get(texKey).frameTotal - 1; // minus __BASE
      this.anims.create({
        key: animKey,
        frames: this.anims.generateFrameNumbers(texKey, { start: 0, end: Math.max(0, frameCount - 1) }),
        frameRate: 8,
        repeat: -1,
      });
    }
    // Match the player avatars' dimensions (92px frame @ 0.75, feet origin) and
    // Y-sort by feet so players walk among the band correctly.
    this.add.sprite(x, y, texKey)
      .setScale(0.75).setOrigin(0.5, 0.85).setDepth(y)
      .play(animKey);
  }

  /** Draw one metal truss segment (two rails + X cross-bracing) between two
   *  points. Works at any orientation — used for the sign rig's beam and legs. */
  private drawTrussSegment(g: Phaser.GameObjects.Graphics, ax: number, ay: number, bx: number, by: number): void {
    const dx = bx - ax, dy = by - ay;
    const len = Math.hypot(dx, dy) || 1;
    const px = -dy / len, py = dx / len; // unit perpendicular
    const off = 3.5;                     // rail half-separation
    // Two parallel rails.
    g.lineStyle(2, 0x9aa0ad, 1);
    g.lineBetween(ax + px * off, ay + py * off, bx + px * off, by + py * off);
    g.lineBetween(ax - px * off, ay - py * off, bx - px * off, by - py * off);
    // X cross-braces along the run.
    g.lineStyle(1.5, 0x565b66, 1);
    const n = Math.max(1, Math.round(len / 13));
    for (let i = 0; i < n; i++) {
      const t0 = i / n, t1 = (i + 1) / n;
      const x0 = ax + dx * t0, y0 = ay + dy * t0, x1 = ax + dx * t1, y1 = ay + dy * t1;
      g.lineBetween(x0 + px * off, y0 + py * off, x1 - px * off, y1 - py * off);
      g.lineBetween(x0 - px * off, y0 - py * off, x1 + px * off, y1 + py * off);
    }
  }

  /** Concert lighting + atmosphere over the stage: sweeping moving-head
   *  spotlight beams and drifting smoke-machine haze. All procedural — no art. */
  private createStageFX(cx: number, cy: number, stageTopY: number): void {
    // Soft round puff texture for smoke (radial white → transparent).
    if (!this.textures.exists('fx_smoke')) {
      const g = this.make.graphics({ x: 0, y: 0 });
      const r = 32;
      for (let i = r; i > 0; i--) {
        g.fillStyle(0xffffff, 0.06);
        g.fillCircle(r, r, i);
      }
      g.generateTexture('fx_smoke', r * 2, r * 2);
      g.destroy();
    }
    // Beam texture: a triangle, apex at top (the light source), widening down.
    if (!this.textures.exists('fx_beam')) {
      const w = 130, h = 230;
      const g = this.make.graphics({ x: 0, y: 0 });
      g.fillStyle(0xffffff, 1);
      g.beginPath();
      g.moveTo(w / 2, 0);
      g.lineTo(w * 0.04, h);
      g.lineTo(w * 0.96, h);
      g.closePath();
      g.fillPath();
      g.generateTexture('fx_beam', w, h);
      g.destroy();
    }

    // Moving-head spotlights: colored beams from above the stage that sweep
    // side to side, each on its own phase, glowing via additive blending.
    const beamSrcY = stageTopY + 8;
    const beams = [
      { color: 0xff3df0, dx: -78, phase: 0 },
      { color: 0x3df0ff, dx: 0,   phase: 850 },
      { color: 0xffe23d, dx: 78,  phase: 1700 },
    ];
    for (const b of beams) {
      const beam = this.add.image(cx + b.dx, beamSrcY, 'fx_beam')
        .setOrigin(0.5, 0).setDepth(D_FX)
        .setTint(b.color).setAlpha(0.16)
        .setBlendMode(Phaser.BlendModes.ADD);
      this.tweens.add({
        targets: beam, angle: { from: -16, to: 16 },
        duration: 2600, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: b.phase,
      });
      this.tweens.add({
        targets: beam, alpha: { from: 0.10, to: 0.24 },
        duration: 1200, yoyo: true, repeat: -1, ease: 'Sine.easeInOut', delay: b.phase,
      });
    }

    // Smoke machine: pale haze billowing up from the front corners of the
    // stage, drifting through the band. Near-white so it reads against both the
    // dark stage and the grey wall, and catches the colored beams.
    for (const sx of [cx - 96, cx + 96]) {
      this.add.particles(sx, cy + 36, 'fx_smoke', {
        speedY: { min: -24, max: -46 },
        speedX: { min: -12, max: 12 },
        scale: { start: 0.6, end: 2.8 },
        alpha: { start: 0.6, end: 0 },
        lifespan: 3600,
        frequency: 300,
        tint: 0xf2f5fb,
      }).setDepth(D_FX);
    }
  }

  /** Draw a standing notice board for the seasonal leaderboard (#23).
   *  Placeholder art until real pixel-art lands. */
  /** Leaderboard billboard — a lit sign the player walks up to. */
  private drawLeaderboardWall(bx: number, by: number): void {
    const tex = this.textures.exists('leaderboard_iso') ? 'leaderboard_iso' : 'leaderboard_board';
    const scale = tex === 'leaderboard_iso' ? 0.85 : 1.6;
    const board = this.add.image(bx, by + 60, tex)
      .setOrigin(0.5, 1).setScale(scale).setDepth(BEHIND_PLAYERS).setTint(BUILDING_TINT);
    board.setData('ename', 'leaderboard');
    this.solids.push(board);
    this.placeBuildingSign('rankings_sign', bx, board.getTopCenter().y + 10, 92, 'Rankings', '#ff6a6a');
  }

  // ─── Leaderboard (#23; walk-up board, top players by season XP) ─────────────

  private toggleLeaderboard(): void {
    if (this.leaderboardPanel) { this.leaderboardPanel.remove(); this.leaderboardPanel = null; return; }
    this.openLeaderboard();
  }

  private openLeaderboard(): void {
    if (this.leaderboardPanel) { this.leaderboardPanel.remove(); this.leaderboardPanel = null; }
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
    closeBtn.onclick = () => { this.leaderboardPanel?.remove(); this.leaderboardPanel = null; };
    panel.appendChild(closeBtn);

    const title = document.createElement('h2');
    title.textContent = '\u{1F3C6} LEADERBOARD';
    title.style.cssText = 'margin: 0 0 4px; text-align: center; color: #ffdd44; font-size: 18px;';
    panel.appendChild(title);

    const content = document.createElement('div');
    content.id = 'leaderboard-content';
    panel.appendChild(content);

    document.body.appendChild(panel);
    this.leaderboardPanel = panel;
    void this.renderLeaderboardContent(content);
  }

  private async renderLeaderboardContent(content: HTMLDivElement): Promise<void> {
    content.innerHTML = '<p style="text-align:center;color:#888">Loading…</p>';
    const authId = this.authState?.session?.user?.id;
    const esc = (s: string) => s.replace(/[&<>"']/g, (c) =>
      ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]!));
    const medal = (r: number) => r === 1 ? '\u{1F947}' : r === 2 ? '\u{1F948}' : r === 3 ? '\u{1F949}' : `#${r}`;
    try {
      const reqs: Promise<Response>[] = [fetch(`${this.apiBase()}/api/leaderboard?limit=25`)];
      if (authId) reqs.push(fetch(`${this.apiBase()}/api/player/${authId}/rank`, { headers: this.authHeader() }));
      const [boardRes, rankRes] = await Promise.all(reqs);
      const board = await boardRes.json();
      const myRank = rankRes ? await rankRes.json() : null;
      content.innerHTML = '';

      // Season header
      const season = document.createElement('div');
      season.style.cssText = 'text-align:center;color:#aaa;font-size:12px;margin-bottom:14px;';
      season.textContent = `Season ${seasonLabel(board.seasonId)}`;
      content.appendChild(season);

      if (!board.entries.length) {
        const empty = document.createElement('p');
        empty.style.cssText = 'text-align:center;color:#888;line-height:1.5;';
        empty.textContent = 'No racers ranked yet this season — be the first! Win races to climb the board.';
        content.appendChild(empty);
      } else {
        const list = document.createElement('div');
        list.innerHTML = board.entries.map((e: any) => {
          const me = !!authId && e.userId === authId;
          return `<div style="display:flex;align-items:center;gap:8px;padding:6px 8px;border-radius:6px;margin-bottom:4px;${me ? 'background:#2a2a4e;border:1px solid #ffdd44;' : ''}">
            <span style="width:34px;text-align:center;font-weight:bold;color:#ffdd44;">${medal(e.rank)}</span>
            <span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${esc(e.username)} <span style="color:#666;font-size:11px;">Lv${e.level}</span></span>
            <span style="color:#9cc99c;font-size:12px;width:42px;text-align:right;">${e.seasonWins}W</span>
            <span style="color:#ffe;width:78px;text-align:right;">${e.seasonXp} XP</span>
          </div>`;
        }).join('');
        content.appendChild(list);
      }

      // The viewer's own standing (esp. when outside the top N).
      if (myRank) {
        const inTop = !!authId && board.entries.some((e: any) => e.userId === authId);
        const foot = document.createElement('div');
        foot.style.cssText = 'margin-top:14px;border-top:1px solid #333;padding-top:10px;text-align:center;font-size:12px;color:#ccc;';
        if (myRank.rank === null) {
          foot.textContent = "You haven't scored this season yet — race to get on the board!";
        } else if (inTop) {
          foot.textContent = `You're #${myRank.rank} of ${myRank.totalRanked} this season \u{1F389}`;
        } else {
          foot.textContent = `Your rank: #${myRank.rank} of ${myRank.totalRanked} · ${myRank.seasonXp} XP`;
        }
        content.appendChild(foot);
      }
    } catch (e) {
      console.error('[Leaderboard] load failed:', e);
      content.innerHTML = '<p style="text-align:center;color:#c66">Couldn’t load the leaderboard. Try again.</p>';
    }
  }

  /** The Store building (#25) — a storefront the player walks up to. */
  private drawCoinShop(sx: number, sy: number): void {
    const tex = this.textures.exists('store_iso') ? 'store_iso' : 'store_building';
    const scale = tex === 'store_iso' ? 0.97 : 0.5;
    const building = this.add.image(sx, sy + 40, tex)
      .setOrigin(0.5, 1).setScale(scale).setDepth(BEHIND_PLAYERS).setTint(BUILDING_TINT);
    building.setData('ename', 'store');
    this.solids.push(building);
    if (tex === 'store_building') {
      // Legacy art needs a label; the iso store has its own neon SHOP sign.
      this.add.text(sx - 12, building.getTopCenter().y + 54, 'STORE', {
        fontSize: '13px', fontFamily: 'monospace', color: '#ffeebb', fontStyle: 'bold',
        stroke: '#1a0e08', strokeThickness: 4,
      }).setOrigin(0.5, 1).setDepth(sy + 40.1);
    }
  }

  // ─── Coin Shop (#25; walk-up stall, monthly curated cosmetics for coins) ────

  private toggleShop(): void {
    if (this.shopPanel) { this.shopPanel.remove(); this.shopPanel = null; return; }
    this.openShop();
  }

  private openShop(): void {
    if (this.shopPanel) { this.shopPanel.remove(); this.shopPanel = null; }
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
    closeBtn.onclick = () => { this.shopPanel?.remove(); this.shopPanel = null; };
    panel.appendChild(closeBtn);

    const title = document.createElement('h2');
    title.textContent = '\u{1F3EA} STORE';
    title.style.cssText = 'margin: 0 0 4px; text-align: center; color: #ffdd44; font-size: 18px;';
    panel.appendChild(title);

    const content = document.createElement('div');
    content.id = 'shop-content';
    panel.appendChild(content);

    document.body.appendChild(panel);
    this.shopPanel = panel;
    void this.renderShopContent(content);
  }

  private async renderShopContent(content: HTMLDivElement): Promise<void> {
    content.innerHTML = '<p style="text-align:center;color:#888">Loading…</p>';
    const authId = this.authState?.session?.user?.id;
    try {
      const storeRes = await fetch(`${this.apiBase()}/api/store`);
      const store = await storeRes.json();
      let coins = 0;
      if (authId) {
        const name = encodeURIComponent(this.authState?.username ?? 'Player');
        const pRes = await fetch(`${this.apiBase()}/api/player/${authId}?username=${name}`, { headers: this.authHeader() });
        if (pRes.ok) coins = (await pRes.json()).coins ?? 0;
      }
      content.innerHTML = '';

      // Header — season label + coin balance.
      const header = document.createElement('div');
      header.style.cssText = 'display:flex;justify-content:space-between;align-items:center;color:#aaa;font-size:12px;margin-bottom:14px;';
      const seasonSpan = document.createElement('span');
      seasonSpan.textContent = `${seasonLabel(store.seasonId)} · 5 picks`;
      const coinSpan = document.createElement('span');
      coinSpan.style.cssText = 'color:#ffd84a;font-weight:bold;';
      coinSpan.textContent = `\u{1F4B0} ${coins}`;
      header.append(seasonSpan, coinSpan);
      content.appendChild(header);

      if (!store.items.length) {
        const empty = document.createElement('p');
        empty.style.cssText = 'text-align:center;color:#888;line-height:1.5;';
        empty.textContent = "This month's shop isn't stocked yet — check back soon!";
        content.appendChild(empty);
        return;
      }

      for (const it of store.items) {
        const row = document.createElement('div');
        row.style.cssText = 'display:flex;align-items:center;gap:10px;padding:8px 10px;border-radius:6px;background:#12121e;margin-bottom:8px;';

        const info = document.createElement('div');
        info.style.flex = '1';
        const name = document.createElement('div');
        name.textContent = it.displayName; // textContent — no XSS from catalog names
        name.style.color = LobbyScene.RARITY_COLORS[it.rarity] ?? '#eee';
        const sub = document.createElement('div');
        sub.style.cssText = 'font-size:11px;color:#666;text-transform:capitalize;';
        sub.textContent = `${it.rarity} · ${String(it.slot).replace(/_/g, ' ')}`;
        info.append(name, sub);

        const price = document.createElement('span');
        price.style.cssText = 'color:#ffd84a;font-size:13px;white-space:nowrap;';
        price.textContent = `\u{1F4B0} ${it.price}`;

        const buy = document.createElement('button');
        const afford = coins >= it.price;
        buy.textContent = afford ? 'Buy' : 'Need more';
        buy.disabled = !afford || !authId;
        buy.style.cssText = `padding:6px 12px;border:none;border-radius:5px;font-family:monospace;font-weight:bold;` +
          `cursor:${afford && authId ? 'pointer' : 'not-allowed'};` +
          `background:${afford && authId ? '#ffdd44' : '#333'};color:${afford && authId ? '#1a1a2e' : '#888'};`;
        if (afford && authId) buy.onclick = () => void this.buyFromShop(it.id, it.displayName, content);

        row.append(info, price, buy);
        content.appendChild(row);
      }

      const status = document.createElement('div');
      status.id = 'shop-status';
      status.style.cssText = 'text-align:center;font-size:12px;margin-top:10px;min-height:16px;';
      content.appendChild(status);
    } catch (e) {
      console.error('[Shop] load failed:', e);
      content.innerHTML = '<p style="text-align:center;color:#c66">Couldn’t load the shop. Try again.</p>';
    }
  }

  private async buyFromShop(itemId: string, name: string, content: HTMLDivElement): Promise<void> {
    const authId = this.authState?.session?.user?.id;
    if (!authId) return;
    const setStatus = (msg: string, color: string) => {
      const s = document.getElementById('shop-status');
      if (s) { s.style.color = color; s.textContent = msg; }
    };
    setStatus('Buying…', '#aaa');
    try {
      const buyId = crypto.randomUUID();
      const resp = await fetch(`${this.apiBase()}/api/player/${authId}/store/buy`, {
        method: 'POST',
        headers: { ...this.authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify({ itemId, buyId }),
      });
      const data = await resp.json();
      if (!resp.ok) { setStatus(data.message ?? 'Purchase failed.', '#e88'); return; }
      await this.renderShopContent(content); // refresh balance + affordability
      setStatus(`Bought ${name}! Find it in your inventory (I).`, '#9c9');
    } catch (e) {
      console.error('[Shop] buy failed:', e);
      setStatus('Purchase failed.', '#e88');
    }
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
    let waitingOnLoading = false;
    for (const itemId of Object.values(loadout)) {
      const eqKey = this.eqKeyFor(itemId, charKey);
      if (!eqKey) continue;
      if (this.loadedEquip.has(eqKey)) continue;            // already ready
      if (this.loadingEquip.has(eqKey)) { waitingOnLoading = true; continue; } // another caller is loading it
      toLoad.push({ itemId, slot: ITEMS[itemId].slot, eqKey });
    }
    if (toLoad.length === 0) {
      // Nothing new to queue. If a needed item is still in flight (queued by
      // another NPC this frame), wait for the loader to finish before building,
      // otherwise rebuildEquip would run on missing textures → naked NPCs.
      if (waitingOnLoading) { this.load.once('complete', onReady); this.load.start(); }
      else onReady();
      return;
    }
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
      if (this.textures.exists(i) && !this.bestIdleFrame.has(i)) {
        this.bestIdleFrame.set(i, this.fullestIdleFrame(i));
      }
    }
  }

  /** Index of the idle sheet's most-complete frame (most opaque pixels). Some
   *  PixelLab back/side idle frames drop parts of the garment; pinning idle to
   *  the fullest frame prevents the layer flashing. Computed once per texture. */
  private fullestIdleFrame(texKey: string): number {
    try {
      const src = this.textures.get(texKey).getSourceImage() as HTMLImageElement;
      const fs = src.height;
      const n = Math.max(1, Math.floor(src.width / fs));
      if (n <= 1) return 0;
      const cv = document.createElement('canvas');
      cv.width = src.width; cv.height = src.height;
      const ctx = cv.getContext('2d');
      if (!ctx) return 0;
      ctx.drawImage(src, 0, 0);
      const data = ctx.getImageData(0, 0, src.width, src.height).data;
      let best = 0, bestCount = -1;
      for (let f = 0; f < n; f++) {
        let count = 0;
        for (let y = 0; y < src.height; y++) {
          for (let x = f * fs; x < (f + 1) * fs; x++) {
            if (data[(y * src.width + x) * 4 + 3] > 0) count++;
          }
        }
        if (count > bestCount) { bestCount = count; best = f; }
      }
      return best;
    } catch {
      return 0;
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
      sprite.setData('itemId', itemId);
      target.set(slot, sprite);
      idx++;
    }
  }

  /** Glue equipment layers to a body's position and play the matching anim,
   *  locking each layer's frame to the body sprite so clothes never drift.
   *  `body` is the avatar's body sprite (local or remote) we sync frames to. */
  private syncEquip(target: Map<string, Phaser.GameObjects.Sprite>, x: number, y: number, dir: string, moving: boolean, baseDepth: number, body: Phaser.GameObjects.Sprite): void {
    if (target.size === 0) return;
    const { suffix, flip } = this.equipDir(dir);
    const bodyFrame = body.anims.currentFrame;
    let idx = 1;
    for (const [, s] of target) {
      s.setPosition(x, y);
      s.setFlipX(flip);
      s.setDepth(baseDepth + 0.001 * idx);
      const eqKey = s.getData('eqKey');
      if (moving) {
        // Walk: play + frame-lock the layer to the body's current frame.
        const animKey = `a_equip_${eqKey}_walk_${suffix}`;
        if (this.anims.exists(animKey)) {
          s.setVisible(true);
          if (s.anims.currentAnim?.key !== animKey) s.play(animKey, true);
          if (bodyFrame && s.anims.currentAnim) {
            const frames = s.anims.currentAnim.frames;
            const tgt = frames[Math.min(bodyFrame.index - 1, frames.length - 1)];
            if (tgt && s.anims.currentFrame !== tgt) s.anims.setCurrentFrame(tgt);
          }
        } else {
          s.setVisible(false);
        }
      } else {
        const idleTex = `equip_${eqKey}_idle_${suffix}`;
        if (this.textures.exists(idleTex)) {
          s.setVisible(true);
          if (s.anims.isPlaying) s.anims.stop();
          if (ITEMS[s.getData('itemId')]?.idleAnimates && bodyFrame) {
            // Clean idle sheet: frame-lock to the body's idle frame so the hat
            // bobs/sways WITH the head instead of hanging frozen.
            const n = this.textures.get(idleTex).frameTotal - 1; // minus __BASE
            const fi = Math.max(0, Math.min(bodyFrame.index - 1, n - 1));
            if (s.texture.key !== idleTex || s.frame.name !== String(fi)) s.setTexture(idleTex, fi);
          } else {
            // Older sheets: hold the fullest frame so broken back/side frames can't flash.
            const best = this.bestIdleFrame.get(idleTex) ?? 0;
            if (s.texture.key !== idleTex || s.frame.name !== String(best)) s.setTexture(idleTex, best);
          }
        } else {
          s.setVisible(false);
        }
      }
      idx++;
    }
  }

  /** Rebuild the local player's equipment layers after a loadout/char change. */
  private refreshMyEquip(): void {
    const sig = this.equipSignature(this.myLoadout, this.charKey);
    if (sig === this.myEquipSig && (this.myEquip.size > 0 || Object.keys(this.myLoadout).length === 0)) return;
    this.ensureEquipLoaded(this.myLoadout, this.charKey, () => {
      this.rebuildEquip(this.myEquip, this.myLoadout, this.charKey, this.playerY);
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
            .setScale(0.75).setOrigin(0.5, 0.85).setDepth(p.y);
          const label = this.add.text(p.x, p.y - 55, p.playerName, {
            fontSize: '13px', fontFamily: 'monospace', color: '#ffffff', fontStyle: 'bold',
          }).setOrigin(0.5, 1).setDepth(D_LABEL);
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
            this.rebuildEquip(o.equip, o.loadout, o.charKey, o.sprite.y);
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

      this.queueRoom.onMessage('launchRace', (data: { roomId?: string | null }) => {
        this.destroyQueueUI();
        this.cameras.main.flash(300, 255, 200, 50);
        const raceRoomId = data?.roomId ?? null;
        this.time.delayedCall(400, () => {
          this.scene.start('IsoScene', { authState: this.authState, raceRoomId });
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
    if (this.editorPanel) { this.editorPanel.remove(); this.editorPanel = null; }
    if (this.profilePanel) { this.profilePanel.remove(); this.profilePanel = null; }
    const hudBtns = document.getElementById('hud-buttons');
    if (hudBtns) hudBtns.remove();
    this.profileBtn = null;
    this.inventoryBtn = null;
    if (this.inventoryPanel) { this.inventoryPanel.remove(); this.inventoryPanel = null; }
    if (this.gachaPanel) { this.gachaPanel.remove(); this.gachaPanel = null; }
    if (this.leaderboardPanel) { this.leaderboardPanel.remove(); this.leaderboardPanel = null; }
    if (this.shopPanel) { this.shopPanel.remove(); this.shopPanel = null; }
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

  /** Append the account-deletion danger zone to the profile panel (M3-5). */
  private appendDeleteAccount(panel: HTMLDivElement): void {
    const authId = this.authState?.session?.user?.id;
    const username = (this.authState?.username ?? '').trim();
    const danger = document.createElement('div');
    danger.style.cssText = 'border-top: 1px solid #5a2230; padding: 12px 16px;';

    const delBtn = document.createElement('button');
    delBtn.textContent = '\u{1F5D1} Delete account';
    delBtn.style.cssText = 'width:100%; padding:8px; background:#2a1320; border:1px solid #6a2436; border-radius:5px; color:#ff8080; font-family:monospace; cursor:pointer;';
    danger.appendChild(delBtn);
    panel.appendChild(danger);

    delBtn.onclick = () => {
      if (!authId) return;
      delBtn.style.display = 'none';
      const warn = document.createElement('div');
      warn.style.cssText = 'font-size:11px; color:#e88; margin-bottom:8px; line-height:1.45;';
      warn.textContent = `This permanently deletes your account, items, and progress — it cannot be undone. Type your username "${username}" to confirm.`;
      const input = document.createElement('input');
      input.placeholder = 'username';
      input.style.cssText = 'width:100%; box-sizing:border-box; padding:6px; background:#12121e; border:1px solid #444; border-radius:4px; color:#eee; font-family:monospace; margin-bottom:8px;';
      input.addEventListener('keydown', (e) => e.stopPropagation());
      input.addEventListener('keyup', (e) => e.stopPropagation());
      const confirmBtn = document.createElement('button');
      confirmBtn.textContent = 'Permanently delete';
      confirmBtn.disabled = true;
      const setConfirmStyle = (ok: boolean) => {
        confirmBtn.style.cssText = `width:100%; padding:8px; border:1px solid #6a2436; border-radius:5px; font-family:monospace; ` +
          `cursor:${ok ? 'pointer' : 'not-allowed'}; background:${ok ? '#7a1d34' : '#3a1422'}; color:${ok ? '#fff' : '#888'};`;
      };
      setConfirmStyle(false);
      const status = document.createElement('div');
      status.style.cssText = 'font-size:11px; text-align:center; margin-top:6px; min-height:14px;';
      input.oninput = () => {
        const ok = input.value.trim() === username && username.length > 0;
        confirmBtn.disabled = !ok;
        setConfirmStyle(ok);
      };
      confirmBtn.onclick = async () => {
        confirmBtn.disabled = true;
        status.style.color = '#aaa'; status.textContent = 'Deleting…';
        try {
          const resp = await fetch(`${this.apiBase()}/api/player/${authId}`, { method: 'DELETE', headers: this.authHeader() });
          if (!resp.ok) { status.style.color = '#e88'; status.textContent = 'Deletion failed. Try again.'; confirmBtn.disabled = false; return; }
          localStorage.clear();
          window.location.reload();
        } catch (e) {
          console.error('[Account] delete failed:', e);
          status.style.color = '#e88'; status.textContent = 'Deletion failed. Try again.'; confirmBtn.disabled = false;
        }
      };
      danger.append(warn, input, confirmBtn, status);
      input.focus();
    };
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

    // Danger zone — GDPR account deletion (M3-5). Reveals a type-your-username
    // confirmation; on success the account + all its data are purged server-side.
    this.appendDeleteAccount(panel);

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
    }).setOrigin(0.5, 1).setDepth(D_BUBBLE);

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

    // Warm the shared body + item-overlay image cache in parallel with the fetch
    // below, so each bag/equip card's drawItemThumbnail resolves from cache
    // instead of awaiting two image loads per card on first open.
    void preloadThumbnails(this.charKey);

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
        <div style="font-size: 11px; margin-top: 6px; color: #444;">Win races to earn coins &amp; XP — and try the gacha for new items!</div>
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
    // Warm item thumbnails so the reveal reel never flashes blank cells.
    preloadThumbnails(this.charKey);
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

    const rank = RANK.indexOf(headline.rarity);
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
      // Bigger flash + payoff the rarer the pull.
      vp.style.boxShadow = `inset 0 0 0 ${2 + rank}px ${color}, 0 0 ${16 + rank * 10}px ${color}`;
      gachaReveal(rank);
      if (rank >= 2) this.spawnSparkles(vp, color, 10 + rank * 6);
      if (rank >= 3 && this.gachaPanel) this.shakePanel(this.gachaPanel);
      setTimeout(onDone, 700);
    };
    vp.onclick = finish; // click to skip
    let lastCell = -1;
    let lastTickAt = 0;
    const stepFn = (now: number) => {
      if (finished) return;
      const t = Math.min(1, (now - t0) / dur);
      const x = finalX * ease(t);
      strip.style.transform = `translateX(${x}px)`;
      // Tick as each cell crosses the marker; throttle so the fast start
      // doesn't machine-gun, and ticks naturally slow as the reel settles.
      const cell = Math.round((viewportW / 2 - x) / cellW);
      if (cell !== lastCell && now - lastTickAt > 45) {
        gachaTick();
        lastCell = cell;
        lastTickAt = now;
      }
      if (t < 1) requestAnimationFrame(stepFn);
      else finish();
    };
    requestAnimationFrame(stepFn);
  }

  /** Burst of rarity-coloured sparkles flying out from the reveal centre. */
  private spawnSparkles(container: HTMLElement, color: string, count: number): void {
    const cx = container.clientWidth / 2;
    const cy = container.clientHeight / 2;
    for (let i = 0; i < count; i++) {
      const size = 3 + Math.random() * 4;
      const s = document.createElement('div');
      s.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;width:${size}px;height:${size}px;`
        + `border-radius:50%;background:${color};box-shadow:0 0 6px ${color};pointer-events:none;z-index:3;`
        + 'transition:transform 0.6s ease-out, opacity 0.6s ease-out;';
      container.appendChild(s);
      const ang = Math.random() * Math.PI * 2;
      const dist = 40 + Math.random() * 80;
      requestAnimationFrame(() => {
        s.style.transform = `translate(${Math.cos(ang) * dist}px, ${Math.sin(ang) * dist}px) scale(0.3)`;
        s.style.opacity = '0';
      });
      setTimeout(() => s.remove(), 700);
    }
  }

  /** Brief shake of the gacha panel for epic+ reveals. */
  private shakePanel(panel: HTMLElement): void {
    if (!document.getElementById('gacha-shake-style')) {
      const st = document.createElement('style');
      st.id = 'gacha-shake-style';
      // Keep the -50%,-50% centring offset while shaking.
      st.textContent = '@keyframes gacha-shake{0%,100%{transform:translate(-50%,-50%)}'
        + '20%{transform:translate(calc(-50% - 7px),-50%)}40%{transform:translate(calc(-50% + 7px),calc(-50% - 3px))}'
        + '60%{transform:translate(calc(-50% - 5px),calc(-50% + 3px))}80%{transform:translate(calc(-50% + 4px),-50%)}}';
      document.head.appendChild(st);
    }
    panel.style.animation = 'gacha-shake 0.4s';
    setTimeout(() => { panel.style.animation = ''; }, 450);
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
