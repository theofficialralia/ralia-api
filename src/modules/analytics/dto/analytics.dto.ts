import { ApiProperty } from '@nestjs/swagger';
import { MoneyDto } from '../../ledger/money';

/**
 * "Views" throughout analytics means non-bot clicks on a promoter's tracking
 * link. A WhatsApp-status view is not directly measurable; the tracking-link
 * click is the honest, countable proxy the platform actually has.
 */

export class EvidenceItemDto {
  @ApiProperty({ format: 'uuid' })
  submission_id!: string;

  @ApiProperty({ nullable: true })
  promoter_name!: string | null;

  @ApiProperty({ nullable: true, example: '@adaeze' })
  promoter_handle!: string | null;

  @ApiProperty({ example: 'INSTAGRAM' })
  platform!: string;

  @ApiProperty({ format: 'date-time' })
  submitted_at!: string;

  @ApiProperty({ example: 3210, description: 'Non-bot clicks on this promoter’s link.' })
  views!: number;

  @ApiProperty({ enum: ['PENDING', 'APPROVED', 'REJECTED'] })
  verdict!: string;

  @ApiProperty({ example: false, description: 'The screenshot perceptually matched an earlier one.' })
  auto_flag!: boolean;

  @ApiProperty({ nullable: true })
  public_url!: string | null;

  @ApiProperty({ nullable: true, description: 'Short-lived signed URL for the screenshot.' })
  image_url!: string | null;
}

export class CampaignAnalyticsDto {
  @ApiProperty({ format: 'uuid' })
  campaign_id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  objective!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty({ nullable: true, format: 'date-time' })
  launched_at!: string | null;

  @ApiProperty({ type: MoneyDto, description: 'Paid out of escrow to promoters and Ralia so far.' })
  spent!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  budget!: MoneyDto;

  @ApiProperty({ example: 41230 })
  views_delivered!: number;

  @ApiProperty({ type: MoneyDto, description: 'spent ÷ views, or ₦0 when there are no views yet.' })
  cost_per_view!: MoneyDto;

  @ApiProperty({ example: 76, description: 'Offers sent to promoters.' })
  offers_sent!: number;

  @ApiProperty({ example: 54, description: 'Offers accepted.' })
  offers_accepted!: number;

  @ApiProperty({ example: 0.71, description: 'accepted ÷ sent, 0–1. 0 when none sent.' })
  acceptance_rate!: number;

  @ApiProperty({ example: 41, description: 'Assignments verified and paid.' })
  completed!: number;

  @ApiProperty({ example: 60 })
  slots_total!: number;

  @ApiProperty({ type: [EvidenceItemDto] })
  evidence!: EvidenceItemDto[];
}

export class DashboardCampaignRowDto {
  @ApiProperty({ format: 'uuid' })
  id!: string;

  @ApiProperty()
  name!: string;

  @ApiProperty()
  objective!: string;

  @ApiProperty()
  status!: string;

  @ApiProperty()
  slots_total!: number;

  @ApiProperty({ type: MoneyDto })
  spent!: MoneyDto;

  @ApiProperty({ type: MoneyDto })
  budget!: MoneyDto;

  @ApiProperty()
  views!: number;

  @ApiProperty({ description: 'Assignments verified and paid.' })
  completed!: number;
}

export class DashboardSummaryDto {
  @ApiProperty({ type: MoneyDto, description: 'Paid out across this client’s campaigns this calendar month.' })
  spent_this_month!: MoneyDto;

  @ApiProperty({ nullable: true, example: 18, description: 'Percent change vs last month; null if last month was zero.' })
  spent_change_pct!: number | null;

  @ApiProperty({ example: 81770 })
  views_delivered!: number;

  @ApiProperty({ example: 4 })
  campaigns_total!: number;

  @ApiProperty({ example: 1 })
  live_campaigns!: number;

  @ApiProperty({ example: 156, description: 'Distinct promoters ever assigned to this client’s campaigns.' })
  promoters_worked_with!: number;

  @ApiProperty({ example: 12, description: 'Submissions received today across all campaigns.' })
  new_evidence_today!: number;

  @ApiProperty({ type: [DashboardCampaignRowDto] })
  campaigns!: DashboardCampaignRowDto[];
}
