import { Router } from 'express';
import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import {
  findUserByEmail, findUserByUsername, findUserByGoogleSub, createUser, createGoogleUser,
  linkGoogleToUser, getUserById, getOrCreatePlayer,
} from '../db/mongo';
import { JWT_SECRET, signToken, type JwtPayload } from './jwt';

const router = Router();

const GOOGLE_CLIENT_ID = '1010797437683-acc3bke8o6qsj69370700vbfk6chbmep.apps.googleusercontent.com';

function cleanUsername(raw: string): string {
  return raw.replace(/[^a-zA-Z0-9 ]/g, '').slice(0, 20).trim() || 'Player';
}

// ─── POST /auth/register ────────────────────────────────────────────────────

router.post('/register', async (req, res) => {
  try {
    const { email, password, username: rawUsername } = req.body;

    if (!email || !password || !rawUsername) {
      return res.status(400).json({ error: 'email, password, and username are required' });
    }
    if (password.length < 6) {
      return res.status(400).json({ error: 'Password must be at least 6 characters' });
    }

    const username = cleanUsername(rawUsername);
    const existing = await findUserByEmail(email);
    if (existing) {
      return res.status(409).json({ error: 'Email already registered' });
    }

    const passwordHash = await bcrypt.hash(password, 10);
    const user = await createUser(email, passwordHash, username);

    // Create player record + starter items
    await getOrCreatePlayer(user._id.toString(), username);

    const token = signToken(user as any);
    res.json({
      token,
      user: { id: user._id.toString(), username: user.username, email: user.email },
    });
  } catch (e: unknown) {
    console.error('[Auth] register error:', e);
    const msg = e instanceof Error && e.message.includes('duplicate key')
      ? 'Username or email already taken'
      : 'Registration failed';
    res.status(500).json({ error: msg });
  }
});

// ─── POST /auth/login ───────────────────────────────────────────────────────

router.post('/login', async (req, res) => {
  try {
    const { username, password } = req.body;
    if (!username || !password) {
      return res.status(400).json({ error: 'Username and password are required' });
    }

    const user = await findUserByUsername(username);
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid username or password' });
    }

    const token = signToken(user as any);
    res.json({
      token,
      user: { id: user._id.toString(), username: user.username, email: user.email },
    });
  } catch (e) {
    console.error('[Auth] login error:', e);
    res.status(500).json({ error: 'Login failed' });
  }
});

// ─── POST /auth/google ──────────────────────────────────────────────────────

async function verifyGoogleToken(idToken: string): Promise<{
  sub: string; email: string; name?: string;
} | null> {
  try {
    const resp = await fetch(
      `https://oauth2.googleapis.com/tokeninfo?id_token=${encodeURIComponent(idToken)}`,
    );
    if (!resp.ok) return null;
    const data = await resp.json() as { aud?: string; sub?: string; email?: string; name?: string };
    if (data.aud !== GOOGLE_CLIENT_ID) return null;
    if (!data.sub || !data.email) return null;
    return { sub: data.sub, email: data.email, name: data.name };
  } catch {
    return null;
  }
}

router.post('/google', async (req, res) => {
  try {
    const { idToken, username: rawUsername } = req.body;
    if (!idToken) {
      return res.status(400).json({ error: 'idToken is required' });
    }

    const googleUser = await verifyGoogleToken(idToken);
    if (!googleUser) {
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    // 1. If a user with this Google sub already exists, log them in.
    let user = await findUserByGoogleSub(googleUser.sub);

    if (!user) {
      // 2. Check for an existing password account on the same email.
      //    Auto-linking would be an account-takeover vector — require password proof instead.
      const emailMatch = await findUserByEmail(googleUser.email);
      if (emailMatch && !emailMatch.googleSub && emailMatch.passwordHash) {
        return res.status(409).json({
          error: 'account_exists',
          requiresPasswordLink: true,
          email: googleUser.email,
        });
      }

      // 3. No existing account — create a fresh Google-only user.
      const username = cleanUsername(rawUsername ?? googleUser.name ?? googleUser.email.split('@')[0]);
      user = await createGoogleUser(googleUser.email, googleUser.sub, username);
    }

    // Ensure player record exists
    await getOrCreatePlayer(user!._id.toString(), user!.username);

    const token = signToken(user as any);
    res.json({
      token,
      user: { id: user!._id.toString(), username: user!.username, email: user!.email },
    });
  } catch (e: unknown) {
    console.error('[Auth] google error:', e);
    const msg = e instanceof Error && e.message.includes('duplicate key')
      ? 'Username already taken'
      : 'Google login failed';
    res.status(500).json({ error: msg });
  }
});

// ─── POST /auth/google/link ─────────────────────────────────────────────────
// Verify the user's password, then attach the Google sub to their account.
// Used after /auth/google returns 409 account_exists.

router.post('/google/link', async (req, res) => {
  try {
    const { idToken, password } = req.body;
    if (!idToken || !password) {
      return res.status(400).json({ error: 'idToken and password are required' });
    }

    const googleUser = await verifyGoogleToken(idToken);
    if (!googleUser) {
      return res.status(401).json({ error: 'Invalid Google token' });
    }

    const user = await findUserByEmail(googleUser.email);
    if (!user || !user.passwordHash) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    // Refuse if a different Google sub is already linked.
    if (user.googleSub && user.googleSub !== googleUser.sub) {
      return res.status(409).json({ error: 'A different Google account is already linked to this user' });
    }

    const valid = await bcrypt.compare(password, user.passwordHash);
    if (!valid) {
      return res.status(401).json({ error: 'Invalid email or password' });
    }

    if (!user.googleSub) {
      await linkGoogleToUser(user._id, googleUser.sub);
    }

    await getOrCreatePlayer(user._id.toString(), user.username);

    const token = signToken(user as any);
    res.json({
      token,
      user: { id: user._id.toString(), username: user.username, email: user.email },
    });
  } catch (e) {
    console.error('[Auth] google/link error:', e);
    res.status(500).json({ error: 'Failed to link Google account' });
  }
});

// ─── GET /auth/me ───────────────────────────────────────────────────────────

router.get('/me', (req, res) => {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token' });
  }
  try {
    const payload = jwt.verify(authHeader.slice(7), JWT_SECRET) as JwtPayload;
    res.json({ id: payload.sub, username: payload.username, email: payload.email });
  } catch {
    res.status(401).json({ error: 'Invalid token' });
  }
});

export { router as authRouter };
