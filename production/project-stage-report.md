# Project Stage Analysis — Crazy Stuff

**Date:** 2026-06-17 (rewritten; prior version dated 2026-03-22 described a pre-code "Systems Design" stage that is long obsolete)
**Stage:** Late vertical slice / early production
**Target:** Public launch-ready — see [`production/roadmap.md`](roadmap.md)

---

## Completeness Overview

| Domain | Status | Detail |
|---|---|---|
| **Design** | ~75% | Monolithic GDD + 5 per-system GDDs (auth, inventory, race, avatar, gacha); systems-index now reflects build status. Several v1 features still need detailed specs (store, leaderboard). |
| **Code** | ~70% of v1 | Core loop complete + deployed. Remaining: economy spend-paths, content depth, hardening, monetization. |
| **Architecture** | High | Phaser 3 + Colyseus + **MongoDB** (ADR-004 superseded PostgreSQL) + JWT auth, all in place and proven. |
| **Production** | Reset | Stale Phase-0 docs replaced by `roadmap.md` (M1–M4) + `sprint-002.md`. |
| **Tests** | Low | Only gacha is tested (`tests/unit/gacha.test.ts`, `tests/integration/gacha.int.test.ts`). Coverage gap is a known risk. |

---

## What Exists (built + deployed)

Full core loop: **login (email + Google) → walkable multiplayer lobby (chat, char select, equip) → ready-up queue → authoritative race (terrain, buttons, pickups, sprint/stamina, scoring) → results → XP/coins persist.** Plus: layered avatar rendering (incl. remote players), item/inventory with transactional equip, **free** gacha (crypto-RNG, pity, idempotent), and a separate **admin dashboard** repo. See [`systems-index.md`](../design/gdd/systems-index.md) for the per-system breakdown (17 Done · 8 Partial · 12 Not Started).

---

## Gaps → addressed by the roadmap

- **Loop polish:** invisible rewards, dead-end coins, race-can-stall → roadmap **M1**.
- **Content:** gacha pool is 25 common + 1 rare (pity dormant); no coin sink; no leaderboard → **M2** (art gated on PixelLab reset).
- **Hardening:** standalone Mongo (no txn guarantee), no rate-limit/password-reset/account-deletion → **M3**.
- **Monetization:** paid gacha coded but off; needs legal review + Stripe → **M4**.

---

## Approved Stack (corrected)

| Layer | Technology |
|---|---|
| Client Renderer | Phaser 3 + TypeScript + Vite |
| Multiplayer Rooms | Colyseus 0.15 |
| Backend API | Node.js + Express |
| Database | **MongoDB** (ADR-004; replaces PostgreSQL) |
| Cache / Session | Redis (planned, not yet wired) |
| Payments | Stripe (planned — M4) |
| Admin | Next.js (separate repo `crazy-stuff-admin`) |
| Platform | Browser (desktop-first) |

---

## Recommended Next Steps

1. **Sprint 2** (`production/sprints/sprint-002.md`) — Milestone 1 (loop polish) + M3-1 (replica set). Pure code; no PixelLab dependency.
2. When PixelLab resets — Milestone 2 (content): nail the item list, generate art, coin store, leaderboard.
3. Resolve the gacha legal question before any paid monetization (M4).
