---
status: reverse-documented
source: src/server/src/rooms/RaceRoom.ts, src/shared/terrain.ts (room-relevant constants only)
date: 2026-04-26
verified-by: Gabriel
---

# System #10 — Race Room (Colyseus)

> **Scope note:** this GDD covers the **room itself** — its lifecycle, slot
> management, race-phase state machine, broadcast protocol, message contract,
> server-authoritative model, disconnect handling, and procedural map seeding.
> Gameplay subsystems that live inside the room have their own GDDs and define
> their own rules:
>
> - **System #07** — Player Movement (8-direction movement, sprint, stamina, jump)
> - **System #15** — Terrain System (Slow / Slide / Crumble / Hole / Wall tiles)
> - **System #17** — Button / Trap System (interactive map elements)
> - **System #18** — Pickup System (Speed, Shield, Slime, Knockback)
> - **System #19** — Scoring System (position points, bonuses, XP/coin awards)
>
> This document defines the **contract** those subsystems must follow when
> running inside a `RaceRoom`.

> **Note:** This document was reverse-engineered from the existing
> implementation. It captures current behavior plus design intent clarified
> with the project lead. Sections marked **[PLANNED]** describe target state
> not yet implemented; **[OPTIONAL FUTURE]** marks improvements that should
> be triggered by a specific condition.

## 1. Overview

The Race Room is the authoritative game container for a single match of Crazy
Stuff. Built on Colyseus, it owns one match's worth of state — five player
slots, a procedurally-generated 180×30 tile course, a phase machine that
drives the match through `Waiting → Countdown → Racing → Finished → Waiting`,
and the broadcast protocol that keeps every client's view of the match in
sync with the server's truth. A room is created when the first player
connects, lives for one match (plus an optional rematch loop), and disposes
itself when empty.

The room is **server-authoritative** — clients send intent (move direction,
use pickup, jump, vote), and the server validates, applies, and broadcasts.
Clients never write directly to game state. This protects against cheating
(modified clients, packet replay, position spoofing) and makes the room the
single source of truth for everything that happens during a match: who moved
where, who picked what up, who finished in what position. All gameplay
subsystems — movement, terrain effects, pickups, buttons, scoring — operate
**inside** this container and consume its broadcast protocol.

The room is also the bridge between transient match state and the persistent
world. It reads each joining player's equipped loadout from the inventory
system (System #08), broadcasts it to all clients so everyone sees everyone's
outfit, and at match-end writes XP and coins back to the player's account via
the scoring system (#19). Between those two points, every keystroke, every
tile change, every pickup activation passes through this single room
instance — making it the highest-leverage component of the entire
multiplayer stack and a critical reliability surface.

## 2. Player Fantasy

Players don't see the Race Room. They see a fast, fair, chaotic match where
everyone shows up, the race starts, weird stuff happens, and someone wins.
The room's job is to make that experience feel **trustworthy and instant**
— the things players notice when this system works are the things they don't
notice.

When five players join, the countdown starts at the same moment for everyone.
The "GO!" lands at the same instant on every screen. When someone picks up a
pickup, every other player sees the pickup vanish on the same frame. When
two players collide, both screens show the same push direction. When the
leader crosses the finish line, every other player sees the 10-second finish
timer start at the same moment. When the race ends, results appear in the
same order with the same scores on every screen. There are no "wait, my
screen showed me winning" arguments — the server's word is final, and the
server tells the same story to every client.

Players also feel the room's **forgiveness**. If their connection hiccups,
their character doesn't teleport or rubber-band — the next broadcast just
updates the position smoothly. If the lobby fills mid-countdown, latecomers
join in time for the start without breaking flow. If someone rage-quits, the
race continues without them; survivors finish and claim their reward. If the
match ends and everyone wants another round, a single tap of "rematch" rolls
a fresh map and starts the countdown again — same crew, new chaos.

Behind all of this is a quiet promise: **what you see is what actually
happened**. No one can hack their way to a faster speed, no one can teleport
to the finish, no one can swap outfits mid-race to disrupt visuals. The game
is fair, and the system enforces fairness invisibly. That trust is the
foundation everything else builds on.

## 3. Detailed Rules

### 3.1 Room Lifecycle (Colyseus)

A `RaceRoom` instance follows the standard Colyseus lifecycle, with three
additional concerns layered on top: map generation, per-player state setup,
and equipment-loadout integration.

#### Lifecycle stages

| Stage | Trigger | What happens |
|-------|---------|--------------|
| **Creation** | First client requests a `'race'` room (Colyseus matchmaker creates one) | `onCreate()`: instantiate `RaceState`, generate procedural map, register message handlers |
| **Population** | Each client joins | `onJoin(client, options)`: assign slot, store auth ID, send `mapData`, fetch loadout, broadcast state |
| **Active match** | Triggered by `checkStartCondition` when ≥ `MIN_PLAYERS_TO_START` players join | Phase machine drives the match (see §3.3) |
| **Player departure** | Client disconnects or calls `leave()` | `onLeave(client)`: free slot, clean up timers, broadcast state, possibly cancel countdown or end race |
| **Disposal** | Last client leaves | `onDispose()`: clear all timers, log shutdown |

#### Room registration (`src/server/src/index.ts:112`)

```ts
gameServer.define('race', RaceRoom);
```

Rooms are matched by name `'race'`. Colyseus matchmaker creates a new
instance when the first client requests it and routes subsequent clients to
the same instance until it reaches `maxClients = 5` or is disposed.

#### `onCreate()` responsibilities (`RaceRoom.ts:183`)

1. Instantiate `RaceState` schema with 5 empty `PlayerSlot` entries.
2. Call `generateMap()` — produces a fresh procedural terrain grid, button
   definitions, and pickup spawn points.
3. Register message handlers: `move`, `usePickup`, `jump`, `rematchVote`,
   `refreshLoadout`. (See §3.5 for the contract.)
4. Log creation with map stats.

#### `onJoin(client, options)` responsibilities (`RaceRoom.ts:225`)

Options shape: `{ playerName?: string, authId?: string }`.

1. **Duplicate-session check:** if `options.authId` matches an existing room
   member, kick the new client with `'error'` message
   `"Already in this room from another tab"` (§3.7).
2. **Slot assignment:** find first unoccupied slot; abort with
   `client.leave()` if none.
3. **Spawn position:** `tileX = SPAWN_X (2)`,
   `tileY = SPAWN_Y - 4 + slotIndex * 2` — five spawn rows spaced 2 tiles
   apart.
4. **Sanitize player name:** strip non-alphanumeric chars, max 20 chars,
   fallback to `'Player'`.
5. **Initialize per-player state:** create `PlayerState` with full stamina,
   default cooldown, no pickup held, etc.
6. **Send map data** to the new client only:
   `client.send('mapData', { map, buttons, pickups })`.
7. **Broadcast state** to all clients (so existing players see the new slot
   occupied).
8. **Fetch loadout** asynchronously and broadcast it (non-blocking — see
   System #08 §3.8).
9. **Check start condition** — if room now has ≥ 2 players in `Waiting`
   phase, start the countdown.

#### `onLeave(client)` responsibilities (`RaceRoom.ts:275`)

1. Find the slot owned by this `sessionId`; abort if none.
2. **Reset slot fields:** blank `sessionId`, `playerName`; restore default
   `tileX/Y`; set `occupied = false`.
3. **Clean up timers** for this player (hole respawn, penalty, speed boost,
   knockback slow).
4. **Drop maps** keyed by sessionId: `players`, `lastDirection`,
   `playerLoadouts`.
5. **Broadcast state** so other clients see the slot empty.
6. **Phase-aware reactions:**
   - In `Countdown` with player count below threshold → `cancelCountdown()`
     (back to `Waiting`).
   - In `Racing` with finish countdown active → `checkAllFinished()` (other
     players might now all be finished).
   - In `Finished` during rematch vote → recompute majority, reset if
     threshold now met.

#### `onDispose()` responsibilities (`RaceRoom.ts:312`)

Cleanup, idempotent:

1. Clear `countdownTimer`, `finishCountdownTimer`, `rematchTimer`.
2. Clear all `crumbleTimers`.
3. Clear all `activeEffects` (button revert timers).
4. Clear all `slimeZones` timers.
5. Clear per-player timers via `clearPlayerTimers` for every remaining
   session (defensive — should be empty).
6. Log disposal.

The room becomes eligible for disposal when the last client leaves. Colyseus
handles the actual destruction.

### 3.2 Slot System

The room has **5 fixed slots**. Slots are the stable identity for a player
within the room — every cross-player reference (loadout broadcast, finish
position, scoring result) keys by `slotIndex`, not by `sessionId`. This
decouples player identity from the underlying transport (sessions can
disconnect/reconnect, slot indexes don't).

#### Schema

```ts
class PlayerSlot extends Schema {
  @type('string')  sessionId  = '';
  @type('string')  playerName = '';
  @type('number')  tileX      = SPAWN_X;
  @type('number')  tileY      = SPAWN_Y;
  @type('boolean') occupied   = false;
}

class RaceState extends Schema {
  @type([PlayerSlot]) slots = new ArraySchema<PlayerSlot>(
    new PlayerSlot(), new PlayerSlot(), new PlayerSlot(),
    new PlayerSlot(), new PlayerSlot(),
  );
}
```

Source: `RaceRoom.ts:24-37`. The 5 entries are pre-allocated at room creation
and **never grow or shrink** — player joins/leaves toggle `occupied` and
overwrite fields, but the array stays length 5.

#### Slot allocation rules

| Rule | Behavior |
|------|----------|
| **First-fit** | Joining player gets the lowest-index unoccupied slot. |
| **Stable index** | A slot keeps its index for the room's entire lifetime. Slot 2 is always slot 2, even if its occupant changes. |
| **No reservation** | Slots are not pre-assigned by matchmaking. Whoever connects first gets slot 0. |
| **No re-shuffling** | When a player leaves, slots after them do **not** shift down. Slot 3 leaving leaves slot 3 empty; slot 4 stays at index 4. |
| **Hard cap of 5** | `maxClients = 5`. Colyseus refuses additional joins. |

#### Spawn-row mapping

Slot index → spawn Y coordinate:

```
spawnY = SPAWN_Y - 4 + slotIndex * 2
```

| Slot | tileX | tileY |
|------|-------|-------|
| 0 | 2 | 10 |
| 1 | 2 | 12 |
| 2 | 2 | 14 |
| 3 | 2 | 16 |
| 4 | 2 | 18 |

Five horizontal rows spaced 2 tiles apart, centered around `SPAWN_Y = 14`.
The 2-tile gap prevents collision pushes during the countdown; the centered
layout means slot 2 is always the middle starter.

Source: `RaceRoom.ts:241`. Same mapping is reused on `resetRace`
(`RaceRoom.ts:518`).

#### Why slot indexes (not sessionIds) for cross-references

Three downstream systems key by slot index:

1. **Loadout broadcast** (System #08 §3.8) — `playerLoadout` messages carry
   `slotIndex` so the client can update the right avatar. SessionIds are
   opaque UUIDs not displayed in UI; slot indexes are stable, predictable,
   and visible.
2. **Visual identity** (avatars, name labels) — clients build an avatar per
   slot, not per session. When a slot's occupant changes mid-room (rare;
   would only happen post-leave + post-join), the avatar's identity is the
   slot.
3. **Finish positions and results** — `finishOrder[]` and `RaceResult` use
   `sessionId` internally for the same-room match, but the client renders
   them by looking up the slot to find the avatar.

#### Slot lifecycle invariants

- **Cardinality:** `slots.length === 5` always. Never grows, never shrinks.
- **Occupied count ≤ 5:** `slots.filter(s => s.occupied).length ≤ 5`.
- **Occupied ⇔ session present:** if `slot.occupied === true`, then
  `players.has(slot.sessionId)` and there's an active Colyseus client with
  that sessionId. After `onLeave`, the slot is reset before the broadcast
  goes out.
- **No duplicate sessions:** at most one slot per `sessionId`. Enforced by
  the duplicate-session check in `onJoin` (§3.7).

### 3.3 Race Phase State Machine

The room moves through 4 phases in a deterministic cycle. The phase value is
broadcast in every `state` message so clients can reactively change UI
(countdown banner, race HUD, results screen).

#### Phase enum (`src/shared/terrain.ts:8`)

```ts
export const RacePhase = {
  Waiting:   0,
  Countdown: 1,
  Racing:    2,
  Finished:  3,
} as const;
```

#### State diagram

```
            players ≥ 2                 timer = 0
  Waiting ─────────────────► Countdown ─────────► Racing
     ▲                          │                    │
     │ players < 2              │ players < 2        │ all finished OR
     │ (cancelCountdown)        │                    │ finish countdown = 0
     │                          ▼                    │
     │                       Waiting                 ▼
     │                                            Finished
     │                                               │
     │           rematch majority OR                 │
     └───────────── 15s timeout ─────────────────────┘
                   (resetRace)
```

#### Phase definitions

**`Waiting` (0)**

- Initial state on room creation, also state after a cancelled countdown or
  after a rematch reset.
- Players can join freely (slots permitting). No gameplay actions accepted.
- **Exit:** `checkStartCondition()` is called after every `onJoin`. If
  `occupiedCount() ≥ MIN_PLAYERS_TO_START (2)`, transitions to `Countdown`.

**`Countdown` (1)**

- Pre-race timer. `countdown` field starts at `COUNTDOWN_SECONDS = 3` and
  decrements once per second via `countdownTimer` (`setInterval`).
- Each tick triggers a `broadcastState()` so clients see the countdown
  number update.
- **Movement disabled** — all `move`/`jump`/`usePickup` messages are no-ops
  because `phase !== RacePhase.Racing`.
- **Exit (success):** `countdown` reaches 0 → `beginRace()` → transitions
  to `Racing`.
- **Exit (cancel):** if `onLeave` drops occupancy below
  `MIN_PLAYERS_TO_START`, `cancelCountdown()` clears the timer and
  transitions back to `Waiting`.

**`Racing` (2)**

- Active match. All gameplay messages accepted (`move`, `jump`, `usePickup`).
- `startTime = Date.now()` captured at entry (used to compute finish times).
- **Finish line detection:** every successful move calls `checkFinishLine`.
  First player to cross triggers `startFinishCountdown()` (`finishCountdown`
  starts at `FINISH_COUNTDOWN_SECONDS = 10`).
- **Exit conditions** (whichever happens first):
  - All occupied players have `finished: true` → `endRace()`.
  - `finishCountdown` reaches 0 → `endRace()`.
- Either path transitions to `Finished`.

**`Finished` (3)**

- Post-race results window. `raceResults` broadcast carries the full
  `RaceResult[]` (positions, times, scores).
- **Rematch vote opens:** 15-second window (`REMATCH_VOTE_TIMEOUT_MS`).
  Players send `rematchVote` to opt in.
- **Award flow:** authenticated players have XP/coins written to MongoDB via
  `awardPostRace` (System #19). Async, non-blocking.
- **Exit conditions:**
  - Rematch votes ≥ majority (`floor(count/2) + 1`) → `resetRace()`
    immediately.
  - 15s timeout reached → `resetRace()` automatically.
- Either path: regenerate map, reset all per-player state, transition to
  `Waiting` (which immediately re-evaluates start condition for the
  still-present players).

#### Phase-aware message handling

Every message handler that mutates gameplay state guards on phase:

```ts
if (this.phase !== RacePhase.Racing) return;
```

This is the single line that keeps movement, pickups, and jumps from firing
during pre-race and post-race phases. The exception is `rematchVote`, which
guards on `phase !== RacePhase.Finished` instead.

#### Timers

| Timer | Set in | Cleared in |
|-------|--------|------------|
| `countdownTimer` | `startCountdown()` | When countdown reaches 0, in `cancelCountdown()`, in `onDispose()` |
| `finishCountdownTimer` | `startFinishCountdown()` | When countdown reaches 0, in `endRace()`, in `onDispose()` |
| `rematchTimer` | `startRematchVoteTimer()` | When majority reached, when fired (auto-reset), in `onDispose()` |

All three are tracked as instance fields so they can be safely cleared on
disposal or phase change.

#### Phase persistence

The phase is **not persisted** anywhere. A server crash mid-match means the
room is gone — clients will be disconnected and must re-queue. This is
acceptable for short matches (typical match length ~2 minutes); longer-running
game modes would need phase persistence to a shared store (Redis is the
planned answer — see System #05).

### 3.4 State Broadcast Protocol

All live match state is delivered to clients via the `state` broadcast — a
single JSON message sent to all connected clients via Colyseus's
`broadcast()` API. This bypasses Colyseus schema delta sync entirely; the
schema (§3.2) exists for room introspection and the join handshake but is
not the active sync mechanism.

#### Why JSON broadcast over schema delta sync

Colyseus offers two ways to keep clients in sync:

1. **Schema delta sync** (decorated `@type` fields auto-replicate as compact
   binary deltas).
2. **Manual broadcast** (`this.broadcast(messageType, payload)` — full
   payload as JSON).

RaceRoom uses #2 as the canonical pattern. The reasons:

- **Per-player effect state** (cooldowns, stamina, immunity, held pickup,
  sprint, knockback slow, etc.) is managed in plain JS in the `PlayerState`
  interface and would need to be re-implemented as schema fields. Keeping it
  as a JSON broadcast avoids the dual-source-of-truth trap.
- **Bandwidth is not a constraint at 5 players.** Each `state` message is a
  few hundred bytes; even at 10 broadcasts/sec per room (rare) that's ~5 KB/s
  — negligible for a browser game.
- **Debuggability:** JSON payloads are inspectable in browser devtools and
  server logs without a schema decoder. Easier to reason about during
  development.

**[OPTIONAL FUTURE]** if/when player counts per room scale beyond 8-10, or if
the room broadcasts grow significantly (more per-player fields), migrate hot
fields to schema delta sync. The trigger condition: bandwidth measurements
show > 50 KB/s per room sustained.

#### `broadcastState()` shape (`RaceRoom.ts:1095`)

```ts
{
  type: 'state',
  phase: number,                    // RacePhase enum value
  countdown: number,                // 3..0 during Countdown phase, else 0
  finishCountdown: number,          // 10..0 after first finisher, else 0
  startTime: number,                // Date.now() at race start, else 0
  slots: [
    {
      sessionId: string,
      playerName: string,
      tileX: number,
      tileY: number,
      occupied: boolean,
      frozen: boolean,              // true while in hole-respawn timer
      penalized: boolean,           // post-hole movement penalty active
      boosted: false,               // legacy field — boost terrain removed
      finished: boolean,            // crossed finish line
      currentTerrain: number,       // Terrain enum value at current tile
      heldPickup: number | null,    // PickupType value or null
      shieldActive: boolean,
      speedBoosted: boolean,        // computed: speedBoostUntil > now
      stuck: boolean,               // computed: stuckUntil > now
      knockbackSlowed: boolean,     // computed: knockbackSlowUntil > now
      stamina: number,              // 0..100
      sprinting: boolean,
      immune: boolean,              // post-respawn invincibility
    },
    // ...always 5 entries (matches slot array length)
  ]
}
```

Always 5 slot entries, even if some are unoccupied. Unoccupied slots have
empty/default values (`occupied: false`, `playerName: ''`, etc.).

#### Trigger points

`broadcastState()` is called after every state-mutating server action:

- Player join / leave
- Phase change (countdown start/cancel, race begin, race end)
- Movement that successfully changes position
- Jump that successfully lands
- Player push (collision)
- Pickup collection
- Pickup activation (each effect-application path)
- Hole respawn (timer-fired)
- Knockback push
- Knockback slow expiration
- Slime stuck application
- Button activation and reversion
- Crumble tile transition
- Finish-line crossing
- Rematch reset

No fixed tick / interval — broadcasts are entirely event-driven. Movement
cooldowns (50-450ms) naturally throttle the rate.

#### Coalescing **[PLANNED]**

Today, multiple state changes within the same JS macrotask each trigger a
separate broadcast. A knockback affecting 4 players would emit 4-5
broadcasts in immediate succession.

**[PLANNED]** Coalesce broadcasts within a 16ms window: replace direct
`broadcastState()` calls with a `dirtyFlag` toggle, flush once per
`setImmediate` or animation-frame-equivalent. This collapses bursty
multi-effect events into a single message and reduces bandwidth without
sacrificing responsiveness (16ms is below human perception threshold).

#### Auxiliary broadcasts

Some events ride on their own message channel rather than the `state`
broadcast — used for client-side animation triggers and one-shot
notifications:

| Message | Payload | Purpose |
|---------|---------|---------|
| `mapData` | `{ map, buttons, pickups }` | Sent only to joining client. Initial terrain load. |
| `terrainReset` | `{ map, buttons, pickups }` | Broadcast on rematch — clients regenerate visual terrain. |
| `terrainChange` | `{ tileX, tileY, terrain }` | Single tile flip (e.g., crumble → hole). |
| `terrainChangeBatch` | `[{ tileX, tileY, terrain }, ...]` | Multi-tile batch (e.g., button effect rectangle). |
| `crumbleWarning` | `{ tileX, tileY }` | Client plays warning animation before tile crumbles. |
| `playerJumped` | `{ sessionId }` | Client triggers jump VFX. |
| `playerPushed` | `{ sessionId, pusherId, x, y }` | Client triggers push animation. |
| `playerStuck` | `{ sessionId }` | Client shows slime-stuck VFX. |
| `playerFinished` | `{ playerName, position, timeSeconds }` | Client shows "X finished Yth" toast. |
| `pickupCollected` | `{ id, sessionId }` | Client removes pickup from map. |
| `pickupUsed` | `{ sessionId, type }` | Client triggers pickup-activation VFX. |
| `slimePlaced` | `{ x, y, size, ownerId }` | Client renders slime zone. |
| `slimeExpired` | `{ x, y }` | Client removes slime zone. |
| `knockbackBlast` | `{ x, y }` | Client triggers shockwave VFX. |
| `shieldUsed` | `{ sessionId }` | Client shows shield-break VFX. |
| `buttonActivated` | `{ id, type }` | Client triggers button-press animation. |
| `buttonReverted` | `{ id }` | Client reverts button visual. |
| `raceResults` | `{ results: RaceResult[] }` | Sent on race end. |
| `rematchVoteUpdate` | `{ votes, needed }` | Live vote-count update during rematch window. |
| `playerLoadout` | `{ slotIndex, charKey, loadout }` | Equipment broadcast (System #08 §3.8). |
| `error` | `{ message }` | Sent only to specific client (e.g., duplicate session kick). |

The split keeps the `state` broadcast focused on continuous state and lets
one-shot events ride lightweight messages without bloating the main payload.

### 3.5 Client → Server Message Contract

Clients send 5 message types to the room. Each carries minimal payload — the
server validates everything and rejects invalid input by silently ignoring
it. There is no "command failed" reply by design — the client trusts the
next `state` broadcast as ground truth.

| Message | Payload | When client sends | Server validates |
|---------|---------|-------------------|-------------------|
| `move` | `{ direction: string, sprint?: boolean }` OR a bare string for legacy | Player presses WASD (single key for diagonals, key combos for cardinals); `sprint: true` when `Shift` is held | Phase = Racing, slot exists, player not finished/frozen/stuck, direction key valid, cooldown elapsed (with priority logic), stamina sufficient if sprint, target tile not wall, not occupied (else push) |
| `jump` | (no payload) | Player presses `Space` | Phase = Racing, player not finished/frozen/stuck, jump cooldown elapsed (1500ms), last direction set, target landing tile reachable |
| `usePickup` | (no payload) | Player presses `E` | Phase = Racing, player not finished/frozen, has a held pickup (`heldPickup !== null`) |
| `rematchVote` | (no payload) | Player clicks "Rematch" button on results screen | Phase = Finished, sessionId not already in `rematchVotes` set (idempotent re-add is harmless) |
| `refreshLoadout` | (no payload) | Client successfully equipped/unequipped via inventory API | `authIds` map has this sessionId (so guest sessions can't trigger DB reads) |

#### Control bindings (client-side)

Source: `IsoScene.ts:1095-1109`. Bindings are hardcoded in the client; the
server only sees the resulting message payloads.

| Key(s) | Action |
|--------|--------|
| `W` / `A` / `S` / `D` (single) | Move in one of 4 isometric diagonals |
| `W+D` / `W+A` / `S+D` / `S+A` (combo) | Move in one of 4 cardinals |
| `Shift` (held while moving) | Sprint — sends `sprint: true` with the move message |
| `Space` | Jump (3-tile leap in last facing direction) |
| `E` | Use held pickup |
| `I` | Toggle inventory panel (client-only, no message) |

#### Direction key vocabulary (`move`)

Single-key directions (4 diagonals — natural for isometric):

| Key | dx | dy | Direction (isometric) |
|-----|-----|-----|----------------------|
| `W` | -1 | -1 | Up-left (north-west) |
| `S` |  1 |  1 | Down-right (south-east) |
| `A` | -1 |  1 | Down-left (south-west) |
| `D` |  1 | -1 | Up-right (north-east) |

Two-key combos (4 cardinals — combine adjacent diagonals):

| Combo | dx | dy | Direction |
|-------|-----|-----|-----------|
| `WD` | 0 | -1 | Up (north) |
| `WA` | -1 | 0 | Left (west) |
| `SD` | 1 | 0 | Right (east) |
| `SA` | 0 | 1 | Down (south) |

Source: `MOVE_DELTAS` in `RaceRoom.ts:42`. Any other key string in
`move.direction` is silently ignored.

#### Why no error replies

The server intentionally does not respond to invalid messages with a
`{ ok: false, reason: ... }` reply. Three reasons:

1. **Cheat suppression:** an attacker probing for accepted/rejected messages
   gets less information without per-message replies.
2. **Bandwidth:** a chatty client (every keypress) would double its message
   count if every move got an ack.
3. **Truth source:** clients should treat the next `state` broadcast as
   ground truth. If the move was rejected, the position simply doesn't
   change — no special handling needed in the client.

The single exception is `error` (server → client) for fatal join-time issues
like duplicate session kicks (§3.7).

### 3.6 Server → Client Message Contract

Cataloged in §3.4 (Auxiliary broadcasts table). This sub-section formalizes
the **delivery semantics**, **ordering guarantees**, and **client
obligations** for those messages.

#### Delivery semantics

All messages ride Colyseus's underlying WebSocket transport. Per Colyseus
defaults:

- **Reliable, ordered.** Messages are delivered in the order the server sent
  them. No drops in normal operation.
- **At-least-once.** Reconnect/recover scenarios can re-deliver messages —
  clients should be idempotent where it matters (see below).
- **Per-room broadcast.** All messages stay scoped to the originating room
  — no cross-room leakage.

#### Ordering guarantees the room provides

1. **`state` after every mutation.** A given mutation's effect is visible in
   the next `state` message after the mutation, never before any auxiliary
   message that describes the same event.
2. **Auxiliary before state for VFX-tied events.** When an event has a
   visual cue (jump VFX, push animation, slime placement), the auxiliary
   message (`playerJumped`, `playerPushed`, `slimePlaced`) is sent
   **before** the `state` broadcast that reflects the resulting position.
   This lets the client schedule the animation to the new state.
3. **`raceResults` precedes the `Finished` `state`.** On race end, results
   are broadcast before the phase-transition state. Clients can populate
   the results UI before the phase flip triggers UI mode change.

#### Client obligations

Clients consuming the broadcast must:

1. **Treat `state` as truth.** Never apply movement locally first; only
   update visual position from `state.slots[i].tileX/Y`.
2. **Interpolate between broadcasts** for smooth visuals. The server sends
   discrete tile positions; the client tweens over the move-cooldown
   duration.
3. **Handle missing slot data gracefully.** A slot might be `occupied: false`
   for several broadcasts during a leave; the avatar should fade/destroy,
   not crash.
4. **Be idempotent on auxiliary events.** If `pickupCollected` arrives twice
   (network resend), the second one is a no-op — the pickup is already
   removed from the visual layer.
5. **Respect the `error` message.** Display the contained message and
   disconnect; do not attempt to recover.

#### Replay & late join

Two cases where clients receive multiple state-bearing messages on connect:

1. **Initial join:** new client receives `mapData` (one-time terrain), then
   the next `state` broadcast carries the full slot snapshot.
2. **Loadout backfill:** after the new player's loadout is fetched and
   broadcast, the server sends the **existing** players' cached loadouts as
   individual `playerLoadout` messages (only to the new client). Clients
   must accept multiple `playerLoadout` messages on join.

No replay of historical events. A late-joining client gets present state
only — they don't see what happened before they joined.

### 3.7 Server-Authoritative Model & Anti-Cheat

Every gameplay decision lives on the server. The client is a presentation
layer — it sends intent, displays state, and triggers cosmetic VFX. It
cannot **directly modify** any field that affects gameplay outcomes.

#### What the client cannot do

| Forbidden capability | Why it can't | What stops it |
|---------------------|--------------|---------------|
| Set its own position | Server controls `slot.tileX/Y` | `move` only accepts a direction key; server computes the new position |
| Skip movement cooldowns | Server tracks `lastMoveTime` and applies cooldowns by priority | Cooldown check in `handleMove` rejects fast-spammed moves |
| Increase its own stamina | Server tracks `stamina` per session | No client message touches stamina; it regens server-side based on time |
| Pick up a pickup remotely | Server checks proximity (within 1 tile) to pickup before granting | `checkPickupCollection` runs per-move on the server |
| Activate buttons remotely | Server checks proximity (within 1 tile) to button | `tryActivateButton` runs per-move on the server |
| Spoof a finish-line crossing | Server checks `tileX >= FINISH_X` after each move | `checkFinishLine` runs per-move on the server |
| Vote rematch as someone else | `rematchVotes` keyed by client's own `sessionId` | Handler reads `sessionId` from Colyseus client object, not from payload |
| Equip an item it doesn't own | Inventory equip API has its own ownership check (System #08 §3.5) | `playerId` filter on the DB query |
| Pretend to be someone else | Server uses Colyseus's per-client `sessionId` (cryptographic, server-issued) | Client cannot forge sessionId |

#### What the client *can* control

- Visual representation (avatar position interpolation, animation choice,
  particle effects)
- Local UI state (open/close menus, sound preferences, camera angle)
- The contents of the `move.direction` payload — but only valid keys move
  the player
- Frequency of `move` messages — but cooldowns throttle effect server-side

#### Identity & authentication

- **`sessionId`** — Colyseus-issued, server-side, used as the in-room player
  identity. Cannot be forged.
- **`authId`** — provided by client at join time as part of `options.authId`.
  Comes from the client's logged-in JWT session (see Auth System #03). Used
  to:
  - Prevent duplicate sessions (`authId` already in room → kick).
  - Identify which player to award XP/coins to at race end.
  - Look up the player's equipped loadout.

The duplicate-session check (`onJoin` step 1) protects against multi-tab
abuse and accidental zombie sessions — only one `RaceRoom` slot per `authId`
at a time.

#### Input sanitization

All client-supplied strings pass through sanitization at the boundary:

```ts
// Player name (in onJoin)
const rawName = (options?.playerName ?? 'Player').replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 20).trim();
slot.playerName = rawName || 'Player';
```

Strips non-alphanumeric chars, caps at 20 chars, falls back to `'Player'` on
empty. This is the single line of defense against XSS or malicious display
names — every system that renders `playerName` (chat, results, hover labels)
trusts this string.

#### Movement validation pipeline (`handleMove`)

Each step rejects invalid moves silently. Order matters — early rejection
costs less:

1. **Phase check:** `phase === Racing` else return.
2. **Slot/state lookup:** abort if missing or finished.
3. **Direction validity:** `MOVE_DELTAS[direction]` exists; not frozen.
4. **Status checks:** not stuck (slime).
5. **Cooldown:** elapsed time vs active cooldown (priority: speed pickup >
   sprint > knockback slow > penalty > terrain).
6. **Boost charges:** consume one if available, else enforce cooldown.
7. **Stamina:** drain if sprinting; reject if insufficient.
8. **Bounds clamp:** clamp `newX/Y` to grid limits.
9. **No-op check:** `newX === slot.tileX && newY === slot.tileY` (e.g.,
   direction blocked by edge) → return.
10. **Wall check:** target tile is not `Terrain.Wall`.
11. **Player collision:** if blocked by another slot → push the blocker, but
    proceed.
12. **Apply position, save lastSafe, run terrain/button/pickup/finish hooks.**
13. **Broadcast state.**

Each step is a hard gate. A move that fails any step has zero effect on the
world.

#### What's NOT validated yet **[GAP]**

- **Rate limiting per session.** A misbehaving client could spam
  `usePickup`/`jump`/`rematchVote` faster than 60Hz. Today these messages
  are ignored if state doesn't allow them, but the message handler still
  runs (cheap ignore, but not free).
- **Move-message coalescing on send.** A client that fires `move` 1000x/sec
  would have 999 ignored, but each costs a function call.
- **Server-side rejection of mid-race equip-API calls** (already noted as a
  [GAP] in System #08 §5.8).

Mitigation plan: connection-level rate limiting at the Colyseus transport
layer (1000 msg/sec hard cap per client), with rate-limit-exceeded resulting
in a disconnect. Flagged as part of broader server hardening, post-Phase-1.

### 3.8 Disconnect / Reconnect Handling

When a client disconnects (network drop, tab close, force-quit), the room
handles it as an unceremonious leave. There is no reconnect window today —
disconnected players are gone for that match.

#### Disconnect flow

1. Colyseus's transport detects the WebSocket close.
2. `onLeave(client)` fires (see §3.1 for the full callback).
3. Slot is freed (`occupied: false`, fields blanked).
4. Per-player timers are cleared.
5. Maps cleaned up: `players`, `lastDirection`, `playerLoadouts`, `authIds`.
6. State broadcast goes out so other clients see the slot empty.

#### Phase-specific behavior

| Phase at disconnect | Effect |
|---------------------|--------|
| `Waiting` | Slot freed. No countdown impact. Other players continue waiting for someone to join. |
| `Countdown` | If occupancy drops below `MIN_PLAYERS_TO_START`, countdown is **cancelled** and phase reverts to `Waiting`. The remaining player(s) wait for a new joiner to retry the countdown. |
| `Racing` (no one finished yet) | Slot freed. Race **continues** with remaining players. Disconnected player gets nothing — no DNF reward, no XP, no coins. They are removed from finishOrder and from result computation. |
| `Racing` (finish countdown active) | Slot freed. `checkAllFinished()` runs to see if remaining occupied players are all finished — if so, race ends immediately. |
| `Finished` (rematch vote window) | Vote count recomputed (their vote, if cast, is removed). If majority threshold is now met by remaining voters, rematch fires immediately. |

#### "Last player remaining" handling

If a player disconnects during `Racing` and only one occupied slot is left,
the surviving player must still **reach the finish line** to claim 1st
place. The race does **not** auto-end — they get to actually finish for the
satisfaction of crossing the line.

**[PLANNED — design call deferred]** Add a "you're alone — finish to win"
notification banner when remaining occupancy drops to 1. Decide later whether
to auto-end the race after a longer timeout (e.g., 30s of solo play) to
prevent stuck rooms.

#### Reconnect: NOT supported today

Disconnected players cannot rejoin the same room. If they reconnect, they
hit the matchmaker, which routes them to a new room (or queues them).

**[PLANNED]** Reconnect window for short network blips. Standard pattern in
Colyseus is `allowReconnection(client, seconds)` which holds the slot
reserved for N seconds, restoring it if the client reconnects with the same
sessionId. Recommended window: 15-30s. Trade-off: an aggressive window risks
players getting stuck in dead rooms; a generous window benefits users on
flaky mobile networks. Implementation deferred to network-hardening pass.

#### Award eligibility on disconnect

Authenticated players (`authId` present) are awarded XP/coins **only if they
were still connected when `endRace()` ran**. The `awardPlayers()` loop
iterates `results[]`, looks up `authId` for each `sessionId`, and skips
entries where the lookup misses (because `authIds` was deleted in `onLeave`).

Net effect: disconnect during racing → no rewards for that player.
Disconnect after the race ended but during rematch vote → rewards already
written in `endRace()` so no impact.

#### Duplicate-session prevention

The `onJoin` duplicate-session check (§3.7) is what prevents a "ghost" slot
from accumulating: a player whose first session went zombie can't sit in
slot 0 indefinitely while their reconnect attempt fights for slot 1. The
first thing `onJoin` does is scan `authIds` for a match — match found →
kick the new client with an error, force the player to clear their old
session first.

A side effect: if the old session is genuinely dead (TCP keepalive hasn't
yet detected the drop), the player is locked out until Colyseus's heartbeat
times out the dead session. Default Colyseus heartbeat timeout is 60s — can
feel long. **[OPTIONAL FUTURE]** tune heartbeat frequency for faster zombie
detection.

### 3.9 Procedural Map Seeding

The room generates a fresh procedural map on every `onCreate` and every
`resetRace`. Currently, generation uses `Math.random()` directly — different
output every call. **[PLANNED]** seeded generation so the same input seed
produces the same map.

#### Current implementation

Source: `generateTerrainMap`, `generateButtons`, `generatePickups` in
`src/shared/terrain.ts`.

Each generator uses `Math.random()` (via the local `randomInt` helper). Run
twice → different output. Players in the same room see the same map (server
runs generation once, broadcasts the result via `mapData`), but no two rooms
share a map.

#### Map shape (180×30 tiles)

Six themed zones across the X axis:

| X range | Zone | Dominant terrain |
|---------|------|------------------|
| 0-8 | Start | Normal |
| 9-25 | Mud field | Slow |
| 26-40 | Open corridor | Normal (pickups) |
| 41-70 | First ice arena | Slide |
| 71-80 | Recovery | Normal |
| 81-110 | Crumble bridge | Crumble + Hole |
| 111-120 | Recovery | Normal |
| 121-145 | Gauntlet | Slow + Crumble + Hole |
| 146-155 | Sprint corridor | Normal (pickups) |
| 156-170 | Second ice section | Slide |
| 171-175 | Final sprint | Normal |
| 176-179 | Finish zone | Normal |

Y axis: rows 0-1 and 28-29 are walls; rows 2 and 27 are holes (fall off
edges); rows 3-26 are the playable lane (top = 4, bot = 25, with 3 and 26
cleared at spawn/finish).

Buttons: 9 zones with one button each, target rectangle 5-8 tiles ahead.
Pickups: 9 zones with 2-3 pickups each (one of 4 random types).

#### Seeding plan **[PLANNED]**

Replace `Math.random()` with a seeded PRNG. Recommended: `seedrandom`
library (well-tested, ~1KB, deterministic across Node + browser).

```ts
// Future shape
import seedrandom from 'seedrandom';

export function generateTerrainMap(seed: string | number = Date.now()): {
  map: number[][],
  seed: string | number,
  buttons: ButtonDef[],
  pickups: PickupDef[],
} {
  const rng = seedrandom(String(seed));
  // replace all Math.random() calls with rng()
  // ...
}
```

#### Seed lifecycle

1. **Generation:** `onCreate` and `resetRace` pick a seed (default:
   timestamp; optional: passed in via room options for ranked/tournament
   modes).
2. **Broadcast:** seed is included in the `mapData` and `terrainReset`
   messages so clients can verify or re-derive the map locally.
3. **Logging:** seed is logged on room creation so QA / support can
   reproduce a specific map for debugging.
4. **Replay:** with the seed + the move log, a future replay system can
   reconstruct any match deterministically.

#### Why seeding matters

- **Ranked / tournament fairness.** Two rooms running the same ranked
  bracket can use the same seed so all players race the same map. Removes
  "lucky map" complaints.
- **Bug reproduction.** "Players got stuck on the crumble bridge in match
  X" — with the seed, QA can spawn the exact map locally.
- **Replay system.** Watching a saved match requires deterministic terrain.
  Without a seed, every playback would be a different map.
- **Speedrun leaderboards.** A speedrun community needs reproducible maps
  to compare times. A daily/weekly fixed seed is the standard pattern.

#### Out of scope for seeding

Player actions (movement, pickup activation, knockback) are **not** seeded
— they're event-driven and depend on real-time input. Seeded generation
only covers the procedural terrain, button placement, and pickup spawn
points.

## 4. Formulas

The room owns a small set of formulas around match timing, voting
thresholds, and finish logic. Gameplay subsystem formulas (movement
cooldowns, scoring math, stamina drain rates) belong to their respective
subsystem GDDs.

### 4.1 Rematch majority

```
majority(n) = floor(n / 2) + 1
```

**Variables:** `n` — current `occupiedCount()`.

**Expected values:**

| n | majority |
|---|----------|
| 1 | 1 |
| 2 | 2 |
| 3 | 2 |
| 4 | 3 |
| 5 | 3 |

**Example:** with 4 players in `Finished` phase, 3 must vote rematch to
skip the timeout. If only 2 vote, the room waits the full 15s.

Source: `rematchMajority()` in `RaceRoom.ts:478`.

### 4.2 Spawn row mapping

```
spawnY(slotIndex) = SPAWN_Y - 4 + slotIndex * 2
```

**Variables:** `slotIndex` ∈ [0, 4]. `SPAWN_Y = 14`.

**Range:** spawnY ∈ [10, 18]. Five rows spaced 2 tiles apart, centered on
row 14.

Source: `RaceRoom.ts:241`. Used in `onJoin` and `resetRace`.

### 4.3 Finish line geometry

A player is considered finished when:

```
finished(slot) = slot.tileX >= FINISH_X
              AND slot.tileY >= FINISH_Y_MIN
              AND slot.tileY <= FINISH_Y_MAX
              AND phase == Racing
              AND !ps.finished
```

**Variables:** `FINISH_X = 176`, `FINISH_Y_MIN = 4`, `FINISH_Y_MAX = 25`.
Finish zone is a 4-wide × 22-tall rectangle at the right edge of the map.

**Edge case:** the player must arrive in the zone via a successful `move`
or `jump` — terrain effects alone (e.g., sliding into the zone) will
trigger the check during `applyTerrainAt`.

Source: `checkFinishLine()` in `RaceRoom.ts:365`.

### 4.4 Race end conditions

The race ends when **either** condition holds:

```
raceEnds = allOccupiedFinished()
        OR finishCountdownExpired()
```

Where:

- `allOccupiedFinished()` = `slots.filter(occupied).every(s => players.get(s.sessionId).finished)` AND `finishOrder.length > 0`.
- `finishCountdownExpired()` = `finishCountdownTimer` reaches 0 (started at
  `FINISH_COUNTDOWN_SECONDS = 10` after first finisher).

**First finisher triggers the timer.** If only one player ever finishes,
the rest get DNF after 10s.

Source: `checkAllFinished()` in `RaceRoom.ts:399`, `startFinishCountdown()`
in `RaceRoom.ts:386`.

### 4.5 Match duration estimate

Approximate match length (no formula in code — for capacity planning):

```
max_match_length = COUNTDOWN_SECONDS + race_duration + FINISH_COUNTDOWN_SECONDS + REMATCH_VOTE_TIMEOUT_MS
                 ≈ 3s + ~120s typical + 10s + 15s
                 ≈ 148 seconds (worst case ≈ 200s if race_duration approaches the soft cap)
```

**Implications for ops:** a single CPU core can handle dozens of concurrent
rooms. The bottleneck is more likely to be MongoDB writes at race end (one
`awardPostRace` per finisher) than CPU.

## 5. Edge Cases

Marker key: **[OK]** = handled correctly; **[GAP]** = undefined / needs
decision; **[BUG]** = current incorrect behavior.

### 5.1 Lifecycle

- **5.1.1 Player joins a full room.** **[OK]** Colyseus refuses the
  connection at the matchmaker (`maxClients = 5`). The defensive
  `client.leave()` in `onJoin` is a backup if the matchmaker race-conditions
  through.
- **5.1.2 Player joins mid-Countdown.** **[OK]** Slot is assigned, spawn
  position set, joining client receives `mapData` and current `state` (with
  phase=Countdown and the live countdown number). Joiner is included in the
  race when it begins.
- **5.1.3 Player joins mid-Racing.** **[GAP]** Slot is assigned and movement
  is enabled because `phase === Racing` is true for everyone. The joiner
  spawns at start with full stamina, racing against players who are already
  partway through. This is a real exploit vector / poor UX — late joiners
  shouldn't be allowed during `Racing`. Recommend refusing new joins when
  `phase !== Waiting`.
- **5.1.4 All players leave during Countdown.** **[OK]** `cancelCountdown`
  reverts to `Waiting`. Room becomes eligible for disposal.
- **5.1.5 All players leave during Racing.** **[OK with caveat]** Race
  effectively dies — `players` map empties, `slots` all unoccupied. Room
  awaits disposal. No `endRace()` ever fires. **[GAP]** The pending
  `finishCountdownTimer` and `rematchTimer` may still fire on an empty room
  before disposal — they call `endRace`/`resetRace` which try to broadcast
  to no clients (harmless, but wasted work).
- **5.1.6 Server crash during Racing.** **[OK with caveat]** Room dies, all
  clients disconnect. No XP/coins awarded for that match. Players hit
  matchmaker, get a fresh room. No reconnect = no resumed race.

### 5.2 Slot system

- **5.2.1 Player A leaves, Player B joins immediately.** **[OK]** B gets
  the lowest unoccupied slot — typically A's old slot if it's still the
  lowest. Slot index is reused.
- **5.2.2 Same `authId` joins twice.** **[OK]** First join wins. Second
  join is kicked with `error` message. Prevents zombie sessions and
  multi-tab abuse.
- **5.2.3 Player joins without `authId` (guest).** **[OK]** Slot assigned
  normally. No XP/coin award (no `authId` to look up). No loadout
  broadcast. Functions as a play-without-account mode.

### 5.3 Phase transitions

- **5.3.1 Countdown timer fires for a 0-player room.** **[OK]** Cannot
  happen — `cancelCountdown` runs in `onLeave` if occupancy drops below
  threshold.
- **5.3.2 First finisher disconnects before race ends.** **[OK]** Their
  slot is freed, their `PlayerState` removed. The `finishOrder[]` still
  contains their record. `endRace()` will award them position 1 in the
  result computation but skip the actual XP/coin write because their
  `authId` is gone from the map. Their finish time appears in the broadcast
  results.
- **5.3.3 No one ever finishes.** **[GAP]** Race ends when finish countdown
  expires (only triggered by first finisher) — but if no first finisher,
  no countdown is ever started, and the race continues indefinitely. Need
  a max-race-time cap to prevent infinite stalls if everyone falls in
  holes endlessly. Recommend 5-minute hard cap that triggers `endRace`
  with everyone DNF.
- **5.3.4 Rematch timer fires after everyone left.** **[OK]** `resetRace`
  runs on an empty room. Map regenerates, slots stay empty.
  `checkStartCondition` runs, no players → stays in `Waiting`. Wasted work
  but harmless.

### 5.4 Broadcasts

- **5.4.1 Client misses a `state` broadcast.** **[OK]** Colyseus is
  reliable-ordered; messages are not dropped under normal conditions. If
  the WebSocket disconnects, the client gets `onLeave` from the server and
  `onClose` locally.
- **5.4.2 `playerLoadout` arrives before `mapData`.** **[OK]** Client must
  handle out-of-order loadout/state messages. The loadout broadcast is
  fire-and-forget non-blocking, so it can race with the `mapData` send.
- **5.4.3 `state` broadcast contains a sessionId not in any client's
  avatar map.** **[OK]** Client must create the avatar on first sight
  rather than assuming it was set up by an earlier event. Prevents brittle
  ordering dependencies.

### 5.5 Disconnect / reconnect

- **5.5.1 Client closes browser tab during Racing.** **[OK]** WebSocket
  close → `onLeave` → slot freed. No rewards. Race continues for others.
- **5.5.2 Client reconnects 2s later.** **[GAP]** Today: kicked because
  their old session is still in `authIds` (if Colyseus heartbeat hasn't
  timed out yet) OR routed to a new room. **[PLANNED]** `allowReconnection`
  window of 15-30s.
- **5.5.3 Network blip during the broadcast of a critical event** (e.g.,
  pickup collection). **[OK]** Colyseus reconnects the transport
  transparently for short blips. If blip exceeds reconnect tolerance,
  client is dropped entirely.
- **5.5.4 Player closes browser during the rematch vote window.** **[OK]**
  Slot freed. `rematchVotes` set has their entry removed. Vote count
  recomputed; if remaining votes still meet majority, rematch fires.

### 5.6 Anti-cheat

- **5.6.1 Client spams `move` 1000x/sec.** **[OK with caveat]** Cooldown
  check rejects all but ~10/sec. Server CPU still pays the message-handler
  cost. **[GAP]** rate limiting at transport layer not yet implemented.
- **5.6.2 Client sends `move` with `direction: "TELEPORT"`.** **[OK]**
  `MOVE_DELTAS["TELEPORT"]` is undefined → silent reject.
- **5.6.3 Client sends `usePickup` while holding nothing.** **[OK]**
  `heldPickup === null` check rejects.
- **5.6.4 Client tries to forge `authId` on join.** **[OK with caveat]**
  Currently `authId` is trusted as supplied — assumes the client validated
  their JWT before sending. **[GAP]** Server should verify the JWT
  signature itself rather than trusting the client. Auth System #03 owns
  the fix.
- **5.6.5 Client sends `playerName` with HTML/JS injection.** **[OK]**
  `replace(/[^a-zA-Z0-9 ]/g, '')` strips everything but alphanumerics +
  spaces. No XSS surface.

### 5.7 Map seeding

- **5.7.1 Two rooms get the same timestamp seed.** **[OK with caveat]**
  Today: two rooms in the same millisecond would generate identical maps.
  Rare but possible under load. **[PLANNED]** seed will use timestamp +
  room ID hash to guarantee uniqueness.
- **5.7.2 Procedural generation produces an unwinnable map.** **[OK with
  caveat]** `ensurePassable` ensures a 3-tile gap exists in every column.
  But pickup placement, button targets, and crumble bridges can
  theoretically combine into a hard-to-cross section. No formal "all paths
  reachable" check today. **[GAP]** Add a post-generation A* validation
  that the start zone connects to the finish zone before broadcasting.

## 6. Dependencies

### 6.1 Upstream (what this system needs)

| System | Why this system depends on it |
|--------|------------------------------|
| **Colyseus framework** | Provides `Room` base class, transport, schema, broadcast primitives, matchmaker. Pinned to v0.15. |
| **System #03 — Authentication / Account** | `authId` from JWT used for duplicate-session check, reward attribution, and loadout lookup. |
| **System #04 — Database Persistence Layer** | Reads loadout/character via `getLoadout`, `getEquippedChar`. Writes XP/coins via `awardPostRace`. Uses MongoDB connection pool. |
| **System #08 — Item / Inventory** | Source of equipped loadout broadcast on player join. The room is the consumer of `getLoadout` and the broadcaster of `playerLoadout` messages. |

### 6.2 Downstream (what depends on this system)

| System | Why it depends on this system |
|--------|------------------------------|
| **System #07 — Player Movement** | Movement subsystem runs entirely inside `handleMove`. Movement cooldown, sprint, stamina, jump live there but consume the room's phase, broadcast, and slot system. |
| **System #11 — Avatar Renderer** | Consumes `state` broadcast slot data + `playerLoadout` messages to render players. |
| **System #15 — Terrain System** | Terrain effects (slow, slide, hole, crumble) run inside `applyTerrainAt`, which runs inside the room's move pipeline. The `Terrain` enum and procedural generator live in shared code. |
| **System #17 — Button / Trap System** | Button activation, target rectangles, cooldown timers, terrain mutations all run inside the room's lifecycle. Buttons are placed during `generateMap`. |
| **System #18 — Pickup System** | Pickup collection, activation, and per-pickup-type effects (speed, shield, slime, knockback) all run inside the room. Pickups are placed during `generateMap`. |
| **System #19 — Scoring System** | `endRace` computes `RaceResult[]` using scoring formulas. `awardPlayers` writes results back to the player document. |
| **System #20 — Matchmaking / Queue** | Queue room (`QueueRoom`) sends players to the race room via Colyseus matchmaking. The room name `'race'` is the integration point. |
| **System #21 — Race UI** | Reads phase, countdown, finishCountdown, slot positions, held pickup, stamina, etc. from `state` broadcasts to render the in-race HUD. |
| **System #28 — Chat System** | (Future) in-race chat messages will likely route through the race room. Chat is currently lobby-only. |

### 6.3 Sibling references (no dependency, but related)

| System | Relationship |
|--------|------------|
| **System #13 — Lobby / Crazy Town** | Lobby is the social hub between matches. Players move from lobby → queue → race → lobby. Independent rooms. |
| **System #22 — XP / Level System** | XP is granted at race end via `awardPostRace`, but the leveling math itself lives in System #19/#22. Race room only computes the per-match score. |
| **System #23 — Seasonal Leaderboard** | Reads race-result events but doesn't run inside the room. Future analytics integration. |

### 6.4 Back-reference checklist

When the GDDs for the following systems are authored, they must include a
dependency-back reference to System #10:

- [ ] System #07 — Player Movement
- [ ] System #11 — Avatar Renderer (existing — needs a §Dependencies update)
- [ ] System #15 — Terrain System
- [ ] System #17 — Button / Trap System
- [ ] System #18 — Pickup System
- [ ] System #19 — Scoring System
- [ ] System #20 — Matchmaking / Queue
- [ ] System #21 — Race UI

## 7. Tuning Knobs

All knobs live in `src/shared/terrain.ts` (timing constants and game
balance) or `RaceRoom.ts` (room-only constants). Changes propagate to both
client and server since `terrain.ts` is shared.

### 7.1 Player count

**Source:** `MIN_PLAYERS_TO_START = 2` (`terrain.ts:132`),
`maxClients = 5` (`RaceRoom.ts:140`).

**Safe range:** min 2-3, max 4-8. Below 2 means solo races (defeats
multiplayer fantasy). Above 8 starts to strain the JSON broadcast (still
cheap but visual chaos increases).

**Tunes:** how often players have to wait for a room to fill, how chaotic
each match feels, server CPU per room.

### 7.2 Countdown duration

**Source:** `COUNTDOWN_SECONDS = 3` (`terrain.ts:133`).

**Safe range:** 2-5 seconds. Below 2: players can't react / get ready.
Above 5: feels slow, players get bored.

**Tunes:** match pacing, time between joining a full room and racing.

### 7.3 Finish countdown

**Source:** `FINISH_COUNTDOWN_SECONDS = 10` (`terrain.ts:134`).

**Safe range:** 5-30 seconds. Below 5: fast finishers feel pressured to
wait; slow players feel rushed. Above 30: the post-finish wait drags.

**Tunes:** how long late finishers have to claim a position before being
DNFed.

### 7.4 Rematch vote timeout

**Source:** `REMATCH_VOTE_TIMEOUT_MS = 15000` (`terrain.ts:136`).

**Safe range:** 10-30 seconds. Below 10: not enough time to read results
before the next race fires. Above 30: room idles too long if some players
are AFK on the results screen.

**Tunes:** match-to-match cadence for engaged groups, how long results
stay on screen for casual viewing.

### 7.5 Spawn row spacing

**Source:** Hardcoded `idx * 2` in `onJoin` and `resetRace`
(`RaceRoom.ts:241`, `:518`).

**Safe range:** 1-3 tiles between rows. Below 1: spawn collisions /
overlap. Above 3: spawn area gets too tall, requires moving `tTop`/`tBot`
accordingly.

**Tunes:** how spread out players feel at the start, collision frequency
in the first few moves.

### 7.6 Map dimensions

**Source:** `GRID_COLS = 180`, `GRID_ROWS = 30` (`terrain.ts:113-114`).

**Safe range:** locked for now — dimensions cascade through every zone
definition, button slot, pickup zone, and terrain generator. Changing
dimensions is a major content rebuild, not a knob.

**Tunes:** match length, course complexity, screen-real-estate use.

**[OPTIONAL FUTURE]** When alternate game modes ship, `generateTerrainMap`
could accept dimensions as parameters and fan out to multiple shapes
(sprint = short, marathon = long, arena = wide).

### 7.7 Broadcast mode

**Source:** Implicit in `broadcastState()` design.

**Current:** Event-driven, full JSON payload, no coalescing.

**Knobs available** (none implemented today, all **[OPTIONAL FUTURE]**):

- **Coalescing window** (proposed 16ms) — collapses bursty events into
  one broadcast.
- **Schema delta sync migration trigger** (proposed > 50 KB/s sustained)
  — switch to binary delta sync if bandwidth becomes a problem.
- **Broadcast filtering** — send slot updates only to clients within
  visual range (irrelevant at 5 players, may matter at 100+).

### 7.8 Heartbeat / reconnect window

**Source:** Colyseus defaults today (no override). Heartbeat ~60s, no
`allowReconnection` configured.

**Safe range when configured:**

- Reconnect window: 10-30s. Below 10s: too short for typical mobile
  network blips. Above 30s: dead rooms persist too long, hurts matchmaking.
- Heartbeat: 15-60s. Below 15s: false-positive disconnects on slow
  networks. Above 60s: zombie sessions linger.

**Tunes:** mobile-network resilience vs. matchmaking responsiveness.

## 8. Acceptance Criteria

Each criterion is concrete and testable. Format: **[ID]** Setup → Action →
Expected. Categories follow the Detailed Rules sections.

### 8.1 Room lifecycle

- **AC-RACE-001** Connect first client to `'race'` room → Colyseus creates a
  fresh `RaceRoom` instance. Server log shows `[RaceRoom] created`.
- **AC-RACE-002** Connect 6th client when 5 are present → connection refused
  by matchmaker. Server log does not show 6th join.
- **AC-RACE-003** Connect a client with the same `authId` as an existing
  client → new client receives `error` message
  `"Already in this room from another tab"` and is disconnected.
- **AC-RACE-004** Last client disconnects → server log shows
  `[RaceRoom] disposed`. All `setTimeout`/`setInterval` IDs cleared
  (verifiable via Node.js heap snapshot showing zero `Timeout` objects).

### 8.2 Slot system

- **AC-RACE-010** First client joins → assigned slot 0 (lowest unoccupied).
  Slot 0's `tileX = 2`, `tileY = 10`.
- **AC-RACE-011** Second client joins → assigned slot 1. Slot 1's spawn at
  `tileY = 12`. Other slots untouched.
- **AC-RACE-012** Slot 1 leaves, then a new client joins → assigned slot 1
  (the freed lowest slot). NOT slot 5.
- **AC-RACE-013** During and after any join/leave, `state.slots.length === 5`
  always.
- **AC-RACE-014** No two slots share the same `sessionId` while both
  `occupied: true`.

### 8.3 Phase transitions

- **AC-RACE-020** Single player in a room → phase remains `Waiting`. No
  countdown timer fires.
- **AC-RACE-021** Second player joins (count = 2) → phase transitions to
  `Countdown`. `state.countdown` starts at 3.
- **AC-RACE-022** Countdown reaches 0 → phase transitions to `Racing`.
  `startTime` is set to a recent `Date.now()`. `state` broadcasts include
  the new phase.
- **AC-RACE-023** During `Countdown`, a player leaves dropping count to 1
  → phase reverts to `Waiting`. Countdown stops broadcasting.
- **AC-RACE-024** First player crosses finish line → `phase` stays `Racing`
  but `state.finishCountdown` is now 10. `playerFinished` broadcast fires
  with position 1.
- **AC-RACE-025** All occupied players are finished → phase transitions to
  `Finished` immediately, `raceResults` broadcast precedes the phase-state
  broadcast.
- **AC-RACE-026** `finishCountdown` reaches 0 with unfinished players →
  phase transitions to `Finished`. Unfinished players appear in
  `raceResults` with `position: 0` and `DNF_POINTS = 5` base.
- **AC-RACE-027** During `Finished`, all clients send `rematchVote` → phase
  transitions to `Waiting` immediately, `terrainReset` broadcast precedes
  new state. Map regenerates with different terrain.
- **AC-RACE-028** During `Finished`, no clients vote and 15s elapse → phase
  transitions to `Waiting` automatically. Map regenerates.

### 8.4 State broadcast

- **AC-RACE-030** Every successful `move` produces exactly one `state`
  broadcast. Multiple state changes in the same call (move + pickup collect
  + slime check) produce one broadcast.
- **AC-RACE-031** `state` payload always contains exactly 5 slot entries.
- **AC-RACE-032** Unoccupied slots in `state.slots` have `occupied: false`,
  `playerName: ''`, default `tileX/Y`.
- **AC-RACE-033** `state.phase` matches the room's internal phase value at
  the moment of the broadcast (no lag).

### 8.5 Message contract

- **AC-RACE-040** Client sends `move` with valid direction during `Racing`
  → server processes, position changes, state broadcasts.
- **AC-RACE-041** Client sends `move` with valid direction during
  `Countdown` → server ignores, no state change, no broadcast.
- **AC-RACE-042** Client sends `move` with invalid direction `"FOO"` →
  server ignores, no state change.
- **AC-RACE-043** Client sends `move` with `sprint: true` while stamina < 10
  → sprint is dropped, normal cooldown applies.
- **AC-RACE-044** Client presses Space (`jump`) twice within 1500ms → second
  jump is rejected (cooldown).
- **AC-RACE-045** Client presses E (`usePickup`) with `heldPickup === null`
  → ignored.
- **AC-RACE-046** Client sends `rematchVote` during `Racing` → ignored.
- **AC-RACE-047** Client sends `refreshLoadout` while in a room as a guest
  (no `authId`) → ignored, no DB query.

### 8.6 Anti-cheat

- **AC-RACE-050** Client sends `move` 100 times in 1 second → at most ~10-20
  succeed (gated by cooldown). Server CPU shows no abnormal spike (within
  rate-limit threshold once that's added).
- **AC-RACE-051** Client modifies position locally (e.g., via DOM hack) →
  server's next `state` broadcast snaps them back. Their local change has
  no persistent effect.
- **AC-RACE-052** Player name `<script>alert(1)</script>` is submitted →
  stored as `scriptalert1script` (HTML/JS chars stripped). No script tag
  survives.
- **AC-RACE-053** Client tries to send `move.direction = "TELEPORT"` to a
  coordinate → ignored.

### 8.7 Disconnect handling

- **AC-RACE-060** Player disconnects during `Waiting` → slot freed, no
  phase change.
- **AC-RACE-061** Player disconnects during `Countdown` dropping count
  below 2 → countdown cancels, phase = `Waiting`.
- **AC-RACE-062** Player disconnects during `Racing` (no one finished) →
  race continues with remaining players. Disconnected player gets no
  XP/coins on race end.
- **AC-RACE-063** Player disconnects during `Finished` rematch window →
  vote count adjusts. If their vote was counted, it's removed. Majority
  recheck.
- **AC-RACE-064** Two players race, one disconnects mid-race → race
  continues. Solo player must reach finish to claim 1st. **[PLANNED]**
  "you're alone" notification appears.
- **AC-RACE-065** Player disconnects mid-race in a 2-player room → only
  the surviving player can finish. Disconnected player gets nothing.

### 8.8 Map seeding **[PLANNED]**

- **AC-RACE-070** **[PLANNED]** Same seed produces identical terrain,
  button placements, and pickup spawns across two `generateMap` calls.
- **AC-RACE-071** **[PLANNED]** Different seeds produce different maps.
- **AC-RACE-072** **[PLANNED]** Seed is broadcast in `mapData` and logged
  on room creation.
- **AC-RACE-073** **[PLANNED]** A* validation rejects unwinnable maps;
  generator retries up to N times before falling back to a known-good
  template.

### 8.9 Loadout integration

- **AC-RACE-080** Authenticated player joins → within 2 seconds, all
  clients (including the joiner) receive a `playerLoadout` message
  containing that player's `slotIndex`, `charKey`, and equipped slots.
- **AC-RACE-081** Authenticated player joins a room with N existing
  authenticated players → joiner receives N `playerLoadout` messages
  (one per existing player), and one `playerLoadout` for themselves
  broadcast to all.
- **AC-RACE-082** Player sends `refreshLoadout` after equipping → all
  clients receive an updated `playerLoadout` for that slot within 500ms.
- **AC-RACE-083** Guest player joins → no `playerLoadout` is broadcast
  for them. Other players see them as the default base body with no
  equipment.

### 8.10 Award flow

- **AC-RACE-090** Race ends, authenticated player finished 1st → MongoDB
  `players` doc shows `xp += positionPoints + bonusPoints` (100 + bonuses),
  `coins += totalScore / 2`, `totalRaces += 1`, `totalWins += 1`.
- **AC-RACE-091** Race ends, authenticated player finished 3rd →
  `xp += 55 + bonus`, `coins += (55 + bonus) / 2`, `totalRaces += 1`,
  `totalWins` unchanged.
- **AC-RACE-092** Race ends, guest player (no authId) → no MongoDB writes
  for that player.
- **AC-RACE-093** Race ends with MongoDB unavailable → `awardPlayers`
  catches the error, logs it, race results still broadcast to clients. No
  crash.

### 8.11 Invariants (continuous)

Run as periodic health checks, both in tests and production audit:

- **AC-RACE-100** `slots.length === 5` at all times.
- **AC-RACE-101** `slots.filter(s => s.occupied).length <= 5` always.
- **AC-RACE-102** Every occupied slot's `sessionId` exists in `players`
  map AND in `clients[]`.
- **AC-RACE-103** Every entry in `players` map has a corresponding
  occupied slot.
- **AC-RACE-104** No two occupied slots share the same `sessionId` or the
  same `authId`.
- **AC-RACE-105** When `phase === Finished`, `endTime - startTime > 0`.
- **AC-RACE-106** When `phase === Racing`, all `setTimeout` timers
  (crumble, hole, pickup) reference active sessions.
