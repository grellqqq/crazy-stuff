/**
 * Canonical equipment item catalog.
 *
 * This is the single source of truth for item metadata: which slot it occupies,
 * whether the visual differs by body shape, sprite frame size, and which
 * animations exist on disk. Both client (sprite loading) and server (validation)
 * read from this file.
 *
 * Sprite paths follow: /sprites/equipment/{slot}/{id}/{bodyKey}/{anim}_{dir}.png
 * where `bodyKey` is resolved by `equipmentBodyKey(id, charKey)`.
 *
 * Catalog plan & rationale: design/gdd/item-catalog.md (v3, 240 items across
 * 10 slots). The 26 originally-arted items are released; the rest ship
 * `released: false` and stay OUT of the gacha pool until their art lands — see
 * `inGachaPool` and item-catalog.md §4.7. Flip `released: true` per batch as
 * PixelLab art is produced.
 */

export type FitProfile =
  /** One sprite set serves all bodies (hats, held items, etc.). */
  | 'shared'
  /**
   * Separate sprites fitted per base body. The six bodies are distinct
   * characters (different builds/poses), so each body key gets its own
   * overlay folder: male, female, male-medium, female-medium, male-dark,
   * female-dark.
   */
  | 'gendered';

/** All base body keys that have their own fitted equipment sprite sets. */
export const BODY_KEYS = [
  'male', 'female',
  'male-medium', 'female-medium',
  'male-dark', 'female-dark',
] as const;

export type BodyKey = (typeof BODY_KEYS)[number];

export type EquipmentAnim = 'walk' | 'idle' | 'run' | 'jump';

export type Rarity = 'common' | 'uncommon' | 'rare' | 'epic' | 'legendary' | 'crazy';

/** Where an item can be acquired. Drives faucet eligibility (gacha pool, store). */
export type ItemSource = 'gacha' | 'store' | 'starter' | 'event' | 'admin';

export interface ItemDef {
  id: string;
  slot: string;
  fitProfile: FitProfile;
  displayName: string;
  rarity: Rarity;
  /** Sprite frame size in pixels. Defaults to 92 (base character size). */
  frameSize?: number;
  /** Animations present on disk. Defaults to ['walk', 'idle']. */
  availableAnims?: EquipmentAnim[];
  /**
   * Acquisition sources. Omitted = available everywhere (default gacha+store).
   * Set explicitly to restrict, e.g. ['store'] for a store-only item or
   * ['event'] for a non-pullable event reward. See gacha GDD §3.1.
   */
  sources?: ItemSource[];
  /**
   * Whether the item's art exists and it may appear in player-facing faucets
   * (gacha pool, store). Omitted = released (true) — keeps the 26 original
   * items pullable. New catalog entries set `released: false` until their
   * sprites are produced, so the live gacha never awards an invisible item.
   * See `inGachaPool` and design/gdd/item-catalog.md §4.7.
   */
  released?: boolean;
}

const FULL_ANIMS: EquipmentAnim[] = ['walk', 'idle', 'run', 'jump'];
/** Overlay accessories (hats, hair, masks) ship walk+idle at minimum. */
const HAT_ANIMS: EquipmentAnim[] = ['walk', 'idle'];

// ─── Builders ───────────────────────────────────────────────────────────────
// The catalog is large and still growing; these keep new families declarative.
// Every helper marks items `released: false` — flip per batch as art lands.

/** Title-case a color/style token for display ('blue' → 'Blue'). */
function cap(s: string): string {
  if (s === 'stripes') return 'Striped';
  return s.charAt(0).toUpperCase() + s.slice(1);
}

type NewOpts = {
  fitProfile: FitProfile;
  frameSize?: number;
  availableAnims?: EquipmentAnim[];
  /** Flip true once the item's art exists (puts it in the gacha pool). */
  released?: boolean;
};

/** A single not-yet-released catalog entry. */
function mk(
  id: string,
  slot: string,
  rarity: Rarity,
  displayName: string,
  opts: NewOpts,
): ItemDef {
  return {
    id, slot, rarity, displayName,
    fitProfile: opts.fitProfile,
    ...(opts.frameSize ? { frameSize: opts.frameSize } : {}),
    availableAnims: opts.availableAnims ?? HAT_ANIMS,
    released: opts.released ?? false,
  };
}

/**
 * A color family: one garment in N colors. id = `${prefix}_${color}`,
 * displayName = `${Color} ${nameBase}` (e.g. hoodie_black → "Black Hoodie").
 */
function colorFamily(
  prefix: string,
  slot: string,
  rarity: Rarity,
  nameBase: string,
  colors: readonly string[],
  opts: NewOpts,
): ItemDef[] {
  return colors.map((c) => mk(`${prefix}_${c}`, slot, rarity, `${cap(c)} ${nameBase}`, opts));
}

// Named color sets (item-catalog.md §2).
const TEE10 = ['black', 'blue', 'brown', 'green', 'pink', 'purple', 'red', 'stripes', 'white', 'yellow'] as const;
const TRACK8 = ['black', 'blue', 'green', 'grey', 'red', 'pink', 'white', 'yellow'] as const;
const HAIR5 = ['brown', 'black', 'blonde', 'red', 'blue'] as const;
const CAPE4 = ['red', 'blue', 'black', 'purple'] as const;
const PACK4 = ['red', 'blue', 'black', 'green'] as const;
const SKIRT3 = ['red', 'blue', 'black'] as const;
const FLANNEL3 = ['red', 'blue', 'green'] as const;
const VARSITY4 = ['blue', 'red', 'yellow', 'green'] as const;
const SHELL2 = ['green', 'brown'] as const;
const CARGO3 = ['green', 'brown', 'black'] as const;

const GENDERED_FULL: NewOpts = { fitProfile: 'gendered', availableAnims: FULL_ANIMS };
const SHARED_HEAD: NewOpts = { fitProfile: 'shared', frameSize: 132, availableAnims: HAT_ANIMS };
// Released head accessories — art produced via the v4 head-band pipeline at 92px
// (omit frameSize → defaults 92). Flip items to this as their art lands.
const HEAD_RELEASED: NewOpts = { fitProfile: 'shared', availableAnims: HAT_ANIMS, released: true };
const SHARED_FACE: NewOpts = { fitProfile: 'shared', availableAnims: HAT_ANIMS }; // frame 92
const SHARED_BACK: NewOpts = { fitProfile: 'shared', frameSize: 132, availableAnims: HAT_ANIMS };
const SHARED_BACK_BIG: NewOpts = { fitProfile: 'shared', frameSize: 152, availableAnims: HAT_ANIMS };
const SHARED_AURA: NewOpts = { fitProfile: 'shared', frameSize: 132, availableAnims: HAT_ANIMS };

// ─── Existing (released) items ───────────────────────────────────────────────
// These 26 have art on disk and stay in the live pool. Do not change their
// ids/slots/rarities/fit — gacha and saved inventories depend on them.

const RELEASED_ITEMS: ItemDef[] = [
  // ─── feet (gendered) ────────────────────────────────────────────────────
  { id: 'beatup_sneakers', slot: 'feet', fitProfile: 'gendered', displayName: 'Beat-up Sneakers', rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'sneakers_black',  slot: 'feet', fitProfile: 'gendered', displayName: 'Black Sneakers',   rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'sneakers_blue',   slot: 'feet', fitProfile: 'gendered', displayName: 'Blue Sneakers',    rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'sneakers_green',  slot: 'feet', fitProfile: 'gendered', displayName: 'Green Sneakers',   rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'sneakers_pink',   slot: 'feet', fitProfile: 'gendered', displayName: 'Pink Sneakers',    rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'sneakers_red',    slot: 'feet', fitProfile: 'gendered', displayName: 'Red Sneakers',     rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'sneakers_yellow', slot: 'feet', fitProfile: 'gendered', displayName: 'Yellow Sneakers',  rarity: 'common', availableAnims: FULL_ANIMS },

  // ─── head_accessory (shared) ────────────────────────────────────────────
  { id: 'wizard_hat', slot: 'head_accessory', fitProfile: 'shared', displayName: 'Wizard Hat', rarity: 'rare', frameSize: 132, availableAnims: ['walk', 'idle'] },

  // ─── lower_body (gendered) ──────────────────────────────────────────────
  { id: 'blue_jeans',  slot: 'lower_body', fitProfile: 'gendered', displayName: 'Blue Jeans',  rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'jeans_black', slot: 'lower_body', fitProfile: 'gendered', displayName: 'Black Jeans', rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'jeans_brown', slot: 'lower_body', fitProfile: 'gendered', displayName: 'Brown Jeans', rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'jeans_green', slot: 'lower_body', fitProfile: 'gendered', displayName: 'Green Jeans', rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'jeans_grey',  slot: 'lower_body', fitProfile: 'gendered', displayName: 'Grey Jeans',  rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'jeans_khaki', slot: 'lower_body', fitProfile: 'gendered', displayName: 'Khaki Jeans', rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'jeans_red',   slot: 'lower_body', fitProfile: 'gendered', displayName: 'Red Jeans',   rarity: 'common', availableAnims: FULL_ANIMS },

  // ─── upper_body (gendered) ──────────────────────────────────────────────
  { id: 'worn_tshirt',    slot: 'upper_body', fitProfile: 'gendered', displayName: 'Worn T-shirt',    rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'tshirt_black',   slot: 'upper_body', fitProfile: 'gendered', displayName: 'Black T-shirt',   rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'tshirt_blue',    slot: 'upper_body', fitProfile: 'gendered', displayName: 'Blue T-shirt',    rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'tshirt_brown',   slot: 'upper_body', fitProfile: 'gendered', displayName: 'Brown T-shirt',   rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'tshirt_green',   slot: 'upper_body', fitProfile: 'gendered', displayName: 'Green T-shirt',   rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'tshirt_pink',    slot: 'upper_body', fitProfile: 'gendered', displayName: 'Pink T-shirt',    rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'tshirt_purple',  slot: 'upper_body', fitProfile: 'gendered', displayName: 'Purple T-shirt',  rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'tshirt_red',     slot: 'upper_body', fitProfile: 'gendered', displayName: 'Red T-shirt',     rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'tshirt_stripes', slot: 'upper_body', fitProfile: 'gendered', displayName: 'Striped T-shirt', rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'tshirt_white',   slot: 'upper_body', fitProfile: 'gendered', displayName: 'White T-shirt',   rarity: 'common', availableAnims: FULL_ANIMS },
  { id: 'tshirt_yellow',  slot: 'upper_body', fitProfile: 'gendered', displayName: 'Yellow T-shirt',  rarity: 'common', availableAnims: FULL_ANIMS },
];

// ─── New (unreleased) items — design/gdd/item-catalog.md §3 ──────────────────

const UPPER_BODY_NEW: ItemDef[] = [
  ...colorFamily('longsleeve', 'upper_body', 'common', 'Long-sleeve Tee', TEE10, GENDERED_FULL),
  ...colorFamily('hoodie', 'upper_body', 'uncommon', 'Hoodie', TEE10, GENDERED_FULL),
  ...colorFamily('flannel', 'upper_body', 'uncommon', 'Flannel Shirt', FLANNEL3, GENDERED_FULL),
  ...colorFamily('varsity', 'upper_body', 'uncommon', 'Varsity Jacket', VARSITY4, GENDERED_FULL),
  ...colorFamily('puffer', 'upper_body', 'rare', 'Puffer Jacket', TEE10, GENDERED_FULL),
  mk('lab_coat', 'upper_body', 'rare', 'Scientist Coat', GENDERED_FULL),
  mk('leather_jacket', 'upper_body', 'rare', 'Leather Jacket', GENDERED_FULL),
  mk('pinned_denim_vest', 'upper_body', 'rare', 'Pinned Denim Vest', GENDERED_FULL),
  mk('rune_cloak', 'upper_body', 'epic', 'Rune Cloak', { fitProfile: 'gendered', frameSize: 132, availableAnims: FULL_ANIMS }),
  mk('circuit_jacket', 'upper_body', 'epic', 'Neon Circuit Jacket', GENDERED_FULL),
  mk('galaxy_hoodie', 'upper_body', 'legendary', 'Galaxy Hoodie', GENDERED_FULL),
  mk('shark_onesie', 'upper_body', 'crazy', 'Shark Onesie', { fitProfile: 'gendered', frameSize: 132, availableAnims: FULL_ANIMS }),
  mk('trex_costume_top', 'upper_body', 'crazy', 'Inflatable T-Rex Top', { fitProfile: 'gendered', frameSize: 132, availableAnims: FULL_ANIMS }),
];

const LOWER_BODY_NEW: ItemDef[] = [
  ...colorFamily('track_pants', 'lower_body', 'uncommon', 'Track Pants', TRACK8, GENDERED_FULL),
  ...colorFamily('cargo_pants', 'lower_body', 'uncommon', 'Cargo Pants', CARGO3, GENDERED_FULL),
  ...colorFamily('skirt', 'lower_body', 'uncommon', 'Skirt', SKIRT3, GENDERED_FULL),
  mk('kilt', 'lower_body', 'uncommon', 'Kilt', GENDERED_FULL),
  mk('short_skirt', 'lower_body', 'uncommon', 'Short Skirt', GENDERED_FULL),
  mk('cyclist_pants', 'lower_body', 'uncommon', 'Cyclist Pants', GENDERED_FULL),
  mk('capri_pants', 'lower_body', 'uncommon', 'Capri Pants', GENDERED_FULL),
  mk('shorts_80s', 'lower_body', 'uncommon', '80s Shorts', GENDERED_FULL),
  mk('baggy_pants', 'lower_body', 'uncommon', 'Baggy Pants', GENDERED_FULL),
  mk('disco_pants', 'lower_body', 'rare', 'Disco Pants', GENDERED_FULL),
  mk('leather_pants', 'lower_body', 'rare', 'Leather Pants', GENDERED_FULL),
  mk('chained_ripped_jeans', 'lower_body', 'rare', 'Chained Ripped Jeans', GENDERED_FULL),
  mk('hologram_leggings', 'lower_body', 'epic', 'Hologram Leggings', GENDERED_FULL),
  mk('magma_pants', 'lower_body', 'legendary', 'Magma Pants', GENDERED_FULL),
];

const FEET_NEW: ItemDef[] = [
  mk('flip_flops', 'feet', 'common', 'Flip-flops', GENDERED_FULL),
  mk('sandals', 'feet', 'common', 'Sandals', GENDERED_FULL),
  mk('slides', 'feet', 'uncommon', 'Slides', GENDERED_FULL),
  mk('heels', 'feet', 'uncommon', 'Heels', GENDERED_FULL),
  mk('oxford_shoes', 'feet', 'uncommon', 'Oxford Shoes', GENDERED_FULL),
  mk('platform_heels', 'feet', 'rare', 'Platform Heels', GENDERED_FULL),
  mk('glowing_sneakers', 'feet', 'rare', 'Glowing Sneakers', GENDERED_FULL),
  mk('cowboy_boots', 'feet', 'rare', 'Cowboy Boots', GENDERED_FULL),
  mk('futuristic_sneakers', 'feet', 'epic', 'Futuristic Sneakers', GENDERED_FULL),
  mk('rocket_boots', 'feet', 'epic', 'Rocket Boots', GENDERED_FULL),
  mk('winged_sandals', 'feet', 'legendary', 'Winged Sandals', GENDERED_FULL),
  mk('giant_clown_shoes', 'feet', 'crazy', 'Giant Clown Shoes', { fitProfile: 'gendered', frameSize: 132, availableAnims: FULL_ANIMS }),
];

const HEAD_NEW: ItemDef[] = [
  // Released batch 1 (2026-06-24) — art via v4 head-band pipeline at 92px.
  mk('beanie', 'head_accessory', 'common', 'Beanie', HEAD_RELEASED),
  mk('baseball_cap', 'head_accessory', 'common', 'Baseball Cap', HEAD_RELEASED),
  mk('headband', 'head_accessory', 'common', 'Headband', SHARED_HEAD),
  mk('bucket_hat', 'head_accessory', 'uncommon', 'Bucket Hat', SHARED_HEAD),
  mk('snapback', 'head_accessory', 'uncommon', 'Snapback', HEAD_RELEASED),
  mk('beret', 'head_accessory', 'uncommon', 'Beret', SHARED_HEAD),
  mk('top_hat', 'head_accessory', 'rare', 'Top Hat', HEAD_RELEASED),
  mk('bay_leaf_crown', 'head_accessory', 'rare', 'Bay Leaf Crown', SHARED_HEAD),
  mk('beer_can_cap', 'head_accessory', 'rare', 'Beer-can Cap', SHARED_HEAD),
  mk('helicopter_cap', 'head_accessory', 'rare', 'Helicopter Cap', SHARED_HEAD),
  mk('tiara', 'head_accessory', 'epic', 'Tiara', SHARED_HEAD),
  mk('halo', 'head_accessory', 'epic', 'Halo', SHARED_HEAD),
  mk('vr_headset', 'head_accessory', 'epic', 'VR Headset', SHARED_HEAD),
  mk('flaming_crown', 'head_accessory', 'legendary', 'Flaming Crown', SHARED_HEAD),
  mk('traffic_cone_hat', 'head_accessory', 'crazy', 'Traffic Cone Hat', SHARED_HEAD),
];

const HAIR_NEW: ItemDef[] = [
  ...colorFamily('hair_short', 'hair', 'common', 'Short Hair', HAIR5, SHARED_HEAD),
  ...colorFamily('hair_ponytail', 'hair', 'common', 'Ponytail', HAIR5, SHARED_HEAD),
  ...colorFamily('hair_buzzcut', 'hair', 'common', 'Buzzcut', HAIR5, SHARED_HEAD),
  ...colorFamily('hair_mohawk', 'hair', 'uncommon', 'Mohawk', HAIR5, SHARED_HEAD),
  ...colorFamily('hair_long', 'hair', 'uncommon', 'Long Hair', HAIR5, SHARED_HEAD),
  ...colorFamily('hair_afro', 'hair', 'uncommon', 'Afro', HAIR5, SHARED_HEAD),
  ...colorFamily('hair_dreads', 'hair', 'rare', 'Dreads', HAIR5, SHARED_HEAD),
  ...colorFamily('hair_undercut', 'hair', 'rare', 'Undercut', HAIR5, SHARED_HEAD),
  mk('hair_flaming', 'hair', 'epic', 'Flaming Hair', SHARED_HEAD),
  mk('hair_neon_glow', 'hair', 'epic', 'Neon Glow Hair', SHARED_HEAD),
  mk('hair_galaxy', 'hair', 'legendary', 'Galaxy Hair', SHARED_HEAD),
  mk('hair_propeller', 'hair', 'crazy', 'Propeller Hair', SHARED_HEAD),
];

const BACK_NEW: ItemDef[] = [
  ...colorFamily('backpack', 'back', 'uncommon', 'Backpack', PACK4, SHARED_BACK),
  mk('scuba_tank', 'back', 'uncommon', 'Scuba Cylinder', SHARED_BACK),
  ...colorFamily('cape', 'back', 'rare', 'Cape', CAPE4, SHARED_BACK),
  ...colorFamily('turtle_shell', 'back', 'rare', 'Turtle Shell', SHELL2, SHARED_BACK),
  mk('sheathed_sword', 'back', 'rare', 'Sheathed Sword', SHARED_BACK),
  mk('berimbau', 'back', 'rare', 'Berimbau', SHARED_BACK_BIG),
  mk('butterfly_wings', 'back', 'rare', 'Butterfly Wings', SHARED_BACK),
  mk('hoverboard_back', 'back', 'rare', 'Strapped Hoverboard', SHARED_BACK),
  mk('jetpack', 'back', 'epic', 'Jetpack', SHARED_BACK),
  mk('feathered_wings', 'back', 'epic', 'Feathered Wings', SHARED_BACK_BIG),
  mk('samurai_banner', 'back', 'epic', 'Samurai Banner', SHARED_BACK_BIG),
  mk('dragon_wings', 'back', 'legendary', 'Dragon Wings', SHARED_BACK_BIG),
  mk('mecha_thrusters', 'back', 'legendary', 'Mecha Thrusters', SHARED_BACK_BIG),
  mk('duck_floatie', 'back', 'crazy', 'Rubber Duck Floatie', SHARED_BACK_BIG),
  mk('snail_shell', 'back', 'crazy', 'Giant Snail Shell', SHARED_BACK_BIG),
];

const AIR_SPACE_NEW: ItemDef[] = [
  mk('aura_dust_sparkle', 'air_space', 'uncommon', 'Dust Sparkles', SHARED_AURA),
  mk('aura_fireflies', 'air_space', 'rare', 'Fireflies', SHARED_AURA),
  mk('aura_autumn_leaves', 'air_space', 'rare', 'Autumn Leaves', SHARED_AURA),
  mk('aura_electric', 'air_space', 'epic', 'Electric Sparks', SHARED_AURA),
  mk('aura_flame', 'air_space', 'epic', 'Flame Aura', SHARED_AURA),
  mk('aura_frost', 'air_space', 'epic', 'Frost Mist', SHARED_AURA),
  mk('aura_rainbow_trail', 'air_space', 'legendary', 'Rainbow Trail', SHARED_AURA),
  mk('aura_golden_glow', 'air_space', 'legendary', 'Golden Glow', SHARED_AURA),
  mk('aura_storm_cloud', 'air_space', 'legendary', 'Storm Cloud', SHARED_AURA),
  mk('aura_toilet_ring', 'air_space', 'crazy', 'Floating Toilet Ring', SHARED_AURA),
  mk('aura_money_rain', 'air_space', 'crazy', 'Money Rain', SHARED_AURA),
  mk('aura_duck_swarm', 'air_space', 'crazy', 'Rubber Duck Swarm', SHARED_AURA),
];

const EYES_NEW: ItemDef[] = [
  mk('round_glasses', 'eyes_accessory', 'common', 'Round Glasses', SHARED_FACE),
  mk('nerd_glasses', 'eyes_accessory', 'common', 'Nerd Glasses', SHARED_FACE),
  mk('sunglasses', 'eyes_accessory', 'uncommon', 'Sunglasses', SHARED_FACE),
  mk('aviators', 'eyes_accessory', 'uncommon', 'Aviators', SHARED_FACE),
  mk('eyepatch', 'eyes_accessory', 'uncommon', 'Eyepatch', SHARED_FACE),
  mk('3d_glasses', 'eyes_accessory', 'uncommon', '3D Glasses', SHARED_FACE),
  mk('star_glasses', 'eyes_accessory', 'uncommon', 'Star Glasses', SHARED_FACE),
  mk('monocle', 'eyes_accessory', 'rare', 'Monocle', SHARED_FACE),
  mk('heart_glasses', 'eyes_accessory', 'rare', 'Heart Glasses', SHARED_FACE),
  mk('ski_goggles', 'eyes_accessory', 'rare', 'Ski Goggles', SHARED_FACE),
  mk('round_shades', 'eyes_accessory', 'rare', 'Round Shades', SHARED_FACE),
  mk('cyber_visor', 'eyes_accessory', 'epic', 'Cyber Visor', SHARED_FACE),
  mk('glowing_eyes', 'eyes_accessory', 'epic', 'Glowing Eyes', SHARED_FACE),
  mk('laser_eyes', 'eyes_accessory', 'legendary', 'Laser Eyes', SHARED_FACE),
  mk('googly_eyes', 'eyes_accessory', 'crazy', 'Googly Eyes', SHARED_FACE),
];

const MOUTH_NEW: ItemDef[] = [
  mk('bubblegum', 'mouth_accessory', 'common', 'Bubblegum', SHARED_FACE),
  mk('pacifier', 'mouth_accessory', 'common', 'Pacifier', SHARED_FACE),
  mk('lollipop', 'mouth_accessory', 'common', 'Lollipop', SHARED_FACE),
  mk('surgical_mask', 'mouth_accessory', 'common', 'Surgical Mask', SHARED_FACE),
  mk('mustache', 'mouth_accessory', 'uncommon', 'Mustache', SHARED_FACE),
  mk('cigar', 'mouth_accessory', 'uncommon', 'Cigar', SHARED_FACE),
  mk('hay_straw', 'mouth_accessory', 'uncommon', 'Hay Straw', SHARED_FACE),
  mk('pipe', 'mouth_accessory', 'rare', 'Pipe', SHARED_FACE),
  mk('vampire_fangs', 'mouth_accessory', 'rare', 'Vampire Fangs', SHARED_FACE),
  mk('gold_grill', 'mouth_accessory', 'rare', 'Gold Grill', SHARED_FACE),
  mk('lettuce_cigarette', 'mouth_accessory', 'rare', 'Lettuce Cigarette', SHARED_FACE),
  mk('cyber_breather', 'mouth_accessory', 'epic', 'Cyber Breather', SHARED_FACE),
  mk('dragon_breath', 'mouth_accessory', 'legendary', 'Dragon Breath', SHARED_FACE),
  mk('giant_tongue', 'mouth_accessory', 'crazy', 'Giant Tongue', SHARED_FACE),
];

const FACE_NEW: ItemDef[] = [
  mk('domino_mask', 'face_accessory', 'common', 'Domino Mask', SHARED_FACE),
  mk('ski_mask', 'face_accessory', 'uncommon', 'Ski Mask', SHARED_FACE),
  mk('bandana_face', 'face_accessory', 'uncommon', 'Bandana', SHARED_FACE),
  mk('clown_paint', 'face_accessory', 'rare', 'Clown Paint', SHARED_FACE),
  mk('hockey_mask', 'face_accessory', 'rare', 'Hockey Mask', SHARED_FACE),
  mk('plague_doctor', 'face_accessory', 'rare', 'Plague Doctor Mask', SHARED_FACE),
  mk('gas_mask', 'face_accessory', 'rare', 'Gas Mask', SHARED_FACE),
  mk('ghost_mask', 'face_accessory', 'rare', 'Screaming Ghost Mask', SHARED_FACE),
  mk('tiki_mask', 'face_accessory', 'rare', 'Tiki Mask', SHARED_FACE),
  mk('robot_visor', 'face_accessory', 'epic', 'Robot Visor', SHARED_FACE),
  mk('oni_mask', 'face_accessory', 'epic', 'Oni Mask', { fitProfile: 'shared', frameSize: 132, availableAnims: HAT_ANIMS }),
  mk('geisha_mask', 'face_accessory', 'epic', 'Geisha Mask', SHARED_FACE),
  mk('golden_mask', 'face_accessory', 'legendary', 'Golden Phantom Mask', SHARED_FACE),
  mk('disco_ball_head', 'face_accessory', 'crazy', 'Disco Ball Head', { fitProfile: 'shared', frameSize: 132, availableAnims: HAT_ANIMS }),
];

const ALL_ITEMS: ItemDef[] = [
  ...RELEASED_ITEMS,
  ...UPPER_BODY_NEW, ...LOWER_BODY_NEW, ...FEET_NEW, ...HEAD_NEW, ...HAIR_NEW,
  ...BACK_NEW, ...AIR_SPACE_NEW, ...EYES_NEW, ...MOUTH_NEW, ...FACE_NEW,
];

export const ITEMS: Record<string, ItemDef> = Object.fromEntries(
  ALL_ITEMS.map((it) => [it.id, it]),
);

// Fail fast on a duplicate id (a copy-paste hazard as the catalog grows).
if (ALL_ITEMS.length !== Object.keys(ITEMS).length) {
  const seen = new Set<string>();
  const dupes = ALL_ITEMS.map((i) => i.id).filter((id) => (seen.has(id) ? true : (seen.add(id), false)));
  throw new Error(`Duplicate item id(s) in catalog: ${[...new Set(dupes)].join(', ')}`);
}

/**
 * Resolve which body sprite folder to load equipment from.
 * - `shared` items always load from /male/ (one set serves all bodies).
 * - `gendered` items load the male or female overlay set. The medium/dark
 *   bodies are palette-swapped copies of the light bodies (see
 *   tools/recolor-skin.py), so their silhouettes are identical and the
 *   light-body overlays fit every skin tone pixel-for-pixel.
 */
export function equipmentBodyKey(itemId: string, charKey: string): BodyKey {
  const item = ITEMS[itemId];
  if (!item || item.fitProfile === 'shared') return 'male';
  return charKey.startsWith('female') ? 'female' : 'male';
}

/**
 * Whether an item is eligible for the gacha pull pool. An item qualifies when
 * its art exists (`released !== false`) AND its sources allow gacha (omitted
 * sources default in). The gacha engine (src/shared/gacha.ts) uses this to
 * build the pool from the catalog, so unreleased items never get awarded as
 * invisible (missing-texture) pulls. See item-catalog.md §4.7.
 */
export function inGachaPool(item: ItemDef): boolean {
  if (item.released === false) return false;
  return item.sources === undefined || item.sources.includes('gacha');
}
