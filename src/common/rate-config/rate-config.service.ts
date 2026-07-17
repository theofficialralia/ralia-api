import { Injectable, InternalServerErrorException } from '@nestjs/common';
import { CampaignObjective, Platform, Prisma, RateConfig, VerificationTier } from '@prisma/client';
import { PricingConfig } from '../pricing/pricing';
import { ReachFactors } from '../reach/effective-reach';
import { PrismaService } from '../prisma/prisma.service';

/** A Decimal(4,2) → integer hundredths, exactly (1.25 → 125). */
function toHundredths(d: Prisma.Decimal): number {
  return Math.round(d.toNumber() * 100);
}

/**
 * The single active rate_config row — handoff §5.2. Coefficients change without
 * a deploy.
 *
 * A campaign stores the price it was quoted, so changing this never reprices a
 * live campaign. Nothing here may be applied retroactively.
 */
@Injectable()
export class RateConfigService {
  constructor(private readonly prisma: PrismaService) {}

  async getActive(): Promise<RateConfig> {
    const config = await this.prisma.rateConfig.findFirst({ where: { isActive: true } });
    if (!config) {
      throw new InternalServerErrorException(
        'No active rate_config row exists. Run the seed, or activate a config.',
      );
    }
    return config;
  }

  /** §5.1 factors, read from config rather than the code defaults. */
  async getReachFactors(): Promise<ReachFactors> {
    const c = await this.getActive();
    const n = (d: Prisma.Decimal): number => d.toNumber();

    return {
      platform: {
        [Platform.WHATSAPP_STATUS]: n(c.factorWhatsappStatus),
        [Platform.WHATSAPP_GROUP]: n(c.factorWhatsappGroup),
        [Platform.TELEGRAM]: n(c.factorTelegram),
        [Platform.INSTAGRAM]: n(c.factorInstagram),
        [Platform.FACEBOOK]: n(c.factorFacebook),
        [Platform.TIKTOK]: n(c.factorTiktok),
        [Platform.X]: n(c.factorX),
        [Platform.LINKEDIN]: n(c.factorLinkedin),
        [Platform.OFFLINE]: n(c.factorOffline),
      },
      tier: {
        [VerificationTier.SELF]: n(c.factorTierSelf),
        [VerificationTier.SCREENSHOT]: n(c.factorTierScreenshot),
        [VerificationTier.INSIGHTS]: n(c.factorTierInsights),
      },
    };
  }

  /** §5.2 pricing coefficients, as integer hundredths where they are multipliers. */
  async getPricingConfig(): Promise<PricingConfig> {
    const c = await this.getActive();
    return {
      rpmMinor: c.rpmMinor,
      objectiveMultHundredths: {
        [CampaignObjective.AWARENESS]: toHundredths(c.multAwareness),
        [CampaignObjective.WEBSITE_VISIT]: toHundredths(c.multWebsiteVisit),
        [CampaignObjective.APP_INSTALL]: toHundredths(c.multAppInstall),
        [CampaignObjective.LEAD_GEN]: toHundredths(c.multLeadGen),
        [CampaignObjective.PURCHASE]: toHundredths(c.multPurchase),
      },
      targetingStepHundredths: toHundredths(c.targetingStep),
      targetingCapHundredths: toHundredths(c.targetingCap),
      takeRateHundredths: toHundredths(c.takeRate),
    };
  }
}
