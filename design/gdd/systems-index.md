# Systems Index — Crazy Stuff

**Version:** 2.0
**Updated:** 2026-06-17 (rewritten to reflect built reality; v1.0 described a pre-multiplayer Phase 0 that was long surpassed)
**Total Systems:** 36 in-game + 1 ops tool (admin dashboard)
**Build status:** 18 Done · 8 Partial · 11 Not Started

> This index tracks **implementation status** of every system. The monolithic GDD
> (`crazy-stuff-gdd.md`) holds vision/pillars; per-system GDDs hold detailed specs.
> The forward plan (what's left, in what order, to public launch) lives in
> [`production/roadmap.md`](../../production/roadmap.md).

**Status legend:** ✅ Done · 🟡 Partial (built, missing pieces) · ⬜ Not Started

---

## Systems by Category

### Foundation (Layer 0)

| # | System | Status | Notes |
|---|---|---|---|
| 01 | Isometric Tile Renderer | ✅ Done | `IsoScene.ts` — iso grid, depth sort, terrain tiles |
| 02 | Input System | ✅ Done | WASD + click; server-authoritative movement send |
| 03 | Authentication / Account | ✅ Done | email+pw, Google OAuth (safe link), JWT, ownership middleware. GDD [03](03-authentication.md) |
| 04 | Database Persistence | ✅ Done | **MongoDB** (ADR-004 superseded PostgreSQL); `db/mongo.ts` |
| 05 | Redis Cache Layer | ⬜ Not Started | not wired; only needed for leaderboard/rate-limit scale |
| 06 | Asset Pipeline | ✅ Done | PixelLab MCP + `tools/` scripts → sprite sheets |

### Core (Layer 1)

| # | System | Status | Notes |
|---|---|---|---|
| 07 | Player Movement | ✅ Done | 8-dir, server-authoritative, lobby + race |
| 08 | Item / Inventory | ✅ Done | per-row inventory, slot conflicts, equip txn, loadout cache. GDD [08](08-item-inventory.md) |
| 09 | Currency (Crazy Coins) | 🟡 Partial | earned + persisted; **no spend path** (no store) → M2 |
| 10 | Race Room (Colyseus) | ✅ Done | authoritative `RaceRoom.ts`. GDD [10](10-race-room.md) |

### Gameplay — Lobby (Layer 2–3)

| # | System | Status | Notes |
|---|---|---|---|
| 11 | Avatar Renderer | ✅ Done | layered compositing, frame-locked, renders remote players. GDD [11](11-avatar-renderer.md) |
| 12 | Avatar / Customization | 🟡 Partial | char select + equip work; **body still on legacy `equippedChar`**, not unified into inventory (skin-slot migration, [08](08-item-inventory.md) §3.3) |
| 13 | Lobby / Crazy Town | 🟡 Partial | walkable hub works; **2 of 6 locations** (gacha + race queue). Missing: store, leaderboard wall, housing district. Placeholder gacha-machine art → M2 |
| 14 | Ambient / NPC System | ⬜ Not Started | post-launch |

### Gameplay — Race (Layer 2–4)

| # | System | Status | Notes |
|---|---|---|---|
| 15 | Terrain System | ✅ Done | slow/slide/crumble/hole/wall (`shared/terrain.ts`) |
| 16 | Respawn System | ✅ Done | fall → respawn in `RaceRoom` |
| 17 | Button / Trap System | ✅ Done | 3 button types |
| 18 | Pickup System | ✅ Done | 4 pickups |
| 19 | Scoring System | ✅ Done | position + bonus → XP/coins |
| 20 | Matchmaking / Queue | ✅ Done | `QueueRoom` ready-up + countdown (variant of GDD's wait-for-5/bots) |
| 21 | Race UI | 🟡 Partial | HUD + results work; **results don't show XP/coins earned** → M1 |

### Progression (Layer 3–4)

| # | System | Status | Notes |
|---|---|---|---|
| 22 | XP / Level System | ✅ Done | XP/level/coins persist via `awardPostRace`. Milestone-reward unlocks not built (post-launch) |
| 23 | Seasonal Leaderboard | ✅ Done | season-XP board + lobby Leaderboard Wall ([E]) + your-rank API; monthly UTC seasons w/ rollover; unit + integration tested. Placeholder wall art; live visual QA pending |

### Economy (Layer 3–4)

| # | System | Status | Notes |
|---|---|---|---|
| 24 | Gacha System | 🟡 Partial | free pull **done** (crypto-RNG, pity, idempotent txn, reveal anim, only tested system); **paid gated `PAID_ENABLED=off`** pending payment + legal → M4. GDD [24](24-gacha-system.md) |
| 25 | Store System | ⬜ Not Started | coin store → M2; paid store → M4 |
| 26 | Payment Integration (Stripe) | ⬜ Not Started | M4 |
| 27 | Economy UI | 🟡 Partial | gacha pull UI done; store/payment UI not → M4 |

### Social (Layer 3–4)

| # | System | Status | Notes |
|---|---|---|---|
| 28 | Chat System | 🟡 Partial | lobby chat done; proximity/global scope + race chat TBD |
| 29 | Voice Chat | ⬜ Not Started | post-launch |
| 30 | Emote System | ⬜ Not Started | post-launch |
| 31 | Friends / Social Graph | ⬜ Not Started | post-launch |
| 32 | Lobby UI | 🟡 Partial | profile/inventory/gacha panels done; friends/customization-rich UI not |

### Housing (Layer 3–5) — all post-launch / V2

| # | System | Status | Notes |
|---|---|---|---|
| 33 | Housing System | ⬜ Not Started | V2 (Gabriel wants to detail — open topic) |
| 34 | Furniture / Decoration | ⬜ Not Started | V2 |
| 35 | Guestbook | ⬜ Not Started | V2 |
| 36 | Housing UI | ⬜ Not Started | V2 |

### Ops (not in original index)

| # | System | Status | Notes |
|---|---|---|---|
| A1 | Admin Dashboard | ✅ Done | **separate repo `crazy-stuff-admin`** (Next.js, direct Mongo, ADMIN_PASSWORD). Player/account/item management |

---

## Build Status Summary

- **✅ Done (18):** 01, 02, 03, 04, 06, 07, 08, 10, 11, 15, 16, 17, 18, 19, 20, 22, 23, A1
- **🟡 Partial (8):** 09, 12, 13, 21, 24, 27, 28, 32
- **⬜ Not Started (11):** 05, 14, 25, 26, 29, 30, 31, 33, 34, 35, 36

The **core loop is complete end-to-end**: login → lobby → queue → race → rewards → progression. Remaining work is breadth (content, economy spend-paths, social/housing) and launch-hardening (replica set, abuse/GDPR), not core risk. See [`production/roadmap.md`](../../production/roadmap.md).

---

## Dependency Map

```
LAYER 0 — Foundation
  Isometric Tile Renderer ✅   Input ✅   Auth ✅   Database ✅   Redis ⬜   Asset Pipeline ✅
LAYER 1 — Core
  Player Movement ✅ → Tile Renderer, Input
  Item / Inventory ✅ → Database
  Currency 🟡 → Database          (blocked-feature: needs Store to matter)
  Race Room ✅ → Auth, Database
LAYER 2 — Gameplay Core
  Avatar Renderer ✅ → Tile Renderer, Item/Inventory
  Terrain ✅ → Tile Renderer, Race Room
  Matchmaking/Queue ✅ → Auth, Race Room
  XP/Level ✅ → Database
LAYER 3 — Gameplay Features
  Avatar/Customization 🟡 → Item/Inventory, Avatar Renderer
  Lobby/Crazy Town 🟡 → Tile Renderer, Movement, Auth, Avatar Renderer
  Respawn ✅ / Button ✅ / Pickup ✅ / Scoring ✅ → Terrain, Race Room
  Gacha 🟡 → Item/Inventory, Database, Payment(soft, paid only)
  Store ⬜ → Item/Inventory, Currency, Database
  Chat 🟡 → Auth, Lobby
LAYER 4 — Dependent
  Race UI 🟡 → Scoring, Race Room, XP/Level, Currency
  Seasonal Leaderboard ⬜ → Scoring, Database, (Redis)
  Payment ⬜ → Auth, Currency
  Economy UI 🟡 → Gacha, Store, Currency, Payment
LAYER 5 — Polish / V2
  Housing ⬜ / Furniture ⬜ / Guestbook ⬜ / Housing UI ⬜ / Voice ⬜ / Emote ⬜ / Friends ⬜ / Ambient ⬜
```

## High-Risk Bottlenecks — all RESOLVED (built + working)

| System | Dependents | Original risk | Status |
|---|---|---|---|
| Isometric Tile Renderer | 8 | tile size / depth sort | ✅ shipped, stable |
| Authentication | 7 | session model | ✅ shipped; security gap (§3.7) closed |
| Race Room | 7 | authoritative schema | ✅ shipped |
| Item / Inventory | 6 | slot schema | ✅ shipped |

The big technical risks are behind us — this is why the project is past prototype.
