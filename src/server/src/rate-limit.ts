import { Request, Response, NextFunction } from 'express';

interface Bucket {
  count: number;
  resetAt: number;
}

/**
 * Minimal in-memory, per-IP fixed-window rate limiter (roadmap M3-2).
 *
 * Suitable for the current single-instance deploy. If we ever run multiple
 * server instances, move to a shared store (Redis) so limits are global —
 * otherwise each instance counts independently. Requires `app.set('trust
 * proxy', …)` so `req.ip` reflects the real client behind the reverse proxy.
 */
export function rateLimit(opts: { windowMs: number; max: number; message?: string }) {
  const buckets = new Map<string, Bucket>();

  // Periodically drop expired buckets so the map can't grow unbounded.
  const sweep = setInterval(() => {
    const now = Date.now();
    for (const [key, b] of buckets) if (b.resetAt <= now) buckets.delete(key);
  }, opts.windowMs);
  if (typeof sweep.unref === 'function') sweep.unref();

  return (req: Request, res: Response, next: NextFunction): void => {
    const ip = req.ip || req.socket.remoteAddress || 'unknown';
    const now = Date.now();

    let b = buckets.get(ip);
    if (!b || b.resetAt <= now) {
      b = { count: 0, resetAt: now + opts.windowMs };
      buckets.set(ip, b);
    }
    b.count++;

    if (b.count > opts.max) {
      res.setHeader('Retry-After', String(Math.ceil((b.resetAt - now) / 1000)));
      res.status(429).json({ error: opts.message ?? 'Too many requests — slow down.' });
      return;
    }
    next();
  };
}
