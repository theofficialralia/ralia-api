/**
 * Season bucketing for the leaderboard (docs/LEADERBOARD.md §5).
 *
 * Seasons are fixed-length windows anchored to a stable epoch, so a moment always
 * falls in the same season no matter when the code runs. The key is what point
 * events and score rollups are grouped by.
 */

/** UTC midnight day-count (days since the Unix epoch), ignoring wall-clock time. */
function utcDayNumber(d: Date): number {
  return Math.floor(Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate()) / 86_400_000);
}

/** Fixed anchor so season boundaries don't shift with deploy time. */
const SEASON_EPOCH_DAY = utcDayNumber(new Date('2026-01-01T00:00:00Z'));

/**
 * The season key a moment belongs to.
 *   - `seasonLengthDays <= 0` → a single "ALL" season that never resets.
 *   - otherwise → "S{n}", where n is the number of whole seasons since the epoch.
 */
export function seasonKeyFor(date: Date, seasonLengthDays: number): string {
  if (seasonLengthDays <= 0) return 'ALL';
  const index = Math.floor((utcDayNumber(date) - SEASON_EPOCH_DAY) / seasonLengthDays);
  return `S${index}`;
}
