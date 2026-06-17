# Crazy Stuff — Roadmap to Public Launch

**Updated:** 2026-06-17
**Target:** Public launch-ready (free multiplayer racing + cosmetic gacha, with monetization switched on after the legal + infra gates)
**Stage:** Late vertical slice / early production — core loop complete, hardening + breadth remain.

> This is the live go-forward plan. Status of every system is in
> [`design/gdd/systems-index.md`](../design/gdd/systems-index.md). Vision/pillars
> are in [`design/gdd/crazy-stuff-gdd.md`](../design/gdd/crazy-stuff-gdd.md).
> Effort: **S** = <1 day · **M** = 1–3 days · **L** = 3+ days.

---

## Where we are (current reality)

The full core loop works end-to-end and is deployed (Dokploy): **login → walkable lobby → ready-up queue → authoritative race → results → XP/coins persist.** Auth (email + Google), inventory/equipment with layered avatar rendering, terrain/buttons/pickups/scoring, and a working **free** gacha (the only tested system) are all built. An admin dashboard (separate repo) manages players/accounts/items.

What's missing is **breadth** (content depth, spend-paths, social/housing) and **launch-hardening** (replica set, abuse protection, GDPR), plus the **monetization** turn-on (gated by a legal review). None of the remaining core-loop work carries the technical risk that's already been retired.

---

## Milestone 1 — Loop Polish & Robustness  *(pure code — START NOW, no PixelLab)*

Make the loop that already exists *feel* finished and not stall.

| ID | Task | Effort | Acceptance |
|---|---|---|---|
| M1-1 | Show **+XP / +Coins earned** on the race results screen (`IsoScene` results) | S | After a race, results displays the XP and coins gained this match (not just totals) |
| M1-2 | Remove/replace the **fake "visit the store" copy** (`LobbyScene` inventory empty-state, etc.) until the store exists | S | No UI references a store that isn't there |
| M1-3 | **Max-race-time cap** in `RaceRoom` — force-end a race after a hard time limit even if nobody finishes (race GDD §5.3.3 gap) | S | A race with zero finishers ends within the cap and returns players to lobby |
| M1-4 | **Block mid-race joins** — `RaceRoom.onJoin` refuses when `phase !== Waiting` (race GDD §5.1.3 gap) | S | Joining a room already Racing is refused, not spawned at the start line |
| M1-5 | **Sync production docs** to reality (this roadmap, systems-index, stage report, `active.md`) | S | Docs match the code; no "Phase 0 / PostgreSQL / 0% code" claims remain |

---

## Milestone 2 — Content & the "Collect" hook  *(art is PixelLab-gated)*

The gacha/pity machinery is built but **dormant** — only 25 Common + 1 Rare items exist. This milestone gives the "collect" pillar something to collect and gives coins a purpose.

| ID | Task | Effort | Gate | Acceptance |
|---|---|---|---|---|
| M2-1 | **Nail down the full item catalog** — items per slot across Uncommon→Crazy tiers (design decision with Gabriel — see Open Topics) | M | Gabriel's item list | Approved catalog rows in `shared/items.ts` |
| M2-2 | **Generate item art** (PixelLab) for the new tiers | M | **PixelLab reset** (0 gen now) | Sprite sheets on disk for every new catalog item; render in lobby + race |
| M2-3 | **Coin store in the lobby** — a store location + UI to spend Crazy Coins on cosmetics (gives currency a sink) | M | M2-1 | Walk to store → buy with coins → item appears in inventory |
| M2-4 | **Seasonal leaderboard + Leaderboard Wall** in the lobby | M | — | Top players by score/XP shown; wall location in lobby |
| M2-5 | **Real gacha-machine art** (replace placeholder primitive) | S–M | PixelLab reset | Gacha machine uses finished art |

---

## Milestone 3 — Launch Hardening  *(pure code/ops — can run alongside M1)*

Required before opening to the public.

| ID | Task | Effort | Acceptance |
|---|---|---|---|
| M3-1 | **MongoDB replica set** (deployed) — convert the Docker Mongo to a single-node replica set | S (ops) | Server logs "transactions supported"; gacha pulls run transactionally. **Gate for M4 paid.** |
| M3-2 | **Auth + room rate-limiting** (register/login, message spam) | M | Brute-force / spam is throttled server-side |
| M3-3 | **Password reset** flow (transactional email) | M | User can reset a forgotten password by email |
| M3-4 | **Email verification** | M | New accounts verify their email |
| M3-5 | **Account deletion** (GDPR) — user-initiated, purges their data | M | A user can delete their account + all associated data. **EU-blocking without it.** |
| M3-6 | **Ops basics** — structured logging, health/readiness, review graceful-degradation paths | S–M | Errors are logged with context; deploy has health checks |

---

## Milestone 4 — Monetization  *(large, gated)*

Do **not** ship paid randomized cosmetics before M3-1 (replica set) **and** M4-1 (legal).

| ID | Task | Effort | Gate | Acceptance |
|---|---|---|---|---|
| M4-1 | **Gacha legal review** + age/geo gate (loot-box rules — BE/NL restricted; gacha GDD §9 Q1) | M (mostly external) | legal decision | Documented compliance stance; gate enforced in code |
| M4-2 | **Stripe payment integration** | L | M4-1 | Test-mode purchase grants pull credits/coins atomically |
| M4-3 | **Paid store + economy UI** (pull credits, seasonal store) | M | M4-2 | Players can buy credits/coins and spend them |
| M4-4 | **Enable paid gacha** (`PAID_ENABLED=on`) | S | M3-1 + M4-1 | Paid pulls work end-to-end, transactionally |

---

## Gates (hard dependencies)

- **PixelLab reset** → blocks M2 art (M2-2, M2-5). Generations exhausted (5009/5000); refills on the monthly billing cycle. *Do M1 + M3 (code-only) while we wait.*
- **MongoDB replica set (M3-1)** → blocks M4-4 (paid pulls must be transactional).
- **Gacha legal review (M4-1)** → blocks all paid monetization.

---

## Post-launch / V2 (documented, deferred)

Designed but intentionally out of v1 scope: **Housing** (system, furniture, guestbook, housing UI — #33–36), **Voice chat** (#29), **Emotes** (#30), **Friends/social graph** (#31), **Ambient/NPC** (#14), seasonal lobby theming, XP **milestone-reward unlocks**, avatar **skin-slot migration** (#12, unify body into inventory), reconnect grace window, proximity/global chat scopes.

---

## Open design topics (to detail with Gabriel in follow-ups)

Gabriel has more in mind than the v1 path above. To capture before they're lost:
- **Full item list "nailed down"** — the complete cosmetic catalog by slot + rarity (feeds M2-1).
- **Store placement in the lobby** — where the store location sits in Crazy Town and how it presents.
- **Housing** — rooms, furniture, display cases, guestbook (V2 design pass).
- **Additional vision items** — Gabriel to enumerate; slot into v1 vs V2 as they come.

---

## Suggested sequencing

1. **Now (code, no PixelLab):** M1 in full, M3-1 (replica set) + start M3-2…M3-5.
2. **When PixelLab resets:** M2-1 (catalog) → M2-2 (art) → M2-3 (store) → M2-4 (leaderboard) → M2-5 (gacha art).
3. **After legal + replica set:** M4.
4. **Post-launch:** V2 systems.
