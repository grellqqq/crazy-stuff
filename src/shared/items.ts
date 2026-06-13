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
}

const FULL_ANIMS: EquipmentAnim[] = ['walk', 'idle', 'run', 'jump'];

export const ITEMS: Record<string, ItemDef> = {
  // ─── feet (shared — sneakers fit either body) ───────────────────────────
  beatup_sneakers: { id: 'beatup_sneakers', slot: 'feet', fitProfile: 'gendered', displayName: 'Beat-up Sneakers', rarity: 'common', availableAnims: FULL_ANIMS },
  sneakers_black:  { id: 'sneakers_black',  slot: 'feet', fitProfile: 'gendered', displayName: 'Black Sneakers',   rarity: 'common', availableAnims: FULL_ANIMS },
  sneakers_blue:   { id: 'sneakers_blue',   slot: 'feet', fitProfile: 'gendered', displayName: 'Blue Sneakers',    rarity: 'common', availableAnims: FULL_ANIMS },
  sneakers_green:  { id: 'sneakers_green',  slot: 'feet', fitProfile: 'gendered', displayName: 'Green Sneakers',   rarity: 'common', availableAnims: FULL_ANIMS },
  sneakers_pink:   { id: 'sneakers_pink',   slot: 'feet', fitProfile: 'gendered', displayName: 'Pink Sneakers',    rarity: 'common', availableAnims: FULL_ANIMS },
  sneakers_red:    { id: 'sneakers_red',    slot: 'feet', fitProfile: 'gendered', displayName: 'Red Sneakers',     rarity: 'common', availableAnims: FULL_ANIMS },
  sneakers_yellow: { id: 'sneakers_yellow', slot: 'feet', fitProfile: 'gendered', displayName: 'Yellow Sneakers',  rarity: 'common', availableAnims: FULL_ANIMS },

  // ─── head_accessory (shared — hats fit either body) ─────────────────────
  wizard_hat: { id: 'wizard_hat', slot: 'head_accessory', fitProfile: 'shared', displayName: 'Wizard Hat', rarity: 'common', frameSize: 132, availableAnims: ['walk', 'idle'] },

  // ─── lower_body (gendered — leg/hip shape differs) ──────────────────────
  blue_jeans:  { id: 'blue_jeans',  slot: 'lower_body', fitProfile: 'gendered', displayName: 'Blue Jeans',  rarity: 'common', availableAnims: FULL_ANIMS },
  jeans_black: { id: 'jeans_black', slot: 'lower_body', fitProfile: 'gendered', displayName: 'Black Jeans', rarity: 'common', availableAnims: FULL_ANIMS },
  jeans_brown: { id: 'jeans_brown', slot: 'lower_body', fitProfile: 'gendered', displayName: 'Brown Jeans', rarity: 'common', availableAnims: FULL_ANIMS },
  jeans_green: { id: 'jeans_green', slot: 'lower_body', fitProfile: 'gendered', displayName: 'Green Jeans', rarity: 'common', availableAnims: FULL_ANIMS },
  jeans_grey:  { id: 'jeans_grey',  slot: 'lower_body', fitProfile: 'gendered', displayName: 'Grey Jeans',  rarity: 'common', availableAnims: FULL_ANIMS },
  jeans_khaki: { id: 'jeans_khaki', slot: 'lower_body', fitProfile: 'gendered', displayName: 'Khaki Jeans', rarity: 'common', availableAnims: FULL_ANIMS },
  jeans_red:   { id: 'jeans_red',   slot: 'lower_body', fitProfile: 'gendered', displayName: 'Red Jeans',   rarity: 'common', availableAnims: FULL_ANIMS },

  // ─── upper_body (gendered — torso shape differs) ────────────────────────
  worn_tshirt:    { id: 'worn_tshirt',    slot: 'upper_body', fitProfile: 'gendered', displayName: 'Worn T-shirt',    rarity: 'common', availableAnims: FULL_ANIMS },
  tshirt_black:   { id: 'tshirt_black',   slot: 'upper_body', fitProfile: 'gendered', displayName: 'Black T-shirt',   rarity: 'common', availableAnims: FULL_ANIMS },
  tshirt_blue:    { id: 'tshirt_blue',    slot: 'upper_body', fitProfile: 'gendered', displayName: 'Blue T-shirt',    rarity: 'common', availableAnims: FULL_ANIMS },
  tshirt_brown:   { id: 'tshirt_brown',   slot: 'upper_body', fitProfile: 'gendered', displayName: 'Brown T-shirt',   rarity: 'common', availableAnims: FULL_ANIMS },
  tshirt_green:   { id: 'tshirt_green',   slot: 'upper_body', fitProfile: 'gendered', displayName: 'Green T-shirt',   rarity: 'common', availableAnims: FULL_ANIMS },
  tshirt_pink:    { id: 'tshirt_pink',    slot: 'upper_body', fitProfile: 'gendered', displayName: 'Pink T-shirt',    rarity: 'common', availableAnims: FULL_ANIMS },
  tshirt_purple:  { id: 'tshirt_purple',  slot: 'upper_body', fitProfile: 'gendered', displayName: 'Purple T-shirt',  rarity: 'common', availableAnims: FULL_ANIMS },
  tshirt_red:     { id: 'tshirt_red',     slot: 'upper_body', fitProfile: 'gendered', displayName: 'Red T-shirt',     rarity: 'common', availableAnims: FULL_ANIMS },
  tshirt_stripes: { id: 'tshirt_stripes', slot: 'upper_body', fitProfile: 'gendered', displayName: 'Striped T-shirt', rarity: 'common', availableAnims: FULL_ANIMS },
  tshirt_white:   { id: 'tshirt_white',   slot: 'upper_body', fitProfile: 'gendered', displayName: 'White T-shirt',   rarity: 'common', availableAnims: FULL_ANIMS },
  tshirt_yellow:  { id: 'tshirt_yellow',  slot: 'upper_body', fitProfile: 'gendered', displayName: 'Yellow T-shirt',  rarity: 'common', availableAnims: FULL_ANIMS },
};

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
