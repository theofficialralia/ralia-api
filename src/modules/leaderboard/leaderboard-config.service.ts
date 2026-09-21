import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { LeaderboardConfig } from '@prisma/client';
import { PrismaService } from '../../common/prisma/prisma.service';
import { seasonKeyFor } from './season';

/**
 * The single active leaderboard_config row — mirrors RateConfigService. All point
 * values, multipliers, caps, season length, and tier thresholds live here so an
 * admin can tune them without a deploy (docs/LEADERBOARD.md §8).
 */
@Injectable()
export class LeaderboardConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getActive(): Promise<LeaderboardConfig> {
    const config = await this.prisma.leaderboardConfig.findFirst({ where: { isActive: true } });
    if (!config) {
      throw new InternalServerErrorException(
        'No active leaderboard_config row exists. Run the migration/seed.',
      );
    }
    return config;
  }

  /** The season key for `now` at the configured season length. */
  async currentSeasonKey(now: Date = new Date()): Promise<string> {
    const config = await this.getActive();
    return seasonKeyFor(now, config.seasonLengthDays);
  }
}
