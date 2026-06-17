# Milestone: Phase 0 — Foundation

**Target:** 2026-04-11
**Status:** ✅ Complete — superseded. This foundation milestone shipped and the project advanced far beyond it (full multiplayer, auth, inventory, gacha). Current plan: [`production/roadmap.md`](../roadmap.md).
**Sprint:** Sprint 1

## Goal

A playable single-player isometric scene in the browser. No multiplayer, no backend, no accounts. Pure client-side proof that the rendering and movement systems work.

## Deliverables

- [ ] S1-01: Repo & toolchain (TypeScript + Phaser 3 + Vite)
- [ ] S1-02: Isometric tile renderer with correct Y-sort depth
- [ ] S1-03: Player sprite rendering on tile map
- [ ] S1-04: Tile-based WASD movement (4 directions, snap-to-tile)
- [ ] S1-05: Avatar compositing PoC (2 slots)
- [ ] S1-06: Node.js + Express server skeleton

## Exit Criteria (Gate to Phase 1)

All of the following must be true before Phase 1 begins:

1. `npm run dev` opens a browser tab with an isometric tile grid
2. Player sprite moves tile-by-tile with WASD, no partial-tile positions
3. Depth sorting is correct for all tested sprite/tile combinations
4. Tile size is locked (32×16px confirmed or revised with rationale)
5. Server skeleton runs at `localhost:3000` with Colyseus and pg installed

## What Phase 1 Builds On Top Of

Phase 1 (Race Prototype, Weeks 4–7) assumes:
- The isometric renderer is stable and the Y-sort function is locked
- Tile-based movement is working (Colyseus will extend it, not replace it)
- TypeScript toolchain is in place for both client and server
