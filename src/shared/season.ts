/**
 * Seasonal-leaderboard time math (Systems Index #23, roadmap M2-4).
 *
 * A "season" is one UTC calendar month, identified by `YYYY-MM`. Player season
 * points (`seasonXp`/`seasonWins`) accumulate within the current season and
 * roll over to zero on the first race of a new season (see `awardPostRace`).
 *
 * Pure + dependency-free so it is unit-testable and shared by server (rollover,
 * ranking) and client (season label display).
 */

/** UTC `YYYY-MM` for the season containing `now`. */
export function currentSeasonId(now: Date = new Date()): string {
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

const MONTH_NAMES = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

/** Human label for a season id, e.g. `2026-06` → `June 2026`. */
export function seasonLabel(seasonId: string): string {
  const [year, month] = seasonId.split('-');
  const name = MONTH_NAMES[Number(month) - 1];
  return name ? `${name} ${year}` : seasonId;
}

/** The minimum shape needed to rank a leaderboard row. */
export interface RankableEntry {
  seasonXp: number;
  seasonWins: number;
  username: string;
}

/**
 * Leaderboard sort order, highest rank first: season XP desc, then season wins
 * desc as a tiebreak, then username asc for a stable, deterministic order.
 * Mirrors the server's Mongo sort so client-side re-sorts agree.
 */
export function compareLeaderboard(a: RankableEntry, b: RankableEntry): number {
  if (b.seasonXp !== a.seasonXp) return b.seasonXp - a.seasonXp;
  if (b.seasonWins !== a.seasonWins) return b.seasonWins - a.seasonWins;
  return a.username.localeCompare(b.username);
}
