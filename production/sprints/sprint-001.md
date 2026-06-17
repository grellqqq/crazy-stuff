# Sprint 1 — Phase 0: Foundation

**Dates:** 2026-03-22 → 2026-04-11
**Status:** ✅ Complete — superseded. Phase-0 foundation shipped; the project advanced far past this (full multiplayer, auth, inventory, gacha). See [`production/roadmap.md`](../roadmap.md) and [`sprint-002.md`](sprint-002.md) for current work.

## Sprint Goal

Browser tab opens to a playable isometric scene — tile grid renders, player sprite moves tile-by-tile with WASD, depth sorting works correctly.

## Capacity

- Total days: 9 (3 weeks × 3 days/week)
- Buffer (20%): 2 days reserved for unplanned work
- Available: 7 days

## Tasks

### Must Have (Critical Path)

| ID | Task | Est. | Dependencies | Acceptance Criteria |
|---|---|---|---|---|
| S1-01 | Repo & toolchain setup — TypeScript + Phaser 3 + Vite, folder structure (`src/client/`, `src/server/`), dev server, lint/format | 0.5d | — | `npm run dev` serves game in browser with no errors |
| S1-02 | Isometric tile renderer — Phaser 3 scene, 32×16px tile grid, centralized Y-sort depth function, static 12×12 test map | 2d | S1-01 | 144 tiles render correctly; sprites at higher Y render in front of sprites at lower Y |
| S1-03 | Player sprite on map — placeholder sprite at tile position, correct depth sort relative to tiles | 0.5d | S1-02 | Player sprite visually behind tiles above it, in front of tiles below it |
| S1-04 | Tile-based movement — WASD input, 4-directional, one tile per step, snap on completion, direction-facing sprite | 1d | S1-03 | Player moves one tile per keypress; no partial-tile positions possible |

### Should Have

| ID | Task | Est. | Dependencies | Acceptance Criteria |
|---|---|---|---|---|
| S1-05 | Avatar compositing PoC — 2 sprite layers (body + hat slot) composited and depth-sorted as one unit; equip/unequip from code | 1.5d | S1-03 | Equipping hat in code shows it on player sprite at correct position in all 4 directions |
| S1-06 | Node.js + Express server skeleton — TypeScript, `/health` endpoint, Colyseus installed (not yet wired), PostgreSQL client installed (not yet connected) | 1d | S1-01 | `curl localhost:3000/health` returns `{ status: "ok" }`; Colyseus and pg packages present |

### Nice to Have

| ID | Task | Est. | Dependencies | Acceptance Criteria |
|---|---|---|---|---|
| S1-07 | Click-to-move — clicking a tile navigates the player there (straight-line, no obstacle avoidance) | 0.5d | S1-04 | Clicking any tile within 5 tiles moves the player there step-by-step |

## Risks

| Risk | Probability | Impact | Mitigation |
|---|---|---|---|
| Y-sort depth bug — overlapping sprites render in wrong order at tile edges | HIGH | HIGH | Build a visual test with 3+ overlapping sprites before moving on; fix the sort function before any other rendering work |
| Tile size wrong — GDD flags 32×16px as "to be confirmed" | MEDIUM | HIGH | During S1-02, render a real pixel art reference tile and eyeball it; lock the size before S1-03 |
| No placeholder assets — S1-03/S1-04 blocked without sprites | MEDIUM | MEDIUM | Use a colored rectangle + directional arrow as placeholder; no art dependency for Sprint 1 |
| Part-time schedule — deep work on renderer interrupted across days | MEDIUM | LOW | Time-block renderer work (S1-02) as a single 2-day block; avoid splitting across non-consecutive days |

## Definition of Done

- [ ] All Must Have tasks completed and acceptance criteria verified
- [ ] No broken states in the browser (no console errors on load)
- [ ] Y-sort depth function centralized and documented — one function, called every frame
- [ ] Tile size locked (32×16px confirmed or revised)
- [ ] Code committed to `main`
