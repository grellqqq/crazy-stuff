/**
 * Tiny structured logger (M3-6 ops basics). One line per event with a level,
 * timestamp, event name, and arbitrary context fields.
 *
 * Production (NODE_ENV=production) emits JSON lines (parseable by log
 * aggregators / Dokploy); dev emits a readable form. No dependency.
 *
 *   log.info('http_request', { method, path, status, ms })
 *   log.error('db_error', { route, err: String(e) })
 */
type Level = 'info' | 'warn' | 'error';

const isProd = process.env.NODE_ENV === 'production';

function emit(level: Level, event: string, fields?: Record<string, unknown>): void {
  const ts = new Date().toISOString();
  let line: string;
  if (isProd) {
    line = JSON.stringify({ ts, level, event, ...fields });
  } else {
    const extra = fields && Object.keys(fields).length ? ' ' + JSON.stringify(fields) : '';
    line = `${ts} ${level.toUpperCase().padEnd(5)} ${event}${extra}`;
  }
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}

export const log = {
  info: (event: string, fields?: Record<string, unknown>) => emit('info', event, fields),
  warn: (event: string, fields?: Record<string, unknown>) => emit('warn', event, fields),
  error: (event: string, fields?: Record<string, unknown>) => emit('error', event, fields),
};
