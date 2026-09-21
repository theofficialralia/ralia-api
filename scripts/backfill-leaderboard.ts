/**
 * One-off leaderboard backfill (docs/LEADERBOARD.md Phase 2). Replays DELIVERY awards
 * for every already-approved submission and rebuilds scores/ranks, so the boards don't
 * launch empty. Idempotent — safe to run more than once.
 *
 *   npm run leaderboard:backfill
 */
import { NestFactory } from '@nestjs/core';
import { AppModule } from '../src/app.module';
import { LeaderboardService } from '../src/modules/leaderboard/leaderboard.service';

async function main(): Promise<void> {
  process.env.NODE_ENV ??= 'development';
  const app = await NestFactory.createApplicationContext(AppModule, { logger: ['log', 'warn', 'error'] });
  try {
    const leaderboard = app.get(LeaderboardService);
    const { submissions, awarded } = await leaderboard.backfill(new Date());
    console.log(`→ backfill complete: ${submissions} approved submissions scanned, ${awarded} new point awards.`);
  } finally {
    await app.close();
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
