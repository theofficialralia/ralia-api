import { ApiProperty } from '@nestjs/swagger';
import { PointEventType, PromoterTier } from '@prisma/client';

export class LeaderboardRowDto {
  @ApiProperty({ example: 1 })
  rank!: number;

  @ApiProperty({ example: 'Ada O.', description: 'Privacy-preserving display name (first name + last initial).' })
  display_name!: string;

  @ApiProperty({ example: 640 })
  points!: number;

  @ApiProperty({ enum: PromoterTier })
  tier!: PromoterTier;

  @ApiProperty({ example: false, description: 'True for the viewer’s own row.' })
  is_me!: boolean;
}

export class LeaderboardDto {
  @ApiProperty({ example: 'S5', description: 'The current season key.' })
  season!: string;

  @ApiProperty({ example: 128, description: 'How many promoters have a score this season.' })
  total!: number;

  @ApiProperty({ type: [LeaderboardRowDto], description: 'The top promoters this season, ranked.' })
  top!: LeaderboardRowDto[];

  @ApiProperty({ type: LeaderboardRowDto, nullable: true, description: 'The viewer’s own row, if they have a score this season.' })
  me!: LeaderboardRowDto | null;
}

export class PointBreakdownDto {
  @ApiProperty({ enum: PointEventType })
  type!: PointEventType;

  @ApiProperty({ example: 300 })
  points!: number;
}

export class NextTierDto {
  @ApiProperty({ enum: PromoterTier })
  tier!: PromoterTier;

  @ApiProperty({ example: 160, description: 'Rolling-90 points still needed to reach it.' })
  points_to_go!: number;
}

export class MyScoreDto {
  @ApiProperty({ example: 'S5' })
  season!: string;

  @ApiProperty({ example: 640 })
  season_points!: number;

  @ApiProperty({ example: 1820 })
  lifetime_points!: number;

  @ApiProperty({ example: 640, description: 'Points in the trailing 90 days — the metric tiers are based on.' })
  rolling_90_points!: number;

  @ApiProperty({ example: 4, nullable: true, description: 'Rank this season, or null with no score yet.' })
  rank!: number | null;

  @ApiProperty({ enum: PromoterTier })
  tier!: PromoterTier;

  @ApiProperty({ type: NextTierDto, nullable: true, description: 'The next tier up and how far off it is, or null at the top.' })
  next_tier!: NextTierDto | null;

  @ApiProperty({ example: 5, description: 'Consecutive on-time deliveries.' })
  streak!: number;

  @ApiProperty({ type: [PointBreakdownDto], description: 'This season’s points grouped by how they were earned.' })
  breakdown!: PointBreakdownDto[];
}
