/**
 * Shared item-display helpers for the inventory UIs (LobbyScene + IsoScene).
 *
 * Resolves an item's human name + rarity from the catalog (the source of
 * truth), and draws a real thumbnail by compositing the base body with the
 * item's overlay — instead of showing a generic slot emoji + raw id.
 */
import { ITEMS, equipmentBodyKey } from '../../shared/items';

export const RARITY_COLORS: Record<string, string> = {
  common: '#888', uncommon: '#44bb44', rare: '#4488ff',
  epic: '#aa44ff', legendary: '#ffaa00', crazy: '#ff44ff',
};

export const SLOT_META: Record<string, { label: string; icon: string }> = {
  head_accessory:  { label: 'Head',  icon: '\u{1F3A9}' },
  hair:            { label: 'Hair',  icon: '\u{1F487}' },
  face_accessory:  { label: 'Face',  icon: '\u{1F3AD}' },
  eyes_accessory:  { label: 'Eyes',  icon: '\u{1F453}' },
  mouth_accessory: { label: 'Mouth', icon: '\u{1F444}' },
  upper_body:      { label: 'Upper', icon: '\u{1F455}' },
  lower_body:      { label: 'Lower', icon: '\u{1F456}' },
  feet:            { label: 'Feet',  icon: '\u{1F45F}' },
  back:            { label: 'Back',  icon: '\u{1F392}' },
  hand_1h:         { label: 'Hand',  icon: '\u{1F5E1}' },
  air_space:       { label: 'Aura',  icon: '\u{2728}' },
  skin:            { label: 'Skin',  icon: '\u{1F9EC}' },
};

const BASE_FS = 92;

export interface ItemDisplay {
  name: string;
  rarity: string;
  color: string;
  slot: string;
  slotLabel: string;
}

/** Resolve display name + rarity from the catalog, falling back to the row. */
export function itemDisplay(itemId: string, fallbackRarity = 'common'): ItemDisplay {
  const def = ITEMS[itemId];
  const rarity = def?.rarity ?? fallbackRarity;
  const slot = def?.slot ?? '';
  return {
    name: def?.displayName ?? itemId,
    rarity,
    color: RARITY_COLORS[rarity] ?? '#888',
    slot,
    slotLabel: SLOT_META[slot]?.label ?? slot,
  };
}

// Cache loaded PNGs (body sheets are shared across items; resolve null on 404
// so a missing asset degrades to "no thumbnail" rather than a broken image).
const imgCache = new Map<string, Promise<HTMLImageElement | null>>();
function loadImage(url: string): Promise<HTMLImageElement | null> {
  let p = imgCache.get(url);
  if (!p) {
    p = new Promise((resolve) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => resolve(null);
      img.src = url;
    });
    imgCache.set(url, p);
  }
  return p;
}

/**
 * Draw a thumbnail of `itemId` as worn by `charKey` into `canvas`: the base
 * body's idle south-east frame 0 with the item's overlay frame 0 composited on
 * top (the overlay is scaled to the 92px body space, matching in-game scaling,
 * so the 132px wizard hat lines up too). Async — resolves once both load.
 */
export async function drawItemThumbnail(
  canvas: HTMLCanvasElement, itemId: string, charKey: string,
): Promise<void> {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.imageSmoothingEnabled = false;

  const def = ITEMS[itemId];
  // Work in a 92×92 space, then blit scaled to the canvas.
  const work = document.createElement('canvas');
  work.width = BASE_FS; work.height = BASE_FS;
  const wctx = work.getContext('2d');
  if (!wctx) return;
  wctx.imageSmoothingEnabled = false;

  const body = await loadImage(`/sprites/characters/${charKey}/idle_south-east.png`);
  if (body) wctx.drawImage(body, 0, 0, BASE_FS, BASE_FS, 0, 0, BASE_FS, BASE_FS);

  if (def && def.slot !== 'skin') {
    const eqBody = equipmentBodyKey(itemId, charKey);
    const fs = def.frameSize ?? BASE_FS;
    const overlay = await loadImage(
      `/sprites/equipment/${def.slot}/${itemId}/${eqBody}/idle_south-east.png`,
    );
    // Source frame is the top-left fs×fs region; scale it onto the 92 space.
    if (overlay) wctx.drawImage(overlay, 0, 0, fs, fs, 0, 0, BASE_FS, BASE_FS);
  }

  // Blit the composite scaled to fill the destination canvas.
  ctx.drawImage(work, 0, 0, BASE_FS, BASE_FS, 0, 0, canvas.width, canvas.height);
}

/** Warm the image cache for the body + every catalog item overlay, so reels
 *  and inventory thumbnails draw instantly (no blank flash on first paint). */
export function preloadThumbnails(charKey: string): void {
  void loadImage(`/sprites/characters/${charKey}/idle_south-east.png`);
  for (const def of Object.values(ITEMS)) {
    if (def.slot === 'skin') continue;
    const eqBody = equipmentBodyKey(def.id, charKey);
    void loadImage(`/sprites/equipment/${def.slot}/${def.id}/${eqBody}/idle_south-east.png`);
  }
}

/** Inventory row as returned by the (normalized) API / dev fixture. */
export interface InvItem {
  id: string;
  item_id: string;
  item_type: string;
  rarity: string;
  equipped?: boolean;
}

/**
 * Build one equipment-slot cell (filled or empty). All item-derived text uses
 * textContent — never innerHTML — so a malicious item id can't inject markup.
 */
export function buildEquipSlot(
  slotKey: string, equipped: InvItem | null, charKey: string,
  onUnequip: (id: string) => void,
): HTMLDivElement {
  const meta = SLOT_META[slotKey] ?? { label: slotKey, icon: '?' };
  const div = document.createElement('div');
  if (equipped) {
    const d = itemDisplay(equipped.item_id, equipped.rarity);
    div.style.cssText = `background:#1e1e30;border:2px solid ${d.color};border-radius:6px;padding:6px 4px;`
      + 'text-align:center;cursor:pointer;min-height:60px;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:center;';
    const canvas = document.createElement('canvas');
    canvas.width = 40; canvas.height = 40;
    canvas.style.cssText = 'image-rendering:pixelated;margin-bottom:2px;';
    void drawItemThumbnail(canvas, equipped.item_id, charKey);
    const name = document.createElement('div');
    name.style.cssText = 'font-size:10px;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;max-width:90px;';
    name.textContent = d.name;
    const rar = document.createElement('div');
    rar.style.cssText = `font-size:9px;color:${d.color};text-transform:capitalize;`;
    rar.textContent = d.rarity;
    div.append(canvas, name, rar);
    div.title = `${meta.label}: ${d.name} (${d.rarity}) — click to unequip`;
    div.onmouseenter = () => { div.style.borderColor = '#ffdd44'; };
    div.onmouseleave = () => { div.style.borderColor = d.color; };
    div.onclick = () => onUnequip(equipped.id);
  } else {
    div.style.cssText = 'background:#131320;border:2px solid #2a2a3a;border-radius:6px;padding:6px 4px;'
      + 'text-align:center;min-height:60px;display:flex;flex-direction:column;'
      + 'align-items:center;justify-content:center;';
    const icon = document.createElement('div');
    icon.style.cssText = 'font-size:16px;opacity:0.3;margin-bottom:2px;';
    icon.textContent = meta.icon;
    const lbl = document.createElement('div');
    lbl.style.cssText = 'font-size:9px;color:#444;';
    lbl.textContent = meta.label;
    div.append(icon, lbl);
    div.title = `${meta.label}: empty`;
  }
  return div;
}

/** Build one bag card (a thumbnail + catalog name + rarity + slot). XSS-safe. */
export function buildBagCard(
  item: InvItem, charKey: string,
  onToggle: (id: string, equip: boolean) => void,
): HTMLDivElement {
  const d = itemDisplay(item.item_id, item.rarity);
  const isEquipped = !!item.equipped;
  const card = document.createElement('div');
  card.style.cssText = `background:${isEquipped ? '#1e1e30' : '#181828'};border:2px solid ${d.color};`
    + 'border-radius:6px;padding:8px 4px;text-align:center;cursor:pointer;position:relative;';
  const canvas = document.createElement('canvas');
  canvas.width = 48; canvas.height = 48;
  canvas.style.cssText = 'image-rendering:pixelated;display:block;margin:0 auto 4px;';
  void drawItemThumbnail(canvas, item.item_id, charKey);
  const name = document.createElement('div');
  name.style.cssText = 'font-size:10px;color:#eee;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';
  name.textContent = d.name;
  const rar = document.createElement('div');
  rar.style.cssText = `font-size:9px;color:${d.color};text-transform:capitalize;`;
  rar.textContent = d.rarity;
  const slot = document.createElement('div');
  slot.style.cssText = 'font-size:9px;color:#555;margin-top:2px;';
  slot.textContent = d.slotLabel;
  card.append(canvas, name, rar, slot);
  if (isEquipped) {
    const badge = document.createElement('div');
    badge.style.cssText = 'font-size:9px;color:#ffdd44;margin-top:2px;font-weight:bold;';
    badge.textContent = 'EQUIPPED';
    card.append(badge);
  }
  card.title = `${d.name} (${d.rarity} ${d.slotLabel}) — click to ${isEquipped ? 'unequip' : 'equip'}`;
  card.onmouseenter = () => { card.style.borderColor = '#ffdd44'; };
  card.onmouseleave = () => { card.style.borderColor = d.color; };
  card.onclick = () => onToggle(item.id, !isEquipped);
  return card;
}
