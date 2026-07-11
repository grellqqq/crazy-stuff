import { defineConfig } from 'vite';

export default defineConfig({
  server: {
    port: 8080,
    headers: {
      // Art sprites are regenerated on disk constantly during iteration.
      // Without this, tabs opened without `?dev` let the browser HTTP-cache
      // the PNGs indefinitely — art fixes then silently never show up (even
      // in-game texture purges refetch the same stale cached bytes).
      'Cache-Control': 'no-store',
    },
  },
});
