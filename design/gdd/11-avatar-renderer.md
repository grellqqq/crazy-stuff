# System #11 — Avatar Renderer (Layered Sprite Compositing)

## 1. Overview

The Avatar Renderer composites multiple transparent sprite layers into a single
on-screen character. Each equipment slot maps to an independent spritesheet that
plays in lockstep with the base body animation. This allows thousands of cosmetic
items to be mixed and matched without pre-generating every combination.

## 2. Player Fantasy

Players see their character as a unique expression of identity. Every hat, shirt,
pair of shoes, and floating familiar is visible to all other players in real time.
Equipping a new item feels immediate — the layer pops onto the character the
moment you tap "equip". Other players see your outfit update live in the lobby
and at race start.

## 3. Detailed Rules

### 3.1 Layer Stack

Each avatar is a `Phaser.GameObjects.Container` holding N sprites stacked in
fixed visual order (bottom to top):

| Order | Slot Key          | Description                        |
|-------|-------------------|------------------------------------|
| 0     | `back`            | Capes, wings, backpacks            |
| 1     | `lower_body`      | Pants, skirts, shorts              |
| 2     | `feet`            | Shoes, boots, bare feet            |
| 3     | `skin`            | Base body (always present)         |
| 4     | `upper_body`      | Shirts, jackets, armor             |
| 5     | `hair`            | Hairstyle overlay                  |
| 6     | `mouth_accessory` | Masks, fangs, pipe                 |
| 7     | `eyes_accessory`  | Glasses, monocle, eye patch        |
| 8     | `face_accessory`  | Full face mask (replaces 6 + 7)    |
| 9     | `head_accessory`  | Hats, crowns, helmets              |
| 10    | `hand_1h`         | Held items (wand, phone, flower)   |
| 11    | `air_space`       | Floating familiars, halos, drones  |

The container itself receives the scene-level depth value (`isoDepth`).
Sprites inside it are ordered by their `add()` sequence — no per-child depth
values. Shadow, name label, and status label remain **outside** the container
with their own depth offsets (+0.1, +0.15).

### 3.2 Sprite Standard

Every equipment item is a set of transparent-background PNG spritesheet strips
that exactly match the base character format:

| Property       | Value                                    |
|----------------|------------------------------------------|
| Frame size     | 92 x 92 pixels                           |
| Scale          | 0.75 (applied at runtime)                |
| Origin         | (0.5, 0.85) — feet at 85% down frame    |
| Directions     | 8 (S, SE, E, NE, N, NW, W, SW)          |
| Walk frames    | 6 per direction                          |
| Run frames     | 6 per direction                          |
| Jump frames    | 9 per direction                          |
| Idle frames    | 4 per direction                          |
| Full file set  | 32 PNGs per item per body type           |
| Minimum set    | 16 PNGs (walk + idle only, MVP)          |

Equipment pixels sit on a fully transparent canvas. Only the visible equipment
pixels are opaque — everything else is alpha 0.

### 3.3 Asset Path Convention

```
src/client/public/sprites/equipment/{slot}/{itemId}/{bodyType}/{anim}_{direction}.png
```

Examples:
```
sprites/equipment/head_accessory/wizard_hat/male/walk_south.png
sprites/equipment/upper_body/red_hoodie/female/idle_north-east.png
sprites/equipment/feet/beatup_sneakers/male-dark/run_west.png
```

The `{bodyType}` folder allows different sprite overlays per base character
silhouette (male, female, male-medium, female-medium, male-dark, female-dark).

### 3.4 Item Registry

A static JSON file served at `/data/items.json`:

```json
{
  "wizard_hat": {
    "slot": "head_accessory",
    "name": "Wizard Hat",
    "rarity": "uncommon",
    "bodyTypes": ["male", "female", "male-medium", "female-medium", "male-dark", "female-dark"],
    "anims": { "walk": true, "run": true, "jump": false, "idle": true },
    "iconPath": "/sprites/equipment/head_accessory/wizard_hat/icon.png",
    "description": "A pointy hat crackling with arcane energy."
  }
}
```

Fields:
- `slot` — one of the 12 `EQUIPMENT_SLOTS`
- `bodyTypes[]` — which base characters have sprites for this item
- `anims` — which animation types have dedicated spritesheets (missing = reuse walk frame 0)
- `iconPath` — 48x48 thumbnail for inventory UI

### 3.5 Animation Sync

The body sprite is the **conductor**. On every `updateAvatarVisual()` call:

1. Determine the correct animation key for the body: `{charKey}_{animType}_{dir}`
2. For each equipment layer, compute the matching key: `equip_{itemId}_{animType}_{dir}`
3. If the equipment animation exists, play it. If not, fall back:
   - `run` falls back to `walk`
   - `jump` falls back to `walk` frame 0 (static)
4. Force-sync frame index: read `bodySprite.anims.currentFrame.index` and set
   it on each equipment sprite via `setCurrentFrame(frames[index])`
5. Apply same `flipX` and `anims.timeScale` as body

This guarantees pixel-perfect sync even after lag spikes or tab-away.

### 3.6 Face Accessory Mutual Exclusion

Equipping a `face_accessory` automatically unequips any `eyes_accessory` and
`mouth_accessory`. Equipping either `eyes_accessory` or `mouth_accessory`
automatically unequips any `face_accessory`. Enforced server-side in
`equipItem()`. The client UI grays out conflicting slots.

### 3.7 Loadout Broadcast (Multiplayer)

Each player's equipped loadout is a `Record<string, string>` (slot -> itemId).

- **On join:** Server fetches loadout from MongoDB, sends `playerLoadout`
  message to all clients: `{ slotIndex, charKey, loadout }`
- **On equip change (lobby):** Client calls equip API, server broadcasts
  updated loadout to room
- **Race:** Equipment is frozen at race start. No changes mid-race.

### 3.8 Lazy Loading

Equipment spritesheets are loaded on-demand when a player with that item enters
the scene. Flow:

1. Receive loadout with unknown item sprites
2. Queue spritesheet loads via `this.load.spritesheet()`
3. Call `this.load.start()` to begin async load
4. On `this.load.on('complete')`, create equipment sprites and add to container
5. Until loaded, the slot renders as empty (base character visible)

Textures for items belonging to players who leave the scene are candidates for
eviction (not immediate — cached for re-entry).

## 4. Formulas

### Depth Sorting

```
containerDepth = isoDepth(displayX + 1, displayY + 1) = displayX + displayY + 2
shadowDepth    = isoDepth(displayX, displayY) - 0.01
labelDepth     = containerDepth + 0.1
statusDepth    = containerDepth + 0.15
```

No per-layer depth within the container — layer order is determined by add-sequence.

### Animation Fallback

```
resolvedAnim(itemId, requestedAnim, dir):
  if item.anims[requestedAnim] exists -> equip_{itemId}_{requestedAnim}_{dir}
  if requestedAnim == 'run' && item.anims.walk exists -> equip_{itemId}_walk_{dir}
  if requestedAnim == 'jump' && item.anims.walk exists -> equip_{itemId}_walk_{dir} (frame 0 only)
  else -> hide layer for this frame
```

### Texture Key Naming

```
equip_{itemId}_{direction}         // walk (default)
equip_{itemId}_run_{direction}     // run
equip_{itemId}_jump_{direction}    // jump
equip_{itemId}_idle_{direction}    // idle
```

Where `{direction}` matches the PixelLab suffixes: `south`, `south-east`,
`east`, `north-east`, `north`, `north-west`, `west`, `south-west`.

## 5. Edge Cases

| Scenario | Behavior |
|----------|----------|
| Item has no sprites for player's body type | Slot renders empty (no crash). Server still marks equipped. |
| Item missing run animation | Falls back to walk animation at run speed |
| Item missing jump animation | Shows walk frame 0 (static) during jump |
| Item missing idle animation | Shows walk frame 0 (static) during idle |
| Two items in same slot | Server prevents — `equipItem` unequips existing before equipping new |
| Face + eyes equipped simultaneously | Server auto-unequips eyes/mouth when face is equipped |
| Player disconnects mid-equip | Server-side equip is atomic (MongoDB updateOne). No partial state. |
| Spritesheet fails to load | Slot renders empty. Console warning logged. Retry on next scene entry. |
| 5 players, all with 12 items | 60 equipment sprites max. Well within Phaser's capacity at 92x92. |
| Tab-away causes animation drift | Force-sync on every `updateAvatarVisual()` call corrects drift |

## 6. Dependencies

| System | Direction | Relationship |
|--------|-----------|-------------|
| **Item/Inventory (#08)** | This depends on | Provides item ownership, equip/unequip API |
| **Authentication (#03)** | This depends on | Player identity for loadout persistence |
| **Race Room (#10)** | This depends on | Broadcasts loadout on join |
| **Lobby (#13)** | Mutual | Lobby scene displays equipped items, equip UI triggers re-render |
| **Gacha (#24)** | That depends on this | New items obtained via gacha must follow sprite standard |
| **Store (#25)** | That depends on this | Store items must follow sprite standard |
| **Avatar/Customization (#12)** | That depends on this | Customization UI drives this renderer |
| **Asset Pipeline (#06)** | That depends on this | PixelLab generation must output this format |

## 7. Tuning Knobs

| Knob | Default | Range | Affects |
|------|---------|-------|---------|
| `LAYER_ORDER` | See 3.1 | Reorderable array | Visual stacking of equipment |
| `EQUIPMENT_FRAME_SIZE` | 92 | 48-128 | Sprite resolution (must match base char) |
| `EQUIPMENT_SCALE` | 0.75 | 0.5-1.5 | On-screen size of equipment layers |
| `EQUIPMENT_ORIGIN_X` | 0.5 | 0.0-1.0 | Horizontal anchor of equipment sprites |
| `EQUIPMENT_ORIGIN_Y` | 0.85 | 0.0-1.0 | Vertical anchor (feet position) |
| `LAZY_LOAD_TIMEOUT` | 5000ms | 1000-30000 | Max wait before giving up on sprite load |
| `TEXTURE_EVICTION_DELAY` | 60000ms | 0-300000 | Time after player leaves before unloading their item textures |

All values are safe to modify without code changes. Frame size and scale must
match the base character to avoid misalignment.

## 8. Acceptance Criteria

- [ ] Avatar renders with container holding body sprite — identical visual to current single-sprite system
- [ ] Equipment sprite layer added to container appears on top of body in correct visual order
- [ ] All 12 equipment slots can render simultaneously without z-fighting or misalignment
- [ ] Equipment layers animate in perfect sync with body across all 8 directions
- [ ] Walk, run, jump, and idle animations all work with equipment layers
- [ ] Animation fallback works: run -> walk, jump -> walk frame 0
- [ ] Face accessory hides eyes and mouth layers; equipping eyes/mouth hides face
- [ ] Other players see your equipment in both lobby and race
- [ ] Equipment persists across scene transitions (lobby -> queue -> race -> lobby)
- [ ] Lazy loading works: equipment appears after async load, no flash or pop
- [ ] Jump offset applies to all layers (entire container lifts)
- [ ] Tint effects (frozen, speed, shield) apply to all layers uniformly
- [ ] Immune flash (alpha pulse) applies to entire container
- [ ] Items with missing body type sprites render as empty slot (no crash)
- [ ] 5 players with full loadouts runs at 60fps on mid-range hardware

---

## PixelLab Generation Pipeline (Reference)

### Base Characters

Generate "underwear only" base characters using these exact parameters:

```json
{
  "size": 92,
  "view": "low top-down",
  "n_directions": 8,
  "outline": "single color black outline",
  "shading": "basic shading",
  "detail": "medium detail",
  "body_type": "humanoid"
}
```

### Body-Slot Items (Diff Extraction)

For items that wrap the body (upper_body, lower_body, feet, hair, skin):
1. Generate full character wearing the item with identical PixelLab params
2. Pixel-diff against the base to extract equipment-only overlay
3. Tool: `tools/extract-equipment-layer.ts`

### Accessory Items (Direct Generation)

For items that sit at fixed positions (head_accessory, hand_1h, back, air_space):
- Generate via `create_map_object` on transparent 92x92 canvas
- Or generate via `create_character` with the accessory and diff-extract

### Consistency Rule

All PixelLab generations for this game MUST use the same size, view, outline,
shading, and detail parameters listed above. Deviating produces style-inconsistent
sprites that break the layering alignment.
