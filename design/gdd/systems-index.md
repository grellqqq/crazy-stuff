# Systems Index — Crazy Stuff

**Version:** 1.0
**Created:** 2026-03-22
**Total Systems:** 34
**Designed:** 3 / 34

> This index is the authoritative decomposition of the game into individual systems.
> Each system should have its own GDD at `design/gdd/[system-slug].md`.
> The monolithic GDD at `design/gdd/crazy-stuff-gdd.md` remains the source of
> vision, pillars, and cross-system context.

---

## Systems by Category

### Foundation (Layer 0 — no dependencies)

| # | System | Phase | Status | GDD |
|---|---|---|---|---|
| 01 | Isometric Tile Renderer | 0 | Not Started | — |
| 02 | Input System | 0 | Not Started | — |
| 03 | Authentication / Account | 0 | Complete (reverse-doc) | [03-authentication.md](03-authentication.md) |
| 04 | Database Persistence Layer | 0 | Not Started | — |
| 05 | Redis Cache Layer | 4 | Not Started | — |
| 06 | Asset Pipeline | 0 | Not Started | — |

### Core (Layer 1 — depends on Foundation)

| # | System | Phase | Status | GDD |
|---|---|---|---|---|
| 07 | Player Movement | 0 | Not Started | — |
| 08 | Item / Inventory | 2 | Complete (reverse-doc) | [08-item-inventory.md](08-item-inventory.md) |
| 09 | Currency | 2 | Not Started | — |
| 10 | Race Room (Colyseus) | 1 | Complete (reverse-doc) | [10-race-room.md](10-race-room.md) |

### Gameplay — Lobby (Layer 2–3)

| # | System | Phase | Status | GDD |
|---|---|---|---|---|
| 11 | Avatar Renderer | 2 | Not Started | — |
| 12 | Avatar / Customization | 2 | Not Started | — |
| 13 | Lobby / Crazy Town | 3 | Not Started | — |
| 14 | Ambient / NPC System | 3 | Not Started | — |

### Gameplay — Race (Layer 2–4)

| # | System | Phase | Status | GDD |
|---|---|---|---|---|
| 15 | Terrain System | 1 | Not Started | — |
| 16 | Respawn System | 1 | Not Started | — |
| 17 | Button / Trap System | 1 | Not Started | — |
| 18 | Pickup System | 1 | Not Started | — |
| 19 | Scoring System | 1 | Not Started | — |
| 20 | Matchmaking / Queue | 1 | Not Started | — |
| 21 | Race UI | 1 | Not Started | — |

### Progression (Layer 3–4)

| # | System | Phase | Status | GDD |
|---|---|---|---|---|
| 22 | XP / Level System | 2 | Not Started | — |
| 23 | Seasonal Leaderboard | 2 | Not Started | — |

### Economy (Layer 3–4)

| # | System | Phase | Status | GDD |
|---|---|---|---|---|
| 24 | Gacha System | 4 | Not Started | — |
| 25 | Store System | 4 | Not Started | — |
| 26 | Payment Integration | 4 | Not Started | — |
| 27 | Economy UI | 4 | Not Started | — |

### Social (Layer 3–4)

| # | System | Phase | Status | GDD |
|---|---|---|---|---|
| 28 | Chat System | 3 | Not Started | — |
| 29 | Voice Chat | 3 | Not Started | — |
| 30 | Emote System | 3 | Not Started | — |
| 31 | Friends / Social Graph | 3 | Not Started | — |
| 32 | Lobby UI | 3 | Not Started | — |

### Housing (Layer 3–5)

| # | System | Phase | Status | GDD |
|---|---|---|---|---|
| 33 | Housing System | 4 | Not Started | — |
| 34 | Furniture / Decoration | 4 | Not Started | — |
| 35 | Guestbook | 4 | Not Started | — |
| 36 | Housing UI | 4 | Not Started | — |

---

## Dependency Map

```
LAYER 0 — Foundation
  Isometric Tile Renderer     (none)
  Input System                (none)
  Authentication / Account    (none)
  Database Persistence Layer  (none)
  Redis Cache Layer           (none)
  Asset Pipeline              (none)

LAYER 1 — Core
  Player Movement       → Tile Renderer, Input
  Item / Inventory      → Database
  Currency              → Database
  Race Room (Colyseus)  → Auth, Database

LAYER 2 — Gameplay Core
  Avatar Renderer       → Tile Renderer, Item/Inventory
  Terrain System        → Tile Renderer, Race Room
  Matchmaking / Queue   → Auth, Race Room
  XP / Level System     → Database (schema only; Scoring grants XP at match-end)
  Friends/Social Graph  → Auth, Database

LAYER 3 — Gameplay Features
  Avatar / Customization  → Item/Inventory, Avatar Renderer
  Lobby / Crazy Town      → Tile Renderer, Player Movement, Auth, Avatar Renderer
  Respawn System          → Terrain, Race Room
  Button / Trap System    → Terrain, Race Room
  Pickup System           → Race Room, Item/Inventory
  Scoring System          → Race Room
  Gacha System            → Item/Inventory, Currency, Database
  Store System            → Item/Inventory, Currency, Database
  Chat System             → Auth, Lobby/Crazy Town
  Emote System            → Avatar Renderer, Lobby/Crazy Town
  Housing System          → Auth, Tile Renderer, Database

LAYER 4 — Dependent Features
  Race UI                 → Scoring, Race Room, XP/Level, Currency
  Seasonal Leaderboard    → Scoring, Database, Redis
  Payment Integration     → Auth, Currency
  Ambient / NPC System    → Lobby/Crazy Town, Tile Renderer
  Voice Chat              → Race Room
  Furniture/Decoration    → Housing, Item/Inventory
  Lobby UI                → Avatar/Customization, Friends/Social Graph
  Economy UI              → Gacha, Store, Currency, Payment

LAYER 5 — Polish
  Guestbook               → Housing, Friends/Social Graph
  Housing UI              → Housing, Furniture/Decoration
```

---

## High-Risk Bottlenecks

These systems have the most dependents — mistakes here cascade widely:

| System | Dependents | Risk |
|---|---|---|
| Isometric Tile Renderer | 8 systems | CRITICAL — validate tile size (32×16px) in prototype before locking |
| Authentication / Account | 7 systems | CRITICAL — session model affects all persistence |
| Race Room (Colyseus) | 7 systems | CRITICAL — authoritative state schema drives all race systems |
| Item / Inventory | 6 systems | HIGH — schema must handle all 12 avatar slots + furniture + pickups |

---

## Recommended Design Order

Design GDDs in this order (dependency-safe + phase-priority ordered).
Note: the monolithic GDD covers most systems at a high level — per-system GDDs
add formulas, edge cases, and acceptance criteria needed before implementation.

```
 1. Isometric Tile Renderer      Phase 0  ← Foundation, most-depended-on
 2. Race Room (Colyseus)         Phase 1  ← Foundation, defines server state schema
 3. Item / Inventory             Phase 2  ← Core bottleneck for 6 systems
 4. Authentication / Account     Phase 0  ← Core bottleneck for 7 systems
 5. Player Movement              Phase 0
 6. Terrain System               Phase 1
 7. Respawn System               Phase 1
 8. Button / Trap System         Phase 1
 9. Pickup System                Phase 1
10. Scoring System               Phase 1
11. Matchmaking / Queue          Phase 1
12. Race UI                      Phase 1
13. Currency                     Phase 2
14. XP / Level System            Phase 2
15. Avatar Renderer              Phase 2
16. Avatar / Customization       Phase 2
17. Seasonal Leaderboard         Phase 2
18. Lobby / Crazy Town           Phase 3
19. Chat System                  Phase 3
20. Friends / Social Graph       Phase 3
21. Emote System                 Phase 3
22. Voice Chat                   Phase 3
23. Ambient / NPC System         Phase 3
24. Lobby UI                     Phase 3
25. Gacha System                 Phase 4
26. Store System                 Phase 4
27. Payment Integration          Phase 4
28. Economy UI                   Phase 4
29. Housing System               Phase 4
30. Furniture / Decoration       Phase 4
31. Guestbook                    Phase 4
32. Housing UI                   Phase 4
33. Redis Cache Layer            Phase 4
34. Database Persistence Layer   Phase 0 (scaffolded early, grows throughout)
```

---

## Progress Tracker

**Phase 0:** 1/6 systems designed
**Phase 1:** 1/7 systems designed
**Phase 2:** 1/7 systems designed
**Phase 3:** 0/6 systems designed
**Phase 4:** 0/8 systems designed

**Overall:** 3/34 systems designed

*Update this tracker as system GDDs are completed. Mark Status as "In Progress",
"Complete", or "Deferred" and add the GDD path.*
