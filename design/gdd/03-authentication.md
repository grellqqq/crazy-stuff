---
status: reverse-documented
source: src/server/src/auth/routes.ts, src/client/src/auth.ts, src/server/src/db/mongo.ts (users collection)
date: 2026-04-27
verified-by: Gabriel
---

# System #03 — Authentication / Account

> **Note:** This document was reverse-engineered from the existing
> implementation (Sprint 1, post-S1-35 Supabase → MongoDB migration). It
> captures current behavior plus design intent clarified with the project
> lead. Sections marked **[PLANNED]** describe target state not yet
> implemented; **[GAP]** marks current behavior that must be addressed
> before public launch.

## 1. Overview

The Authentication / Account system owns player identity. It establishes who
a player is (email, username, Google account), proves it on every request
(JWT-signed sessions), and provides a stable `userId` that every other
persistent system keys against — inventory, currency, XP, race results,
friends, housing.

Three sign-in paths converge on a single MongoDB `users` collection: **email
+ password registration** (with bcrypt password storage), **username +
password login** (the primary day-to-day login flow), and **Google OAuth**
(one-tap or popup via Google Identity Services). Sessions are JWT-based —
the server signs a 7-day token on successful authentication, the client
stores it in `localStorage`, and presents it on subsequent requests as a
`Bearer` header. Token validation is stateless: the server verifies
signature + expiry, no session-store lookup required.

The `userId` issued by this system is the **single foreign key** every
other system uses to look up a player's data. Inventory rows reference it
as `playerId`; race rooms send it as `authId` to attribute XP/coin awards;
the player document on `players` collection joins to it as `userId`. There
is no other identity. If this system fails or its trust boundaries leak,
every persistent system's integrity collapses — making this Layer-0
foundation the highest-stakes security surface in the codebase.

## 2. Player Fantasy

Players want to **log in once and stay logged in**. They don't think about
authentication — they think about getting back into the game. The system's
job is to make that invisible: open the page, see your character, play.

First-time players want **frictionless onboarding**. The Google one-tap
button means a player who's already signed into a Google account in the
same browser can be racing in two clicks. For players without Google (or
who prefer not to link it), the email + password path takes 30 seconds:
pick a username, an email, a password, you're in. The same flow ends with
starter items already in the inventory and an avatar visible on screen —
no setup wizard, no profile page, no email verification interruption.

Returning players want **persistence**. Their username is theirs across
sessions, their items don't get forgotten, their progress carries forward.
Closing the browser and re-opening it tomorrow restores them to the same
identity, the same inventory, the same XP. The only time the system asks a
player to do anything is when their session has truly expired (7 days) —
then they sign in once more and are back.

Behind it all, a quiet promise: **only you control your account**. No one
can pretend to be you, claim your items, or wear your hard-won legendary
outfit. Your username belongs to you. Your inventory belongs to you. The
system enforces that boundary invisibly — players don't see the JWT
verification or the bcrypt hash, but they trust that the line between "me"
and "everyone else" is real.

## 3. Detailed Rules

### 3.1 User Schema

Two MongoDB collections store account data. The `users` collection owns the
**identity** (how to authenticate a request); the `players` collection
(managed by System #08 / persistence layer) owns the **gameplay state**
(XP, coins, equipped loadout). A 1:1 relationship between them via
`players.userId → users._id`.

#### `users` collection

Source: indexes in `src/server/src/db/mongo.ts:20-22`, fields in
`createUser`/`createGoogleUser` (lines 67-94).

| Field | Type | Description |
|-------|------|-------------|
| `_id` | ObjectId | MongoDB-assigned primary key. Surfaces to clients as the string `userId`. **Immutable.** |
| `email` | string \| null | Lowercased. Unique. May be `null` for legacy/edge accounts but in practice every account has one. |
| `passwordHash` | string \| null | bcrypt hash (cost 10). `null` for Google-only accounts that never set a password. |
| `googleSub` | string \| null | Google's stable subject ID (`sub` claim). Unique, sparse. `null` for password-only accounts. |
| `username` | string | Sanitized, max 20 chars, alphanumeric + spaces only. Unique. The primary player-facing identifier. |
| `createdAt` | Date | Account creation timestamp. |

#### Indexes

```ts
users.email      → unique
users.username   → unique
users.googleSub  → unique sparse  (sparse so multiple null googleSub values don't conflict)
```

All three are enforced at the database level. Duplicate-key errors during
registration surface to the client as user-friendly messages.

#### Auth modality matrix

A user document may represent one of three auth states:

| `passwordHash` | `googleSub` | Auth modality |
|----------------|-------------|---------------|
| set | null | Password-only account |
| null | set | Google-only account |
| set | set | Linked account — can log in via either method |

Linking happens automatically when a Google login finds an existing account
by email (see §3.4). Once linked, both paths produce the same JWT against
the same `_id`. **[GAP — security]** This auto-link is a known
account-takeover vector; safer pattern documented in §3.4.

#### Why username is the primary login identifier (not email)

Industry split: many games use email-as-login, many use username-as-login.
Crazy Stuff chose **username** for `/auth/login` because:

- Players think of themselves by their in-game name. Memorable.
- Email exposes a privacy surface during login (typing in a public stream,
  etc.).
- The username is already the public identity — using it for login adds no
  leak.

Email is still required at registration (for future password reset + spam
control) but is never the lookup key for day-to-day login.

#### Schema constraints

- **`username` immutable post-registration.** Today there's no rename API.
  **[OPTIONAL FUTURE]** could add a "change username" feature with a coin
  cost, but every system that displays the username (chat, race results,
  leaderboards, house plaques) would see the change — needs a propagation
  strategy.
- **`email` mutable but rarely changed.** No API today. **[PLANNED]**
  "change email" with verification of new email before swap.
- **`_id` never exposed in clear text outside of being the `userId` value.**
  The `userId` is sent to the client (in JWT payload + `/auth/me` response)
  but is not used as a public-facing handle.

#### Player-document linkage

Every authenticated user gets a `players` collection document on first
login (lazily created by `getOrCreatePlayer`). The link is
`players.userId === users._id.toString()`. The two are conceptually one
logical "account" split across two collections for separation of concerns:
identity vs. gameplay state.

**Cascade rule [PLANNED]:** if a `users` document is ever deleted (account
deletion request, GDPR), the corresponding `players` doc and all
`inventory` rows must be deleted in the same transaction. Today there's no
delete-account flow.

### 3.2 Email + Password Registration

Endpoint: `POST /auth/register`. Source: `src/server/src/auth/routes.ts:31-66`.

#### Request

```ts
POST /auth/register
Content-Type: application/json

{
  "email": "player@example.com",
  "password": "minimum6chars",
  "username": "PlayerName"
}
```

#### Response (200)

```ts
{
  "token": "<JWT>",
  "user": { "id": "<userId>", "username": "...", "email": "..." }
}
```

#### Validation rules (in order)

1. **All three fields required.** Missing any → `400 { error: "email, password, and username are required" }`.
2. **Password length ≥ 6.** Below → `400 { error: "Password must be at least 6 characters" }`. **[PLANNED]** strengthen to ≥ 8 + complexity rules before public launch.
3. **Username sanitized:** strip non-alphanumeric, max 20, fallback `'Player'` (same `cleanUsername` helper used everywhere).
4. **Email uniqueness check:** `findUserByEmail(email)` — if exists → `409 { error: "Email already registered" }`.
5. **Username uniqueness:** enforced at DB layer. Duplicate-key errors surface as `500 { error: "Username or email already taken" }` (current generic message).

#### Side effects on success

1. **Hash password:** `bcrypt.hash(password, 10)`.
2. **Insert `users` doc:** `{ email, passwordHash, googleSub: null, username, createdAt }`.
3. **Create player record + starter items:** `getOrCreatePlayer(userId, username)` (System #08 entry point — grants the 3 starter items).
4. **Sign JWT** with 7d expiry, return to client.

The registration is **transactional in spirit but not technically atomic**
— if step 3 fails after step 2 succeeds, the user exists with no player
doc. Recoverable: next login auto-runs `getOrCreatePlayer` (idempotent),
creating the player record. Worst case the user logs in once with no
starter items but the next race-end will lazy-create their player record.

#### Failure modes

| Code | Cause | Body |
|------|-------|------|
| 400 | Missing email/password/username | `"email, password, and username are required"` |
| 400 | Short password | `"Password must be at least 6 characters"` |
| 409 | Email collision | `"Email already registered"` |
| 500 | DB duplicate-key on username | `"Username or email already taken"` |
| 500 | Other DB error | `"Registration failed"` |

### 3.3 Username + Password Login

Endpoint: `POST /auth/login`. Source: `routes.ts:70-96`.

#### Request

```ts
POST /auth/login
Content-Type: application/json

{
  "username": "PlayerName",
  "password": "theirPassword"
}
```

#### Response (200)

Same shape as registration: `{ token, user: { id, username, email } }`.

#### Validation rules

1. **Both fields required.** Missing → `400 { error: "Username and password are required" }`.
2. **User lookup:** `findUserByUsername(username)`. If missing OR has no
   `passwordHash` (Google-only account) → `401 { error: "Invalid username or password" }`.
   **Generic error by design** — does not leak whether the username exists
   vs. the password is wrong.
3. **Password comparison:** `bcrypt.compare(password, user.passwordHash)`.
   Mismatch → same generic 401.

#### Side effects on success

Sign JWT with 7-day expiry, return to client. **No DB writes** — login is
read-only on the auth path. (Last-login timestamps are not tracked today;
**[OPTIONAL FUTURE]** if needed for analytics or spam detection.)

#### Why username, not email

Documented in §3.1. Email-based login is **not implemented**. A user who
has forgotten their username but knows their email has no recovery path
today. **[PLANNED]** password reset flow (§3.10) will use email as the
lookup key, partially closing this gap.

#### Generic error messages

The same `"Invalid username or password"` message is returned for:

- Username doesn't exist
- User has no `passwordHash` (Google-only)
- Password doesn't match

This prevents username-enumeration attacks (an attacker can't probe the
system to discover which usernames are registered). Standard pattern.

#### Failure modes

| Code | Cause | Body |
|------|-------|------|
| 400 | Missing fields | `"Username and password are required"` |
| 401 | User not found, no password, or bad password | `"Invalid username or password"` |
| 500 | DB error | `"Login failed"` |

### 3.4 Google OAuth (with account merging)

Endpoint: `POST /auth/google`. Source: `routes.ts:117-152`.

Google sign-in flow uses **Google Identity Services (GSI)** on the client to
obtain an ID token. The token is sent to the server, which verifies it via
Google's tokeninfo endpoint and either looks up or creates a corresponding
user.

#### Client-side flow

1. Player clicks "Sign in with Google."
2. Client loads GSI script (`https://accounts.google.com/gsi/client`)
   lazily.
3. Client calls `google.accounts.id.initialize({ client_id })` then
   `prompt()`.
4. If one-tap is blocked (browser settings, no Google session), client
   falls back to rendering a hidden GSI button and clicking it to open a
   popup.
5. On user consent, GSI returns an `idToken` (JWT signed by Google).
6. Client sends `POST /auth/google` with `{ idToken, username }`. Username
   is asked for explicitly via `prompt()` if the field was empty.

Source: `src/client/src/auth.ts:87-120` (`googleSignIn`),
`auth.ts:245-263` (button handler).

#### Server-side verification (`verifyGoogleToken`, routes.ts:100-115)

1. Server fetches
   `https://oauth2.googleapis.com/tokeninfo?id_token=<token>`.
2. Validates `data.aud === GOOGLE_CLIENT_ID` (the configured client ID for
   this app). Mismatched audience → reject.
3. Requires `data.sub` and `data.email` to be present.
4. Returns `{ sub, email, name }` if valid, `null` otherwise.

**Why tokeninfo and not signature verification:** simpler, no key-rotation
logic, Google handles validation server-side. Trade-off: one extra HTTP
round-trip per Google login. Acceptable at current scale. **[OPTIONAL
FUTURE]** migrate to local JWKS-based signature verification if Google
login volume grows enough that the round-trip cost matters.

#### Account resolution

After successful verification:

1. **Lookup by Google sub:** `findUserByGoogleSub(googleUser.sub)`.
   - If found → use this account, sign JWT, done.
2. **Lookup by email:** if no Google-sub match, `createGoogleUser` checks
   email first.
   - If found → **link Google sub to existing account** (sets `googleSub`
     field on the existing user doc). This is the auto-merge behavior.
   - If not found → create a new user with `passwordHash: null`,
     `googleSub: <sub>`, the supplied username.
3. Ensure `players` doc exists via `getOrCreatePlayer`.
4. Sign JWT, return.

#### Account merging — current behavior is unsafe **[GAP — security]**

The current auto-link flow has a known vulnerability:

> **Scenario:** Alice registers with `alice@example.com` + password.
> Mallory acquires a Google idToken for `alice@example.com` (e.g., Alice's
> Google account is compromised separately, or the email is at a domain
> Mallory controls). Mallory POSTs to `/auth/google` with that idToken.
> Server finds the existing Alice account by email, links Mallory's Google
> sub to it. Mallory now has full access — she got a JWT for Alice's
> account without ever knowing Alice's password.

**Target safer pattern (industry standard):**

1. If Google login finds an existing email-matched user with a
   `passwordHash` set, **do not auto-link.** Instead:
   - Return `409 { error: "Account exists. Sign in with password to link Google." }`
     to the client.
   - Client shows a "verify password to link" flow.
   - Only after the user proves password ownership does the server set
     `googleSub` on the account.
2. If the existing user has **no** `passwordHash` (Google-only), the link
   is safe — auto-link is fine.
3. If no existing user, create new (current behavior is fine).

Implementation deferred to security-hardening pass before public launch.

#### Username handling on Google login

- Client always asks for a username before sending (prefilled from the
  input field, falls back to `prompt()`, falls back to Google name, falls
  back to email prefix).
- Server runs the same `cleanUsername` sanitization.
- On linked-account path, the **existing username is preserved** — the
  supplied username is ignored. (You can't change your username by
  re-linking via Google.)

#### Failure modes

| Code | Cause | Body |
|------|-------|------|
| 400 | Missing `idToken` | `"idToken is required"` |
| 401 | Google rejected the token, audience mismatch, or missing sub/email | `"Invalid Google token"` |
| 500 | DB duplicate-key on username | `"Username already taken"` |
| 500 | Other error | `"Google login failed"` |

### 3.5 JWT Sessions & Token Lifecycle

Sessions are stateless JWTs (JSON Web Tokens) signed with HS256. The server
holds no session state — every request is authenticated by validating the
token's signature against the secret.

#### Token shape

Source: `signToken` in `routes.ts:20-23`.

```ts
// Header
{ "alg": "HS256", "typ": "JWT" }

// Payload
{
  "sub": "<userId>",        // MongoDB users._id as string
  "username": "<username>",
  "email": "<email>",       // optional
  "iat": <issuedAt>,        // Unix seconds (auto-added by jsonwebtoken)
  "exp": <expiresAt>        // iat + 7 days
}

// Signature
HMAC-SHA256(base64url(header) + "." + base64url(payload), JWT_SECRET)
```

#### Lifetime

- **Issuance:** at successful registration, login, or Google sign-in.
- **Expiry:** 7 days from issuance (`expiresIn: '7d'`).
- **Refresh:** none today. When the token expires, the client falls back
  to the login modal. **[OPTIONAL FUTURE]** silent refresh via a
  refresh-token pair, if 7 days proves too short for casual players.
- **Revocation:** none today. A leaked token is valid for the full 7 days.
  **[OPTIONAL FUTURE]** token blacklist or short-lived access tokens with
  refresh tokens for true logout.

#### `JWT_SECRET`

Source: `routes.ts:11`.

```ts
const JWT_SECRET = process.env.JWT_SECRET ?? 'dev-secret-change-me';
```

**[GAP — security blocker]** The fallback default `'dev-secret-change-me'`
means a misconfigured production deployment (env var not set) would use a
publicly-known secret, allowing anyone to forge tokens. **Required
mitigation before public launch:** server should `throw` on startup if
`JWT_SECRET` is unset in production, refusing to start rather than running
with the fallback.

Recommended `JWT_SECRET` strength: 32+ random bytes (256-bit entropy),
generated via `openssl rand -hex 32` or equivalent. Stored in environment
variables / secrets manager, never in source.

#### Algorithm choice

HS256 (symmetric HMAC) is used. The trade-off vs. RS256 (asymmetric):

- **HS256 (current):** single secret, shared between any service that
  signs or verifies. Faster, smaller tokens.
- **RS256:** public/private keypair. Verifiers only need the public key,
  signing isolated to the auth service.

HS256 is fine for a single-service architecture. **[OPTIONAL FUTURE]**
migrate to RS256 if the architecture splits into multiple services that
need to verify tokens without the signing capability.

#### Client storage

- `localStorage` keys: `crazy_stuff_token`, `crazy_stuff_user`.
- **Trade-offs vs. cookies:**
  - localStorage is XSS-vulnerable but immune to CSRF.
  - Cookies (HttpOnly, Secure, SameSite) are XSS-resistant but require
    CSRF protection on every state-mutating request.
  - For an SPA with a strict CSP, localStorage is acceptable. **[OPTIONAL
    FUTURE]** revisit if XSS surface concerns rise (e.g., user-generated
    HTML in chat).
- Source: `auth.ts:8-9, 49-68`.

#### Token transport

- **HTTP API requests:** `Authorization: Bearer <token>` header. Currently
  only `/auth/me` validates this. **[GAP]** see §3.7.
- **Colyseus join:** client passes `userId` (JWT subject) as
  `options.authId`. Server does not currently verify the token. **[GAP]**
  see §3.7.
- **WebSocket:** Colyseus's persistent connection inherits the room-join
  authentication; no per-message JWT.

### 3.6 Session Restore (page reload)

When a player reloads the page or returns to the site, the client checks
for an existing token in `localStorage` and validates it before showing
the login modal.

Source: `auth.ts:125-142` (`authenticate` function).

#### Flow

1. Client reads `crazy_stuff_token` and `crazy_stuff_user` from
   `localStorage`.
2. If present, `GET /auth/me` with `Authorization: Bearer <token>`.
3. If response is 200, restore session — return `{ session, username }`
   to caller. **No login modal.**
4. If response is non-200 OR network fails OR localStorage is missing,
   clear localStorage and proceed to show the login modal.

#### Endpoint: `GET /auth/me`

Source: `routes.ts:156-167`.

```ts
GET /auth/me
Authorization: Bearer <token>

// 200
{ "id": "<userId>", "username": "...", "email": "..." }

// 401
{ "error": "No token" }   or   { "error": "Invalid token" }
```

The endpoint:

1. Reads `Authorization` header. If missing or doesn't start with
   `"Bearer "` → 401.
2. Calls `jwt.verify(token, JWT_SECRET)`. Verifies signature + expiry.
3. On success, returns the JWT payload claims (no DB lookup — token IS
   the source of truth).

**No DB lookup:** the endpoint is fast (just signature verification).
Trade-off: if the user was deleted/banned after token issuance but before
expiry, `/auth/me` still returns success. **[OPTIONAL FUTURE]** add a DB
lookup if a "ban a user instantly" feature is needed.

#### Why this approach

- **No backend session store** — JWT signature is the authentication.
  Stateless.
- **One round-trip on page load** — the browser hits `/auth/me` to
  validate, gets the user info back, and the rest of the page proceeds.
- **Graceful expiry** — when the token has expired (>7 days), the client
  cleanly falls back to the login flow without confusing errors.

#### Edge case: invalid JSON in localStorage

If `crazy_stuff_user` has been corrupted (manual edits, browser bugs),
`loadAuth()` returns `null` and the modal shows. No crash.

### 3.7 Authorization Contract — REQUIRED BEFORE PUBLIC LAUNCH

This section defines the **target authorization model** for every API
route and Colyseus join. Current state is **incomplete** — multiple
routes trust the supplied `userId` without verifying the caller's JWT.
This is the highest-priority security gap in the codebase.

#### The contract

> **Every API route or Colyseus room that operates on a player's data
> MUST verify the JWT signature AND match the JWT's `sub` claim against
> the target `userId`. If either check fails, the request is rejected
> with 401.**

Three categories of endpoint:

1. **Public** (no auth required) — `/auth/register`, `/auth/login`,
   `/auth/google`, `/health`.
2. **Authenticated** (JWT required, but operates on the caller's own
   data) — `/auth/me`.
3. **Authenticated + ownership** (JWT required + `:userId` must match
   `sub`) — every `/api/player/:userId/*` route, every Colyseus room
   that uses `authId`.

#### Current state per endpoint

| Endpoint | Required model | Current state |
|----------|---------------|---------------|
| `POST /auth/register` | Public | ✅ Public |
| `POST /auth/login` | Public | ✅ Public |
| `POST /auth/google` | Public | ✅ Public |
| `GET /auth/me` | Authenticated | ✅ Verifies JWT |
| `GET /health` | Public | ✅ Public |
| `GET /api/player/:userId` | Authenticated + ownership | **[GAP]** — no JWT check; trusts URL param |
| `GET /api/player/:userId/equipped-char` | Authenticated + ownership | **[GAP]** |
| `POST /api/player/:userId/equip-char` | Authenticated + ownership | **[GAP]** |
| `GET /api/player/:userId/inventory` | Authenticated + ownership | **[GAP]** |
| `POST /api/player/:userId/equip` | Authenticated + ownership | **[GAP]** |
| Colyseus `lobby` room join | Authenticated (auth optional) | **[GAP]** — `authId` trusted as supplied |
| Colyseus `queue` room join | Authenticated | **[GAP]** |
| Colyseus `race` room join | Authenticated | **[GAP]** — flagged in System #10 §5.6.4 |

#### Implementation pattern

A single Express middleware should enforce ownership on
`/api/player/:userId/*`:

```ts
// Pseudocode — design target
function requireOwnership(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'No token' });
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as JwtPayload;
    if (payload.sub !== req.params.userId) {
      return res.status(403).json({ error: 'Forbidden' });
    }
    req.userId = payload.sub;  // attach for downstream handlers
    next();
  } catch {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

app.use('/api/player/:userId', requireOwnership);
```

#### Colyseus join authentication

Each room's `onAuth` (Colyseus's per-join verification hook) should
validate the JWT:

```ts
// Pseudocode — design target, per room
async onAuth(client, options) {
  if (!options?.token) return false; // reject unauthenticated joins (or allow guest if guest-mode is supported)
  try {
    const payload = jwt.verify(options.token, JWT_SECRET) as JwtPayload;
    return { authId: payload.sub, username: payload.username }; // returned to onJoin
  } catch {
    return false;
  }
}
```

Client must send the JWT (not just the `authId`) in
`joinOrCreate('race', { token, ... })`. The server derives `authId` from
the verified token instead of trusting the client-supplied string.

#### Threat model addressed

| Threat | Without ownership check | With ownership check |
|--------|------------------------|---------------------|
| Read another player's inventory | Possible — guess their userId, hit `/api/player/:userId/inventory` | Blocked — JWT sub won't match |
| Equip/unequip another player's items | Possible — POST `/equip` with their userId | Blocked |
| Steal XP/coin awards by joining race with their authId | Possible — pass their userId as `authId` | Blocked — server derives authId from JWT |
| Spam-create accounts | Limited only by registration rate (no auth needed) | Same — registration is intentionally public |

#### Guest-mode handling

Today's race rooms accept guest joins (no `authId`). Decision needed:
**does the locked-down version still allow guests, or require auth on
every room join?**

Recommendation: **continue allowing guests in lobby and casual race
rooms**, require auth for ranked / leaderboard / store / inventory
operations. The rooms that don't write to persistent state can stay
guest-friendly (lower onboarding friction); the ones that do must require
auth.

Captured in §6 (dependencies) — every downstream system that takes
`authId` should agree on guest behavior.

### 3.8 Logout

Logout is currently a **client-side-only** operation. Source:
`auth.ts:268-270` (`signOut`).

#### Current behavior

```ts
export async function signOut(): Promise<void> {
  clearAuth();  // localStorage.removeItem(token + user)
}
```

Effect:

- Token and user object are removed from `localStorage` on this device.
- Next page load will show the login modal.
- **The token itself remains valid** — anyone who copied it before logout
  (e.g., from devtools, a network capture, a malicious script) can still
  use it for up to 7 days.

#### Why client-only is acceptable for MVP

- The threat model assumes the player's own device is trusted. Voluntary
  logout is for cleanup ("I'm using a friend's computer"), not for
  revoking compromised tokens.
- Token revocation requires server-side state (a blacklist or
  session-revocation list) that contradicts the stateless JWT design.
- For a casual game pre-launch, the cost of a full revocation system
  isn't justified.

#### When this becomes a problem **[OPTIONAL FUTURE]**

- **Lost / stolen device:** the player has no way to invalidate their
  session remotely. Mitigation: shorter token lifetime (e.g., 24h), or
  implement true revocation.
- **Compromised account suspicion:** support team can't force-log-out a
  flagged account.
- **GDPR account deletion:** when account-deletion is implemented, the
  user's existing JWTs should immediately stop working.

Standard mitigation patterns:

1. **Token blacklist** in Redis. Every `/auth/me` and `requireOwnership`
   check first looks up `BLACKLIST:<jti>`. Adds a Redis hop per
   authenticated request — usually fine.
2. **Short access tokens + refresh tokens.** Access token expires in 15
   minutes; refresh token is revocable in a server-side store. Industry
   standard for mobile apps.
3. **JWT version field on user doc.** Every JWT carries a
   `tokenVersion: N`. Logout-everywhere increments `users.tokenVersion`.
   Auth middleware compares JWT version to current — mismatch → reject.
   Adds one DB read per authenticated request, but no Redis dependency.

Recommendation: option **3** (JWT version field) when this becomes needed
— minimal infra, leverages the existing MongoDB connection.

### 3.9 Rate Limiting **[PLANNED]**

No rate limiting on auth endpoints today. **[GAP]** for public launch —
auth endpoints are the most likely target of automated abuse (credential
stuffing, account creation farms, password brute-forcing).

#### Target rate limits

| Endpoint | Limit | Window | Identifier | Lockout policy |
|----------|-------|--------|------------|----------------|
| `POST /auth/login` | 5 attempts | 1 minute per IP | client IP | After 5 failures: 60s soft block. After 20 failures in 10min: 1h hard block. |
| `POST /auth/login` | 10 attempts | 1 hour per username | username | After 10 failures on the same username: account flagged, 1h cooldown. Notification email when implemented. |
| `POST /auth/register` | 3 registrations | 1 hour per IP | client IP | Hard block after 3, requires email verification before next attempt (post-§3.11). |
| `POST /auth/google` | 10 attempts | 1 minute per IP | client IP | Lighter limit since Google itself rate-limits idToken issuance. |
| `GET /auth/me` | 60 requests | 1 minute per IP | client IP | Generous — just for session-restore on page load and tab focus. |

#### Implementation

Recommended: `express-rate-limit` with a Redis store. Redis is already
planned for System #05 — extends naturally to rate-limit storage.

```ts
// Pseudocode — design target
import rateLimit from 'express-rate-limit';

const loginLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 5,
  keyGenerator: (req) => req.ip,
  handler: (req, res) => res.status(429).json({ error: 'Too many login attempts. Try again later.' }),
});

app.use('/auth/login', loginLimiter);
```

#### Per-IP vs. per-username

A pure per-IP limit is bypassed by attackers using IP rotation (botnets,
residential proxies). A per-username limit protects individual accounts
even when the IP varies.

The dual-key approach (both per-IP **and** per-username) is the standard
pattern. Whichever limit is hit first triggers the rejection.

#### Lockout escalation

First violation → soft block (1 minute). Repeat violations within a
longer window → escalating hard blocks. Standard exponential-backoff
pattern.

**Avoid permanent IP bans** — shared IPs (corporate networks, mobile
carriers, school NAT) would punish innocent users.

#### CAPTCHA escalation **[OPTIONAL FUTURE]**

When per-IP rate limits trigger, a CAPTCHA challenge can let legitimate
users retry without waiting out the cooldown. Cloudflare Turnstile is the
easy default — minimal UX disruption.

### 3.10 Password Reset **[PLANNED]**

No password reset today. Required before public launch — an indie game
without a forgot-password flow is a support nightmare.

#### Target flow

1. Player clicks "Forgot password?" on the login modal.
2. Client prompts for email address. POST `/auth/forgot-password` with
   `{ email }`.
3. Server:
   - Looks up user by email. **Always returns 200** regardless of whether
     the email exists (don't leak email enumeration).
   - If user exists, generates a single-use reset token (random 32-byte
     hex), stores it in MongoDB `passwordResetTokens` collection with
     `userId`, `tokenHash` (hashed at rest), `expiresAt` (1 hour),
     `used: false`.
   - Sends an email with a link:
     `https://crazy-stuff.app/reset-password?token=<token>`.
4. Player clicks the link → client shows "set new password" form.
5. Player submits new password. POST `/auth/reset-password` with
   `{ token, password }`.
6. Server:
   - Looks up token, validates not expired and not used.
   - bcrypt-hashes the new password.
   - Updates `users.passwordHash`.
   - Marks token used.
   - Optionally: revokes all existing JWTs for this user (via §3.8
     versioning).
7. Returns success. Client redirects to login.

#### Security details

- **Token is hashed at rest** so a DB leak doesn't expose active reset
  tokens.
- **Single-use** — once consumed, marked used. A second click on the
  email link gets a generic "expired or already used" error.
- **1-hour expiry** balances usability (some users don't read email
  immediately) with security (limits the window for token capture).
- **Email content** must include "if you didn't request this, ignore
  this email" copy.
- **Rate limit** — same per-email and per-IP limits as login. 3 reset
  requests per hour per email.

#### Email infra

Requires transactional email service. Options:

- **SendGrid** — Twilio-owned, reliable, free tier (~100/day).
- **AWS SES** — cheapest at scale, slightly more setup.
- **Resend** — newer, developer-friendly, good free tier.

Recommendation: Resend for ease of setup, migrate to SES if email volume
grows beyond ~10k/month.

#### Schema addition (`passwordResetTokens` collection)

| Field | Type |
|-------|------|
| `_id` | ObjectId |
| `userId` | ObjectId (ref to users) |
| `tokenHash` | string (sha256 of the token) |
| `expiresAt` | Date |
| `used` | bool |
| `createdAt` | Date |
| `requestedFromIp` | string (audit) |

Index `tokenHash` for fast lookup. TTL index on `expiresAt` to auto-clean
expired tokens.

### 3.11 Email Verification **[PLANNED]**

No email verification today. **[GAP]** anyone can register with any email
— no proof the email is real or owned by the registrant.

#### Why it matters

- **Spam control:** without verification, registration spam is trivial.
  1000 throwaway accounts in 5 minutes.
- **Password reset trust:** the reset flow (§3.10) assumes the email
  belongs to the registrant. Without verification, an attacker can
  register `victim@gmail.com` (with a wrong-typed email), then never use
  it — but block the real victim from registering with their actual
  email.
- **Communication channel:** patch notes, support replies, account
  warnings — all need a verified email.

#### Soft-skip for MVP

Verification is **not required for MVP / closed alpha** because:

- The user pool is small and trusted (invited testers).
- Adding email infra is a launch dependency we can defer.
- The cost-benefit favors fast iteration during pre-launch.

#### Target flow (post-launch)

1. On registration, server generates a `verificationToken` (random
   32-byte hex), stores hashed copy in `users` doc with `verifiedAt: null`
   and `verificationExpiresAt: now + 24h`.
2. Server sends "Welcome to Crazy Stuff! Click here to verify your email"
   with a link: `/verify-email?token=...`.
3. Player can play immediately (verification is non-blocking) — but
   unverified accounts have **soft restrictions**:
   - Cannot use Store / Gacha (System #24, #25).
   - Cannot post in chat.
   - Cannot reset password (since the reset flow uses email, an
     unverified email is untrusted).
   - Race participation works fine.
4. Clicking the link sets `verifiedAt: now`, removes restrictions.
5. Resend-verification button on the profile page if the email got lost.

#### Schema additions to `users`

| Field | Type |
|-------|------|
| `verifiedAt` | Date \| null |
| `verificationToken` | string (sha256 hash) \| null |
| `verificationExpiresAt` | Date \| null |

#### Resend rate limit

3 resend-verification emails per email per hour. Same email infra as
password reset.

#### Google accounts skip verification

Google has already verified the email (Google's identity guarantee). On
first Google login, server sets `verifiedAt: now` directly. No separate
flow needed.

#### Lockout for long-unverified accounts **[design call deferred]**

Some games auto-disable accounts that never verified within 7 days.
Trade-off: pushes engagement, but punishes users who registered
impulsively and didn't return immediately. Decision deferred to
post-launch.

## 4. Formulas

Auth is mostly rules, not math. The few quantitative parameters live here
for tuning reference.

### 4.1 bcrypt cost factor

```
hash = bcrypt.hash(password, COST=10)
```

**Variable:** `COST` — exponential work factor. Each +1 doubles the time
per hash.

**Current value:** 10. Hash time ~70-100ms on modern CPU. Industry
standard 2024-2026.

**Safe range:** 10-12. Below 10: too fast, brute-force-friendly. Above
12: noticeable login delay (>500ms) for legitimate users.

**When to revisit:** when ~50ms hash time becomes feasible to attackers
(Moore's Law trajectory), bump to 11. Re-hash on next login.

### 4.2 JWT lifetime

```
expiresAt = issuedAt + 7 days
```

**Safe range:** 1 hour - 30 days. Trade-off:

- Short (1h-1d): forces frequent re-login. Better for revocation, worse
  for casual UX.
- Long (7d-30d): convenient. Bad if revocation matters.

**Current 7-day** chosen for casual-game UX. Re-login once a week is
acceptable.

**Tunes with:** §3.8 (logout/revocation). If revocation is added,
lifetime can shrink without user-visible cost.

### 4.3 Username sanitization

```
cleaned = raw.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 20).trim() || 'Player'
```

**Variables:**

- Allowed character set: `[a-zA-Z0-9 ]` (alphanumeric + space).
- Max length: 20 chars.
- Fallback: `'Player'`.

**Tunes:** localization (Unicode usernames? Currently no), legibility,
namespace pressure (shorter cap = more name collisions).

### 4.4 Password minimum length

```
length(password) >= 6
```

**Current:** 6 chars. Below industry standard 8+.

**Pre-launch:** strengthen to 8+ with at least one of [letter, number]
required (zxcvbn-style strength scoring is overkill but possible).

### 4.5 Rate limits **[PLANNED]** (formalized in §3.9)

All formulas are documented in the §3.9 table. Summary:

```
max_login_attempts_per_ip_per_min     = 5
max_login_attempts_per_username_per_h = 10
max_registers_per_ip_per_hour         = 3
max_google_per_ip_per_min             = 10
```

## 5. Edge Cases

Marker key: **[OK]** = handled correctly; **[GAP]** = needs work; **[BUG]**
= current incorrect behavior.

### 5.1 Registration

- **5.1.1 Email contains uppercase or surrounding whitespace.** **[OK]**
  Stored lowercased via `email.toLowerCase()` in `createUser`. Comparison
  is case-insensitive.
- **5.1.2 Username contains emoji.** **[OK]** Sanitization strips emoji;
  the resulting string may be shorter than expected. If empty after
  stripping, falls back to `'Player'`.
- **5.1.3 Password is exactly 6 characters.** **[OK]** Accepted (>= 6).
- **5.1.4 Same username, different email, simultaneous registration.**
  **[OK]** DB unique index on username catches it. Second request gets
  500 with the duplicate message.
- **5.1.5 Email already exists, registration with new username.** **[OK]**
  Caught by `findUserByEmail` check before insert. Returns 409.

### 5.2 Login

- **5.2.1 Username typed with wrong case.** **[GAP]** Currently username
  comparison is case-sensitive (`findUserByUsername` is exact match). User
  who registered "PlayerOne" can't log in as "playerone".
  **Recommendation:** lowercase the username for storage AND comparison,
  OR allow case-insensitive matching. Industry standard is case-insensitive
  lookup.
- **5.2.2 Password is correct, account is Google-only (no `passwordHash`).**
  **[OK]** 401 generic error. Doesn't reveal that the account is
  Google-linked.
- **5.2.3 Username has special chars in the request that wouldn't pass
  sanitization.** **[OK]** Lookup just fails (no match), 401. The
  sanitizer isn't applied at login (only at registration), so a
  sanitization-mismatched user wouldn't be findable.

### 5.3 Google OAuth

- **5.3.1 Google idToken expired.** **[OK]** `verifyGoogleToken` returns
  null because tokeninfo endpoint rejects.
- **5.3.2 Google idToken signed for a different client ID.** **[OK]**
  `aud` check rejects.
- **5.3.3 Network failure during tokeninfo lookup.** **[OK]** Try/catch
  returns null → 401.
- **5.3.4 Google account email matches existing password account.**
  **[GAP — security]** Auto-links without password verification.
  Documented in §3.4.
- **5.3.5 Google account exists, but client supplied a different
  username.** **[OK]** Server preserves existing username, ignores
  client-supplied name on linked account path.

### 5.4 JWT

- **5.4.1 Token expired between requests.** **[OK]** `jwt.verify` throws,
  handlers return 401.
- **5.4.2 Token signed with old `JWT_SECRET` after a secret rotation.**
  **[OK]** Verification fails → 401 → user re-logs in. (No graceful
  migration today; secret rotation forces all users to re-login.)
- **5.4.3 Token tampering (modified payload, original signature).**
  **[OK]** Signature mismatch → 401.
- **5.4.4 Token replay after logout.** **[GAP — known limitation]** Token
  still valid after `signOut`. Mitigation discussed in §3.8.

### 5.5 Session restore

- **5.5.1 localStorage cleared while user is on the page.** **[OK]** Next
  protected request fails with 401 → user falls back to login modal.
- **5.5.2 Server is down on page load.** **[OK]** `apiPost` returns
  network error → fall through to login modal. User can still see the
  modal even if backend is down.
- **5.5.3 User has token from a different deployment / older
  `JWT_SECRET`.** **[OK]** Verification fails → modal.

### 5.6 Multi-device

- **5.6.1 Same user logs in on phone and laptop.** **[OK]** Both devices
  get separate JWTs (both valid). Both can use the API independently.
- **5.6.2 Same user joins a Colyseus room from two devices simultaneously.**
  **[OK]** RaceRoom's duplicate-session check kicks the second one
  (System #10 §3.7). Lobby and queue rooms don't enforce this — second
  join just connects normally.
- **5.6.3 Logout on one device doesn't log out the other.** **[OK by
  design]** Each device clears its own localStorage. Tokens remain
  independently valid until expiry.

### 5.7 Account deletion **[GAP — not implemented]**

- **5.7.1 User wants to delete their account.** **[GAP]** No flow exists.
  GDPR-blocking for any EU launch. Required pre-launch.
- **5.7.2 What about the items / XP / leaderboard records?** **[GAP —
  design call needed]** Options:
  - **Hard delete** — drop user, players, inventory rows. Leaderboard
    entries become "(deleted user)".
  - **Soft delete** — mark user as deleted, anonymize username. Inventory
    remains tied to a phantom account.
  - **Hybrid** — username freed for re-registration, gameplay data stays
    anonymized.

Recommendation: **hybrid** for GDPR compliance + integrity of historical
leaderboards.

## 6. Dependencies

### 6.1 Upstream

| System | Why |
|--------|-----|
| **System #04 — Database Persistence Layer** | MongoDB connection, `users`/`players` collection management. |
| **MongoDB** (external) | Storage and unique-index enforcement. |
| **Google Identity Services** (external) | OAuth provider for `/auth/google`. |
| **bcryptjs** (npm) | Password hashing. |
| **jsonwebtoken** (npm) | JWT signing and verification. |
| **express** (npm) | HTTP routing, middleware. |

### 6.2 Downstream (every persistent system)

| System | What it consumes |
|--------|-------------------|
| **System #08 — Item / Inventory** | `userId` from JWT subject. Inventory rows key by it. |
| **System #09 — Currency** | `userId` for coin balances. |
| **System #10 — Race Room** | `authId` (= `userId`) for duplicate-session check, reward attribution, loadout lookup. **Must adopt §3.7 JWT verification.** |
| **System #13 — Lobby / Crazy Town** | `authId` for player identity in lobby. |
| **System #19 — Scoring System** | `userId` to award XP/coins via `awardPostRace`. |
| **System #20 — Matchmaking / Queue** | `authId` to route players to race rooms. |
| **System #22 — XP / Level System** | `userId` for level state. |
| **System #23 — Seasonal Leaderboard** | `userId` for leaderboard entries. |
| **System #24 — Gacha System** | `userId` for pull history + entitlements. |
| **System #25 — Store System** | `userId` for purchase records. |
| **System #26 — Payment Integration** | `userId` for Stripe customer mapping. |
| **System #28 — Chat System** | `userId` for chat author identity, ban list. |
| **System #31 — Friends / Social Graph** | `userId` for friend relationships. |
| **System #33 — Housing System** | `userId` for house ownership. |

### 6.3 Sibling references

| System | Relationship |
|--------|------------|
| **System #05 — Redis Cache Layer** | Future home for rate-limit counters and session blacklist (if revocation lands). Independent today. |

### 6.4 Back-reference checklist

Every downstream system above (§6.2) must reference System #03 in its
dependency section.

## 7. Tuning Knobs

### 7.1 JWT lifetime

**Source:** `routes.ts:22` (`expiresIn: '7d'`).

**Safe range:** 1h - 30d. **Tunes:** re-login frequency vs. revocation
responsiveness.

### 7.2 bcrypt cost

**Source:** `routes.ts:48` (`bcrypt.hash(password, 10)`).

**Safe range:** 10-12. **Tunes:** hash time vs. brute-force resistance.

### 7.3 Password minimum length

**Source:** `routes.ts:38` (`password.length < 6`).

**Safe range:** 6-12. **Tunes:** UX friction vs. security floor.
Strengthen to 8 before public launch.

### 7.4 Username max length

**Source:** `routes.ts:26` (`slice(0, 20)`).

**Safe range:** 12-32. **Tunes:** display real estate (chat lines,
leaderboard rows) vs. expressive freedom.

### 7.5 Rate limit thresholds **[PLANNED]**

Defined in §3.9. All windows + counts are tunable. Trade-off: looser =
better UX, tighter = better abuse resistance.

### 7.6 Reset token expiry **[PLANNED]**

Default 1 hour. Range: 15min - 24h. **Tunes:** email-delivery-tolerance
vs. token-capture window.

### 7.7 Email verification grace period **[PLANNED]**

Soft restrictions kick in immediately, hard restrictions (if any)
deferred. Default lockout: never (passive forever). Range: 7d-90d if a
hard cutoff is desired.

## 8. Acceptance Criteria

### 8.1 Registration

- **AC-AUTH-001** POST `/auth/register` with valid `{ email, password ≥ 6 chars, username }` → 200 with `{ token, user }`. User row exists in MongoDB. Player doc exists with starter items (3 items in `inventory`).
- **AC-AUTH-002** POST `/auth/register` with missing `username` → 400, no DB writes.
- **AC-AUTH-003** POST `/auth/register` with password length 5 → 400 `"Password must be at least 6 characters"`.
- **AC-AUTH-004** POST `/auth/register` twice with same email → second returns 409.
- **AC-AUTH-005** Returned JWT verifies against `JWT_SECRET` and contains `sub: <userId>`, `username`, `email`.

### 8.2 Login

- **AC-AUTH-010** POST `/auth/login` with correct username + password → 200 with valid JWT.
- **AC-AUTH-011** POST `/auth/login` with wrong password → 401 with generic `"Invalid username or password"`.
- **AC-AUTH-012** POST `/auth/login` with non-existent username → 401 with same generic error.
- **AC-AUTH-013** POST `/auth/login` for a Google-only account (no `passwordHash`) → 401 with same generic error.
- **AC-AUTH-014** POST `/auth/login` with missing username → 400.

### 8.3 Google OAuth

- **AC-AUTH-020** POST `/auth/google` with valid idToken (new email) → creates user with `googleSub` set, returns JWT. Player doc + starter items created.
- **AC-AUTH-021** POST `/auth/google` with valid idToken (same Google sub as before) → returns JWT for existing user. No new row.
- **AC-AUTH-022** POST `/auth/google` with valid idToken (email matches existing password account) → links Google sub to existing user. **[GAP]** target: rejects with 409 until password verification.
- **AC-AUTH-023** POST `/auth/google` with idToken signed for wrong client ID → 401.
- **AC-AUTH-024** POST `/auth/google` with expired idToken → 401.

### 8.4 Session restore

- **AC-AUTH-030** GET `/auth/me` with valid token → 200 with `{ id, username, email }`.
- **AC-AUTH-031** GET `/auth/me` with no `Authorization` header → 401.
- **AC-AUTH-032** GET `/auth/me` with expired token → 401.
- **AC-AUTH-033** GET `/auth/me` with tampered token → 401.
- **AC-AUTH-034** Reload page after recent login → no login modal appears. Player auto-restored.
- **AC-AUTH-035** Reload page after 8 days → login modal appears. localStorage cleared.

### 8.5 Authorization (target state) **[PLANNED]**

- **AC-AUTH-040** **[PLANNED]** GET `/api/player/:userId/inventory` with token whose `sub` ≠ `:userId` → 403.
- **AC-AUTH-041** **[PLANNED]** GET `/api/player/:userId/inventory` with no token → 401.
- **AC-AUTH-042** **[PLANNED]** GET `/api/player/:userId/inventory` with own token → 200 with inventory.
- **AC-AUTH-043** **[PLANNED]** Colyseus join with no token → rejected.
- **AC-AUTH-044** **[PLANNED]** Colyseus join with token whose `sub` doesn't match supplied `authId` → server uses sub from token (ignores supplied authId).

### 8.6 Logout

- **AC-AUTH-050** Click logout → localStorage cleared. Reload page → login modal.
- **AC-AUTH-051** **[Known limitation]** After logout, the same JWT used in another tab still works for up to 7 days. Documented in §3.8.

### 8.7 Sanitization & input

- **AC-AUTH-060** Register with username `<script>alert(1)</script>` → stored as `scriptalert1script`.
- **AC-AUTH-061** Register with username 50 chars → truncated to 20.
- **AC-AUTH-062** Register with username `   ` (whitespace) → fallback to `'Player'`.
- **AC-AUTH-063** Email `Bob@EXAMPLE.com` → stored as `bob@example.com`.

### 8.8 Rate limiting **[PLANNED]**

- **AC-AUTH-070** **[PLANNED]** 6 login attempts in 60s from same IP → 6th returns 429.
- **AC-AUTH-071** **[PLANNED]** 4 register attempts in 1h from same IP → 4th returns 429.
- **AC-AUTH-072** **[PLANNED]** 11 wrong-password attempts on same username in 1h → 11th returns 429 / lockout.

### 8.9 Password reset **[PLANNED]**

- **AC-AUTH-080** **[PLANNED]** POST `/auth/forgot-password` with valid email → 200 (always). Email sent in real-world deployment.
- **AC-AUTH-081** **[PLANNED]** POST `/auth/forgot-password` with non-existent email → 200 (no enumeration).
- **AC-AUTH-082** **[PLANNED]** POST `/auth/reset-password` with valid token → password updated.
- **AC-AUTH-083** **[PLANNED]** POST `/auth/reset-password` with same token twice → second fails.
- **AC-AUTH-084** **[PLANNED]** POST `/auth/reset-password` with expired token → 400.

### 8.10 Email verification **[PLANNED]**

- **AC-AUTH-090** **[PLANNED]** New registration triggers verification email.
- **AC-AUTH-091** **[PLANNED]** Click link → `verifiedAt` set, restrictions lifted.
- **AC-AUTH-092** **[PLANNED]** Unverified user attempts gacha pull → 403 with "verify email" message.
- **AC-AUTH-093** **[PLANNED]** Google login → `verifiedAt` set immediately.
