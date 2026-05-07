# ADR-004: MongoDB as Primary Database

**Date:** 2026-04-07
**Status:** Accepted
**Supersedes:** [ADR-003](adr-003-postgresql-database.md)
**Deciders:** Gabriel

---

## Context

ADR-003 selected PostgreSQL via Supabase. During Sprint 1, the auth and data
layer was migrated off Supabase (custom JWT replaced Supabase Auth). With the
persistence layer being rewritten anyway, the database choice was reopened.

## Decision

Use **MongoDB** as the primary database. The PostgreSQL/Supabase path from
ADR-003 is retired.

## Rationale

- **Developer familiarity** — Gabriel has significantly more day-to-day
  experience with MongoDB than with Postgres/Supabase. For a solo indie
  project, time-to-feature is the dominant constraint and familiarity
  translates directly to that.
- **Schema flexibility for early content iteration** — equipment slots,
  inventory items, loadouts, and gacha drop tables are still being designed.
  Document schema absorbs shape changes without migration scripts.
- **Denormalized fit** — `players.equippedLoadout` is read on every
  world-state broadcast; storing it on the player document avoids a join on
  the hot path.
- **Driver quality** — official Node.js driver with first-class TypeScript
  types.

## Alternatives Considered

- **Stay on PostgreSQL** (managed via Neon, DigitalOcean Managed PG) —
  Stronger ACID story, but operating outside Gabriel's strongest stack
  outweighed the gain.
- **SQLite** — Disqualified for the same reason as ADR-003: no concurrent
  multi-user access.

## Consequences

- All durable data (users, players, inventory) lives in MongoDB collections
  (`crazystuff` database).
- Indexes are created in code on connect (`src/server/src/db/mongo.ts`) rather
  than via a migration tool — must be kept in sync as fields are added.
- **Gacha and economy operations need explicit multi-document transactions
  before any monetized launch.** The original ACID concern from ADR-003
  (atomic currency deduct + item grant + pity counter update) still applies.
  Current code in `mongo.ts` does NOT wrap these in `withTransaction()`
  blocks. **Tracked as a launch blocker for the gacha system.**
- Redis is still slated for ephemeral state (leaderboard cache, rate
  limiting). Unchanged from ADR-003.
- `pg` driver, type defs, and `schema.sql` were removed in commit `91e7fb7`.

## Migration Notes

Migrated in commit `2c9167c` (S1-35, 2026-04-07). No production data needed
migration — project had not launched.
