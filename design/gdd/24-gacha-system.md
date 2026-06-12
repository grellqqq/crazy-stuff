# System #24 — Gacha System

> **Status**: Approved (design-review run 2026-06-12; all findings fixed in-place)
> **Author**: Gabriel + Claude Code agents
> **Last Updated**: 2026-06-12
> **Implements Pillar**: "Items feel meaningful because they are rare. Gacha creates excitement." + daily-login habit loop

## 1. Overview

The Gacha System is the game's randomized cosmetic-acquisition machine:
players spend a free daily pull or real money to receive a random item from
a rarity-weighted pool drawn from the item catalog. It is the primary faucet
for Epic/Legendary/Crazy items, the main daily-login habit driver, and (with
the seasonal store) one of the two monetization surfaces. Players interact
with it actively at the Gacha Machine in Crazy Town's plaza. Without it,
rarity tiers are meaningless (nothing scarce), daily logins have no hook,
and the game has no revenue path.

## 2. Player Fantasy

Anticipation and the jackpot moment. The free daily pull is a tiny ritual of
"maybe today" — a slot-machine lever that costs nothing and occasionally
erupts (0.1% Crazy = rainbow-animated, never sold). The fantasy targets are:
(a) the **lottery thrill** of the reveal animation, (b) the **collector's
pride** of owning what others don't, and (c) the **"I was there"** timestamp
of pulling a seasonal item before it vanished. Reference: Habbo rare drops +
Hearthstone pack-opening reveal pacing. This is a "love engaging with it"
system — the pull moment deserves real ceremony (build-up, rarity-colored
flash, reveal). It must NOT feel like infrastructure.

## 3. Detailed Rules

### 3.1 Core Rules

#### Pull types

1. **Daily free pull** — 1 per account per day. Availability:
   `players.lastFreePullAt` is before the most recent midnight UTC. No
   carryover, no banking — unused pulls vanish (creates the daily habit).
2. **Paid pulls** — $1.99 ×1, $8.99 ×5, $16.99 ×10 (prices are tuning
   knobs). Paid pulls consume **pull credits** (§3.3 Payment). A 10-pull
   guarantees at least one Rare-or-above: if slots 1–9 rolled no Rare+,
   slot 10's rarity roll is forced into the Rare+ tiers.

#### The roll (two-stage, catalog-driven)

1. **Rarity roll**: weighted across the six tiers (Common 50 / Uncommon 30
   / Rare 15 / Epic 4 / Legendary 0.9 / Crazy 0.1) — **renormalized over
   non-empty tiers only**. A tier is non-empty when at least one catalog
   item has that rarity and the `gacha` source tag. With today's catalog
   (25 Common + wizard_hat Rare) the effective disclosed odds are
   Common 76.9% / Rare 23.1%. As art lands in higher tiers, odds drift
   automatically toward the design targets — the pull screen always
   discloses the *computed current* odds, never the aspirational table.
2. **Item roll**: uniform among pool items within the rolled tier.

#### Pity

- A per-player counter (`players.pityCounter`) increments on every pull
  (free and paid) that yields below Epic.
- At 50, the next pull's rarity roll is forced to Epic+ (renormalized among
  non-empty Epic/Legendary/Crazy). Counter resets to 0 on any Epic+ result,
  forced or natural.
- **Dormancy rule**: while no Epic+ tier has items, the counter accumulates
  but never forces (nothing to force into). It triggers on the first pull
  after Epic+ content exists — early players' accumulated pity is honored.

#### Duplicates

Allowed. Each pull inserts a fresh inventory row via `addItem` (consistent
with inventory §3.2 no-stack = always-insert). Two identical tees are two
rows; future trading/gifting gives dupes value.

#### Rarity assignment

All current items are Common except `wizard_hat` (Rare). Every future item
declares its rarity in the catalog **before** implementation; the pool picks
it up automatically via the `sources: ['gacha']` tag. No per-item drop
weights — rarity is the only weighting lever.

#### Starter kit (replaces the dev grant)

New players receive exactly `worn_tshirt`, `blue_jeans`, `beatup_sneakers` —
granted on account creation and **auto-equipped** so new players spawn
dressed. The full-catalog dev grant in `ensureStarterItems` is removed at
gacha launch. **Grandfather rule**: existing accounts keep everything
already granted (early-access perk); narrowing affects new accounts only.

#### Atomicity & idempotency (implements inventory §3.9 caller obligations)

- Every pull request carries a client-generated `pullId` (UUID). The server
  records it in a `pulls` collection with a unique index on `pullId`.
- The sequence *consume entitlement → roll → addItem → pity update → record
  pull* runs inside `withTransaction` (S1-49, `src/server/src/db/mongo.ts`).
  A retried request with a known `pullId` returns the recorded result
  instead of re-rolling — no double-grants, no double-debits.
- **A multi-pull (5 or 10) is ONE transaction** containing all its rolls and
  grants — never N separate transactions. The Rare+ guarantee and mid-batch
  pity semantics (edge case 6) depend on the batch being atomic.
- Server rolls all randomness using a crypto-grade RNG
  (`crypto.randomInt`/`crypto.getRandomValues` — not `Math.random`); real
  money rides on these rolls. The client never sends a result.

### 3.2 States and Transitions

| State | Meaning | Transitions |
|---|---|---|
| `idle` | Machine available, shows current odds + pity counter | → `confirming` (player interacts) |
| `confirming` | Pull type chosen, cost shown | → `rolling` (confirm) / → `idle` (cancel) |
| `rolling` | Server transaction in flight | → `revealing` (success) / → `error` (fail; entitlement untouched — transaction rollback) |
| `revealing` | Ceremony animation, rarity-colored | → `result` (animation done / skip tap) |
| `result` | Item card shown, "again?" prompt | → `confirming` / → `idle` |

### 3.3 Interactions with Other Systems

| System | Direction | Interface |
|---|---|---|
| Item/Inventory (#08) | out | `addItem(userId, slot, itemId, rarity)` inside the pull transaction; catalog validation per inventory §3.9 |
| Currency (#09) | none at launch | Crazy Coins do not buy pulls (real money only). Provisional: if coin pulls are ever added, this doc owns the sink definition |
| Payment (#26) | in | Stripe checkout grants N **pull credits** to `players.pullCredits` (webhook-driven); the gacha machine consumes credits. Payment latency never blocks the roll; refunds map to credit deductions |
| Database (#04) | out | `pulls` collection (pullId unique, userId, result, rarity, timestamps), `players.pityCounter`, `players.lastFreePullAt`, `players.pullCredits` |
| Economy UI (#27) | out | Odds disclosure endpoint (computed renormalized odds), pity counter, pull credits balance, pull result payload |
| Seasonal Store (#25) | shared pool flag | Seasonal items may carry a `gachaSeasonal` flag entering the pool at their rarity during their month (details owned by Store GDD) |

## 4. Formulas

**F1 — Renormalized tier probability.** `P(t) = W_t / Σ W_u` over non-empty
tiers `u`. Weights `W`: Common 50, Uncommon 30, Rare 15, Epic 4,
Legendary 0.9, Crazy 0.1.
*Example (today's pool, C+R only):* P(C) = 50/65 = **76.92%**,
P(R) = 15/65 = **23.08%**.

**F2 — Per-item probability.** `P(item) = P(tier) / N_tier` (uniform within
tier). *Example:* P(wizard_hat) = 23.08% (only Rare item);
P(any specific common) = 76.92/25 = **3.08%**.

**F3 — Pity trigger.** Forced roll when `pityCounter ≥ 50`, over non-empty
Epic+ tiers renormalized. Full pool: weights 4 / 0.9 / 0.1 over their sum
5.0 → Epic 80% / Legendary 18% / Crazy 2% on the forced pull.

**F4 — 10-pull guarantee frequency.** Chance slot 10 needs forcing =
P(no Rare+)⁹. Today: 0.7692⁹ ≈ **9.4%** of 10-pulls; full-pool targets:
0.8⁹ ≈ **13.4%**.

**F5 — Free pull availability.**
`available = lastFreePullAt < floorToMidnightUTC(now)`. Server clock
authoritative; client countdown is cosmetic.

**F6 — Pull credits.** Stripe webhook: `pullCredits += {1, 5, 10}` per pack
($1.99 / $8.99 / $16.99). Paid pull action: `pullCredits -= batchSize`
(single = 1, 10-pull = 10), validated before the transaction.

**F7 — Reference expectations (tuning context, not rules).** Expected pulls
per Crazy at full pool = 1/0.001 = 1,000 (~2.7 years of daily-free-only
play). Legendary ≈ 111 free days — the realistic long-term free chase.

## 5. Edge Cases

1. **Double-tap / two tabs on free pull** — both submit distinct pullIds;
   availability is re-validated *inside* the transaction; the second commit
   fails on the `lastFreePullAt` write conflict and returns
   `FREE_PULL_USED`. One item granted, ever.
2. **Network retry, same pullId** — unique index hit → server returns the
   recorded result. No re-roll, no second item.
3. **Catalog changes between odds display and roll** — roll computes from
   the live catalog; the odds endpoint may be ≤60 s stale. Acceptable
   drift, no compensation.
4. **A tier empties (item retired)** — renormalization (F1) silently
   absorbs it; no error.
5. **Entire pool empty** — machine enters disabled state; pulls rejected
   `POOL_EMPTY`. (Guard only; 26 items exist.)
6. **Pity fires inside a 10-pull** — forced Epic+ lands on the slot where
   the counter hits 50; that result also satisfies the batch's Rare+
   guarantee. One forced roll can satisfy both guarantees.
7. **Pity counter > 50 from dormancy (e.g., 120)** — first pull after Epic+
   content exists is forced; counter resets to 0; surplus is **not** banked
   (no multi-trigger).
8. **Insufficient credits** — rejected `INSUFFICIENT_CREDITS` before any
   transaction starts. A 10-pull needs ≥10 credits regardless of pack
   origin (the Rare+ guarantee binds to the batch action, not the pack).
9. **Refund/chargeback after spending** — Payment may claw credits
   negative; negative balance blocks paid pulls until topped up. **Granted
   items are never revoked** (inventory invariant: items never disappear).
10. **Player doc missing mid-transaction** — `addItem` returns null →
    transaction aborts → nothing persisted.
11. **Same item twice in one 10-pull** — allowed; rolls are independent;
    duplicates rule applies.
12. **Crazy on the free daily pull** — fully allowed. That story is the
    marketing.
13. **Client clock skew** — the "next free pull" countdown is cosmetic;
    server rejects early requests with `FREE_PULL_USED`.

## 6. Dependencies

| System | Direction | Hard/Soft | Interface |
|---|---|---|---|
| Item/Inventory #08 | upstream | **Hard** | `addItem` + catalog as pool source; contract per its §3.9 (already lists gacha as caller — bidirectional ✅) |
| Database #04 | upstream | **Hard** | `pulls` collection; `players.{pityCounter, lastFreePullAt, pullCredits}` |
| Authentication #03 | upstream | **Hard** | authenticated userId on every pull request |
| Payment #26 | upstream | Soft | pull-credit grants via Stripe webhook — free daily works without Payment existing |
| Currency #09 | — | None at launch | coins don't buy pulls; provisional future sink owned by this doc if added |
| Economy UI #27 | downstream | — | odds endpoint, pity counter, credits balance, result payload |
| Store #25 | downstream | — | shares rarity model; `gachaSeasonal` pool flag (Store GDD owns details) |
| Lobby #13 | downstream | Soft | Gacha Machine placement in the plaza |

**Doc-sync obligations:**
- Inventory GDD §3.9 PLANNED `sources[]` catalog validation becomes a
  requirement of this system (gacha is the first multi-source faucet).
- Inventory GDD §3.5 "equip flow is not transactional" caveat is outdated
  since S1-49 (withTransaction) and needs a one-line correction.

## 7. Tuning Knobs

| Knob | Default | Safe range | Too low | Too high |
|---|---|---|---|---|
| Tier weights `W` | 50/30/15/4/0.9/0.1 | C 30–70, Crazy 0.05–0.5 | commons worthless, rares inflate, collection completes too fast | pulls feel like trash; Crazy >1% destroys its jackpot identity |
| Pity threshold | 50 | 20–100 | Epic+ becomes a token vending machine | bad-luck streaks churn paying players |
| 10-pull guarantee tier | Rare+ | Rare–Epic | (n/a, floor) | Epic+ guarantee makes 10-pulls the only rational buy, kills singles |
| Pull prices | $1.99 / $8.99 / $16.99 | bundle discount 10–25% | no reason to bundle | bundle cannibalizes singles entirely |
| Free pulls/day | 1 | 1–3 | — | dilutes the ritual; 3× faucet supply |
| Daily reset hour | 00:00 UTC | **set once, never move** | — | moving it creates double-pull or skipped-day edges |
| Odds cache TTL | 60 s | 10–300 s | endpoint hammering | stale disclosure vs live roll |
| Starter kit | tee+jeans+sneakers | 3–5 items | naked newbies | nothing left to chase |

**Interaction warning:** pity threshold ↓ and Crazy weight ↑ both inflate
top-tier supply — tune one at a time, never both in one patch.

All knobs live in external config (data-driven per coding standards), not
hardcoded. Source rationale: weights and pricing from monolithic GDD §9;
ranges from F1–F7 sensitivity.

## 8. Acceptance Criteria

1. **Odds correctness**: 100k simulated rolls per pool config → tier
   frequencies within ±0.5 pp of F1's computed odds (χ² pass).
2. **Idempotency**: same pullId submitted twice → byte-identical result,
   exactly 1 inventory row, exactly 1 `pulls` doc.
3. **Concurrency**: 10 parallel free-pull requests, same account → exactly
   1 success, 9 × `FREE_PULL_USED`.
4. **Pity**: forced sequence of 50 sub-Epic results → pull 51 is Epic+
   (when tier non-empty), counter resets to 0.
5. **10-pull guarantee**: batch with 9 forced commons → slot 10 is Rare+;
   batch with a natural Rare in slot 3 → no forcing occurs.
6. **Transactionality** (requires replica set): fault-injection kill
   between credit debit and item grant → after restart, account shows
   either complete pull or untouched state. Never a drained credit without
   an item.
7. **Daily reset**: pulls at 23:59:59 and 00:00:01 UTC both succeed; two
   pulls inside one UTC day → second rejected.
8. **Dormant pity honored**: counter accumulated past 50 with empty Epic+
   tiers → first pull after an Epic item enters the catalog is forced
   Epic+.
9. **Starter kit**: new account → exactly `worn_tshirt`, `blue_jeans`,
   `beatup_sneakers`, auto-equipped. Pre-existing account → full
   grandfathered inventory intact.
9b. **Backfill stopped**: a NEW item added to the catalog after gacha launch
    is NOT granted to existing players on their next login (the old
    ensureStarterItems backfill loop must be starter-kit-only). Verify by
    adding a test item and logging in with a pre-existing account.
10. **Disclosure**: pull-screen odds match the odds endpoint, which matches
    the live catalog within TTL.
11. **Performance**: pull transaction p95 < 250 ms server-side at 100
    concurrent players.

## 9. Open Questions

| # | Question | Owner | Resolve by |
|---|---|---|---|
| 1 | **Loot-box regulation**: real-money randomized cosmetics are restricted/banned in some markets (BE, NL) and may require age gating + odds disclosure elsewhere. Geo-block? Age gate? | Gabriel + release-manager | **before any paid pull ships** |
| 2 | Reveal ceremony spec (animation beats, rarity colors, audio stingers, 10-pull pacing/skip) | Economy UI GDD + art/audio directors | Economy UI design |
| 3 | Seasonal pool mechanics (`gachaSeasonal` rates, entry/exit timing) | Store GDD | Store design |
| 4 | Trading/gifting (gives dupes their value) | producer backlog | post-launch |
| 5 | Regional pricing & currency display | Payment GDD | Payment design |
| 6 | Exact flag/rollout for removing the dev grant (gacha + starter kit must land in the same deploy) | implementation plan | gacha implementation |
| 7 | Pool-depth launch gate: with 25 C + 1 R, "Rare" drops every ~4 pulls. Free daily can launch thin; should paid pulls wait for Uncommon/Rare/Epic depth (suggested: ≥10 U, ≥5 R, ≥2 E)? | Gabriel | before paid pulls ship (pairs with Q1) |
