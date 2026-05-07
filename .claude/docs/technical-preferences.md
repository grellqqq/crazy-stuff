# Technical Preferences

<!-- Populated by /setup-engine. Updated as the user makes decisions throughout development. -->
<!-- All agents reference this file for project-specific standards and conventions. -->

## Stack

- **Client Renderer**: Phaser 3 (browser-based, canvas/WebGL)
- **Multiplayer**: Colyseus (authoritative game rooms, WebSocket)
- **Backend API**: Node.js + Express (REST API)
- **Database**: MongoDB
- **Language**: TypeScript (client + server)
- **Platform**: Browser (no native app)

## Naming Conventions

- **Classes**: [TO BE CONFIGURED]
- **Variables**: [TO BE CONFIGURED]
- **Signals/Events**: [TO BE CONFIGURED]
- **Files**: [TO BE CONFIGURED]
- **Scenes/Prefabs**: [TO BE CONFIGURED]
- **Constants**: [TO BE CONFIGURED]

## Performance Budgets

- **Target Framerate**: [TO BE CONFIGURED]
- **Frame Budget**: [TO BE CONFIGURED]
- **Draw Calls**: [TO BE CONFIGURED]
- **Memory Ceiling**: [TO BE CONFIGURED]

## Testing

- **Framework**: [TO BE CONFIGURED]
- **Minimum Coverage**: [TO BE CONFIGURED]
- **Required Tests**: Balance formulas, gameplay systems, networking (if applicable)

## Forbidden Patterns

<!-- Add patterns that should never appear in this project's codebase -->
- [None configured yet — add as architectural decisions are made]

## Allowed Libraries / Addons

- **phaser** — client game renderer
- **colyseus** — multiplayer room server
- **colyseus.js** — Colyseus client SDK
- **express** — HTTP API server
- **mongodb** — MongoDB official Node.js driver
- **redis** / **ioredis** — Redis cache (leaderboard, session state, rate limiting)
- **stripe** — payment processing (gacha pulls, seasonal store)

## Architecture Decisions Log

- [ADR-001](../../docs/architecture/adr-001-phaser3-renderer.md) — Phaser 3 as client renderer
- [ADR-002](../../docs/architecture/adr-002-colyseus-multiplayer.md) — Colyseus for multiplayer rooms
- [ADR-003](../../docs/architecture/adr-003-postgresql-database.md) — PostgreSQL as primary database (**superseded by ADR-004**)
- [ADR-004](../../docs/architecture/adr-004-mongodb-database.md) — MongoDB as primary database
