import { ApiProperty, ApiPropertyOptional } from '@nestjs/swagger';
import { PointEventType, PromoterTier } from '@prisma/client';
import { IsInt, IsNumber, IsOptional, IsString, Max, MaxLength, Min } from 'class-validator';

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

// ── Admin board (full standings) ─────────────────────────────

export class AdminLeaderboardRowDto {
  @ApiProperty({ example: 1 }) rank!: number;
  @ApiProperty({ format: 'uuid' }) promoter_id!: string;
  @ApiProperty({ nullable: true, example: 'Ada Okafor' }) full_name!: string | null;
  @ApiProperty({ example: 640 }) season_points!: number;
  @ApiProperty({ example: 1820 }) lifetime_points!: number;
  @ApiProperty({ enum: PromoterTier }) tier!: PromoterTier;
  @ApiProperty({ example: 5 }) streak!: number;
}

export class AdminLeaderboardDto {
  @ApiProperty({ example: 'S5' }) season!: string;
  @ApiProperty({ example: 128 }) total!: number;
  @ApiProperty({ type: [AdminLeaderboardRowDto] }) rows!: AdminLeaderboardRowDto[];
}

// ── Admin config (Phase 4) ───────────────────────────────────

/** The tunable leaderboard_config, as the admin sees and edits it (snake_case). */
export class LeaderboardConfigDto {
  @ApiProperty() pts_delivery_completed!: number;
  @ApiProperty() pts_on_time!: number;
  @ApiProperty() pts_quality_clean!: number;
  @ApiProperty() over_base!: number;
  @ApiProperty() over_cap_ratio!: number;
  @ApiProperty() streak_step!: number;
  @ApiProperty() streak_cap!: number;
  @ApiProperty() pts_breadth!: number;
  @ApiProperty() pts_milestone!: number;
  @ApiProperty() penalty_no_show!: number;
  @ApiProperty() penalty_rejected!: number;
  @ApiProperty() penalty_duplicate!: number;
  @ApiProperty() per_campaign_point_cap!: number;
  @ApiProperty() mult_creation_hundredths!: number;
  @ApiProperty() mult_distribution_hundredths!: number;
  @ApiProperty() season_length_days!: number;
  @ApiProperty() tier_silver_at!: number;
  @ApiProperty() tier_gold_at!: number;
  @ApiProperty() tier_platinum_at!: number;
  @ApiProperty({ example: 0.8 }) tier_reliability_floor!: number;
}

/** All optional — only fields sent are changed. Non-negative integers; the reliability
 *  floor is a 0–1 fraction. */
export class LeaderboardConfigUpdateDto {
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) pts_delivery_completed?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) pts_on_time?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) pts_quality_clean?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) over_base?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) over_cap_ratio?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) streak_step?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) streak_cap?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) pts_breadth?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) pts_milestone?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) penalty_no_show?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) penalty_rejected?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) penalty_duplicate?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) per_campaign_point_cap?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) mult_creation_hundredths?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(1) mult_distribution_hundredths?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) season_length_days?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) tier_silver_at?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) tier_gold_at?: number;
  @ApiPropertyOptional() @IsOptional() @IsInt() @Min(0) tier_platinum_at?: number;
  @ApiPropertyOptional({ example: 0.8 }) @IsOptional() @IsNumber() @Min(0) @Max(1) tier_reliability_floor?: number;
}

/** Promoter-facing "how points work" values, from the live config. */
export class PointRulesDto {
  @ApiProperty({ example: 50, description: 'Points for an approved delivery.' })
  delivery_completed!: number;

  @ApiProperty({ example: 20, description: 'Bonus for delivering on time.' })
  on_time!: number;

  @ApiProperty({ example: 15, description: 'Bonus for a clean (non-duplicate) proof.' })
  quality_clean!: number;

  @ApiProperty({ example: 60, description: 'Maximum bonus for over-delivering (at the cap ratio).' })
  over_delivery_max!: number;

  @ApiProperty({ example: 3, description: 'Over-delivery is rewarded up to this many times the target.' })
  over_cap_ratio!: number;

  @ApiProperty({ example: 40, description: 'Points lost for a missed post.' })
  penalty_no_show!: number;

  @ApiProperty({ example: 20, description: 'Points lost for a rejected submission.' })
  penalty_rejected!: number;

  @ApiProperty({ example: 30, description: 'Points lost for a duplicate proof.' })
  penalty_duplicate!: number;
}

export class AdjustPointsDto {
  @ApiProperty({ example: 100, description: 'Points to award (positive) or dock (negative).' })
  @IsInt()
  @Min(-100000)
  @Max(100000)
  points!: number;

  @ApiProperty({ example: 'Compensating a proof lost in review.', description: 'Why — recorded on the audit log and the point event.' })
  @IsString()
  @MaxLength(500)
  reason!: string;
}
