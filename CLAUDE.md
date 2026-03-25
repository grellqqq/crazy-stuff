# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

# Claude Code Game Studios -- Game Studio Agent Architecture

Indie game development managed through 48 coordinated Claude Code subagents.
Each agent owns a specific domain, enforcing separation of concerns and quality.

## Technology Stack

- **Client**: Phaser 3 (browser, WebGL/Canvas) + TypeScript + Vite
- **Server**: Colyseus 0.15 (authoritative game rooms) + Express + TypeScript
- **Runtime**: Node.js with `tsx` for dev hot-reload
- **Database**: PostgreSQL (via `pg`)
- **Version Control**: Git with trunk-based development
- **Platform**: Browser only (no native app)

## Dev Commands

The repo uses npm workspaces. Run these from the **root**:

```bash
# Start client dev server (Vite, http://localhost:5173)
npm run dev

# Start game server (tsx watch, ws://localhost:3000)
npm run server

# Build client for production
npm run build --workspace=src/client

# Build server
npm run build --workspace=src/server

# Start built server
npm run start --workspace=src/server
```

The client connects to `ws://localhost:3000` hardcoded in `IsoScene.ts`. Both processes must be running for multiplayer to work.

## Game Architecture

### Client (`src/client/src/`)

- **`main.ts`** — Phaser game config entry point; registers `IsoScene`.
- **`IsoScene.ts`** — Single Phaser scene that owns everything: isometric tile grid rendering, avatar compositing, WASD input, and Colyseus room connection.

Key patterns in `IsoScene`:
- **Isometric math** — `tileToScreen(tileX, tileY)` and `isoDepth(tileX, tileY)` are the single source of truth for coordinate conversion and depth sorting. Never compute these inline.
- **Depth sort** — runs every frame in `update()` by calling `isoDepth()` on all `sortables` and all avatar layers. Hat layer gets `+0.05`, label gets `+0.1`.
- **Server-authoritative movement** — `setupInput()` sends `room.send('move', direction)` and does NOT update local position. The avatar position only changes when a `state` message arrives from the server.
- **Slot-based identity** — players are tracked by slot index (0-4), not by sessionId. Slot index is stable across occupant changes.
- **Avatar compositing** — each avatar has three layers: `body` (Graphics), `hat` (Graphics, local-only, H key toggle), `label` (Text). All three must be updated/destroyed together.

### Server (`src/server/src/`)

- **`index.ts`** — Express + Colyseus bootstrap. Registers `lobby` (LobbyRoom) and `race` (RaceRoom) rooms on port 3000.
- **`rooms/LobbyRoom.ts`** — Minimal lobby with Colyseus schema state tracking player count.
- **`rooms/RaceRoom.ts`** — Authoritative game room. Owns movement validation, slot assignment, and state broadcast.

Key patterns in `RaceRoom`:
- **State broadcast** — uses plain JSON via `this.broadcast('state', {...})`, NOT Colyseus schema delta sync. The client receives full slot array on every change.
- **Slot system** — 5 fixed `PlayerSlot` entries in `RaceState.slots`. On join, finds first unoccupied slot; on leave, resets slot fields and marks `occupied = false`.
- **Movement** — `MOVE_DELTAS` maps WASD to isometric `[dx, dy]` pairs. Bounds-clamped to `[0, GRID_MAX]` (14). Server calls `broadcastState()` after every valid move.
- **Grid** — 15×15 tiles. Players spawn at (7,7).

## Project Structure

@.claude/docs/directory-structure.md

## Engine Version Reference

@docs/engine-reference/godot/VERSION.md

## Technical Preferences

@.claude/docs/technical-preferences.md

## Coordination Rules

@.claude/docs/coordination-rules.md

## Collaboration Protocol

**User-driven collaboration, not autonomous execution.**
Every task follows: **Question -> Options -> Decision -> Draft -> Approval**

- Agents MUST ask "May I write this to [filepath]?" before using Write/Edit tools
- Agents MUST show drafts or summaries before requesting approval
- Multi-file changes require explicit approval for the full changeset
- No commits without user instruction

See `docs/COLLABORATIVE-DESIGN-PRINCIPLE.md` for full protocol and examples.

> **First session?** If the project has no engine configured and no game concept,
> run `/start` to begin the guided onboarding flow.

## Coding Standards

@.claude/docs/coding-standards.md

## Context Management

@.claude/docs/context-management.md
