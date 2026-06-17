# Sprint 2 — Milestone 1: Loop Polish & Robustness (+ replica-set infra)

**Dates:** 2026-06-17 → (open)
**Status:** Active
**Roadmap:** Milestone 1 (all) + M3-1. See [`production/roadmap.md`](../roadmap.md).

## Sprint Goal

The core loop *feels finished* — rewards are visible, no dead-ends, races can't stall — and the deployed MongoDB is a replica set so the economy can run transactionally. All pure code/ops; **no PixelLab dependency** (content art waits for the credit reset).

## Tasks

### Must Have

| ID | Roadmap | Task | Est. | Acceptance |
|---|---|---|---|---|
| S2-01 | M1-1 | Show **+XP / +Coins earned** on the race results screen | 0.5d | Results shows the per-match XP + coins gained, not just totals |
| S2-02 | M1-2 | Remove/replace the **fake "visit the store" copy** | 0.25d | No UI references a store that doesn't exist |
| S2-03 | M1-3 | **Max-race-time cap** in `RaceRoom` (force-end if nobody finishes) | 0.5d | A race with zero finishers ends within the cap; players return to lobby |
| S2-04 | M1-4 | **Block mid-race joins** (`onJoin` refuses when `phase !== Waiting`) | 0.5d | Joining a Racing room is refused, not spawned at the start line |
| S2-05 | M3-1 | **MongoDB replica set** (deployed Docker → single-node replica set) | 0.5d (ops) | Server logs `transactions supported`; gacha pulls run transactionally |

### Should Have

| ID | Roadmap | Task | Est. | Acceptance |
|---|---|---|---|---|
| S2-06 | M3-2 | **Auth rate-limiting** (register/login + room message spam) | 1d | Repeated auth attempts / message floods are throttled server-side |

### Done this sprint (meta)

| ID | Roadmap | Task | Status |
|---|---|---|---|
| S2-07 | M1-5 | Sync production docs to reality (roadmap, systems-index, stage report, active.md) | ✅ Done |

## Risks

| Risk | Prob | Impact | Mitigation |
|---|---|---|---|
| Replica-set conversion loses data (Docker container recreated without reusing the data volume) | MED | HIGH | Identify + reuse the existing data volume; `mongodump` backup before recreating |
| `rs.initiate` host mismatch (member host not reachable by the app) | MED | MED | Initiate with the host the app connects to; use `directConnection=true` for single-node |
| Rate-limit false positives lock out real players | LOW | MED | Generous limits; per-IP + per-account; log before enforcing |

## Definition of Done

- [ ] All Must-Have acceptance criteria verified — including a **2-player playtest** of the results screen + no-finisher race (motion-QA: watch it live, not idle)
- [ ] Replica set confirmed in deploy logs (`transactions supported`)
- [ ] No console errors; client + server build clean
- [ ] Committed to `main` (game repo)
