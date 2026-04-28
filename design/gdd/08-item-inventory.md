---
status: reverse-documented
source: src/server/src/db/mongo.ts, src/server/src/index.ts, src/server/src/rooms/RaceRoom.ts, src/client/src/IsoScene.ts
date: 2026-04-25
verified-by: Gabriel
---

# System #08 — Item / Inventory

> **Note:** This document was reverse-engineered from the existing implementation
> in Sprint 1 (commits S1-35 through S1-41). It captures current behavior plus
> design intent clarified with the project lead. Sections marked **[PLANNED]**
> describe target state not yet implemented.

## 1. Overview

The Item / Inventory system is the canonical store of every cosmetic asset a
player owns and the source of truth for what they currently wear. Every avatar
item — hats, shirts, pants, shoes, capes, hand-helds, hovering familiars, and
skin variants — flows into a player's inventory from one of several **faucets**
(gacha pulls, the store, race/progression rewards, and any future acquisition
path such as events, trades, gifts, or achievements) and is referenced by a
stable `itemId` that points into a versioned **item catalog**. Each inventory
entry is a unique row (no stacking — two identical pulls produce two rows), and
a denormalized `equippedLoadout` map on the player document caches the
currently-equipped slot → itemId mapping for fast read-side access. The system
enforces one-item-per-slot, slot-conflict rules (face accessory vs. eyes/mouth),
and broadcasts equipped loadouts to all clients in a race room so every player
sees every other player's outfit in real time. Inventory is the system every
acquisition path and the avatar renderer converge on — its schema and contract
govern how cosmetic content enters and is consumed by the game.

## 2. Player Fantasy

Players want to feel that what they own is **theirs** — a personal collection
that grew with them, that they can show off, and that no one can take away. The
inventory is their wardrobe and trophy case in one: opening it should feel like
opening a closet stuffed with memories ("oh yeah, I got this hat from the
Halloween event"), not browsing a sterile equipment menu.

Equipping an item is **immediate and visible** — the moment a player hits
"equip", their character changes on screen, and within a second every other
player in the lobby sees it too. Outfits are a social signal: a rare item
across someone's avatar reads as "this person plays a lot" or "this person was
here for the spring season." Mixing slots is a creative act, not a stat
optimization — there is no best loadout, only the loadout that says what the
player wants to say today.

The bag itself should feel **bottomless and forgiving** — players never have
to delete things to make room, never lose an item by mistake, and can always
go back to an old look from years ago. Rarity color borders give a quick read
of "what's the most precious thing I own," and the slot grid makes it obvious
at a glance what's currently worn vs. what's sitting in storage.

## 3. Detailed Rules

### 3.1 Item Catalog (canonical source)

The **item catalog** is the canonical, versioned definition of every item that
exists in the game. Inventory rows reference the catalog by `itemId`; the
catalog itself owns all metadata (display name, slot, rarity, visuals, source,
sort order, etc.). This is the standard live-service pattern — Fortnite,
Valorant, Genshin, and Apex all separate "what items exist in the game"
(catalog, ships with the build / patched server-side) from "what each player
owns" (inventory, mutable per player).

**Current state (Sprint 1):** there is no central catalog. `itemId` is a
free-form string written into inventory rows, and visual metadata
(`EQUIP_FRAME_SIZES`, `EQUIP_AVAILABLE_ANIMS`) is hardcoded client-side in
`IsoScene.ts`. This works while the item count is small but breaks down once
gacha/store/seasonal content land. **[PLANNED]** A `items` collection in
MongoDB (mirrored as a build-time JSON manifest the client can preload).

**Catalog entry schema [PLANNED]:**

| Field | Type | Description |
|-------|------|-------------|
| `itemId` | string (PK) | Stable identifier, e.g. `wizard_hat`, `tshirt_red`. Snake_case, immutable. |
| `displayName` | string | Localized player-facing name, e.g. "Wizard Hat". |
| `slot` | enum | One of the 12 equipment slots (see §3.3). |
| `rarity` | enum | One of the 6 rarity tiers (see §3.4). |
| `releaseSeason` | string \| null | Season tag, e.g. `s1`, `halloween-2026`, or `null` for permanent. |
| `sources` | string[] | Where this item can drop from: `gacha`, `store`, `race_reward`, `event`, `starter`, `legacy`. |
| `storePriceCoins` | int \| null | Coin price if sold in store; `null` if not for sale. |
| `gachaWeight` | int \| null | Relative weight in gacha pool; `null` if not in gacha. |
| `frameSize` | int | Sprite frame size in pixels (currently 92 for base, 132 for oversized like wizard hat). |
| `availableAnims` | string[] | Which animation tracks have sprites: `idle`, `walk`, `run`, `jump`. |
| `bodyTypeOverrides` | map | Per-body-type sprite path overrides (some items may not render on all 6 bodies yet). |
| `sortOrder` | int | Tiebreaker for catalog display ordering. |
| `addedInBuild` | string | First build/version this item shipped in (audit trail). |
| `retired` | bool | If `true`, item can no longer be acquired but remains valid in existing inventories. |

**Versioning rules:**

- `itemId` is **immutable** once shipped. Renaming an item breaks every
  inventory row that references it.
- Adding a new item = new catalog row. Removing an item = set `retired: true`
  (never delete — players who already own it must keep their copy).
- Visual fields (`frameSize`, `availableAnims`) may be updated, but slot and
  rarity must never change after release (would invalidate equip rules and
  rarity-based UI).

**Migration path:**

1. Create `items` collection seeded from current hardcoded values.
2. Server `addItem()` validates `itemId` exists in catalog before inserting.
3. Client preloads catalog JSON at boot and looks up visual metadata from it
   instead of `EQUIP_FRAME_SIZES` / `EQUIP_AVAILABLE_ANIMS`.
4. Inventory queries left-join catalog so the client gets `displayName` and
   current rarity in one round-trip.

### 3.2 Inventory Storage Model

Player-owned items live in a per-player document store with one row per owned
item. Two writes for the same `itemId` produce two distinct rows — there is no
stacking, no quantity field, no merge logic.

**MongoDB collection: `inventory`** (current implementation,
`src/server/src/db/mongo.ts`):

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | MongoDB-assigned primary key. Returned to the client as the `id` string used in equip API calls. |
| `playerId` | string | The owning player's `players._id` as a string. Indexed (`{ playerId: 1 }`). |
| `itemType` | string | The slot key (one of the 12 in §3.3). Denormalized from catalog for query speed. |
| `itemId` | string | Catalog reference (see §3.1). |
| `rarity` | string | One of the 6 rarity tiers. Denormalized from catalog for fast UI rendering without a join. |
| `equipped` | bool | `true` if currently worn by the player. Exactly one `equipped: true` row per slot per player (enforced in code, see §3.5). |
| `obtainedAt` | Date | Acquisition timestamp. Drives sort order (newest first) in the bag UI. |

**Denormalization rationale:** `itemType` and `rarity` are stored on each
inventory row even though they could be looked up from the catalog. This is
intentional — the inventory query (the most frequent read for any owning
system) returns everything the UI needs in one collection scan, no join
required. The cost is that a catalog rarity change (which the §3.1 rules
forbid anyway) would require a backfill across all inventory rows.

**No quantity / no stacks:**

- Acquisition (`addItem`) always inserts a fresh row.
- Two pulls of `wizard_hat` = two rows with distinct `_id`s.
- This treats every owned copy as a unique physical thing — closer to a
  wardrobe than a card collection. Future trading or gifting features can
  move individual rows without splitting/merging stacks.

**No bag capacity limit:**

- Players can accumulate unbounded items.
- The MongoDB `playerId` index keeps queries fast even with thousands of rows.
- **Tuning knob (see §7):** a future premium tier may introduce per-player or
  per-account caps; the schema accommodates this with no migration (cap check
  would live in `addItem`).

**Player-document fields owned by this system** (on the `players` collection):

| Field | Type | Description |
|-------|------|-------------|
| `equippedChar` | string | Currently selected base body, one of `male`, `female`, `male-medium`, `female-medium`, `male-dark`, `female-dark`. **[Legacy — see §3.3 skin-slot migration.]** |
| `equippedLoadout` | map<string, string> | Denormalized cache of slot → itemId for currently-worn items. Rebuilt by `recomputeLoadout()` after every equip/unequip. See §3.7. |

### 3.3 Equipment Slots

The avatar has **12 equipment slots**. Each slot accepts exactly one item at a
time. The slot key is the same string used as `inventory.itemType` and as the
key in `equippedLoadout`.

| # | Slot Key | Display Label | Examples |
|---|----------|---------------|----------|
| 1 | `skin` | Skin | Base body — see migration note below |
| 2 | `hair` | Hair | Hairstyle + color |
| 3 | `head_accessory` | Head | Hats, crowns, helmets, flowers |
| 4 | `eyes_accessory` | Eyes | Glasses, monocle, eye patch |
| 5 | `mouth_accessory` | Mouth | Cigar, pipe, mustache, mask covering mouth only |
| 6 | `face_accessory` | Face | Full-face masks, balaclavas (mutually exclusive with eyes + mouth — see §3.6) |
| 7 | `upper_body` | Upper | Shirts, jackets, hoodies, robes |
| 8 | `lower_body` | Lower | Pants, skirts, shorts |
| 9 | `feet` | Feet | Shoes, boots, bare feet |
| 10 | `back` | Back | Capes, wings, backpacks |
| 11 | `hand_1h` | Hand | Wand, phone, flower, weapon skin (one-handed) |
| 12 | `air_space` | Aura | Drones, familiars, floating halos |

Source of truth: `EQUIPMENT_SLOTS` in `src/server/src/db/mongo.ts:33`.
Mirrored client-side as `SLOT_META` in `IsoScene.ts:2002` (with display labels
and emoji icons for the inventory UI).

**Layer render order** (bottom to top, used by the avatar renderer — see
System #11):

```
back → lower_body → feet → skin → upper_body → hair →
mouth_accessory → eyes_accessory → face_accessory →
head_accessory → hand_1h → air_space
```

Source: `LAYER_ORDER` in `IsoScene.ts:106`. Note that `back` renders below the
body so capes hang behind the character, and `air_space` renders on top so
familiars/auras are never occluded.

#### Skin Slot Migration **[PLANNED]**

**Current state:** the base body (one of 6 — `male`, `female`, plus `-medium`
and `-dark` variants) is selected via `players.equippedChar` and lives outside
the inventory system. The `skin` slot exists in `EQUIPMENT_SLOTS` but no item
ever uses it.

**Target state:** the 6 base bodies become **catalog items in the `skin`
slot**, granted automatically to every player on account creation (one of
each, all 6 owned, common rarity). `equippedChar` becomes a derived value
computed from `equippedLoadout.skin`. Rare skin variants (event drops, gacha
skins, seasonal palettes) then drop into the same slot as normal inventory
items.

**Why this matters:** without the migration, two parallel systems represent
"what does my character look like" — `equippedChar` for body, `equippedLoadout`
for everything else. The migration unifies them so all visual customization
flows through one path (gacha, store, equip API, broadcast).

**Migration steps (deferred):**

1. Catalog seed: 6 entries with `slot: 'skin'`, `rarity: 'common'`,
   `sources: ['starter']`.
2. Backfill: every existing player gets 6 inventory rows with `equipped: true`
   on the row matching their current `equippedChar`.
3. Server: `equipChar` API becomes a wrapper that calls `equipItem` on the
   right `skin` row. `equippedChar` becomes a read-through computed field for
   back-compat.
4. Eventually: `equippedChar` removed from schema, all reads go through
   `equippedLoadout.skin` → catalog lookup.

### 3.4 Rarity Tiers

The catalog defines **6 rarity tiers**. Rarity is a fixed property of each
catalog entry — it never changes after release and is the same for every
player who owns the item. Rarity drives UI presentation (border colors, sort
order, "best item" highlights) and serves as the input dimension for gacha
drop-rate tables.

| # | Rarity | UI Color | Hex | Typical Sources |
|---|--------|----------|-----|-----------------|
| 1 | `common` | Gray | `#888` | Gacha (high rate), store (cheap), starter items |
| 2 | `uncommon` | Green | `#44bb44` | Gacha (mid rate), store |
| 3 | `rare` | Blue | `#4488ff` | Gacha (low rate), seasonal store |
| 4 | `epic` | Purple | `#aa44ff` | Gacha (very low rate), limited seasonal |
| 5 | `legendary` | Gold | `#ffaa00` | Gacha (ultra rare), event-exclusive |
| 6 | `crazy` | Magenta / Animated | `#ff44ff` | Gacha (~0.1% rate), never sold in store |

Source of truth: `RARITY_COLORS` in `src/client/src/IsoScene.ts:2017` and
`LobbyScene.ts:1037`. Drop-rate targets and store-pricing curves live in the
**Gacha System (#24)** and **Store System (#25)** GDDs respectively — this
system only enforces that the rarity *exists* and is one of the six.

**Rules:**

- Every catalog item must have exactly one rarity from this set.
- Rarity is **denormalized** onto each inventory row (see §3.2) so the bag UI
  can color borders without joining the catalog.
- The `crazy` tier is the only one with special visual treatment beyond a
  static border color — it should render with an animated rainbow gradient or
  particle effect (per the monolithic GDD §"Item Rarity Tiers"). Implementation
  deferred to System #11 (Avatar Renderer) and the inventory UI polish pass.
- Tiers are **ordinal** — `common < uncommon < rare < epic < legendary < crazy`.
  Sort order in the bag UI is "newest first" (by `obtainedAt`), but rarity
  becomes the secondary sort key when filters are added.

**Tuning constraints:**

- Adding a 7th tier later is a breaking change — every UI surface assumes 6
  colors and every gacha table assumes 6 weight buckets. If a 7th tier is
  needed, treat it as a major version bump of this system.
- Removing or renaming a tier is forbidden — would invalidate every inventory
  row at that tier.

### 3.5 Equip / Unequip Behavior

Equipping is the most frequent write to the inventory system and it's where
the slot-conflict invariants are enforced. The contract: **after any
equip/unequip operation completes, exactly zero or one inventory rows per slot
per player has `equipped: true`**.

#### Equip flow (`equipItem` in `src/server/src/db/mongo.ts:229`)

Inputs: `userId`, `inventoryItemId` (the `_id` of the row to equip).

1. **Resolve player.** Look up `players` doc by `userId`. If missing, abort
   with `null`.
2. **Resolve item row.** `inventory.findOne({ _id: inventoryItemId, playerId })`.
   If missing, abort with `null` (this is the ownership check — players cannot
   equip items they don't own, even with a guessed ID).
3. **Clear same-slot.** `inventory.updateMany({ playerId, itemType: item.itemType, equipped: true }, { equipped: false })`.
   Removes whatever was previously worn in this slot.
4. **Apply slot conflicts.** If the slot has conflicts defined in
   `FACE_CONFLICTS` (see §3.6), `updateMany` to clear all conflicting slots.
5. **Equip the target.** `inventory.updateOne({ _id: item._id }, { equipped: true })`.
6. **Recompute loadout.** Call `recomputeLoadout()` to rebuild
   `players.equippedLoadout` from inventory truth (see §3.7).
7. **Return** the equipped item row.

#### Unequip flow (`unequipItem` in `src/server/src/db/mongo.ts:262`)

Inputs: `userId`, `inventoryItemId`.

1. Resolve player. Abort with `null` if missing.
2. `inventory.updateOne({ _id: inventoryItemId, playerId }, { equipped: false })`.
   The `playerId` filter doubles as the ownership check.
3. If `modifiedCount > 0`, recompute loadout. (If the item was already
   unequipped, no recompute — a small optimization that avoids spurious cache
   writes.)
4. Return `true` if a row was modified, `false` otherwise.

#### HTTP API (`src/server/src/index.ts:83`)

Single endpoint handles both directions:

```
POST /api/player/:userId/equip
Body: { inventoryItemId: string, equipped: boolean }
200: { ok: true }
400: { error: "could not equip item" } | { error: "could not unequip item" }
```

The boolean dispatches to `equipItem` (true) or `unequipItem` (false). The
endpoint name is asymmetric (`/equip` covers both) — kept as-is for now, but
flagged as a candidate for renaming to `/loadout` or `/equipment` if the API
ever gets cleaned up.

#### Atomicity caveat

The equip flow is **not transactional** — steps 3, 4, 5, and 6 are separate
MongoDB operations. A server crash mid-flow could leave the inventory in an
intermediate state (e.g., old item unequipped but new item not yet equipped,
or new item equipped but `equippedLoadout` cache stale). `recomputeLoadout`
is idempotent — it always rebuilds from the inventory truth — so the cache
will self-heal on the next equip. The intermediate-state window is
microseconds-long under normal conditions, and the worst observable symptom
is "player sees an empty slot for a moment before the next sync." See §5
(Edge Cases) for full enumeration.

#### Toggling rule (UI-level)

The inventory panel treats the bag-card click as a toggle: clicking an
unequipped item equips it; clicking an equipped item unequips it. Clicking an
equipped slot in the equipment grid (top section) also unequips. This is a UI
convenience — at the API level there is no "toggle"; the client decides
direction and sends `equipped: true | false` accordingly.

### 3.6 Slot Conflicts

A slot conflict is a rule that says "equipping into slot A automatically
unequips whatever is currently in slot B." The current system has exactly one
such rule, defined declaratively as a map.

#### Defined conflicts

Source: `FACE_CONFLICTS` in `src/server/src/db/mongo.ts:47`.

| Equipping into... | Auto-unequips... | Why |
|-------------------|------------------|-----|
| `face_accessory` | `eyes_accessory`, `mouth_accessory` | Full-face items (masks, balaclavas) cover the eye and mouth regions, so having all three on at once would render glasses and mustaches *underneath* a mask — visually broken. |
| `eyes_accessory` | `face_accessory` | Symmetric: equipping glasses removes the full-face mask. |
| `mouth_accessory` | `face_accessory` | Symmetric: equipping a mustache removes the full-face mask. |

The asymmetry between (`face_accessory` clears two slots) and
(`eyes_accessory` / `mouth_accessory` each clear one) is intentional — face
is the "umbrella" slot that subsumes both; eyes and mouth are independent of
each other and only conflict with face.

#### Enforcement

Conflicts are enforced **server-side in `equipItem`** (step 4 of the equip
flow, §3.5). The client does not need to know the conflict rules — it just
sends an equip request and the server clears whatever else needs clearing.
Conflicts are a one-way effect of *equipping*; *unequipping* never triggers
any conflict logic.

#### UI obligation

The inventory UI **should** communicate the conflict before the player commits
the equip — e.g., a tooltip on the `face_accessory` card that says "wearing
this will remove your glasses and mustache." This is **not implemented today**
— the slots just silently clear after the equip and the player sees the
result on next render. Flagged as a UX polish item.

#### Future conflicts (open design space)

The `FACE_CONFLICTS` map is the single extension point — adding new rules is
a one-line edit. Candidates the design team has discussed but not committed
to:

- **Two-handed weapons** in `hand_1h` clearing `back` (a greatsword on the
  back conflicts with a cape).
- **Full helmets** in `head_accessory` clearing `hair` (helmet covers hair).
- **Bulky backpacks** in `back` clearing `air_space` (familiar/aura wouldn't
  have room).

These are explicitly **not enforced today** (decision in this session,
2026-04-25). Any future addition follows the same data-driven pattern: add
an entry to the conflict map, document the rationale here, ship.

#### Constraints

- Conflicts must be **declared symmetrically** in the map. If A conflicts
  with B, both `A → [B]` and `B → [A]` entries must exist. Otherwise, the
  player can equip-around the rule by going through the unblocked direction.
- Conflicts only operate on `equipped: true` rows — they never delete items,
  only unequip them. The displaced items remain in the bag and can be
  re-equipped at any time.

### 3.7 Loadout Denormalization

The `equippedLoadout` map on each player document is a **read-side cache** of
what the player is currently wearing, derived from the inventory truth. It
exists for one reason: a player joining a race room needs their loadout
broadcast to all other clients within the join window, and walking the
inventory collection on every join would mean an extra query in a
latency-sensitive path. The cached map is one document read.

#### Shape

```js
// On players collection
{
  _id: ObjectId(...),
  userId: "...",
  equippedChar: "male",
  equippedLoadout: {
    upper_body: "worn_tshirt_red",
    lower_body: "blue_jeans",
    feet: "beatup_sneakers",
    head_accessory: "wizard_hat"
    // ...only equipped slots present; absent slots = empty
  }
}
```

Slots with no equipped item are **omitted** from the map (not stored as
`null`). An empty loadout is `{}`.

#### Recompute trigger

Source: `recomputeLoadout` in `src/server/src/db/mongo.ts:187`.

Called once at the end of every `equipItem` and every `unequipItem` that
modified a row (steps 6 of equip / 3 of unequip in §3.5). The function:

1. Queries `inventory.find({ playerId, equipped: true })`.
2. Builds a fresh `{ slot: itemId }` map from the result.
3. Writes the whole map atomically via
   `players.updateOne({ userId }, { $set: { equippedLoadout: ... } })`.

The function is **idempotent** — calling it twice in a row produces the same
result. This is the property that lets the cache self-heal after partial
failures (see §3.5 atomicity caveat and §5 edge cases).

#### Read paths

- **`getLoadout(userId)`** in `mongo.ts:181` — single-document lookup, returns
  the cached map. Used by `RaceRoom` on player join (see §3.8).
- The inventory list endpoint (`GET /api/player/:userId/inventory`) does
  **not** use the cache — it returns full inventory rows including the
  `equipped` boolean. The client builds its own slot view from those rows.
  This is intentional: the inventory UI needs the full bag anyway, so reading
  the cache would be redundant.

#### Consistency invariants

The cache is correct when:

- For every `(slot, itemId)` pair in `equippedLoadout`, there exists exactly
  one `inventory` row with `playerId == player._id`, `itemType == slot`,
  `itemId == itemId`, and `equipped == true`.
- For every `inventory` row with `equipped: true`, there is a matching entry
  in `equippedLoadout`.

Violations are recoverable: any subsequent `equipItem`/`unequipItem` call
rebuilds the cache from scratch. A future maintenance/debug command could
expose `recomputeLoadout` as an admin endpoint to force a rebuild.

#### Why not skip the cache and join inventory live?

Considered and rejected for two reasons:

1. **Race join latency.** A player joining a race room means N existing
   players each need M loadouts broadcast (N × M individual loadout reads on
   join). The cache makes this O(N) document reads instead of O(N) collection
   scans.
2. **Loadout broadcast batching.** Sending the cached map directly is a
   single object send; reconstructing it from inventory rows on every
   broadcast would burn server CPU during the high-frequency lobby phase.

### 3.8 Multiplayer Broadcast

Equipped loadouts must be visible to every other player in the same race room
within ~1 second of an equip change. The broadcast is a separate Colyseus
message channel from the main `state` broadcast (which carries position/score
data) — loadouts change rarely and are bulky, so they ride their own channel
and are not folded into the per-frame state delta.

#### Server-side cache

Source: `playerLoadouts` map in `src/server/src/rooms/RaceRoom.ts:177`.

```ts
private playerLoadouts = new Map<string, {
  charKey: string;
  loadout: Record<string, string>;
}>();
```

Keyed by Colyseus `sessionId`. Populated on player join, mutated when a
player sends `refreshLoadout`, cleared on player leave. The cache is
process-local — race rooms are short-lived (one match) and don't need
cross-room loadout state.

#### Join flow (`onJoin`, `RaceRoom.ts:263`)

1. Server fetches `equippedChar` and `equippedLoadout` from MongoDB in
   parallel via `Promise.all`.
2. Stores them in `playerLoadouts[sessionId]`.
3. Broadcasts `playerLoadout` message **to all clients** (including the
   joiner) with `{ slotIndex, charKey, loadout }`.
4. Replays all *existing* players' loadouts to the joining client only — so
   the new joiner sees everyone else's outfit immediately, not just on the
   next change.

The fetch is **non-blocking with respect to the join handshake** — the
player enters the room and receives the main `state` broadcast immediately;
their visual loadout populates ~1 frame later when the loadout fetch
completes. Client falls back to base body until the loadout arrives.

#### Refresh flow (`refreshLoadout` message handler, `RaceRoom.ts:205`)

Trigger: client sends `room.send('refreshLoadout')` after a successful
equip/unequip API call (`IsoScene.ts:2332`).

1. Server re-fetches loadout from MongoDB.
2. Updates the local cache.
3. Broadcasts `playerLoadout` to all clients.

The client trusts the server's broadcast — it does **not** apply the equip
locally first. This avoids the case where the API call succeeds but the
broadcast is delayed, leaving local state ahead of remote state.

#### Frozen during race

Loadouts are intentionally **not refreshed during the active racing phase**
(the inventory UI is also disabled — see `IsoScene.ts:2049`). This avoids:

- The visual confusion of someone changing outfit mid-race.
- The server CPU cost of mid-race DB reads under load.
- The race-condition risk of an item disappearing from the avatar
  mid-animation.

Players can change outfits in the lobby phase; once the race starts, every
player's outfit is locked until the race ends.

#### Message shape

```ts
// Server → all clients
{
  type: 'playerLoadout',
  slotIndex: number,        // 0-4, the player's stable slot index in this room
  charKey: string,          // base body identifier
  loadout: {                // slot → itemId map (matches §3.7 shape)
    upper_body: 'worn_tshirt_red',
    // ...
  }
}
```

Note that the broadcast keys by `slotIndex`, not `sessionId` — slots are
stable across the whole room lifecycle (see RaceRoom slot system) so the
client can always find the right avatar to update without tracking session
UUIDs.

### 3.9 Acquisition Contract

Every system that grants items to a player goes through this system's
`addItem` API. This section defines what those upstream systems must guarantee
and what they get in return.

#### The single faucet API

Source: `addItem` in `src/server/src/db/mongo.ts:215`.

```ts
addItem(
  userId: string,
  itemType: string,   // slot key (one of the 12 in §3.3)
  itemId: string,     // catalog reference
  rarity: string      // one of the 6 tiers
): Promise<InventoryRow | null>
```

Returns the newly-inserted inventory row, or `null` if the player doesn't
exist. Always inserts (never updates) — see §3.2 no-stack rule.

#### Caller obligations

Any system calling `addItem` (gacha, store, race rewards, events, trades,
gifts, achievements, admin grants, ...) **must**:

1. **Validate `itemId` against the catalog** before calling. The catalog's
   `slot` and `rarity` fields are the source of truth; passing an
   `itemType`/`rarity` that disagrees with the catalog is a programming error.
   **[PLANNED]** Once the catalog migration lands (§3.1), `addItem` itself
   will validate this and reject mismatched calls.
2. **Verify the player owns the right to acquire the item** at the call site.
   `addItem` does no auth, no payment check, no roll validation — it trusts
   the caller. The faucet system (gacha pool weights, store coin debit,
   race-reward eligibility) is responsible for "should this player get this
   item right now."
3. **Be idempotent at the transactional boundary** if the upstream operation
   might retry. `addItem` is not idempotent — calling it twice creates two
   inventory rows. Gacha pulls and store purchases must use their own
   idempotency mechanism (request ID, debit-then-grant ordering) to prevent
   duplicate grants from network retries.

#### What this system guarantees in return

- The granted item is immediately visible in `getInventory(userId)`.
- The item is **unequipped by default** (`equipped: false`). The caller can
  choose to follow up with `equipItem` if the design wants auto-equip (e.g.,
  starter items are granted unequipped, then a separate flow could equip the
  default outfit).
- The item never disappears, never converts to currency, never expires. Once
  granted, it is the player's forever (subject only to the §3.1
  `retired: true` rule, which prevents new grants but preserves existing
  ones).
- The grant is durable — once `addItem` returns successfully, the row is
  committed to MongoDB. No in-memory queue, no eventual consistency.

#### Source tagging **[PLANNED]**

Catalog entries declare their valid `sources[]` (§3.1). When `addItem` is
upgraded to validate against the catalog, it should also accept an optional
`source` parameter and verify it's in the catalog's allowed list. This
prevents bugs like "the gacha system accidentally grants a store-only
legendary." Adding `source` to the inventory row itself (for analytics —
"where did each player get each item from") is a candidate enhancement,
deferred until analytics needs it.

#### Special cases

- **Starter items** are granted inline in `getOrCreatePlayer`
  (`mongo.ts:127`), bypassing `addItem` for performance (3 inserts in a
  tight loop right after player creation). The contract is identical — same
  row shape, same invariants — but the call path differs.
- **Admin grants** (manual item awards via the admin panel) should go through
  `addItem` with `source: 'admin'`. **[PLANNED]** — admin panel exists in a
  separate repo (grellqqq/crazy-stuff-admin); contract documented here for
  forward reference.

## 4. Formulas

The Item / Inventory system is primarily transactional rather than
mathematical — most behavior is rule-based (slot exclusion, denormalization,
broadcast) rather than formula-driven. The formulas it does have are simple
invariant checks and one capacity calculation.

### 4.1 Loadout cardinality invariant

For any player `P` and any slot `S`:

```
count(inventory rows where playerId = P AND itemType = S AND equipped = true) ∈ {0, 1}
```

**Variables:**

- `P` — a player's `_id`.
- `S` — one of the 12 slot keys from §3.3.

**Expected value:** always 0 or 1. A count of 2+ indicates a corrupted state
(concurrent equip race, bypassed `equipItem`, or direct DB write). The system
has no auto-repair — manual intervention required.

**Example:** Player has 3 t-shirts in inventory. At most one of those 3 rows
has `equipped = true`. Equipping a 4th t-shirt sets the previously-equipped
one to `false` and the new one to `true` — count remains 1.

### 4.2 Loadout cache consistency

For any player `P`:

```
equippedLoadout[S] = itemId  ⟺  ∃ row { playerId=P, itemType=S, itemId=itemId, equipped=true }
```

**Variables:**

- `equippedLoadout[S]` — the cached map's value for slot `S`, or undefined if
  absent.
- `itemId` — a catalog reference string.

**Expected behavior:** bidirectional. Every cache entry has a backing
inventory row; every equipped inventory row appears in the cache.

**Example:** If `equippedLoadout = { upper_body: "tshirt_red" }`, then
exactly one inventory row exists with `itemType: "upper_body"`,
`itemId: "tshirt_red"`, `equipped: true`. No other inventory rows have
`equipped: true`.

### 4.3 Bag capacity (when introduced)

Currently unbounded. **[PLANNED]** when premium tiers ship:

```
max_bag_size(player) = base_capacity + Σ(capacity_upgrades_owned)
```

**Variables:**

- `base_capacity` — free-tier limit. Proposed default: **500 items**. Range:
  200–2000.
- `capacity_upgrades_owned` — count of permanent capacity-upgrade items in
  the player's inventory or entitlements.

**Expected value range:** 500 (base) to ~5000 (max premium tier with all
upgrades).

**Example:** A free player owns 487 items and tries to receive a 14th gacha
pull. `addItem` would reject the 14th item (487 + 14 > 500). Pre-grant check
happens at the faucet (gacha pre-flight), not inside `addItem`.

### 4.4 Display sort order (bag UI)

Items in the bag panel sort by:

```
primary_key   = obtained_at DESC
secondary_key = rarity_ordinal DESC  (when filters introduced)
tertiary_key  = catalog.sortOrder ASC
```

**Variables:**

- `rarity_ordinal` — `common=1, uncommon=2, rare=3, epic=4, legendary=5,
  crazy=6` (per §3.4).
- `catalog.sortOrder` — integer field on catalog entry.

**Current implementation:** only `obtainedAt DESC` is enforced (the Mongo
query in `getInventory` sorts by `{ obtainedAt: -1 }`). Secondary/tertiary
keys activate when filter UI is added.

## 5. Edge Cases

Enumerated edge cases and their explicit handling. Cases marked **[OK]** are
handled correctly today; **[BUG]** is current incorrect behavior; **[GAP]**
is undefined behavior that needs a decision.

### 5.1 Concurrent equip into the same slot

Two API calls land on the server at the same instant, both trying to equip
different items into `upper_body`.

**Current:** **[OK with caveat]** Each call independently runs the equip flow.
The `updateMany` clear-step in step 3 (§3.5) sets all currently-equipped
`upper_body` rows to `false`, then step 5 sets the target to `true`. If both
calls interleave, the final state has whichever item ran step 5 last as the
equipped one. The other item's `equipped: true` write is overwritten.
Cardinality invariant (§4.1) holds. The cache (§3.7) is recomputed by both
calls; the second recompute wins.

**Failure mode:** if both calls' step-3 clears run *before* either step-5
sets, both items could end up equipped (cardinality = 2). Window: ~1ms.
Self-heals on next equip via `recomputeLoadout`.

### 5.2 Equip an item the player doesn't own

Client sends `inventoryItemId` for a row owned by a different player.

**Current:** **[OK]** `inventory.findOne({ _id, playerId })` returns null in
step 2 (§3.5) — the `playerId` filter is the security boundary. API returns
400 "could not equip item." Nothing is modified.

### 5.3 Equip an inventory row that no longer exists

Stale client cache references a deleted item. (Currently impossible — items
are never deleted — but defensive.)

**Current:** **[OK]** Same path as §5.2 — `findOne` returns null, API
returns 400.

### 5.4 Server crash mid-equip

Server dies between step 3 (clear same-slot) and step 5 (equip target).

**Current:** **[OK with self-heal]** Player ends up with no item equipped in
that slot. The cardinality invariant holds (count = 0 is valid). The cache
is stale — `equippedLoadout` still references the cleared item. On the next
equip/unequip, `recomputeLoadout` rebuilds the cache correctly. Worst case:
player sees an empty slot until they touch the inventory again.

### 5.5 Server crash mid-recompute

Steps 3-5 succeed, server dies in step 6.

**Current:** **[OK with self-heal]** Inventory truth is correct (cardinality
holds), but `equippedLoadout` cache lags by one operation. Next equip/unequip
restores consistency. RaceRoom on join would broadcast the stale cached
loadout — visual symptom: the previously-equipped item shows on other
clients until the next equip happens.

### 5.6 Catalog item retired while still equipped

An item's catalog entry is set `retired: true` while a player has it equipped.

**Current:** **[OK]** Retirement only affects new acquisitions — equipped
items stay equipped, the inventory row is untouched, the cache still
references the itemId. The catalog lookup (when the client renders) finds
the retired entry and renders normally. Players keep wearing legacy items
forever.

### 5.7 Catalog itemId references a row that was never seeded

A bug or admin error puts an itemId in inventory that has no catalog entry.

**Current:** **[GAP]** Today there's no catalog so this can't happen.
**[PLANNED]** Once the catalog ships, the client should fall back to a
placeholder render (gray box + itemId text) and log a warning. Server should
refuse to grant an unknown itemId via `addItem` (caller obligation in §3.9).

### 5.8 Equipping during the racing phase

Player tries to open inventory mid-race.

**Current:** **[OK]** The inventory button is disabled (`IsoScene.ts:2049`
checks `RacePhase.Racing` and bails). If the player somehow forces an API
call (e.g., direct fetch), the equip succeeds at the DB level but the
broadcast doesn't happen — the change is invisible to other clients until
next room join. **[GAP]** server should ideally also reject mid-race equips
for symmetry; flagged as a hardening item.

### 5.9 Player joins room with an empty loadout

New player has equipped nothing.

**Current:** **[OK]** `getLoadout` returns `{}`. Broadcast carries an empty
loadout. Client renders only the base body. The starter items are granted
unequipped, so a fresh player starts with a bare avatar — they must open
inventory and equip starter clothes manually. This is a UX gap (most players
expect to spawn dressed); deferred decision: should starters auto-equip?

### 5.10 Slot conflict equipped through the back door

Player has `eyes_accessory` equipped. Server-side `equipItem` is bypassed
(admin grant + manual update). Player then equips `face_accessory` normally.

**Current:** **[OK]** The face equip flow's step 4 clears `eyes_accessory`
regardless of how it got equipped. The `FACE_CONFLICTS` check is purely
state-based, not history-based. Self-corrects.

### 5.11 Item granted while player is offline

Admin grants an item via `addItem` while the player has no active session.

**Current:** **[OK]** Item is inserted to inventory. The player sees it the
next time they open the inventory panel (which fetches fresh from the API).
No push notification; no auto-equip. **[PLANNED]** Notification system would
surface "you got a new item!" on next login.

### 5.12 Two devices, same account, simultaneous equip

Player has the game open on phone and laptop, equips different items at the
same time.

**Current:** **[OK]** Both devices' API calls hit the server. Same handling
as §5.1 (concurrent equip race). The other device sees the change on its
next `refreshLoadout` broadcast (or on inventory panel re-open). **[GAP]**
there's no real-time cross-device push — the second device's UI shows stale
state until refreshed.

### 5.13 Inventory grows beyond practical query limits

Player accumulates 50,000+ items over years.

**Current:** **[OK with future risk]** MongoDB query is indexed on `playerId`
so it stays fast. The API returns the entire inventory as one JSON blob — at
50k items that's ~5MB+, slow to parse client-side. **[PLANNED]** pagination
or filter-on-server when item count crosses ~1000 per player.

## 6. Dependencies

Dependencies are listed in two directions: **upstream** (systems this one
depends on) and **downstream** (systems that depend on this one). Per project
convention, every back-reference must be added to the corresponding system's
GDD when those docs are written.

### 6.1 Upstream (what this system needs)

| System | Why this system depends on it |
|--------|------------------------------|
| **System #03 — Authentication / Account** | `userId` (the auth subject) is the foreign key on every player document. Inventory is partitioned per-player by this ID. No auth → no inventory. |
| **System #04 — Database Persistence Layer** | MongoDB collections (`inventory`, `players`) and the connection management live in this layer. Defines the `playerId` index, schema migrations, and connection pool. |
| **System #06 — Asset Pipeline** | Equipment sprite delivery (per-item directories under `src/client/public/sprites/equipment/{slot}/{itemId}/{bodyType}/`) is the asset pipeline's responsibility. The catalog's `frameSize` and `availableAnims` fields document what the pipeline must produce per item. |

### 6.2 Downstream (what depends on this system)

| System | Why it depends on this system |
|--------|------------------------------|
| **System #10 — Race Room (Colyseus)** | Holds the `playerLoadouts` cache, calls `getLoadout` on player join, broadcasts `playerLoadout` messages. The freeze-during-race rule (§3.8) is enforced here. |
| **System #11 — Avatar Renderer** | Consumes the `loadout` map in `playerLoadout` broadcasts to composite layered sprites. Every entry in `LAYER_ORDER` corresponds to a slot defined here (§3.3). |
| **System #12 — Avatar / Customization** | The customization UI is a thin presentation layer over `getInventory` + the `/equip` API. Slot conflicts (§3.6) are surfaced through this UI. |
| **System #18 — Pickup System** | Race-time pickups that grant items go through `addItem` per the §3.9 acquisition contract. |
| **System #19 — Scoring System** | Race-end rewards (winning an item) call `addItem`. End-of-match grant flow follows §3.9. |
| **System #21 — Race UI** | Displays "you got X" notifications for newly-granted items. Reads from `getInventory` to identify items added since the race started. |
| **System #24 — Gacha System** | Highest-volume caller of `addItem`. Must implement the §3.9 idempotency obligation (request IDs, debit-then-grant ordering). Owns drop-rate tables (catalog `gachaWeight`). |
| **System #25 — Store System** | Calls `addItem` after coin debit. Owns price tables (catalog `storePriceCoins`). Surfaces seasonal items per `releaseSeason`. |
| **System #27 — Economy UI** | Renders the bag-style inventory panel during store browsing for "items I already own" greying. |
| **System #28 — Chat System** | Displays "X equipped Y" or "X received a legendary Z" social broadcasts (proposed). Reads from inventory events. |
| **System #34 — Furniture / Decoration** | Open question: are housing furniture items stored in the same `inventory` collection with a separate slot taxonomy, or in a parallel `house_inventory` collection? Decision deferred to that system's GDD; flagged here so the schema choice surfaces. |

### 6.3 Sibling references (no dependency, but related)

| System | Relationship |
|--------|------------|
| **System #09 — Currency** | Independent (currency is grant/spend on `players` doc, not inventory rows), but every store purchase couples them transactionally — see §3.9 caller obligations. |
| **System #22 — XP / Level System** | Independent today. Future "unlock items at level N" gating would couple them — capture as future work in the XP doc when it's written. |

### 6.4 Back-reference checklist

When the GDDs for the following systems are authored, they must include a
dependency-back reference to System #08:

- [ ] System #10 — Race Room (Colyseus)
- [ ] System #11 — Avatar Renderer (existing doc — needs a §Dependencies update)
- [ ] System #12 — Avatar / Customization
- [ ] System #18 — Pickup System
- [ ] System #19 — Scoring System
- [ ] System #21 — Race UI
- [ ] System #24 — Gacha System
- [ ] System #25 — Store System
- [ ] System #27 — Economy UI
- [ ] System #28 — Chat System
- [ ] System #34 — Furniture / Decoration

## 7. Tuning Knobs

Configurable values that designers can change without touching system
architecture. Each knob lists its current value, safe range, and the gameplay
aspect it tunes.

### 7.1 Starter item set

**Source:** `STARTER_ITEMS` in `src/server/src/db/mongo.ts:40`.

**Current:** `worn_tshirt`, `blue_jeans`, `beatup_sneakers` (all `common`).

**Safe range:** 0–6 starter items, all `common` rarity. Adding rare/epic
items here would devalue gacha pulls. Removing all starters means new
players spawn truly bare (see §5.9).

**Tunes:** new-player visual identity, perceived "starting kit" generosity,
rate at which players first feel the urge to acquire more items.

**Recommendation when revisiting:** decide whether starters auto-equip
(currently no — see §5.9). If yes, add an `autoEquip: true` field to each
starter entry.

### 7.2 Bag capacity (when premium tier ships)

**Source:** **[PLANNED]** — proposed default `base_capacity = 500` (see §4.3).

**Safe range:** 200–2000 base; up to 5000 with all premium upgrades.

**Tunes:** how often free players feel collection pressure, premium-tier
appeal, server query/payload size.

**Below 200:** punishes casual players, forces deletion of legacy items,
breaks the "bottomless wardrobe" fantasy from §2. Above 2000 base: removes
any reason to upgrade, weakens premium value proposition.

### 7.3 Slot conflict map

**Source:** `FACE_CONFLICTS` in `src/server/src/db/mongo.ts:47`.

**Current:** Only face/eyes/mouth conflicts (see §3.6).

**Safe range:** any number of additional symmetric conflict pairs. Each new
conflict reduces combinatorial outfit space — adding too many makes the
customization feel restrictive.

**Tunes:** visual coherence (preventing nonsense overlaps), creative freedom
(more conflicts = less freedom), perceived item value (a conflict-blocked
slot makes alternatives more valuable).

**Hard rule:** all conflicts must be declared symmetrically (see §3.6).
Asymmetric conflicts are exploitable.

### 7.4 Rarity color palette

**Source:** `RARITY_COLORS` in `src/client/src/IsoScene.ts:2017` (and
`LobbyScene.ts:1037` — keep in sync).

**Current:** Gray / Green / Blue / Purple / Gold / Magenta (per §3.4).

**Safe range:** any 6 distinct colors with sufficient contrast. Stick close
to MMO conventions (gray-green-blue-purple-gold) — players have a learned
visual vocabulary for rarity.

**Tunes:** rarity recognition speed, accessibility (color-blind players need
sufficient contrast or shape differentiation as fallback).

**Constraint:** `crazy` should remain visually distinct from `legendary`
even if the static fallback is similar. The animated/rainbow treatment is
the differentiator (per §3.4).

### 7.5 Inventory panel layout

**Source:** Hardcoded in `IsoScene.ts:2056-2299`.

**Knobs:**

- Equipment grid columns: currently **4**. Safe range 3–6.
- Bag grid columns: currently **5**. Safe range 4–8.
- Panel width: currently **620px**. Safe range 500–800.
- Panel max-height: currently **80vh**. Safe range 60–90vh.

**Tunes:** at-a-glance density, scroll frequency, mobile usability (narrower
panel = more scroll, wider = less fits on screen).

### 7.6 Loadout broadcast frequency

**Source:** Triggered by `refreshLoadout` message in `RaceRoom.ts:205` —
there's no rate limit today.

**Current:** broadcast on every successful equip/unequip API call.

**Safe range:** rate-limit to 1 broadcast per player per 500ms once player
counts grow. A spammy player toggling rapidly could cause N² broadcast
bursts. Rate-limiting at the room level (debounce per sessionId) is the
cleanest fix.

**Tunes:** server CPU under stress, perceived equip responsiveness (debounce
raises latency).

### 7.7 Inventory frozen during racing

**Source:** `IsoScene.ts:2049` — `if (this.currentPhase === RacePhase.Racing) return;`

**Current:** inventory button disabled during `RacePhase.Racing` only (open
during lobby and post-race phases).

**Safe range:** could narrow to "lobby only" (also disable post-race) if
mid-results outfit changes feel weird, or open to "all phases except active
racing" (current). Server-side enforcement is the **[GAP]** noted in §5.8.

**Tunes:** when players express their style, race-time focus, broadcast
traffic shape across phases.

## 8. Acceptance Criteria

Each criterion is a concrete, observable test a QA tester can execute.
Criteria are grouped by category. Format: **[ID]** Setup → Action → Expected.

### 8.1 Storage & schema

- **AC-INV-001** With a fresh account: open inventory → exactly 3 items
  appear (`worn_tshirt`, `blue_jeans`, `beatup_sneakers`), all marked
  unequipped, all `common` rarity.
- **AC-INV-002** Grant the same item twice via admin: open inventory → 2
  distinct rows appear with the same `itemId`, distinct `id`s.
- **AC-INV-003** Inventory query for a player with 1000+ items returns in
  under 200ms (single MongoDB roundtrip with `playerId` index).

### 8.2 Equip / unequip

- **AC-INV-010** Equip an item in `upper_body` → DB shows exactly 1 inventory
  row with `itemType: "upper_body"`, `equipped: true` for that player.
- **AC-INV-011** Equip a second item in `upper_body` → first item's row now
  has `equipped: false`; second item's row has `equipped: true`. Cardinality
  remains 1.
- **AC-INV-012** Unequip an equipped item → row updates to `equipped: false`.
  Cardinality for that slot becomes 0.
- **AC-INV-013** Equip an item using another player's `inventoryItemId` →
  API returns 400 "could not equip item." No DB rows change for either
  player.
- **AC-INV-014** Equip an item with a non-existent `inventoryItemId` → API
  returns 400. No DB rows change.

### 8.3 Slot conflicts

- **AC-INV-020** Equip `eyes_accessory` then `face_accessory` → after the
  second equip, `eyes_accessory` row has `equipped: false`, `face_accessory`
  row has `equipped: true`.
- **AC-INV-021** Equip `mouth_accessory` then `face_accessory` → mouth is
  unequipped, face is equipped.
- **AC-INV-022** Equip `face_accessory` then `eyes_accessory` → face is
  unequipped, eyes is equipped.
- **AC-INV-023** Equip `face_accessory` then `mouth_accessory` → face is
  unequipped, mouth is equipped.
- **AC-INV-024** With both `eyes_accessory` AND `mouth_accessory` equipped,
  equip `face_accessory` → both eyes and mouth unequipped, only face
  equipped.

### 8.4 Loadout cache (`equippedLoadout`)

- **AC-INV-030** After any equip operation, `players.equippedLoadout`
  reflects the current `equipped: true` rows from inventory exactly
  (cardinality + key/value match per §4.2).
- **AC-INV-031** After any unequip operation that modified a row, the cache
  reflects the change.
- **AC-INV-032** With nothing equipped: `players.equippedLoadout = {}`
  (empty object, not `null` or absent).
- **AC-INV-033** `getLoadout(userId)` returns the cached map without
  touching the inventory collection (verified via query log).

### 8.5 Multiplayer broadcast

- **AC-INV-040** Player A joins a race room with player B already present →
  A receives a `playerLoadout` message for B's loadout within 1 second of
  join.
- **AC-INV-041** Player A equips an item, then sends `refreshLoadout` → all
  clients in the room (including A) receive a `playerLoadout` message with
  A's updated loadout within 500ms.
- **AC-INV-042** During `RacePhase.Racing`, player A sends `refreshLoadout`
  → server still rebroadcasts (current behavior). **[GAP — see §5.8]**
  future test: server should reject mid-race refreshes.
- **AC-INV-043** Player leaves the room → `playerLoadouts` map no longer
  contains their `sessionId`.

### 8.6 UI

- **AC-INV-050** Press `I` in the lobby → inventory panel opens. Press `I`
  again → panel closes.
- **AC-INV-051** During `RacePhase.Racing`, press `I` or click inventory
  button → nothing happens (panel does not open).
- **AC-INV-052** Equipment grid shows 12 slot tiles in the order defined by
  `SLOT_META`. Empty slots show the slot's icon at 30% opacity. Equipped
  slots show the item ID + rarity-colored border.
- **AC-INV-053** Bag grid shows all owned items. Equipped items have a
  yellow "EQUIPPED" tag. Border color matches rarity.
- **AC-INV-054** Click an item in the bag → equips/unequips it (toggle
  direction based on current state). Panel re-renders within 300ms with the
  new state.
- **AC-INV-055** Click an equipped slot in the equipment grid → unequips
  the item.
- **AC-INV-056** Character preview canvas in the panel updates immediately
  to reflect the new loadout after any equip/unequip.

### 8.7 Acquisition contract

- **AC-INV-060** Calling `addItem(userId, slot, itemId, rarity)` with valid
  args → returns the new inventory row, row is immediately visible in
  `getInventory(userId)`, row has `equipped: false`.
- **AC-INV-061** Calling `addItem` for a non-existent `userId` → returns
  `null`. No DB writes.
- **AC-INV-062** **[PLANNED]** Calling `addItem` with an `itemId` not in
  the catalog → returns `null` and logs a warning. (Pending catalog
  migration §3.1.)
- **AC-INV-063** Granted items persist across server restart and player
  logout.

### 8.8 Catalog (when shipped)

- **AC-INV-070** **[PLANNED]** Every `itemId` in any inventory row has a
  corresponding catalog entry.
- **AC-INV-071** **[PLANNED]** Setting a catalog entry to `retired: true`
  does not change any existing inventory rows.
- **AC-INV-072** **[PLANNED]** Attempting to add a `retired: true` item via
  `addItem` is rejected.

### 8.9 Invariant audit (operations)

Run periodically as a health check:

- **AC-INV-080** For every player, no slot has more than 1 inventory row
  with `equipped: true` (cardinality invariant §4.1).
- **AC-INV-081** For every player, the `equippedLoadout` map exactly
  matches the set of `equipped: true` inventory rows (consistency invariant
  §4.2).
- **AC-INV-082** Violations of either invariant are logged and surface in
  the admin dashboard.
