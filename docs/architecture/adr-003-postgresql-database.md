# ADR-003: PostgreSQL as Primary Database

**Date:** 2026-03-22
**Status:** Superseded by [ADR-004](adr-004-mongodb-database.md) (2026-04-07)
**Deciders:** Gabriel

---

## Context

Crazy Stuff requires persistent storage for:
- Player accounts and authentication
- Avatar inventory (items owned per player, equipped state per slot)
- Player housing state (room layout, placed furniture)
- Progression data (XP, level, Crazy Coins balance)
- Seasonal leaderboard scores and history
- Gacha pity counters (must be durable — loss of pity data is a trust issue)
- Transaction records (purchases, gacha pulls)

## Decision

Use **PostgreSQL** as the primary database.

## Rationale

- Relational model fits the structured, inter-related data (player → inventory → items → slots)
- ACID transactions are critical for gacha pulls (atomically deduct currency + grant item + update pity counter)
- Strong consistency guarantees for leaderboard updates and economy operations
- Mature tooling, excellent Node.js drivers (pg, postgres.js)
- Hosted easily on existing DigitalOcean droplet (managed Postgres or self-hosted)
- JSON column support available for flexible housing layout storage if needed

## Alternatives Considered

- **MongoDB** — Flexible schema is appealing for inventory, but lack of multi-document ACID transactions is a risk for gacha/economy operations
- **SQLite** — Too limited for multi-user concurrent access
- **PlanetScale / Neon** — Serverless Postgres options; valid but adds vendor dependency; DigitalOcean managed Postgres preferred

## Consequences

- All durable player data goes through PostgreSQL
- Gacha pull logic must run inside a database transaction (currency deduct + item grant + pity update = atomic)
- Redis is used alongside PostgreSQL for ephemeral data (leaderboard cache, room session state, rate limiting) — PostgreSQL is NOT used for high-frequency transient state
- Schema migrations required as content expands (items, seasons, new systems)
- Express API owns all database access; Colyseus rooms call the API for persistence, not the DB directly
