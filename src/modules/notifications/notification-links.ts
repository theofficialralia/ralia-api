/**
 * Maps a notification to its call-to-action button (label + deep link into the
 * right app). Client-facing types point at the client app, promoter-facing types
 * at the promoter app; base URLs come from env so each environment links to its own
 * deployment. Returns null when there's no useful action (e.g. a rejection).
 */

const CLIENT_URL = (process.env.CLIENT_APP_URL ?? 'http://localhost:6300').replace(/\/+$/, '');
const PROMOTER_URL = (process.env.PROMOTER_APP_URL ?? 'http://localhost:6400').replace(/\/+$/, '');

export type Cta = { label: string; url: string };

export function notificationCta(type: string, data: unknown): Cta | null {
  const d = (data ?? {}) as Record<string, unknown>;
  const campaignId = typeof d.campaignId === 'string' ? d.campaignId : null;

  switch (type) {
    // ── Client-facing (client app) ──
    case 'campaign.approved':
    case 'campaign.live':
      return campaignId ? { label: 'View campaign', url: `${CLIENT_URL}/campaigns/${campaignId}` } : null;
    case 'campaign.rejected':
      return campaignId ? { label: 'Review campaign', url: `${CLIENT_URL}/campaigns/${campaignId}` } : null;
    case 'campaign.evidence_verified':
      return campaignId ? { label: 'See the proof', url: `${CLIENT_URL}/campaigns/${campaignId}` } : null;
    case 'campaign.fulfilled':
      return campaignId ? { label: 'View report', url: `${CLIENT_URL}/campaigns/${campaignId}` } : null;

    // ── Promoter-facing (promoter app) ──
    case 'offer.created':
      return { label: 'View offer', url: `${PROMOTER_URL}/offers` };
    case 'submission.approved':
      return { label: 'View campaign', url: `${PROMOTER_URL}/campaigns` };
    case 'submission.rejected':
      return { label: 'Resubmit proof', url: `${PROMOTER_URL}/campaigns` };
    case 'assignment.reclaimed':
      return { label: 'View campaigns', url: `${PROMOTER_URL}/campaigns` };
    case 'promoter.approved':
      return { label: 'See your offers', url: `${PROMOTER_URL}/offers` };
    case 'withdrawal.approved':
    case 'withdrawal.failed':
    case 'withdrawal.reversed':
      return { label: 'View earnings', url: `${PROMOTER_URL}/earnings` };

    // promoter.rejected and anything else: no actionable CTA.
    default:
      return null;
  }
}
